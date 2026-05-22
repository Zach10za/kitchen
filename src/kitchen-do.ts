import type { Env } from './env';
import type { Interaction } from './discord/types';
import { EmbedColor } from './discord/types';
import { runAgent, runDraftFlow, runPantryFlow } from './agent/loop';
import { findActiveWeek } from './agent/context';
import { planEmbed, groceryEmbeds, statusEmbed } from './agent/render';
import {
  currentOrNextMondayISO, nextMondayISO, nextDraftTime, mealCookTime,
} from './util/datetime';
import { captureError } from './error-triage';
import { recordUsage, costFooter } from './runtime/usage';
import { AgentDOBase } from './runtime/agent-do-base';
import { KITCHEN_SPEC } from './kitchen/spec';

/**
 * KitchenDO holds all household state. Universal chat IO lives in
 * `AgentDOBase`; kitchen-only concerns here are:
 *
 *  - Weekly draft alarm (`alarm()` + `armNextDraft()` + `ensureAlarmSet()`)
 *  - Defrost/prep reminder scheduling + dispatch
 *  - Approve-workflow IO (`/workflow/load-draft`, `/workflow/save-approved`, …)
 *  - Grocery-list IO (admin + slash-command paths)
 *  - In-process `/draft` and `/pantry message: …` flows that bypass the chat
 *    workflow because they don't need conversation history
 *
 * The /chat slash command (formerly /steer) routes through the unified
 * AgentChatWorkflow via `dispatchChatInteraction`.
 */
