import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { Interaction, MessagePayload } from './discord/types';
import { DiscordAPI } from './discord/api';
import { prepareInteractionThread } from './discord/thread';
import { captureError } from './error-triage';
import { runMigrations, type Migration } from './runtime/migrations';
import {
  checkRelayRateLimit as checkRelayRate,
  ensureRelayRateSchema,
} from './runtime/relay-rate-limit';
import { makeOpenAIClient } from './runtime/openai';
import { runSync } from './finance/sync';
import { executeFinanceTool, type FinanceToolCtx } from './finance/loop';
import { buildFinanceSystemPrompt } from './finance/prompts';
import {
  accountsEmbed,
  spendingSummaryEmbed,
  merchantHistoryEmbed,
  syncResultEmbed,
} from './finance/render';
import type { AccountRow, TransactionRow } from './finance/tools';

/** Keep this many of the most recent conversation rows when pruning. */
const CONVERSATION_PRUNE_KEEP = 400;
const CONVERSATION_PRUNE_INTERVAL_MS = 24 * 3600 * 1000;

/**
 * FinanceDO holds all financial state for the user. Mirrors KitchenDO in
 * shape but with completely separate SQL tables — there's no shared schema.
 *
 * Responsibilities:
 *  - Persist accounts + transactions + conversation in SQLite
 *  - Pull from SimpleFin (called from the hourly Worker cron)
 *  - Serve as state backing for FinanceSteerWorkflow (which runs the agent)
 *
 * Single-tenant for now: one DO named "default-household" — same convention
 * as KitchenDO, so eventual multi-tenancy can be added uniformly.
 */
