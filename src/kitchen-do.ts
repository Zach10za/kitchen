import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { Interaction, MessagePayload } from './discord/types';
import { EmbedColor } from './discord/types';
import { DiscordAPI } from './discord/api';
import { prepareInteractionThread } from './discord/thread';
import { runAgent, runDraftFlow, runPantryFlow, executeTool, type ToolCtx } from './agent/loop';
import { buildSystemPromptFor, findActiveWeek } from './agent/context';
import { planEmbed, groceryEmbeds, statusEmbed } from './agent/render';
import { currentOrNextMondayISO, nextMondayISO, nextDraftTime, mealCookTime } from './util/datetime';
import { captureError } from './error-triage';
import { makeOpenAIClient } from './runtime/openai';
import {
  checkRelayRateLimit as checkRelayRate,
  ensureRelayRateSchema,
} from './runtime/relay-rate-limit';
import { runMigrations, type Migration } from './runtime/migrations';
import { maybePruneConversationByWeek } from './runtime/conversation';
import {
  ensureUsageSchema,
  recordUsage,
  sumUsageByThread,
  sumUsageSince,
  countTurnsByThread,
  costFooter,
} from './runtime/usage';

/** Keep this many of the most recent conversation rows per week_of when pruning. */
const CONVERSATION_PRUNE_PER_WEEK = 200;

/**
 * KitchenDO holds all household state. One instance per household
 * (currently single-tenant under the name "default-household").
 *
 * Responsibilities:
 *  - Persist plan, conversation, preferences, pantry in SQLite
 *  - Run the agent loop on incoming Discord interactions
 *  - Fire the weekly draft via alarm and post it to Discord
 */
