import type { Env } from './env';
import type { Interaction } from './discord/types';
import { EmbedColor } from './discord/types';
import { runPantryFlow } from './agent/loop';
import { loadDayDecision } from './agent/context';
import { statusEmbed } from './agent/render';
import { nextDailyTime, todayISO } from './util/datetime';
import { captureError } from './error-triage';
import { AgentDOBase } from './runtime/agent-do-base';
import { dispatchChat } from './runtime/bot-registry';
import { KITCHEN_SPEC } from './kitchen/spec';

/**
 * KitchenDO holds all household state. Universal chat IO lives in
 * `AgentDOBase`; kitchen-only concerns here are:
 *
 *  - Daily suggestion alarm (`alarm()` + `armNextSuggest()` + `ensureAlarmSet()`)
 *  - Defrost reminder scheduling (in agent/loop.ts) + dispatch (here)
 *  - The fast in-process `/pantry message: …` flow that bypasses the chat
 *    workflow because it doesn't need conversation history
 *
 * Everything else (/cook, /now, /profile, /chat) routes through the unified
 * AgentChatWorkflow via `dispatchChatInteraction`, exactly like the other bots.
 */
export class KitchenDO extends AgentDOBase<Env> {
  protected getSpec() { return KITCHEN_SPEC; }

  protected async onHeartbeat(): Promise<void> {
    await this.ensureAlarmSet();
    await this.dispatchDueReminders();
  }

  protected async onReset(): Promise<void> {
    // Base already dropped user data; re-arm the daily alarm so it isn't lost.
    await this.ctx.storage.deleteAlarm();
    await this.armNextSuggest();
  }

  protected async handleCustomRoute(_request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/ensure-alarm') {
      await this.ensureAlarmSet();
      return new Response('ok');
    }
    return null;
  }

  protected async dispatchCommand(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value]),
    );

    // Read-only commands (/pantry, /profile, /reminders with no message) are
    // short-circuited via /fast-read in the Worker; by here we're on a path
    // that mutates state or needs the LLM.

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

    // /chat needs a message; everything else routes through the chat workflow.
    if (commandName === 'chat' && !String(optionMap.message ?? '').trim()) {
      await this.discord.editOriginal(
        interaction.token,
        'Provide a message, e.g. /chat message: swap tonight for something lighter',
      );
      return;
    }

    const { userMessage, titleSeed } = this.seedFor(commandName, optionMap);
    await this.dispatchChatInteraction(interaction, userMessage, titleSeed);
  }

  /** Build the seed user message + thread title for a slash command. */
  private seedFor(
    commandName: string,
    optionMap: Record<string, unknown>,
  ): { userMessage: string; titleSeed: string } {
    const message = String(optionMap.message ?? '').trim();
    switch (commandName) {
      case 'cook':
        return {
          userMessage: message
            ? `What should I cook today? ${message}`
            : 'What should I cook today? Give me 2-3 options based on what I have.',
          titleSeed: message ? `cook: ${message}` : 'what to cook today',
        };
      case 'now': {
        const nowLocal = new Date().toLocaleString('en-US', {
          timeZone: this.env.TIMEZONE,
          weekday: 'long', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true,
        });
        return {
          userMessage: `Right now it is **${nowLocal}** (${this.env.TIMEZONE}). If I've already decided on a meal for today, tell me concretely what I should be doing in the kitchen right now (timing, next step). If I haven't decided yet, suggest 2-3 options for tonight based on what I have.`,
          titleSeed: 'what to cook now',
        };
      }
      case 'profile':
        return {
          userMessage: `The user is updating their cooking profile. Their input, VERBATIM:\n\n"""\n${message}\n"""\n\nCall update_profile. Preserve every detail and the user's wording. If a profile already exists, merge intelligently — never drop information. Organize into clear Markdown sections (## Equipment, ## Dietary, ## Cuisines, ## Style, ## Time, etc.). Do not paraphrase or summarize.`,
          titleSeed: `profile: ${message}`,
        };
      case 'chat':
        return { userMessage: message, titleSeed: message };
      default:
        return { userMessage: `Unknown command: ${commandName}`, titleSeed: `/${commandName}` };
    }
  }

  protected async customDump(): Promise<Record<string, unknown>> {
    const meals = this.sql.exec('SELECT id, date, name, cuisine, status, created_at FROM meals ORDER BY date DESC, id DESC LIMIT 30').toArray();
    const pantry = this.sql.exec('SELECT * FROM pantry ORDER BY added_at DESC').toArray();
    const prefs = this.sql.exec('SELECT id, insight, weight, learned_at FROM preferences ORDER BY weight DESC, learned_at DESC').toArray();
    const reminders = this.sql.exec('SELECT id, due_at, type, day, sent_at, message FROM reminders ORDER BY due_at DESC').toArray();
    const settings = this.sql.exec("SELECT key, length(value) as len, substr(value, 1, 500) as preview, updated_at FROM settings").toArray();
    const recentConv = this.sql.exec('SELECT id, thread_id, role, ts, substr(content, 1, 200) as preview FROM conversation ORDER BY id DESC LIMIT 30').toArray();
    const alarm = await this.ctx.storage.getAlarm();
    return {
      alarm_at: alarm,
      alarm_iso: alarm ? new Date(alarm).toISOString() : null,
      meals, pantry, prefs, reminders, settings,
      recent_conversation: recentConv,
    };
  }

  // ─── Kitchen-only API surface ──────────────────────────────────────────

  /**
   * Daily suggestion alarm. Fires at SUGGEST_HOUR_LOCAL. Posts 2-3 dinner
   * options into the channel — UNLESS the user has already decided today
   * (picked a meal or declared a no-cook night). Always re-arms for tomorrow.
   */
  async alarm(): Promise<void> {
    try {
      const decided = loadDayDecision(this.sql, todayISO(this.env.TIMEZONE));
      if (decided.length > 0) {
        // The user already settled tonight — stay quiet.
        return;
      }
      await dispatchChat(
        this.env,
        'kitchen',
        "It's the daily dinner check-in. Suggest 2-3 dinner options for tonight based on my pantry, freezer (prioritize items that are aging), preferences, and recent meals — vary it from what I've had lately. Add a short 'need to buy' line for anything missing. Keep it brief; I haven't decided yet.",
        this.env.DISCORD_CHANNEL_ID,
        { column: 'thread_id', value: this.env.DISCORD_CHANNEL_ID },
      );
    } catch (err) {
      // Don't let a thrown alarm cancel the next one — captureError + rearm.
      console.error('kitchen alarm failed', err);
      await captureError(this.env, err, { source: 'kitchen:alarm' });
    } finally {
      await this.armNextSuggest();
    }
  }

  async ensureAlarmSet(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.armNextSuggest();
    }
  }

  private async armNextSuggest(): Promise<void> {
    const hour = Number(this.env.SUGGEST_HOUR_LOCAL) || 12;
    const next = nextDailyTime(hour, this.env.TIMEZONE);
    await this.ctx.storage.setAlarm(next.getTime());
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
      // than a single missed reminder; the user can always check /reminders.
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
