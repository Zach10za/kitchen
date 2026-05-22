import type { Env } from './env';
import type { Interaction } from './discord/types';
import { runSync } from './finance/sync';
import { syncResultEmbed } from './finance/render';
import type { AccountRow, TransactionRow } from './finance/tools';
import { AgentDOBase } from './runtime/agent-do-base';
import { captureError } from './error-triage';
import { FINANCE_SPEC } from './finance/spec';

/**
 * FinanceDO holds all financial state for the user. Mirrors the structure of
 * the other agent DOs — the universal endpoints (chat IO, fast-read, reset,
 * heartbeat, rate-limit) live in `AgentDOBase`. Finance-only concerns here:
 *
 *  - Hourly heartbeat triggers a SimpleFin pull (`runScheduledSync`).
 *  - `/sync` admin endpoint forces an immediate pull.
 *  - `/dump` extends the base's payload with finance-specific snapshots.
 */
export class FinanceDO extends AgentDOBase<Env> {
  protected readonly spec = FINANCE_SPEC;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
  }

  protected async onHeartbeat(): Promise<void> {
    await this.runScheduledSync();
  }

  protected async handleCustomRoute(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/sync' && request.method === 'POST') {
      const result = await runSync(this.env, this.sql);
      return Response.json(result);
    }
    return null;
  }

  protected async dispatchCommand(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value]),
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

    // /finance with a message → AgentChatWorkflow. Bare /finance is short-
    // circuited by the Worker fast-read path before reaching this handler.
    if (commandName === 'finance' && optionMap.message) {
      const message = String(optionMap.message);
      await this.dispatchChatInteraction(interaction, message, `finance: ${message}`);
      return;
    }

    await this.discord.editOriginal(
      interaction.token,
      `Unknown finance command: \`${commandName}\``,
    );
  }

  protected async customDump(): Promise<Record<string, unknown>> {
    const accounts = this.sql.exec<AccountRow>('SELECT * FROM accounts').toArray();
    const txCount = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM transactions').toArray()[0]?.n ?? 0;
    const recentTx = this.sql.exec<TransactionRow>(
      'SELECT id, account_id, posted, amount, description, normalized_payee, pending FROM transactions ORDER BY posted DESC LIMIT 30',
    ).toArray();
    const recentConv = this.sql.exec(
      'SELECT id, role, ts, substr(content, 1, 200) AS preview FROM conversation ORDER BY id DESC LIMIT 30',
    ).toArray();
    const settings = this.sql.exec(
      'SELECT key, length(value) AS len, substr(value, 1, 200) AS preview, updated_at FROM settings',
    ).toArray();
    return {
      accounts,
      transaction_count: txCount,
      recent_transactions: recentTx,
      recent_conversation: recentConv,
      settings,
    };
  }

  /** Pull latest from SimpleFin. Called from /heartbeat (hourly cron) and the
   *  /sync admin endpoint. Errors are captured so a single bad sync doesn't
   *  kill the heartbeat (which also drives the conversation prune). */
  private async runScheduledSync(): Promise<void> {
    if (!this.env.SIMPLEFIN_ACCESS_URL) {
      // Don't error on every heartbeat in environments without the secret.
      return;
    }
    try {
      await runSync(this.env, this.sql);
    } catch (err) {
      console.error('finance scheduled sync failed', err);
      await captureError(this.env, err, { source: 'finance:scheduled-sync' });
    }
  }
}
