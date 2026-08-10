/**
 * Abstract base for every agent-backed Durable Object. Owns the endpoints that
 * are universal across bots:
 *
 *   /heartbeat              — conversation prune + spec-defined hook work
 *   /relay-allowed          — per-channel rate-limit check
 *   /reset                  — wipe tables listed in spec.resetTables
 *   /fast-read              — defer to spec.fastRead
 *   /interaction            — wrapper that catches + surfaces tool errors,
 *                             then defers to subclass `dispatchCommand`
 *   /workflow/agent/load-context
 *   /workflow/agent/save-turn
 *   /workflow/agent/record-usage
 *   /workflow/agent/cost-summary
 *   /workflow/agent/exec-tool
 *
 * Subclasses point to their `BotSpec` via `getSpec()` and may:
 *  - override `onHeartbeat()` for bot-specific heartbeat work (kitchen alarms +
 *    reminder dispatch),
 *  - override `handleCustomRoute()` to add bot-specific endpoints (kitchen has
 *    /ensure-alarm, /get-grocery, /clear-grocery, /workflow/load-draft, …),
 *  - override `dispatchCommand()` to handle slash-command interactions that
 *    aren't a plain `<bot> message:` chat (kitchen has /now, /pantry, /profile,
 *    /draft, /approve, /grocery),
 *  - add an `alarm()` method (kitchen's weekly draft alarm).
 *
 * The base intentionally doesn't know about alarms, reminders, or any
 * domain-specific tables — those live in the subclass.
 */

import { DurableObject } from 'cloudflare:workers';
import OpenAI from 'openai';
import type { Env } from '../env';
import type { Interaction } from '../discord/types';
import { DiscordAPI } from '../discord/api';
import { prepareInteractionThread } from '../discord/thread';
import { captureError } from '../error-triage';
import { runMigrations } from './migrations';
import { maybePruneConversationByThread } from './conversation';
import { checkRelayRateLimit } from './relay-rate-limit';
import {
  recordUsage,
  sumUsageByThread,
  sumUsageSince,
  countTurnsByThread,
  type RecordUsageBody,
} from './usage';
import { makeLLMClient } from './llm';
import { tavilySearch } from './tavily';
import type { RoundUsage } from './agent-round';
import type { BotSpec, ConversationScope, ToolExecCtx } from './bot-spec';
import { dispatchChat } from './bot-registry';

const CONVERSATION_PRUNE_KEEP_DEFAULT = 400;

/** Tool-execution budget per call. Kitchen tools (which call OpenAI internally
 *  for draft/swap) need the longer budget; we use 60s uniformly so the value
 *  is one constant the operator can reason about. */
const TOOL_TIMEOUT_MS = 60_000;

export abstract class AgentDOBase<E extends Env> extends DurableObject<E> {
  protected sql: SqlStorage;
  protected discord: DiscordAPI;
  private lastConversationPruneAt = 0;

  /** Subclasses return their module-level `BotSpec` constant. Implemented as
   *  a method (not a field) so the base constructor can invoke it via virtual
   *  dispatch — TS class-field initializers haven't run when `super()` does. */
  protected abstract getSpec(): BotSpec;

