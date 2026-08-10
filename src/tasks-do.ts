import type { Env } from './env';
import type { Interaction } from './discord/types';
import { AgentDOBase } from './runtime/agent-do-base';
import { dispatchChat } from './runtime/bot-registry';
import { captureError } from './error-triage';
import { nextDailyTime } from './util/datetime';
import { TASKS_SPEC } from './tasks/spec';
import { buildTaskStats, buildProjectsSnapshot, dueNudgeTasks } from './tasks/loop';
import { projectsNudgeEmbed } from './tasks/render';

/** Per-message attachment cap and per-file size cap for /files/ingest. */
const MAX_FILES_PER_MESSAGE = 5;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Hosts Discord serves user attachments from. Exact, lowercased hostname
 *  match — never endsWith/includes, which `evil.cdn.discordapp.com.x.dev`
 *  style hosts can defeat. */
const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function isDiscordCdnUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && DISCORD_CDN_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Keep filenames safe for R2 keys and Discord re-upload: basename only,
 *  printable subset, bounded length. */
function sanitizeFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? 'file';
  const clean = base.replace(/[^\w.\- ()]/g, '_').trim();
  return (clean || 'file').slice(0, 120);
}

/**
 * TasksDO holds the projects bot's state (the internal id stays 'tasks' —
 * the DO binding, channel env key, and admin ?bot= names are wired to it).
 * Universal chat IO lives in `AgentDOBase`; projects-only concerns here are:
 *
 *  - Daily review alarm: Mondays post an LLM-composed project review; other
 *    days post a deterministic due-check embed only when something is due
 *    today or just went overdue (quiet otherwise).
 *  - Slash-command dispatch and a richer /dump.
 */
export class TasksDO extends AgentDOBase<Env> {
  protected getSpec() { return TASKS_SPEC; }

  protected async onHeartbeat(): Promise<void> {
    await this.ensureAlarmSet();
  }

  protected async onReset(): Promise<void> {
    // Base already dropped user data; re-arm the daily alarm so it isn't lost.
    await this.ctx.storage.deleteAlarm();
    await this.armNextReview();
  }