export class FinanceDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private discord: DiscordAPI;
  private lastConversationPruneAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.discord = new DiscordAPI(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID);
    runMigrations(this.sql, FinanceDO.MIGRATIONS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/interaction') {
      const interaction = (await request.json()) as Interaction;
      this.ctx.waitUntil(
        this.handleInteraction(interaction).catch(async (err) => {
          console.error('finance handleInteraction failed', err);
          await captureError(this.env, err, {
            source: `finance-interaction:${interaction.data?.name ?? 'unknown'}`,
            tags: {
              interaction_type: interaction.type,
              channel_id: interaction.channel_id,
              guild_id: interaction.guild_id,
            },
          });
          await this.discord
            .editOriginal(interaction.token, `Something broke: ${(err as Error).message}`)
            .catch(() => {});
        })
      );
      return new Response('queued');
    }

    if (url.pathname === '/heartbeat') {
      await this.runScheduledSync();
      this.maybePruneConversation();
      return new Response('ok');
    }

    if (url.pathname === '/sync' && request.method === 'POST') {
      const result = await runSync(this.env, this.sql);
      return Response.json(result);
    }

    if (url.pathname === '/relay-allowed' && request.method === 'POST') {
      const body = (await request.json()) as { channelId: string };
      if (!body.channelId) return Response.json({ allowed: false, reason: 'missing channelId' }, { status: 400 });
      const limit = Number(this.env.RELAY_RATE_LIMIT_PER_HOUR ?? '') || undefined;
      const decision = checkRelayRate(this.sql, body.channelId, limit);
      return Response.json(decision, { status: decision.allowed ? 200 : 429 });
    }

    if (url.pathname === '/fast-read') {
      const interaction = (await request.json()) as Interaction;
      const payload = this.handleFastRead(interaction);
      return Response.json(payload);
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      this.sql.exec('DELETE FROM transactions');
      this.sql.exec('DELETE FROM accounts');
      this.sql.exec('DELETE FROM conversation');
      return Response.json({ status: 'ok', cleared: ['transactions', 'accounts', 'conversation'] });
    }

    // ─── FinanceSteerWorkflow IO ──────────────────────────────────────
    // The workflow drives the agent loop in steps; each step calls these
    // endpoints to read/write conversation state and execute tools. Keeps
    // SQL writes inside the DO (transactional) and avoids exposing
    // SqlStorage to the workflow runtime.

    if (url.pathname === '/workflow/finance/load-context') {
      const threadId = url.searchParams.get('thread_id');
      const systemPrompt = buildFinanceSystemPrompt(this.sql, this.env.TIMEZONE);
      // Conversation is scoped per thread so each thread has its own context;
      // a missing thread_id (legacy callers) falls back to the global tail.
      const history = threadId
        ? this.sql
            .exec<{ role: string; content: string }>(
              "SELECT role, content FROM conversation WHERE thread_id = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 30",
              threadId
            )
            .toArray()
            .reverse()
        : this.sql
            .exec<{ role: string; content: string }>(
              "SELECT role, content FROM conversation WHERE thread_id IS NULL AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 30"
            )
            .toArray()
            .reverse();
      return Response.json({ systemPrompt, history });
    }

    if (url.pathname === '/workflow/finance/save-turn' && request.method === 'POST') {
      const body = (await request.json()) as {
        role: string;
        content: string;
        tool_call_json?: string;
        thread_id?: string;
      };
      this.sql.exec(
        'INSERT INTO conversation (role, content, tool_call_json, thread_id, ts) VALUES (?, ?, ?, ?, ?)',
        body.role, body.content, body.tool_call_json ?? null, body.thread_id ?? null, Date.now()
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === '/workflow/finance/exec-tool' && request.method === 'POST') {
      const body = (await request.json()) as { name: string; args: any };
      // 60s per-tool budget. Most tools are local SQLite; sync_now hits the
      // SimpleFin API and can be slow on a large account list.
      const client = makeOpenAIClient(this.env, { timeoutMs: 60_000 });
      const ctx: FinanceToolCtx = { env: this.env, sql: this.sql, client };
      const result = await executeFinanceTool(body.name, body.args, ctx);
      return new Response(result, { headers: { 'content-type': 'text/plain' } });
    }

    if (url.pathname === '/dump') {
      const accounts = this.sql.exec('SELECT * FROM accounts').toArray();
      const txCount = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM transactions').toArray()[0]?.n ?? 0;
      const recentTx = this.sql.exec('SELECT id, account_id, posted, amount, description, normalized_payee, pending FROM transactions ORDER BY posted DESC LIMIT 30').toArray();
      const recentConv = this.sql.exec('SELECT id, role, ts, substr(content, 1, 200) AS preview FROM conversation ORDER BY id DESC LIMIT 30').toArray();
      const settings = this.sql.exec('SELECT key, length(value) AS len, substr(value, 1, 200) AS preview, updated_at FROM settings').toArray();
      return new Response(
        JSON.stringify({ now: Date.now(), accounts, transaction_count: txCount, recent_transactions: recentTx, recent_conversation: recentConv, settings }, null, 2),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response('not found', { status: 404 });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value])
    );

    if (commandName === 'finance-sync') {
      const replyChannelId = await this.openReplyThread(interaction, 'sync from simplefin');
      const result = await runSync(this.env, this.sql);
      await this.discord.postMessage(replyChannelId, {
        embeds: [syncResultEmbed({
          inserted: result.transactionsInserted,
          updated: result.transactionsUpdated,
          accounts: result.accountsUpdated,
          errors: result.errors,
        })],
      });
      return;
    }

    // /finance with a message → run via FinanceSteerWorkflow so each agent
    // round has its own retry budget. /finance bare goes through the fast-read
    // path before reaching this handler.
    if (commandName === 'finance' && optionMap.message) {
      const message = String(optionMap.message);
      const replyChannelId = await this.openReplyThread(interaction, `finance: ${message}`);
      await this.env.FINANCE_STEER_WORKFLOW.create({
        params: { userMessage: message, replyChannelId },
      });
      return;
    }

    await this.discord.editOriginal(
      interaction.token,
      `Unknown finance command: \`${commandName}\``
    );
  }

  /**
   * Synchronous read-only command handler. Identical to KitchenDO's pattern.
   * Returns a {content?, embeds?} payload directly, no LLM calls.
   */
  private handleFastRead(interaction: Interaction): MessagePayload {
    const cmd = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value])
    );

    if (cmd === 'finance') {
      // Bare /finance — show a quick spending summary (last 30d).
      return { embeds: [this.spendingSummary(30)] };
    }

    if (cmd === 'spending') {
      const days = Math.max(1, Math.min(365, Number(optionMap.days ?? 30)));
      return { embeds: [this.spendingSummary(days)] };
    }

    if (cmd === 'merchant') {
      const name = String(optionMap.name ?? '').trim().toLowerCase();
      const days = Math.max(1, Math.min(730, Number(optionMap.days ?? 90)));
      if (!name) {
        return { content: 'Usage: `/merchant name:<merchant> [days:90]`' };
      }
      const rows = this.sql
        .exec<TransactionRow>(
          'SELECT * FROM transactions WHERE normalized_payee = ? AND posted >= ? ORDER BY posted DESC',
          name,
          Math.floor(Date.now() / 1000) - days * 86_400
        )
        .toArray();
      return { embeds: [merchantHistoryEmbed({ merchant: name, days, rows })] };
    }

    if (cmd === 'accounts') {
      const accounts = this.sql.exec<AccountRow>('SELECT * FROM accounts ORDER BY name').toArray();
      return { embeds: [accountsEmbed(accounts)] };
    }

    return { content: `Unknown fast-read finance command: ${cmd}` };
  }

  private spendingSummary(days: number) {
    const since = Math.floor(Date.now() / 1000) - days * 86_400;
    const totals = this.sql
      .exec<{ inflow: number; outflow: number; count: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS inflow,
           COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS outflow,
           COUNT(*) AS count
         FROM transactions
         WHERE posted >= ?`,
        since
      )
      .toArray()[0]!;
    const topMerchants = this.sql
      .exec<{ normalized_payee: string; total: number; count: number }>(
        `SELECT normalized_payee, SUM(amount) AS total, COUNT(*) AS count
           FROM transactions
          WHERE posted >= ? AND amount < 0
          GROUP BY normalized_payee
          ORDER BY total ASC
          LIMIT 8`,
        since
      )
      .toArray();
    return spendingSummaryEmbed({ days, ...totals, topMerchants });
  }

  /** Wrap a Discord interaction with our standard "open thread + reply" pattern. */
  private async openReplyThread(interaction: Interaction, titleSeed: string): Promise<string> {
    return prepareInteractionThread({
      discord: this.discord,
      env: this.env,
      interactionToken: interaction.token,
      titleSeed,
    });
  }

  /**
   * Triggered hourly by the Worker cron. Pulls latest from SimpleFin and
   * upserts. Errors are captured so a single bad sync doesn't kill the
   * heartbeat (which also drives conversation prune).
   */
  private async runScheduledSync(): Promise<void> {
    if (!this.env.SIMPLEFIN_ACCESS_URL) {
      // Don't error on every heartbeat in environments without the secret set.
      return;
    }
    try {
      await runSync(this.env, this.sql);
    } catch (err) {
      console.error('finance scheduled sync failed', err);
      await captureError(this.env, err, { source: 'finance:scheduled-sync' });
    }
  }

  private maybePruneConversation(): void {
    const now = Date.now();
    if (now - this.lastConversationPruneAt < CONVERSATION_PRUNE_INTERVAL_MS) return;
    this.lastConversationPruneAt = now;
    this.sql.exec(
      `DELETE FROM conversation
        WHERE id NOT IN (SELECT id FROM conversation ORDER BY id DESC LIMIT ?)`,
      CONVERSATION_PRUNE_KEEP
    );
  }

  /**
   * Schema migrations. Append-only, never mutate or remove existing entries.
   * Independent of KitchenDO's schema_version even though they live in
   * separate DOs and never share a SQLite file.
   */
  private static readonly MIGRATIONS: readonly Migration[] = [
    {
      version: 1,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            org_name TEXT,
            currency TEXT NOT NULL,
            balance TEXT NOT NULL,
            available_balance TEXT,
            last_synced_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            posted INTEGER NOT NULL,
            amount REAL NOT NULL,
            description TEXT NOT NULL,
            payee TEXT,
            normalized_payee TEXT NOT NULL,
            memo TEXT,
            pending INTEGER NOT NULL DEFAULT 0,
            raw_json TEXT NOT NULL,
            ingested_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_tx_posted ON transactions(posted DESC);
          CREATE INDEX IF NOT EXISTS idx_tx_merchant_posted
            ON transactions(normalized_payee, posted DESC);
          CREATE INDEX IF NOT EXISTS idx_tx_account_posted
            ON transactions(account_id, posted DESC);
          CREATE TABLE IF NOT EXISTS conversation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tool_call_json TEXT,
            ts INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_conv_id ON conversation(id DESC);
        `);
      },
    },
    {
      version: 2,
      up: (sql) => ensureRelayRateSchema(sql),
    },
    {
      // Conversation scoping per Discord thread. Each thread is its own
      // chat context — the agent should remember what it just said in
      // *this* thread, not whatever happened in an unrelated thread.
      version: 3,
      up: (sql) => {
        const cols = sql
          .exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', 'conversation')
          .toArray()
          .map((r) => r.name);
        if (!cols.includes('thread_id')) {
          sql.exec('ALTER TABLE conversation ADD COLUMN thread_id TEXT');
        }
        sql.exec('CREATE INDEX IF NOT EXISTS idx_conv_thread ON conversation(thread_id, id DESC)');
      },
    },
  ];
}
