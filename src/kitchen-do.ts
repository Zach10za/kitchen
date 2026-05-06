import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { Interaction } from './discord/types';
import { DiscordAPI } from './discord/api';
import { runAgent, runDraftFlow, runPantryFlow, executeTool, type ToolCtx } from './agent/loop';
import { buildSystemPrompt } from './agent/prompts';
import { renderPlan } from './agent/render';
import { currentOrNextMondayISO, nextMondayISO, nextDraftTime, mealCookTime } from './util/datetime';
import { captureError } from './error-triage';
import OpenAI from 'openai';

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
            .followUp(interaction.token, `Something broke: ${(err as Error).message}`)
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
      return new Response('ok');
    }

    if (url.pathname === '/fast-read') {
      const interaction = (await request.json()) as Interaction;
      const text = this.handleFastRead(interaction);
      return new Response(text);
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
      const systemPrompt = this.buildSystemPromptForWorkflow(weekOf);
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
      const client = new OpenAI({
        apiKey: this.env.OPENAI_API_KEY,
        baseURL: this.env.AI_GATEWAY_URL || undefined,
        timeout: 25_000,
        maxRetries: 1,
      });
      const ctx: ToolCtx = { env: this.env, sql: this.sql, client };
      const result = await executeTool(body.name, body.args, ctx);
      return new Response(result, { headers: { 'content-type': 'text/plain' } });
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
   * Synchronous read-only command handler. Returns rendered Markdown directly.
   * Bypasses the agent — no LLM calls. Used for /profile, /plan, /pantry, /grocery
   * when called without modification arguments.
   */
  private handleFastRead(interaction: Interaction): string {
    const cmd = interaction.data?.name ?? '';
    const weekOf = currentOrNextMondayISO(this.env.TIMEZONE);

    if (cmd === 'profile') {
      const row = this.sql
        .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'cooking_profile'")
        .toArray()[0];
      return row?.value
        ? `**Cooking profile:**\n\n${row.value}`
        : 'No cooking profile set. Use `/profile message: ...` to create one.';
    }

    if (cmd === 'plan') {
      // Prefer the most recently drafted plan within the last 2 weeks.
      // This handles the common case: user drafted last Sat for "this week",
      // now they're mid-week reading the plan, week_of is in the past.
      const cutoff = Date.now() - 14 * 86_400_000;
      const week = this.sql
        .exec<WeekRow>(
          'SELECT * FROM weeks WHERE drafted_at >= ? ORDER BY drafted_at DESC LIMIT 1',
          cutoff
        )
        .toArray()[0];
      if (!week) return `No plan in the last 14 days. Use \`/steer message: make a plan\` to create one.`;
      const meals = JSON.parse(week.meals_json);
      if (meals.length === 0) return `Plan for ${week.week_of} is empty.`;
      const lines = meals.map((m: any) => {
        const noteSuffix = m.notes?.length > 0 ? `  _${m.notes.join('; ')}_` : '';
        const statusBadge = m.status === 'cooked' ? ' ✅' : m.status === 'skipped' ? ' ⏭️' : '';
        return `\`${m.day.toUpperCase()}\`${statusBadge}  **${m.name}**  _${m.cuisine}_  (${m.total_minutes}min, ${m.effort})${noteSuffix}\n     ${m.description}`;
      });
      return `**Plan for week of ${week.week_of}** _(status: ${week.status})_\n\n${lines.join('\n')}\n\nUse \`/steer\` to change anything${week.status === 'draft' ? ', `/approve` to lock it in' : ''}.`;
    }

    if (cmd === 'pantry') {
      const items = this.sql.exec<any>('SELECT * FROM pantry ORDER BY location, added_at DESC').toArray();
      if (items.length === 0) return 'Pantry is empty. Use `/pantry message: I have ...` to add items.';
      const grouped: Record<string, string[]> = {};
      for (const item of items) {
        const loc = item.location || 'shelf';
        const qty = item.qty_value != null ? ` (${item.qty_value}${item.qty_unit ? ' ' + item.qty_unit : ''})` : '';
        (grouped[loc] ??= []).push(`- ${item.name}${qty}`);
      }
      const sections = ['freezer', 'fridge', 'shelf']
        .filter((l) => grouped[l]?.length)
        .map((l) => `**${l.toUpperCase()}**\n${grouped[l]!.join('\n')}`);
      return sections.join('\n\n');
    }

    if (cmd === 'reminders') {
      const now = Date.now();
      const upcoming = this.sql.exec<ReminderRow>(
        'SELECT * FROM reminders WHERE sent_at IS NULL AND due_at >= ? ORDER BY due_at ASC LIMIT 25',
        now
      ).toArray();
      if (upcoming.length === 0) return 'No upcoming reminders.';

      const lines = upcoming.map((r) => {
        const dt = new Date(r.due_at);
        // Format: "Tue 6:00 PM" relative to today.
        const dayName = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: this.env.TIMEZONE });
        const time = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: this.env.TIMEZONE });
        const month = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: this.env.TIMEZONE });
        const icon = r.type === 'defrost' ? '🧊' : r.type === 'prep' ? '🥣' : '⏰';
        // Show first line only of message (it has Markdown formatting otherwise)
        const preview = r.message.split('\n')[0]!.replace(/\*\*/g, '').slice(0, 100);
        return `${icon} \`${dayName} ${month} ${time}\`  ${preview}`;
      });
      return `**Upcoming reminders:**\n\n${lines.join('\n')}`;
    }

    // /grocery is intentionally NOT a fast-read — its content typically
    // exceeds Discord's 2000-char limit so it goes through handleGroceryRead
    // which uses follow-up messages.

    return `Unknown fast-read command: ${cmd}`;
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
      try {
        await this.discord.postMessage(this.env.DISCORD_CHANNEL_ID, reminder.message);
        this.sql.exec('UPDATE reminders SET sent_at = ? WHERE id = ?', now, reminder.id);
      } catch (err) {
        console.error('reminder dispatch failed', { id: reminder.id, err });
        await captureError(this.env, err, {
          source: 'reminders:dispatch',
          tags: { reminder_id: reminder.id },
        });
        // Leave sent_at NULL so we retry on the next heartbeat.
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

      const plan = this.getWeek(weekOf);
      const message = plan
        ? `**Draft for week of ${weekOf}**\n\n${renderPlan(plan)}\n\n${result.summary}\n\nReply with /steer to change it, or /approve to lock it in.`
        : `Draft generation failed: ${result.summary}`;

      await this.discord.postMessage(this.env.DISCORD_CHANNEL_ID, message);
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
      const cutoff = Date.now() - 14 * 86_400_000;
      const week = this.sql
        .exec<WeekRow>(
          'SELECT * FROM weeks WHERE drafted_at >= ? ORDER BY drafted_at DESC LIMIT 1',
          cutoff
        )
        .toArray()[0];

      if (!week) {
        await this.discord.editOriginal(
          interaction.token,
          'No plan in the last 14 days. Use `/draft` to create one first.'
        );
        return;
      }

      await this.env.APPROVE_WORKFLOW.create({
        params: {
          weekOf: week.week_of,
          interactionToken: interaction.token,
        },
      });
      // Initial Discord ack — the workflow's first step will overwrite this.
      await this.discord.editOriginal(
        interaction.token,
        `🚀 Approval workflow started for **${week.week_of}**…`
      );
      return;
    }

    // Direct write path for /pantry with a message — single LLM extraction
    // call instead of full agent loop. ~1-2s vs ~5-10s.
    if (commandName === 'pantry' && optionMap.message) {
      await runPantryFlow({
        env: this.env,
        sql: this.sql,
        discord: this.discord,
        interactionToken: interaction.token,
        userMessage: String(optionMap.message),
      });
      return;
    }

    // /grocery direct path — reads from SQL but uses follow-up messages when
    // the list exceeds Discord's 2000-char-per-message limit (it usually does).
    if (commandName === 'grocery') {
      await this.handleGroceryRead(interaction.token);
      return;
    }

    // Direct write path for /draft — bypass agent for plan generation since
    // this routinely exceeds the agent's combined budget on slow LLM responses.
    if (commandName === 'draft') {
      await runDraftFlow({
        env: this.env,
        sql: this.sql,
        discord: this.discord,
        interactionToken: interaction.token,
        weekOf: nextMondayISO(this.env.TIMEZONE),
        notes: optionMap.notes ? String(optionMap.notes) : undefined,
      });
      return;
    }

    let userMessage: string;
    const weekOf = currentOrNextMondayISO(this.env.TIMEZONE);

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

      // Pick the active week (same as /plan + /approve) so they all agree.
      const cutoff = Date.now() - 14 * 86_400_000;
      const recent = this.sql
        .exec<WeekRow>(
          'SELECT * FROM weeks WHERE drafted_at >= ? ORDER BY drafted_at DESC LIMIT 1',
          cutoff
        )
        .toArray()[0];
      const targetWeek = recent?.week_of ?? weekOf;

      await this.env.STEER_WORKFLOW.create({
        params: {
          weekOf: targetWeek,
          interactionToken: interaction.token,
          userMessage: userMsg,
        },
      });
      await this.discord.editOriginal(interaction.token, '🤔 Working on it…');
      return;
    }

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
        break;
      }
      case 'pantry':
        userMessage = `Update the pantry: ${optionMap.message}`;
        break;
      case 'profile':
        // Verbatim user input wrapped in delimiters + explicit do-not-summarize directive.
        userMessage = `The user is updating their cooking profile. Their input, VERBATIM:\n\n"""\n${optionMap.message}\n"""\n\nCall update_profile. Preserve every detail and the user's wording. If a profile already exists, merge intelligently — never drop information. Organize into clear Markdown sections (## Equipment, ## Dietary, ## Cuisines, ## Style, ## Time, etc.). Do not paraphrase or summarize.`;
        break;
      default:
        userMessage = `Unknown command: ${commandName}`;
    }

    const result = await runAgent({
      env: this.env,
      sql: this.sql,
      userMessage,
      weekOf,
    });

    await this.discord.editOriginal(interaction.token, result.summary || '(no response)');
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

  private initSchema(): void {
    const ddl = `
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
    `;
    this.sql.exec(ddl);
    this.migratePantryColumns();
  }

  /**
   * Idempotently add freezer-tracking columns to pantry. SQLite has no
   * native "ADD COLUMN IF NOT EXISTS" so we introspect via pragma_table_info
   * and only ALTER when missing.
   */
  private migratePantryColumns(): void {
    const cols = this.sql
      .exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', 'pantry')
      .toArray()
      .map((r) => r.name);
    const have = new Set(cols);
    if (!have.has('location')) {
      this.sql.exec("ALTER TABLE pantry ADD COLUMN location TEXT DEFAULT 'shelf'");
    }
    if (!have.has('qty_value')) {
      this.sql.exec('ALTER TABLE pantry ADD COLUMN qty_value REAL');
    }
    if (!have.has('qty_unit')) {
      this.sql.exec('ALTER TABLE pantry ADD COLUMN qty_unit TEXT');
    }
  }

  getWeek(weekOf: string): WeekRow | null {
    const rows = this.sql.exec<WeekRow>('SELECT * FROM weeks WHERE week_of = ?', weekOf).toArray();
    return rows[0] ?? null;
  }

  /**
   * Read the grocery list and post it to Discord, splitting across multiple
   * messages if it exceeds Discord's 2000-char-per-message limit.
   */
  private async handleGroceryRead(interactionToken: string): Promise<void> {
    // Find the most-recent week (matches /plan and /approve targeting).
    const cutoff = Date.now() - 14 * 86_400_000;
    const week = this.sql
      .exec<WeekRow>(
        'SELECT * FROM weeks WHERE drafted_at >= ? ORDER BY drafted_at DESC LIMIT 1',
        cutoff
      )
      .toArray()[0];
    if (!week) {
      await this.discord.editOriginal(interactionToken, 'No plan in the last 14 days.');
      return;
    }

    const row = this.sql
      .exec<{ items_json: string }>('SELECT items_json FROM grocery_lists WHERE week_of = ?', week.week_of)
      .toArray()[0];
    if (!row) {
      await this.discord.editOriginal(
        interactionToken,
        `No grocery list yet for **${week.week_of}**. Use \`/approve\` to lock the plan and generate one.`
      );
      return;
    }

    const items = JSON.parse(row.items_json) as { item: string; qty: string; category: string }[];
    const grouped: Record<string, string[]> = {};
    for (const item of items) {
      (grouped[item.category] ??= []).push(`- [ ] ${item.qty} ${item.item}`);
    }
    const order = ['produce', 'protein', 'dairy', 'pantry', 'frozen', 'other'];
    const sections: string[] = [];
    for (const cat of order) {
      const list = grouped[cat];
      if (!list || list.length === 0) continue;
      sections.push(`**${cat.toUpperCase()}**\n${list.join('\n')}`);
    }

    const header = `🛒 **Grocery list for ${week.week_of}** _(${items.length} items)_\n\n`;
    const chunks = chunkSections(header, sections, 1900);

    // First chunk goes via editOriginal; rest as follow-ups.
    await this.discord.editOriginal(interactionToken, chunks[0]!);
    for (let i = 1; i < chunks.length; i++) {
      await this.discord.followUp(interactionToken, chunks[i]!);
    }
  }

  /**
   * Build the system prompt for the SteerWorkflow. Pulls all context from
   * SQLite directly; same format as runAgent's loadContext.
   */
  private buildSystemPromptForWorkflow(weekOf: string): string {
    const planRow = this.sql
      .exec<WeekRow>('SELECT * FROM weeks WHERE week_of = ?', weekOf)
      .toArray()[0];
    const plan = planRow
      ? {
          week_of: planRow.week_of,
          status: planRow.status,
          drafted_at: planRow.drafted_at,
          approved_at: planRow.approved_at,
          meals: JSON.parse(planRow.meals_json),
          constraints: JSON.parse(planRow.constraints_json),
        }
      : null;

    const preferences = this.sql
      .exec<any>('SELECT * FROM preferences ORDER BY weight DESC, learned_at DESC LIMIT 25')
      .toArray();
    const pantry = this.sql
      .exec<any>('SELECT * FROM pantry ORDER BY added_at DESC')
      .toArray();
    const recentMeals = this.loadRecentMealsForWorkflow(weekOf, 14);
    const profileRow = this.sql
      .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'cooking_profile'")
      .toArray()[0];

    return buildSystemPrompt({
      plan,
      preferences,
      pantry,
      recentMeals,
      profile: profileRow?.value ?? null,
    });
  }

  private loadRecentMealsForWorkflow(excludeWeekOf: string, daysBack: number) {
    const cutoff = Date.now() - daysBack * 86_400_000;
    const rows = this.sql.exec<WeekRow>(
      "SELECT * FROM weeks WHERE week_of != ? AND drafted_at >= ? AND status IN ('approved', 'in_progress') ORDER BY week_of DESC LIMIT 4",
      excludeWeekOf, cutoff
    ).toArray();
    const out: { weekOf: string; day: string; name: string; cuisine: string }[] = [];
    for (const row of rows) {
      const meals = JSON.parse(row.meals_json);
      for (const m of meals) {
        out.push({ weekOf: row.week_of, day: m.day, name: m.name, cuisine: m.cuisine });
      }
    }
    return out;
  }

  /** Used by the approve workflow after meals are materialized. */
  scheduleDefrostRemindersFromMeals(weekOf: string, meals: any[]): number {
    this.sql.exec(
      "DELETE FROM reminders WHERE week_of = ? AND type = 'defrost' AND sent_at IS NULL",
      weekOf
    );
    const freezer = this.sql
      .exec<{ name: string }>("SELECT name FROM pantry WHERE location = 'freezer'")
      .toArray();
    if (freezer.length === 0) return 0;

    const defrost: Record<string, number> = {
      chicken: 24, beef: 24, pork: 24, lamb: 36, salmon: 12, fish: 12,
      shrimp: 6, turkey: 48, roast: 48,
    };
    const pickHours = (n: string) => {
      const lower = n.toLowerCase();
      for (const [k, h] of Object.entries(defrost)) if (lower.includes(k)) return h;
      return 12;
    };

    const dayLabel: Record<string, string> = {
      mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
      thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
    };

    let count = 0;
    for (const meal of meals) {
      if (meal.status === 'skipped' || meal.status === 'cooked') continue;
      if (!meal.ingredients) continue;
      for (const ing of meal.ingredients) {
        const ingLower = (ing.item || '').toLowerCase();
        const match = freezer.find((f) => ingLower.includes(f.name) || f.name.includes(ingLower.split(' ').pop() ?? ''));
        if (!match) continue;
        // Cook time = 6 PM in user's local timezone on the meal's weekday.
        // Previously we anchored to UTC midnight which fired ~7h early in PT.
        const cookTime = mealCookTime(weekOf, meal.day, 18, this.env.TIMEZONE);
        const dueAt = cookTime - pickHours(match.name) * 3_600_000;
        if (dueAt < Date.now()) continue;
        const message = `🧊 **Defrost reminder**: pull the ${match.name} out of the freezer for ${dayLabel[meal.day] ?? meal.day}'s ${meal.name}.`;
        this.sql.exec(
          'INSERT INTO reminders (due_at, type, week_of, day, message) VALUES (?, ?, ?, ?, ?)',
          dueAt, 'defrost', weekOf, meal.day, message
        );
        count++;
      }
    }
    return count;
  }
}

export interface WeekRow {
  week_of: string;
  status: 'draft' | 'approved' | 'in_progress';
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

/**
 * Split header + sections into Discord-message-sized chunks. Sections aren't
 * split mid-line if avoidable; oversized sections fall back to line-by-line.
 */
function chunkSections(header: string, sections: string[], limit: number): string[] {
  const chunks: string[] = [];
  let current = header;
  for (const section of sections) {
    const candidate = current === header ? current + section : current + '\n\n' + section;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current.trim().length > 0 && current !== header) chunks.push(current);
    if (section.length <= limit) {
      current = section;
    } else {
      const lines = section.split('\n');
      let buf = '';
      for (const line of lines) {
        if ((buf + '\n' + line).length > limit) {
          chunks.push(buf);
          buf = line;
        } else {
          buf = buf ? buf + '\n' + line : line;
        }
      }
      if (buf) current = buf;
    }
  }
  if (current.trim().length > 0) chunks.push(current);
  return chunks;
}