  /**
   * /files/ingest — called by the Worker's /relay/message handler when a
   * forwarded Discord message carries attachments. Downloads each file from
   * the Discord CDN (those URLs expire — R2 is the durable home), stores the
   * bytes, and indexes a row with project_id NULL (the inbox). The agent
   * files it to a project via attach_file based on the message's caption.
   */
  protected async handleCustomRoute(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/files/ingest' && request.method === 'POST') {
      const body = (await request.json()) as {
        attachments?: Array<{ url: string; filename: string; content_type?: string | null; size?: number }>;
      };
      const saved: Array<{ id: string; filename: string; size: number }> = [];
      const skipped: string[] = [];

      for (const att of (body.attachments ?? []).slice(0, MAX_FILES_PER_MESSAGE)) {
        if (!att?.url || !att.filename) continue;
        // SSRF guard: only fetch Discord's CDN. The relay is authenticated,
        // but a leaked relay secret must not turn this DO into an
        // arbitrary-URL fetcher. redirect:'manual' below keeps a 3xx from
        // re-introducing an arbitrary host.
        if (!isDiscordCdnUrl(att.url)) {
          skipped.push(`${att.filename} (unexpected attachment host)`);
          continue;
        }
        const filename = sanitizeFilename(att.filename);
        if ((att.size ?? 0) > MAX_FILE_BYTES) {
          skipped.push(`${filename} (over the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit)`);
          continue;
        }
        try {
          const res = await fetch(att.url, { redirect: 'manual' });
          if (!res.ok || !res.body) {
            skipped.push(`${filename} (download failed: ${res.status})`);
            continue;
          }
          const id = `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          const key = `projects/${id}/${filename}`;
          await this.env.FILES.put(key, res.body, {
            httpMetadata: att.content_type ? { contentType: att.content_type } : undefined,
          });
          this.sql.exec(
            'INSERT INTO project_files (id, project_id, filename, r2_key, content_type, size, note, created_at) VALUES (?, NULL, ?, ?, ?, ?, NULL, ?)',
            id, filename, key, att.content_type ?? null, att.size ?? null, Date.now(),
          );
          saved.push({ id, filename, size: att.size ?? 0 });
        } catch (err) {
          console.error('file ingest failed', { filename, err });
          skipped.push(`${filename} (error storing)`);
        }
      }
      return Response.json({ files: saved, skipped });
    }
    return null;
  }

  protected async dispatchCommand(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value]),
    );

    // /projects with a message → AgentChatWorkflow. Bare /projects short-
    // circuits through the Worker fast-read path before this handler runs.
    if (commandName === 'projects' && optionMap.message) {
      const message = String(optionMap.message);
      await this.dispatchChatInteraction(interaction, message, `projects: ${message}`);
      return;
    }

    // /supplies with a message → agent ("got the pvc", "the sprinkler project
    // needs 7 heads"). Bare /supplies is a fast read.
    if (commandName === 'supplies' && optionMap.message) {
      const message = String(optionMap.message);
      await this.dispatchChatInteraction(
        interaction,
        `Supplies update: ${message}`,
        `supplies: ${message}`,
      );
      return;
    }

    await this.discord.editOriginal(
      interaction.token,
      `Unknown projects command: \`${commandName}\``,
    );
  }

  protected async customDump(): Promise<Record<string, unknown>> {
    const stats = buildTaskStats(this.sql);
    const snapshot = buildProjectsSnapshot(this.sql);
    const recentTasks = this.sql.exec('SELECT id, title, status, type, priority, parent_id, due_at, updated_at, length(plan) AS plan_len FROM tasks ORDER BY updated_at DESC LIMIT 30').toArray();
    const deps = this.sql.exec('SELECT * FROM task_deps').toArray();
    const supplies = this.sql.exec('SELECT * FROM supplies ORDER BY status, created_at DESC LIMIT 50').toArray();
    const recentConv = this.sql.exec(
      'SELECT id, role, ts, substr(content, 1, 200) AS preview FROM conversation ORDER BY id DESC LIMIT 30',
    ).toArray();
    const alarm = await this.ctx.storage.getAlarm();
    return {
      alarm_at: alarm,
      alarm_iso: alarm ? new Date(alarm).toISOString() : null,
      stats: {
        total: stats.total,
        by_status: stats.byStatus,
        by_priority: stats.byPriority,
        overdue_count: stats.overdueTasks.length,
        ready_count: stats.readyTasks.length,
        blocked_count: stats.blockedTasks.length,
        in_progress_count: stats.inProgressTasks.length,
      },
      projects: snapshot.projects.map((p) => ({
        id: p.project.id,
        title: p.project.title,
        status: p.project.status,
        steps_done: p.doneSteps,
        steps_total: p.totalSteps,
        stale: p.stale,
        last_activity_iso: new Date(p.lastActivity).toISOString(),
      })),
      loose_tasks: snapshot.loose,
      overdue: stats.overdueTasks,
      recent_tasks: recentTasks,
      deps,
      supplies,
      recent_conversation: recentConv,
    };
  }

  // ─── Proactive surface ─────────────────────────────────────────────────

  /**
   * Daily alarm at PROJECTS_REVIEW_HOUR_LOCAL. Mondays get the full weekly
   * review (LLM-composed via the chat workflow); every other day posts a
   * due-check embed only if something is due today or became overdue in the
   * last 24h — silence is the default. Always re-arms for tomorrow.
   */
  async alarm(): Promise<void> {
    try {
      const weekday = new Date().toLocaleDateString('en-US', {
        timeZone: this.env.TIMEZONE,
        weekday: 'short',
      });
      if (weekday === 'Mon') {
        await this.postWeeklyReview();
      } else {
        await this.postDueNudge();
      }
    } catch (err) {
      // Don't let a thrown alarm cancel the next one — captureError + rearm.
      console.error('projects alarm failed', err);
      await captureError(this.env, err, { source: 'tasks:alarm' });
    } finally {
      await this.armNextReview();
    }
  }

  private async postWeeklyReview(): Promise<void> {
    const { projects, loose } = buildProjectsSnapshot(this.sql);
    if (projects.length === 0 && loose.length === 0) return; // nothing to review
    await dispatchChat(
      this.env,
      'tasks',
      "It's the Monday morning project review. Call show_projects first, then write a short review of where things stand: for each active project, progress and the single next action to knock out this week. Flag anything overdue or due this week, and any project whose next step is blocked on unbought supplies (suggest one combined store run if several projects need things). For projects stale 2+ weeks, ask whether they're still happening or the next step should be split smaller. If a project's steps are all done, ask to close it. End with a one-line 'if you only do one thing this week' pick. Keep it tight — this is a nudge, not a report.",
      this.env.DISCORD_TASKS_CHANNEL_ID,
      { column: 'thread_id', value: this.env.DISCORD_TASKS_CHANNEL_ID },
    );
  }

  private async postDueNudge(): Promise<void> {
    const { newlyOverdue, dueToday } = dueNudgeTasks(this.sql);
    if (newlyOverdue.length === 0 && dueToday.length === 0) return; // stay quiet
    await this.discord.postMessage(this.env.DISCORD_TASKS_CHANNEL_ID, {
      embeds: [projectsNudgeEmbed(newlyOverdue, dueToday)],
    });
  }

  async ensureAlarmSet(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.armNextReview();
    }
  }

  private async armNextReview(): Promise<void> {
    const hour = Number(this.env.PROJECTS_REVIEW_HOUR_LOCAL) || 9;
    const next = nextDailyTime(hour, this.env.TIMEZONE);
    await this.ctx.storage.setAlarm(next.getTime());
  }
}