export class KitchenDO extends AgentDOBase<Env> {
  protected readonly spec = KITCHEN_SPEC;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
  }

  protected async onHeartbeat(): Promise<void> {
    await this.ensureAlarmSet();
    await this.dispatchDueReminders();
  }

  protected async onReset(): Promise<void> {
    // Base already dropped user data; re-arm the weekly draft alarm so it
    // isn't lost with the reset.
    await this.ctx.storage.deleteAlarm();
    await this.armNextDraft();
  }

  protected async handleCustomRoute(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/ensure-alarm') {
      await this.ensureAlarmSet();
      return new Response('ok');
    }

    if (url.pathname === '/get-grocery') {
      const weekOf = url.searchParams.get('week_of');
      if (!weekOf) return new Response('missing week_of', { status: 400 });
      const row = this.sql.exec<{ items_json: string }>(
        'SELECT items_json FROM grocery_lists WHERE week_of = ?', weekOf,
      ).toArray()[0];
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

    // ─── ApproveWorkflow IO ────────────────────────────────────────────

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
      // retries don't clobber the timestamp. Always update meals_json (it's
      // the materialized form which the workflow guarantees is correct).
      this.sql.exec(
        "UPDATE weeks SET meals_json = ? WHERE week_of = ?",
        JSON.stringify(body.meals), body.week_of,
      );
      this.sql.exec(
        "UPDATE weeks SET status = 'approved', approved_at = ? WHERE week_of = ? AND status != 'approved'",
        Date.now(), body.week_of,
      );
      const reminders = this.scheduleDefrostRemindersFromMeals(body.week_of, body.meals);
      return Response.json({ remindersScheduled: reminders });
    }

    if (url.pathname === '/workflow/save-grocery' && request.method === 'POST') {
      const body = (await request.json()) as { week_of: string; items: any[] };
      this.sql.exec(
        'INSERT INTO grocery_lists (week_of, items_json, generated_at) VALUES (?, ?, ?) ON CONFLICT(week_of) DO UPDATE SET items_json=excluded.items_json, generated_at=excluded.generated_at',
        body.week_of, JSON.stringify(body.items), Date.now(),
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === '/workflow/has-grocery') {
      const weekOf = url.searchParams.get('week_of');
      if (!weekOf) return Response.json({ exists: false });
      const row = this.sql.exec('SELECT 1 FROM grocery_lists WHERE week_of = ? LIMIT 1', weekOf).toArray()[0];
      return Response.json({ exists: !!row });
    }

    return null;
  }

  protected async dispatchCommand(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value]),
    );

    // Read-only commands are short-circuited via /fast-read in the Worker; by
    // this point we're on an agent path.

    if (commandName === 'approve') {
      const week = findActiveWeek(this.sql);
      if (!week) {
        await this.discord.editOriginal(
          interaction.token,
          'No plan in the last 14 days. Use `/draft` to create one first.',
        );
        return;
      }
      const replyChannelId = await this.openReplyThread(
        interaction, `approve plan ${week.week_of}`,
      );
      // Post the kickoff line BEFORE creating the workflow so it can't get
      // interleaved with the workflow's own first-step post.
      await this.discord.postMessage(
        replyChannelId, `🚀 Approval workflow started for **${week.week_of}**…`,
      );
      await this.env.APPROVE_WORKFLOW.create({
        params: { weekOf: week.week_of, replyChannelId },
      });
      return;
    }

    // /pantry with a message — single LLM extraction call instead of the full
    // chat loop. ~1-2s vs ~5-10s.
    if (commandName === 'pantry' && optionMap.message) {
      const replyChannelId = await this.openReplyThread(
        interaction, `pantry: ${optionMap.message}`,
      );
      await runPantryFlow({
        env: this.env, sql: this.sql, discord: this.discord, replyChannelId,
        userMessage: String(optionMap.message),
      });
      return;
    }

    // /grocery — reads from SQL but uses multiple thread messages when the
    // list exceeds Discord's 10-embed-per-message limit.
    if (commandName === 'grocery') {
      const replyChannelId = await this.openReplyThread(interaction, 'grocery list');
      await this.handleGroceryRead(replyChannelId);
      return;
    }

    // /draft — bypass the chat loop for plan generation since it routinely
    // exceeds the chat budget on slow LLM responses.
    if (commandName === 'draft') {
      const weekOfNext = nextMondayISO(this.env.TIMEZONE);
      const seed = optionMap.notes
        ? `draft ${weekOfNext}: ${optionMap.notes}`
        : `draft ${weekOfNext}`;
      const replyChannelId = await this.openReplyThread(interaction, seed);
      await runDraftFlow({
        env: this.env, sql: this.sql, discord: this.discord, replyChannelId,
        weekOf: weekOfNext, notes: optionMap.notes ? String(optionMap.notes) : undefined,
      });
      return;
    }

    // Same "active week" picker used by /chat, /plan, and /approve — so
    // conversation rows and tool effects from /now, /pantry, /profile land on
    // the same week_of. Otherwise on Thursdays the agent would write to next-
    // Monday's week while /chat wrote to this-Monday's.
    const activeWeek = findActiveWeek(this.sql);
    const weekOf = activeWeek?.week_of ?? currentOrNextMondayISO(this.env.TIMEZONE);

    // /chat — routes through the unified AgentChatWorkflow. Conversation
    // scope is the active week so the agent sees history relevant to the
    // currently-active plan.
    if (commandName === 'chat') {
      const userMsg = String(optionMap.message ?? '').trim();
      if (!userMsg) {
        await this.discord.editOriginal(
          interaction.token,
          'Provide a message: `/chat message: <what you want to change>`',
        );
        return;
      }
      await this.dispatchChatInteraction(
        interaction, userMsg, userMsg,
        { column: 'week_of', value: weekOf },
      );
      return;
    }

    // Remaining commands run the in-process agent so they can emit their
    // formatted reply directly (no thread footer, no cost line in the workflow
    // shape). The Worker's fast-read path already short-circuited the read-
    // only variants — only /now, /pantry (write), /profile (write) reach
    // this switch.
    let userMessage: string;
    let titleSeed: string;
    switch (commandName) {
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
        userMessage = `The user is updating their cooking profile. Their input, VERBATIM:\n\n"""\n${optionMap.message}\n"""\n\nCall update_profile. Preserve every detail and the user's wording. If a profile already exists, merge intelligently — never drop information. Organize into clear Markdown sections (## Equipment, ## Dietary, ## Cuisines, ## Style, ## Time, etc.). Do not paraphrase or summarize.`;
        titleSeed = `profile: ${optionMap.message}`;
        break;
      default:
        userMessage = `Unknown command: ${commandName}`;
        titleSeed = `/${commandName}`;
    }

    const replyChannelId = await this.openReplyThread(interaction, titleSeed);
    const result = await runAgent({
      env: this.env, sql: this.sql, userMessage, weekOf,
    });
    const threadTotal = recordUsage(this.sql, {
      thread_id: replyChannelId,
      model: this.env.OPENAI_MODEL,
      ...result.usage,
    });
    const summary = result.summary || '(no response)';
    await this.discord.postMessage(
      replyChannelId, summary + costFooter(result.usage, threadTotal, this.env),
    );
  }

  protected async customDump(): Promise<Record<string, unknown>> {
    const weeks = this.sql.exec('SELECT week_of, status, drafted_at, approved_at, length(meals_json) as meals_size, substr(meals_json, 1, 200) as meals_preview FROM weeks ORDER BY drafted_at DESC').toArray();
    const pantry = this.sql.exec('SELECT * FROM pantry ORDER BY added_at DESC').toArray();
    const prefs = this.sql.exec('SELECT id, insight, weight, learned_at FROM preferences ORDER BY weight DESC, learned_at DESC').toArray();
    const reminders = this.sql.exec('SELECT id, due_at, type, week_of, day, sent_at, message FROM reminders ORDER BY due_at DESC').toArray();
    const settings = this.sql.exec("SELECT key, length(value) as len, substr(value, 1, 500) as preview, updated_at FROM settings").toArray();
    const recentConv = this.sql.exec('SELECT id, week_of, role, ts, substr(content, 1, 200) as preview FROM conversation ORDER BY id DESC LIMIT 30').toArray();
    const groceryLists = this.sql.exec('SELECT week_of, length(items_json) as size, substr(items_json, 1, 500) as preview, generated_at FROM grocery_lists').toArray();
    const alarm = await this.ctx.storage.getAlarm();
    return {
      alarm_at: alarm,
      alarm_iso: alarm ? new Date(alarm).toISOString() : null,
      weeks, pantry, prefs, reminders, settings,
      recent_conversation: recentConv,
      grocery_lists: groceryLists,
    };
  }

  // ─── Kitchen-only API surface ──────────────────────────────────────────

  async alarm(): Promise<void> {
    try {
      const weekOf = nextMondayISO(this.env.TIMEZONE);
      const result = await runAgent({
        env: this.env, sql: this.sql,
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
    } catch (err) {
      // Don't let a thrown alarm cancel the next one — captureError + rearm.
      console.error('kitchen alarm failed', err);
      await captureError(this.env, err, { source: 'kitchen:alarm' });
    } finally {
      await this.armNextDraft();
    }
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
      this.env.TIMEZONE,
    );
    await this.ctx.storage.setAlarm(next.getTime());
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

    const items = JSON.parse(row.items_json) as {
      item: string; qty: string;
      category: 'produce' | 'protein' | 'dairy' | 'pantry' | 'frozen' | 'other';
    }[];
    const embeds = groceryEmbeds(items, week.week_of);
    for (let i = 0; i < embeds.length; i += 10) {
      await this.discord.postMessage(replyChannelId, { embeds: embeds.slice(i, i + 10) });
    }
  }

  /**
   * Send any reminders whose due_at has passed and that haven't been sent.
   * Called from the hourly cron heartbeat.
   */
  private async dispatchDueReminders(): Promise<void> {
    const now = Date.now();
    const due = this.sql.exec<ReminderRow>(
      'SELECT * FROM reminders WHERE sent_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 10',
      now,
    ).toArray();

    for (const reminder of due) {
      // Stamp sent_at BEFORE the network call so this is at-most-once. A
      // duplicate reminder every hour while Discord is down would be worse
      // than a single missed reminder; the user can always check /reminders
      // to see what's coming.
      this.sql.exec('UPDATE reminders SET sent_at = ? WHERE id = ?', now, reminder.id);
      try {
        const title = reminder.type === 'defrost'
          ? '🧊 Defrost reminder'
          : reminder.type === 'prep'
            ? '🥣 Prep reminder'
            : '⏰ Reminder';
        const body = reminder.message
          .replace(/^🧊\s*\*\*Defrost reminder\*\*:\s*/i, '')
          .replace(/^🥣\s*\*\*Prep reminder\*\*:\s*/i, '');
        await this.discord.postMessage(this.env.DISCORD_CHANNEL_ID, {
          embeds: [statusEmbed({
            title, description: body, color: EmbedColor.reminder,
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

  /**
   * Used by the approve workflow after meals are materialized. The model
   * populates `requires_defrost` per recipe during materialization, so we
   * just schedule a reminder per entry — no keyword matching, no defaults.
   */
  scheduleDefrostRemindersFromMeals(weekOf: string, meals: any[]): number {
    this.sql.exec(
      "DELETE FROM reminders WHERE week_of = ? AND type = 'defrost' AND sent_at IS NULL",
      weekOf,
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
          dueAt, 'defrost', weekOf, meal.day, message,
        );
        count++;
      }
    }
    return count;
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