export class KitchenDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private discord: DiscordAPI;
  private lastConversationPruneAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.discord = new DiscordAPI(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID);
    this.initSchema();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/interaction') {
      const interaction = (await request.json()) as Interaction;
      // Run the work in the DO's own waitUntil so the parent Worker's request
      // can end immediately. The DO has its own request lifetime budget here.
      this.ctx.waitUntil(
        this.handleInteraction(interaction).catch(async (err) => {
          console.error('handleInteraction failed', err);
          await captureError(this.env, err, {
            source: `interaction:${interaction.data?.name ?? 'unknown'}`,
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

    if (url.pathname === '/ensure-alarm') {
      await this.ensureAlarmSet();
      return new Response('ok');
    }

    if (url.pathname === '/heartbeat') {
      await this.ensureAlarmSet();
      await this.dispatchDueReminders();
      this.maybePruneConversation();
      return new Response('ok');
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

    if (url.pathname === '/get-grocery') {
      const weekOf = url.searchParams.get('week_of');
      if (!weekOf) return new Response('missing week_of', { status: 400 });
      const row = this.sql.exec<{ items_json: string }>('SELECT items_json FROM grocery_lists WHERE week_of = ?', weekOf).toArray()[0];
      if (!row) return Response.json({ items: [] });
      return new Response(row.items_json, { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/clear-grocery' && request.method === 'POST') {
      const weekOf = url.searchParams.get('week_of');
      if (!weekOf) return new Response('missing week_of', { status: 400 });
      const before = this.sql.exec('SELECT 1 FROM grocery_lists WHERE week_of = ?', weekOf).toArray().length;
      this.sql.exec('DELETE FROM grocery_lists WHERE week_of = ?', weekOf);
      return Response.json({ cleared: before > 0, week_of: weekOf });
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      // Wipe all user-data tables except settings (profile).
      this.sql.exec('DELETE FROM weeks');
      this.sql.exec('DELETE FROM conversation');
      this.sql.exec('DELETE FROM pantry');
      this.sql.exec('DELETE FROM preferences');
      this.sql.exec('DELETE FROM grocery_lists');
      this.sql.exec('DELETE FROM reminders');

      // Re-arm the weekly draft alarm. Old alarm timestamp may be stale.
      await this.ctx.storage.deleteAlarm();
      await this.armNextDraft();

      const remaining = this.sql
        .exec<{ key: string }>('SELECT key FROM settings')
        .toArray()
        .map((r) => r.key);

      return new Response(
        JSON.stringify({
          status: 'ok',
          cleared: ['weeks', 'conversation', 'pantry', 'preferences', 'grocery_lists', 'reminders'],
          preserved_settings_keys: remaining,
          alarm_rearmed: await this.ctx.storage.getAlarm(),
        }, null, 2),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    // ─── Workflow IO endpoints ─────────────────────────────────────────
    // The ApproveWorkflow needs to read/write state via these. Each is small
    // and synchronous so workflow steps stay short.

    if (url.pathname === '/workflow/load-draft') {
      const weekOf = url.searchParams.get('week_of');
      if (!weekOf) return Response.json({ error: 'missing week_of' }, { status: 400 });
      const week = this.getWeek(weekOf);
      if (!week) return Response.json(null);
      return Response.json({
        week_of: week.week_of,
        status: week.status,
        drafted_at: week.drafted_at,
        meals: JSON.parse(week.meals_json),
      });
    }

    if (url.pathname === '/workflow/get-pantry') {
      const items = this.sql.exec('SELECT * FROM pantry').toArray();
      return Response.json(items);
    }

    if (url.pathname === '/workflow/save-approved' && request.method === 'POST') {
      const body = (await request.json()) as { week_of: string; meals: any[] };
      // Idempotent: only stamp approved_at on the first transition, so workflow
      // retries don't clobber the timestamp. Always update meals_json (it's the
      // materialized form which the workflow guarantees is correct).
      this.sql.exec(
        "UPDATE weeks SET meals_json = ? WHERE week_of = ?",
        JSON.stringify(body.meals), body.week_of
      );
      this.sql.exec(
        "UPDATE weeks SET status = 'approved', approved_at = ? WHERE week_of = ? AND status != 'approved'",
        Date.now(), body.week_of
      );
      // Schedule defrost reminders for any freezer-using meals.
      const reminders = this.scheduleDefrostRemindersFromMeals(body.week_of, body.meals);
      return Response.json({ remindersScheduled: reminders });
    }

    if (url.pathname === '/workflow/save-grocery' && request.method === 'POST') {
      const body = (await request.json()) as { week_of: string; items: any[] };
      this.sql.exec(
        'INSERT INTO grocery_lists (week_of, items_json, generated_at) VALUES (?, ?, ?) ON CONFLICT(week_of) DO UPDATE SET items_json=excluded.items_json, generated_at=excluded.generated_at',
        body.week_of, JSON.stringify(body.items), Date.now()
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === '/workflow/has-grocery') {
      const weekOf = url.searchParams.get('week_of');
      if (!weekOf) return Response.json({ exists: false });
      const row = this.sql.exec('SELECT 1 FROM grocery_lists WHERE week_of = ? LIMIT 1', weekOf).toArray()[0];
      return Response.json({ exists: !!row });
    }

    // ─── SteerWorkflow IO ──────────────────────────────────────────────

    if (url.pathname === '/workflow/load-context') {
      const weekOf = url.searchParams.get('week_of') ?? '';
      const systemPrompt = buildSystemPromptFor(this.sql, weekOf, this.env.TIMEZONE);
      const history = this.sql.exec<{ role: string; content: string }>(
        "SELECT role, content FROM conversation WHERE week_of = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 30",
        weekOf
      ).toArray().reverse();
      return Response.json({ systemPrompt, history });
    }

    if (url.pathname === '/workflow/save-turn' && request.method === 'POST') {
      const body = (await request.json()) as {
        week_of: string;
        role: string;
        content: string;
        tool_call_json?: string;
      };
      this.sql.exec(
        'INSERT INTO conversation (week_of, role, content, tool_call_json, ts) VALUES (?, ?, ?, ?, ?)',
        body.week_of, body.role, body.content, body.tool_call_json ?? null, Date.now()
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === '/workflow/exec-tool' && request.method === 'POST') {
      const body = (await request.json()) as { name: string; args: any };
      // 25s per-tool budget keeps a single slow tool from monopolizing the
      // workflow step retry budget; the whole-flow budget lives at the round level.
      const client = makeOpenAIClient(this.env, { timeoutMs: 25_000 });
      const ctx: ToolCtx = { env: this.env, sql: this.sql, client };
      const result = await executeTool(body.name, body.args, ctx);
      // Always return the structured form so SteerWorkflow can fold tool-internal
      // LLM usage (e.g. generate_draft, swap_meal) into the round's footer total.
      const payload = typeof result === 'string'
        ? { output: result, usage: null }
        : { output: result.output, usage: result.usage ?? null };
      return Response.json(payload);
    }

    if (url.pathname === '/workflow/record-usage' && request.method === 'POST') {
      const body = (await request.json()) as Parameters<typeof recordUsage>[1];
      const totals = recordUsage(this.sql, body);
      return Response.json({ thread_total_usage: totals });
    }

    if (url.pathname === '/workflow/cost-summary') {
      const threadId = url.searchParams.get('thread_id');
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') ?? 30)));
      const sinceMs = Date.now() - days * 86_400_000;
      const totals = threadId ? sumUsageByThread(this.sql, threadId) : sumUsageSince(this.sql, sinceMs);
      const turnCount = threadId
        ? countTurnsByThread(this.sql, threadId)
        : this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM usage WHERE ts >= ?', sinceMs).toArray()[0]?.n ?? 0;
      return Response.json({ usage: totals, turn_count: turnCount, days, thread_id: threadId });
    }

    if (url.pathname === '/dump') {
      const weeks = this.sql.exec('SELECT week_of, status, drafted_at, approved_at, length(meals_json) as meals_size, substr(meals_json, 1, 200) as meals_preview FROM weeks ORDER BY drafted_at DESC').toArray();
      const pantry = this.sql.exec('SELECT * FROM pantry ORDER BY added_at DESC').toArray();
      const prefs = this.sql.exec('SELECT id, insight, weight, learned_at FROM preferences ORDER BY weight DESC, learned_at DESC').toArray();
      const reminders = this.sql.exec('SELECT id, due_at, type, week_of, day, sent_at, message FROM reminders ORDER BY due_at DESC').toArray();
      const settings = this.sql.exec("SELECT key, length(value) as len, substr(value, 1, 500) as preview, updated_at FROM settings").toArray();
      const recentConv = this.sql.exec('SELECT id, week_of, role, ts, substr(content, 1, 200) as preview FROM conversation ORDER BY id DESC LIMIT 30').toArray();
      const groceryLists = this.sql.exec('SELECT week_of, length(items_json) as size, substr(items_json, 1, 500) as preview, generated_at FROM grocery_lists').toArray();
      const alarm = await this.ctx.storage.getAlarm();
      const dump = {
        now: Date.now(),
        now_iso: new Date().toISOString(),
        alarm_at: alarm,
        alarm_iso: alarm ? new Date(alarm).toISOString() : null,
        weeks,
        pantry,
        prefs,
        reminders,
        settings,
        recent_conversation: recentConv,
        grocery_lists: groceryLists,
      };
      return new Response(JSON.stringify(dump, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }

  /**
   * Synchronous read-only command handler. Returns a {content?, embeds?}
   * payload directly. Bypasses the agent — no LLM calls. Used for /profile,
   * /plan, /pantry, /reminders when called without modification arguments.
   */
  private handleFastRead(interaction: Interaction): MessagePayload {
    const cmd = interaction.data?.name ?? '';

    if (cmd === 'profile') {
      const row = this.sql
        .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'cooking_profile'")
        .toArray()[0];
      if (!row?.value) {
        return { embeds: [statusEmbed({
          title: '👤 Cooking profile',
          description: 'No profile set yet. Use `/profile message: ...` to create one.',
          color: EmbedColor.archived,
        })] };
      }
      return { embeds: [{
        title: '👤 Cooking profile',
        description: row.value.length > 4096 ? row.value.slice(0, 4093) + '…' : row.value,
        color: EmbedColor.inProgress,
      }] };
    }

    if (cmd === 'plan') {
      const week = findActiveWeek(this.sql);
      if (!week) {
        return { embeds: [statusEmbed({
          title: '🍴 No active plan',
          description: 'No plan in the last 14 days. Use `/steer message: make a plan` to create one.',
          color: EmbedColor.archived,
        })] };
      }
      return { embeds: [planEmbed(week, { includeFooterHint: true })] };
    }

    if (cmd === 'pantry') {
      const items = this.sql
        .exec<any>('SELECT * FROM pantry ORDER BY location, added_at DESC')
        .toArray();
      if (items.length === 0) {
        return { embeds: [statusEmbed({
          title: '🥫 Pantry',
          description: 'Pantry is empty. Use `/pantry message: I have ...` to add items.',
          color: EmbedColor.archived,
        })] };
      }
      const grouped: Record<string, string[]> = {};
      for (const item of items) {
        const loc = item.location || 'shelf';
        const qty = item.qty_value != null ? ` (${item.qty_value}${item.qty_unit ? ' ' + item.qty_unit : ''})` : '';
        (grouped[loc] ??= []).push(`• ${item.name}${qty}`);
      }
      const fields = (['freezer', 'fridge', 'shelf'] as const)
        .filter((l) => grouped[l]?.length)
        .map((l) => ({
          name: `${l === 'freezer' ? '🧊' : l === 'fridge' ? '🧴' : '🥫'} ${l.toUpperCase()}`,
          value: grouped[l]!.join('\n').slice(0, 1024),
          inline: true,
        }));
      return { embeds: [{
        title: '🥫 Pantry',
        description: `**${items.length}** items`,
        color: EmbedColor.inProgress,
        fields,
      }] };
    }

    if (cmd === 'reminders') {
      const now = Date.now();
      const upcoming = this.sql.exec<ReminderRow>(
        'SELECT * FROM reminders WHERE sent_at IS NULL AND due_at >= ? ORDER BY due_at ASC LIMIT 25',
        now
      ).toArray();
      if (upcoming.length === 0) {
        return { embeds: [statusEmbed({
          title: '⏰ Upcoming reminders',
          description: 'No upcoming reminders.',
          color: EmbedColor.archived,
        })] };
      }
      const lines = upcoming.map((r) => {
        const icon = r.type === 'defrost' ? '🧊' : r.type === 'prep' ? '🥣' : '⏰';
        const preview = r.message.split('\n')[0]!.replace(/\*\*/g, '').slice(0, 100);
        // Discord's <t:unix:R> tag renders as a localized relative timestamp client-side.
        return `${icon} <t:${Math.floor(r.due_at / 1000)}:R> · ${preview}`;
      });
      return { embeds: [{
        title: '⏰ Upcoming reminders',
        description: lines.join('\n').slice(0, 4096),
        color: EmbedColor.reminder,
      }] };
    }

    // /grocery is intentionally NOT a fast-read — sometimes large enough to
    // warrant the deferred + follow-up path; goes through handleGroceryRead.

    return { content: `Unknown fast-read command: ${cmd}` };
  }

  /**
   * Send any reminders whose due_at has passed and that haven't been sent.
   * Called from the hourly cron heartbeat.
   */
  private async dispatchDueReminders(): Promise<void> {
    const now = Date.now();
    const due = this.sql.exec<ReminderRow>(
      'SELECT * FROM reminders WHERE sent_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 10',
      now
    ).toArray();

    for (const reminder of due) {
      // Stamp sent_at BEFORE the network call so this is at-most-once.
      // A duplicate reminder every hour while Discord is down would be
      // worse than a single missed reminder; the user can always check
      // `/reminders` to see what's coming.
      this.sql.exec('UPDATE reminders SET sent_at = ? WHERE id = ?', now, reminder.id);
      try {
        const title = reminder.type === 'defrost'
          ? '🧊 Defrost reminder'
          : reminder.type === 'prep'
            ? '🥣 Prep reminder'
            : '⏰ Reminder';
        // Reminder messages are stored in markdown form — strip the leading
        // emoji+bold prefix so the embed title carries the kind, body the rest.
        const body = reminder.message
          .replace(/^🧊\s*\*\*Defrost reminder\*\*:\s*/i, '')
          .replace(/^🥣\s*\*\*Prep reminder\*\*:\s*/i, '');
        await this.discord.postMessage(this.env.DISCORD_CHANNEL_ID, {
          embeds: [statusEmbed({
            title,
            description: body,
            color: EmbedColor.reminder,
          })],
        });
      } catch (err) {
        console.error('reminder dispatch failed', { id: reminder.id, err });
        await captureError(this.env, err, {
          source: 'reminders:dispatch',
          tags: { reminder_id: reminder.id },
        });
      }
    }
  }

  async alarm(): Promise<void> {
    try {
      const weekOf = nextMondayISO(this.env.TIMEZONE);
      const result = await runAgent({
        env: this.env,
        sql: this.sql,
        userMessage: `It's time to draft the plan for the week of ${weekOf}. Generate a fresh draft now using current preferences and pantry. Then summarize it briefly.`,
        weekOf,
      });

      // The alarm posts top-level into the kitchen channel (not a thread).
      // Use the channel id as the "thread" key so the running thread_total
      // surfaces aggregate cost of all auto-drafts in this channel.
      const threadTotal = recordUsage(this.sql, {
        thread_id: this.env.DISCORD_CHANNEL_ID,
        model: this.env.OPENAI_MODEL,
        ...result.usage,
      });
      const footer = costFooter(result.usage, threadTotal, this.env);

      const plan = this.getWeek(weekOf);
      if (plan) {
        await this.discord.postMessage(this.env.DISCORD_CHANNEL_ID, {
          content: (result.summary || '') + footer,
          embeds: [planEmbed(plan, { includeFooterHint: true })],
        });
      } else {
        await this.discord.postMessage(this.env.DISCORD_CHANNEL_ID, {
          content: footer.trimStart(),
          embeds: [statusEmbed({
            title: '⚠️ Draft generation failed',
            description: result.summary || 'Unknown error.',
            color: EmbedColor.error,
          })],
        });
      }
    } finally {
      await this.armNextDraft();
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value])
    );

    // Read-only commands have already been short-circuited in the Worker via
    // /fast-read. By the time we get here, we're on the agent path.

    // /approve runs as a Cloudflare Workflow — each step has its own request
    // budget + automatic retries, so slow LLM calls or transient failures
    // don't kill the whole flow.
    if (commandName === 'approve') {
      // Find the most-recent plan (same logic /plan uses) and pass its week_of
      // to the workflow so they target the same one.
      const week = findActiveWeek(this.sql);

      if (!week) {
        await this.discord.editOriginal(
          interaction.token,
          'No plan in the last 14 days. Use `/draft` to create one first.'
        );
        return;
      }

      const replyChannelId = await this.openReplyThread(
        interaction,
        `approve plan ${week.week_of}`
      );
      // Post the kickoff line BEFORE creating the workflow so it can't get
      // interleaved with the workflow's own first-step post.
      await this.discord.postMessage(
        replyChannelId,
        `🚀 Approval workflow started for **${week.week_of}**…`
      );
      await this.env.APPROVE_WORKFLOW.create({
        params: { weekOf: week.week_of, replyChannelId },
      });
      return;
    }

    // Direct write path for /pantry with a message — single LLM extraction
    // call instead of full agent loop. ~1-2s vs ~5-10s.
    if (commandName === 'pantry' && optionMap.message) {
      const replyChannelId = await this.openReplyThread(
        interaction,
        `pantry: ${optionMap.message}`
      );
      await runPantryFlow({
        env: this.env,
        sql: this.sql,
        discord: this.discord,
        replyChannelId,
        userMessage: String(optionMap.message),
      });
      return;
    }

    // /grocery direct path — reads from SQL but uses additional thread messages
    // when the list exceeds Discord's 10-embed-per-message limit.
    if (commandName === 'grocery') {
      const replyChannelId = await this.openReplyThread(interaction, 'grocery list');
      await this.handleGroceryRead(replyChannelId);
      return;
    }

    // Direct write path for /draft — bypass agent for plan generation since
    // this routinely exceeds the agent's combined budget on slow LLM responses.
    if (commandName === 'draft') {
      const weekOfNext = nextMondayISO(this.env.TIMEZONE);
      const seed = optionMap.notes
        ? `draft ${weekOfNext}: ${optionMap.notes}`
        : `draft ${weekOfNext}`;
      const replyChannelId = await this.openReplyThread(interaction, seed);
      await runDraftFlow({
        env: this.env,
        sql: this.sql,
        discord: this.discord,
        replyChannelId,
        weekOf: weekOfNext,
        notes: optionMap.notes ? String(optionMap.notes) : undefined,
      });
      return;
    }

    let userMessage: string;
    // Use the same "active week" picker that /steer, /plan, and /approve use,
    // so conversation rows and tool effects from /now, /pantry, /profile land
    // on the same week_of. Otherwise on Thursdays the agent would write to
    // next-Monday's week while /steer wrote to this-Monday's.
    const activeWeek = findActiveWeek(this.sql);
    const weekOf = activeWeek?.week_of ?? currentOrNextMondayISO(this.env.TIMEZONE);

    // /steer runs as a Workflow — each agent loop iteration is its own step
    // with retries, so slow LLM calls don't take down the whole conversation.
    if (commandName === 'steer') {
      const userMsg = String(optionMap.message ?? '').trim();
      if (!userMsg) {
        await this.discord.editOriginal(
          interaction.token,
          'Provide a message: `/steer message: <what you want to change>`'
        );
        return;
      }

      const replyChannelId = await this.openReplyThread(interaction, userMsg);
      await this.env.STEER_WORKFLOW.create({
        params: { weekOf, replyChannelId, userMessage: userMsg },
      });
      return;
    }

    let titleSeed: string;
    switch (commandName) {
      // /plan, /grocery, /pantry-no-msg, /reminders, /profile-no-msg are all
      // routed through the Worker fast-read path. /approve, /steer, /pantry-msg,
      // /draft, /grocery short-circuit earlier in this method. So the only
      // commands that reach this switch are: /now, /pantry (write), /profile (write).
      case 'now': {
        const nowLocal = new Date().toLocaleString('en-US', {
          timeZone: this.env.TIMEZONE,
          weekday: 'long',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        userMessage = `Right now it is **${nowLocal}** (${this.env.TIMEZONE}). Based on the current time, today's planned meal, and my cooking profile (especially any dinner time I've set), tell me concretely what I should be doing in the kitchen right now. Don't give "if it's morning, do X" branches — you know exactly what time it is. If it's still hours before dinner, tell me when to start cooking and what (if anything) to prep now. If it's close to dinner time, walk me through the next step.`;
        titleSeed = 'what to cook now';
        break;
      }
      case 'pantry':
        userMessage = `Update the pantry: ${optionMap.message}`;
        titleSeed = `pantry: ${optionMap.message}`;
        break;
      case 'profile':
        // Verbatim user input wrapped in delimiters + explicit do-not-summarize directive.
        userMessage = `The user is updating their cooking profile. Their input, VERBATIM:\n\n"""\n${optionMap.message}\n"""\n\nCall update_profile. Preserve every detail and the user's wording. If a profile already exists, merge intelligently — never drop information. Organize into clear Markdown sections (## Equipment, ## Dietary, ## Cuisines, ## Style, ## Time, etc.). Do not paraphrase or summarize.`;
        titleSeed = `profile: ${optionMap.message}`;
        break;
      default:
        userMessage = `Unknown command: ${commandName}`;
        titleSeed = `/${commandName}`;
    }

    const replyChannelId = await this.openReplyThread(interaction, titleSeed);

    const result = await runAgent({
      env: this.env,
      sql: this.sql,
      userMessage,
      weekOf,
    });

    const threadTotal = recordUsage(this.sql, {
      thread_id: replyChannelId,
      model: this.env.OPENAI_MODEL,
      ...result.usage,
    });
    const summary = result.summary || '(no response)';
    await this.discord.postMessage(
      replyChannelId,
      summary + costFooter(result.usage, threadTotal, this.env)
    );
  }

  /**
   * Set the deferred response's content to a generated title and start a
   * thread anchored to that message. Returns the thread's channel id, into
   * which all subsequent reply messages should be posted.
   */
  private async openReplyThread(interaction: Interaction, titleSeed: string): Promise<string> {
    return prepareInteractionThread({
      discord: this.discord,
      env: this.env,
      interactionToken: interaction.token,
      titleSeed,
    });
  }

  async ensureAlarmSet(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.armNextDraft();
    }
  }

  private async armNextDraft(): Promise<void> {
    const next = nextDraftTime(
      this.env.DRAFT_DAY,
      Number(this.env.DRAFT_HOUR_LOCAL),
      this.env.TIMEZONE
    );
    await this.ctx.storage.setAlarm(next.getTime());
  }

  /**
   * Schema migrations. Each entry is run at most once; the highest applied
   * version is stored in settings.schema_version. Append new entries — never
   * mutate existing ones, since old DOs may have already applied them.
   */
  private static readonly MIGRATIONS: readonly Migration[] = [
    {
      version: 1,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS weeks (
            week_of TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'draft',
            meals_json TEXT NOT NULL DEFAULT '[]',
            constraints_json TEXT NOT NULL DEFAULT '[]',
            drafted_at INTEGER NOT NULL,
            approved_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS conversation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            week_of TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tool_call_json TEXT,
            ts INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS preferences (
            id TEXT PRIMARY KEY,
            insight TEXT NOT NULL,
            rationale TEXT NOT NULL,
            weight INTEGER NOT NULL DEFAULT 5,
            learned_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS pantry (
            name TEXT PRIMARY KEY,
            qty TEXT,
            added_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS grocery_lists (
            week_of TEXT PRIMARY KEY,
            items_json TEXT NOT NULL,
            generated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            due_at INTEGER NOT NULL,
            type TEXT NOT NULL,
            week_of TEXT,
            day TEXT,
            message TEXT NOT NULL,
            sent_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_reminders_due
            ON reminders(due_at) WHERE sent_at IS NULL;
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
        `);
      },
    },
    {
      // Freezer-tracking columns on pantry. SQLite has no native
      // "ADD COLUMN IF NOT EXISTS" so we introspect via pragma_table_info.
      version: 2,
      up: (sql) => {
        const cols = sql
          .exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', 'pantry')
          .toArray()
          .map((r) => r.name);
        const have = new Set(cols);
        if (!have.has('location')) {
          sql.exec("ALTER TABLE pantry ADD COLUMN location TEXT DEFAULT 'shelf'");
        }
        if (!have.has('qty_value')) {
          sql.exec('ALTER TABLE pantry ADD COLUMN qty_value REAL');
        }
        if (!have.has('qty_unit')) {
          sql.exec('ALTER TABLE pantry ADD COLUMN qty_unit TEXT');
        }
      },
    },
    {
      // Index for unbounded conversation table + the prune helper that runs hourly.
      version: 3,
      up: (sql) => {
        sql.exec(
          'CREATE INDEX IF NOT EXISTS idx_conversation_week ON conversation(week_of, id DESC)'
        );
      },
    },
    {
      // /relay/message rate-limit hits. Schema lives in runtime/relay-rate-limit
      // so other bots can adopt the same table by calling ensureRelayRateSchema.
      version: 4,
      up: (sql) => ensureRelayRateSchema(sql),
    },
    {
      // Per-turn usage rows shared with FinanceDO via runtime/usage.
      // Used to render the cost footer on every Discord-bound reply.
      version: 5,
      up: (sql) => ensureUsageSchema(sql),
    },
  ];

  private initSchema(): void {
    runMigrations(this.sql, KitchenDO.MIGRATIONS);
  }

  getWeek(weekOf: string): WeekRow | null {
    const rows = this.sql.exec<WeekRow>('SELECT * FROM weeks WHERE week_of = ?', weekOf).toArray();
    return rows[0] ?? null;
  }

  /**
   * Read the grocery list and post it into the reply thread. groceryEmbeds
   * returns one embed when it fits and falls back to multiple for very large
   * lists; Discord allows up to 10 embeds per message.
   */
  private async handleGroceryRead(replyChannelId: string): Promise<void> {
    const week = findActiveWeek(this.sql);
    if (!week) {
      await this.discord.postMessage(replyChannelId, {
        embeds: [statusEmbed({
          title: '🛒 No grocery list',
          description: 'No plan in the last 14 days.',
          color: EmbedColor.archived,
        })],
      });
      return;
    }

    const row = this.sql
      .exec<{ items_json: string }>('SELECT items_json FROM grocery_lists WHERE week_of = ?', week.week_of)
      .toArray()[0];
    if (!row) {
      await this.discord.postMessage(replyChannelId, {
        embeds: [statusEmbed({
          title: '🛒 No grocery list',
          description: `No grocery list yet for **${week.week_of}**. Use \`/approve\` to lock the plan and generate one.`,
          color: EmbedColor.archived,
        })],
      });
      return;
    }

    const items = JSON.parse(row.items_json) as { item: string; qty: string; category: 'produce' | 'protein' | 'dairy' | 'pantry' | 'frozen' | 'other' }[];
    const embeds = groceryEmbeds(items, week.week_of);
    for (let i = 0; i < embeds.length; i += 10) {
      await this.discord.postMessage(replyChannelId, { embeds: embeds.slice(i, i + 10) });
    }
  }

  // System-prompt + recent-meals loaders moved to ./agent/context.ts so the
  // in-process agent and the SteerWorkflow share one source of truth.

  /**
   * Used by the approve workflow after meals are materialized. The model
   * populates `requires_defrost` per recipe during materialization, so we
   * just schedule a reminder per entry — no keyword matching, no defaults.
   */
  scheduleDefrostRemindersFromMeals(weekOf: string, meals: any[]): number {
    this.sql.exec(
      "DELETE FROM reminders WHERE week_of = ? AND type = 'defrost' AND sent_at IS NULL",
      weekOf
    );

    const dayLabel: Record<string, string> = {
      mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
      thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
    };

    let count = 0;
    for (const meal of meals) {
      if (meal.status === 'skipped' || meal.status === 'cooked') continue;
      const defrostEntries: { item: string; hours: number }[] = meal.requires_defrost ?? [];
      if (defrostEntries.length === 0) continue;
      const cookTime = mealCookTime(weekOf, meal.day, 18, this.env.TIMEZONE);
      for (const entry of defrostEntries) {
        const hours = Number.isFinite(entry.hours) && entry.hours > 0 ? entry.hours : 12;
        const dueAt = cookTime - hours * 3_600_000;
        if (dueAt < Date.now()) continue;
        const message = `🧊 **Defrost reminder**: pull the ${entry.item} out of the freezer for ${dayLabel[meal.day] ?? meal.day}'s ${meal.name}.`;
        this.sql.exec(
          'INSERT INTO reminders (due_at, type, week_of, day, message) VALUES (?, ?, ?, ?, ?)',
          dueAt, 'defrost', weekOf, meal.day, message
        );
        count++;
      }
    }
    return count;
  }

  /**
   * Periodically prune the conversation table so it can't grow unbounded.
   * Keeps the most recent CONVERSATION_PRUNE_PER_WEEK rows per week_of.
   * Triggered by the hourly heartbeat; rate-limited so we don't burn every
   * heartbeat on it.
   */
  private maybePruneConversation(): void {
    // Per-week prune via shared helper. Bound parameter (not template
    // interpolation) so configurability is safe even if the constant
    // later moves into settings.
    this.lastConversationPruneAt = maybePruneConversationByWeek(
      (sql, ...params) => this.sql.exec(sql, ...params),
      this.lastConversationPruneAt,
      CONVERSATION_PRUNE_PER_WEEK,
    );
  }
}

export interface WeekRow {
  week_of: string;
  status: 'draft' | 'approved' | 'in_progress' | 'archived';
  meals_json: string;
  constraints_json: string;
  drafted_at: number;
  approved_at: number | null;
  [key: string]: SqlStorageValue;
}

export interface ReminderRow {
  id: number;
  due_at: number;
  type: string;
  week_of: string | null;
  day: string | null;
  message: string;
  sent_at: number | null;
  [key: string]: SqlStorageValue;
}