  /** Convenience getter so the rest of the base can read `this.spec` instead
   *  of calling `this.getSpec()` repeatedly. */
  protected get spec(): BotSpec {
    return this.getSpec();
  }

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.discord = new DiscordAPI(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID);
    // Runs against the subclass's spec via virtual dispatch on getSpec(). This
    // eliminates the foot-gun where a subclass forgot to call ensureSchema()
    // and crashed on its first SQL query.
    runMigrations(this.sql, this.getSpec().migrations, this.ctx.storage);
  }

  /** Hook: bot-specific heartbeat work after universal prune. Default no-op. */
  protected async onHeartbeat(): Promise<void> {}

  /** Hook: bot-specific routes not covered by the base. Return null when the
   *  path isn't handled so the base can return 404 (or surface a different
   *  base-owned route). */
  protected async handleCustomRoute(_request: Request, _url: URL): Promise<Response | null> {
    return null;
  }

  /** Hook: bot-specific post-reset cleanup. Default no-op. Kitchen overrides
   *  to re-arm its weekly-draft alarm. */
  protected async onReset(): Promise<void> {}

  /** Slash-command dispatch. The base owns the try/catch + error reporting
   *  shell; subclasses implement the per-command routing. */
  protected abstract dispatchCommand(interaction: Interaction): Promise<void>;

  /** Optional: subclasses can override to assemble extra fields for /dump. */
  protected async customDump(): Promise<Record<string, unknown>> {
    return {};
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/interaction') {
      const interaction = (await request.json()) as Interaction;
      this.ctx.waitUntil(
        this.dispatchCommand(interaction).catch(async (err) => {
          console.error(`${this.spec.id} dispatchCommand failed`, err);
          await captureError(this.env, err, {
            source: `${this.spec.id}-interaction:${interaction.data?.name ?? 'unknown'}`,
            tags: {
              interaction_type: interaction.type,
              channel_id: interaction.channel_id,
              guild_id: interaction.guild_id,
            },
          });
          await this.discord
            .editOriginal(interaction.token, `Something broke: ${(err as Error).message}`)
            .catch(() => {});
        }),
      );
      return new Response('queued');
    }

    if (url.pathname === '/heartbeat') {
      // onHeartbeat throws shouldn't skip the prune below — both run on the
      // hourly cron and shedding one isn't worth losing the other.
      try {
        await this.onHeartbeat();
      } catch (err) {
        console.error(`${this.spec.id} onHeartbeat failed`, err);
        await captureError(this.env, err, { source: `${this.spec.id}:heartbeat` });
      }
      this.maybePruneConversation();
      return new Response('ok');
    }

    if (url.pathname === '/relay-allowed' && request.method === 'POST') {
      const body = (await request.json()) as { channelId?: string };
      if (!body.channelId) {
        return Response.json({ allowed: false, reason: 'missing channelId' }, { status: 400 });
      }
      const limit = Number(this.env.RELAY_RATE_LIMIT_PER_HOUR ?? '') || undefined;
      const decision = checkRelayRateLimit(this.sql, body.channelId, limit);
      return Response.json(decision, { status: decision.allowed ? 200 : 429 });
    }

    if (url.pathname === '/fast-read') {
      const interaction = (await request.json()) as Interaction;
      try {
        const payload = this.spec.fastRead(this.sql, this.env, interaction);
        if (!payload) {
          return Response.json({ content: `Unknown command: \`${interaction.data?.name ?? ''}\`` });
        }
        return Response.json(payload);
      } catch (err) {
        console.error(`${this.spec.id} fast-read failed`, err);
        this.ctx.waitUntil(captureError(this.env, err, {
          source: `${this.spec.id}-fast-read:${interaction.data?.name ?? 'unknown'}`,
        }));
        return Response.json({ content: `Something broke: ${(err as Error).message}` });
      }
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      // Iterate spec.resetTables in declared order — kitchen's children must
      // delete before parents because DO SQLite doesn't enable foreign_keys.
      for (const table of this.spec.resetTables) {
        this.sql.exec(`DELETE FROM ${table}`);
      }
      await this.onReset();
      return Response.json({ status: 'ok', cleared: [...this.spec.resetTables] });
    }

    // ─── Universal AgentChatWorkflow IO ─────────────────────────────────

    if (url.pathname === '/workflow/agent/load-context') {
      const scope = scopeFromQuery(url);
      const systemPrompt = this.spec.buildSystemPrompt(this.sql, this.env, scope);
      const history = this.loadHistory(scope, 30);
      return Response.json({ systemPrompt, history });
    }

    if (url.pathname === '/workflow/agent/save-turn' && request.method === 'POST') {
      const body = (await request.json()) as {
        role?: unknown;
        content?: unknown;
        tool_call_json?: unknown;
        scope_column?: unknown;
        scope_value?: unknown;
      };
      if (typeof body.role !== 'string' || !body.role) {
        return Response.json({ error: 'save-turn: missing/invalid role' }, { status: 400 });
      }
      if (typeof body.content !== 'string') {
        return Response.json({ error: 'save-turn: content must be a string' }, { status: 400 });
      }
      const scope = scopeFromBody(body);
      if (!scope) {
        return Response.json({ error: 'save-turn: missing/invalid scope' }, { status: 400 });
      }
      const toolCallJson = typeof body.tool_call_json === 'string' ? body.tool_call_json : null;
      // `scope.column` is a typed enum, safe to inline.
      this.sql.exec(
        `INSERT INTO conversation (${scope.column}, role, content, tool_call_json, ts) VALUES (?, ?, ?, ?, ?)`,
        scope.value, body.role, body.content, toolCallJson, Date.now(),
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === '/workflow/agent/record-usage' && request.method === 'POST') {
      const body = (await request.json()) as Partial<RecordUsageBody>;
      if (typeof body.model !== 'string' || !body.model) {
        return Response.json({ error: 'record-usage: missing/invalid model' }, { status: 400 });
      }
      const totals = recordUsage(this.sql, body as RecordUsageBody);
      return Response.json({ thread_total_usage: totals });
    }

    if (url.pathname === '/workflow/agent/cost-summary') {
      const threadId = url.searchParams.get('thread_id');
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') ?? 30)));
      const sinceMs = Date.now() - days * 86_400_000;
      const totals = threadId ? sumUsageByThread(this.sql, threadId) : sumUsageSince(this.sql, sinceMs);
      const turnCount = threadId
        ? countTurnsByThread(this.sql, threadId)
        : this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM usage WHERE ts >= ?', sinceMs)
            .toArray()[0]?.n ?? 0;
      return Response.json({ usage: totals, turn_count: turnCount, days, thread_id: threadId });
    }

    if (url.pathname === '/workflow/agent/exec-tool' && request.method === 'POST') {
      const body = (await request.json()) as {
        name?: unknown;
        args?: unknown;
        scope_column?: unknown;
        scope_value?: unknown;
      };
      if (typeof body.name !== 'string' || !body.name) {
        return Response.json({ error: 'exec-tool: missing/invalid name' }, { status: 400 });
      }
      const scope = scopeFromBody(body);
      if (!scope) {
        return Response.json({ error: 'exec-tool: missing/invalid scope' }, { status: 400 });
      }
      const toolName = body.name;
      const client = makeLLMClient(this.env, { timeoutMs: TOOL_TIMEOUT_MS });
      const toolCtx: ToolExecCtx = {
        env: this.env,
        sql: this.sql,
        client: client as unknown as OpenAI,
        timezone: this.env.TIMEZONE,
        scope,
      };
      // Each spec.executeTool wraps its inner handlers in try/catch and
      // returns a string error — but a bug *outside* that inner try (bad ctx
      // shape, an unmatched tool case, a rejected promise from executeTool
      // itself) would otherwise bubble a 500 with no body. The workflow turns
      // that into a JSON-parse failure and the user gets nothing. Wrapping
      // here keeps the round alive: the model sees the failure string and
      // can either retry or apologize.
      let payload: { output: string; usage: RoundUsage | null };
      try {
        const args = (body.args ?? {}) as Record<string, unknown>;
        // web_search is a shared tool every bot exposes — execute it here so
        // each spec doesn't need its own case. Tavily replaces OpenAI's hosted
        // web_search built-in; results are source-stripped, untrusted reference.
        const result = toolName === 'web_search'
          ? await tavilySearch(this.env, String(args.query ?? ''))
          : await this.spec.executeTool(toolName, args, toolCtx);
        payload = typeof result === 'string'
          ? { output: result, usage: null }
          : { output: result.output, usage: result.usage ?? null };
      } catch (err) {
        console.error(`${this.spec.id} exec-tool ${toolName} failed`, err);
        this.ctx.waitUntil(captureError(this.env, err, {
          source: `${this.spec.id}-exec-tool:${toolName}`,
        }));
        payload = { output: `[tool ${toolName} failed: ${(err as Error).message}]`, usage: null };
      }
      return Response.json(payload);
    }

    // Subclass-defined extras (kitchen's alarm/grocery/approve IO). Run last
    // so they can't accidentally shadow a base route.
    const custom = await this.handleCustomRoute(request, url);
    if (custom) return custom;

    if (url.pathname === '/dump') {
      const dump = {
        now: Date.now(),
        now_iso: new Date().toISOString(),
        bot: this.spec.id,
        ...(await this.customDump()),
      };
      return new Response(JSON.stringify(dump, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }

  /** Standard helper subclasses use when opening a Discord thread for a slash
   *  command interaction. Centralized so every bot's reply-thread pattern is
   *  the same. */
  protected async openReplyThread(interaction: Interaction, titleSeed: string): Promise<string> {
    return prepareInteractionThread({
      discord: this.discord,
      env: this.env,
      interactionToken: interaction.token,
      titleSeed,
    });
  }

  /** Dispatch a `<bot> message: …` style interaction into the unified
   *  AgentChatWorkflow. Subclasses use this from `dispatchCommand`. The
   *  default scope is whatever the spec computes; callers with richer context
   *  (kitchen's findActiveWeek) may pass an explicit scope override. */
  protected async dispatchChatInteraction(
    interaction: Interaction,
    userMessage: string,
    titleSeed: string,
    scopeOverride?: ConversationScope,
  ): Promise<void> {
    const replyChannelId = await this.openReplyThread(interaction, titleSeed);
    const scope = scopeOverride ?? this.spec.defaultScope(this.env, replyChannelId);
    await dispatchChat(this.env, this.spec.id, userMessage, replyChannelId, scope);
  }

  /** Read the most recent N user/assistant rows for the given scope. */
  private loadHistory(scope: ConversationScope, limit: number): { role: string; content: string }[] {
    return this.sql
      .exec<{ role: string; content: string }>(
        `SELECT role, content FROM conversation
          WHERE ${scope.column} = ?
            AND role IN ('user', 'assistant')
          ORDER BY id DESC
          LIMIT ?`,
        scope.value, limit,
      )
      .toArray()
      .reverse();
  }

  private maybePruneConversation(): void {
    const runner = (sql: string, ...params: any[]) => this.sql.exec(sql, ...params);
    this.lastConversationPruneAt = maybePruneConversationByThread(
      runner, this.lastConversationPruneAt, CONVERSATION_PRUNE_KEEP_DEFAULT,
    );
  }
}

function scopeFromQuery(url: URL): ConversationScope {
  return { column: 'thread_id', value: url.searchParams.get('scope_value') ?? '' };
}

function scopeFromBody(body: { scope_column?: unknown; scope_value?: unknown }): ConversationScope | null {
  if (typeof body.scope_value !== 'string') return null;
  return { column: 'thread_id', value: body.scope_value };
}
