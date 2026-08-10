import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../env';
import { DiscordAPI } from '../discord/api';
import {
  MAX_TOOL_ROUNDS,
  runAgentRound,
  emptyUsage,
  addUsage,
  type RoundResult,
  type RoundUsage,
} from '../runtime/agent-round';
import { makeLLMClient } from '../runtime/llm';
import { computeCost, formatUsd } from '../runtime/pricing';
import { withTypingRefresh } from '../runtime/typing';
import type { AgentChatParams, ConversationScope } from '../runtime/bot-spec';
import { getStubFor } from '../runtime/bot-spec';
import { getBotSpec } from '../runtime/bot-registry';
import { captureError } from '../error-triage';

/**
 * Unified chat workflow used by every bot. Resolves its spec at run time from
 * `params.botId`, then drives the standard turn:
 *
 *   1. initial-typing       — instant feedback while load-context runs
 *   2. load-context         — system prompt + recent history from the DO
 *   3. save-user-turn       — persist the user message
 *   4. round-{N}            — one model call + tool execution, up to
 *                             MAX_TOOL_ROUNDS. Each round is its own step with
 *                             retries:0 — tool side effects make round-level
 *                             retries unsafe; the LLM client retries
 *                             network errors internally.
 *   5. record-usage         — best-effort; failure never blocks delivery
 *   6. post-final           — post into the Discord thread
 *   7. save-assistant       — persist the final reply text. Runs AFTER
 *                             post-final on purpose: if delivery throws, the
 *                             workflow aborts before the assistant turn is
 *                             persisted, so the next turn can't replay a
 *                             message the user never saw.
 *
 * Replaces the four bot-specific `*SteerWorkflow` classes. URL prefix moved
 * from `/workflow/<bot>/…` to the bot-agnostic `/workflow/agent/…` since each
 * DO is already its own namespace.
 */
export class AgentChatWorkflow extends WorkflowEntrypoint<Env, AgentChatParams> {
  async run(event: WorkflowEvent<AgentChatParams>, step: WorkflowStep) {
    const { botId, replyChannelId, userMessage, scope } = event.payload;
    const discord = new DiscordAPI(this.env.DISCORD_BOT_TOKEN, this.env.DISCORD_APP_ID);
    const stub = getStubFor(this.env, botId);

    await step.do('initial-typing', async () => {
      await discord.postTyping(replyChannelId).catch(() => {});
    });

    const ctx = await step.do('load-context', async () => {
      const qs = new URLSearchParams({ scope_column: scope.column, scope_value: scope.value });
      const res = await stub.fetch(`https://internal/workflow/agent/load-context?${qs.toString()}`);
      if (!res.ok) {
        throw new Error(`load-context: HTTP ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as {
        systemPrompt: string;
        history: { role: 'user' | 'assistant'; content: string }[];
      };
    });

    await step.do('save-user-turn', async () => {
      const res = await stub.fetch('https://internal/workflow/agent/save-turn', {
        method: 'POST',
        body: JSON.stringify({
          role: 'user',
          content: userMessage,
          scope_column: scope.column,
          scope_value: scope.value,
        }),
      });
      if (!res.ok) {
        throw new Error(`save-user-turn: HTTP ${res.status} ${await res.text()}`);
      }
    });

    let messages: any[] = [
      { role: 'system', content: ctx.systemPrompt },
      ...ctx.history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage },
    ];

    let finalText: string | null = null;
    let turnUsage: RoundUsage = emptyUsage();
    let roundsRun = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const inputMessages = messages;
      const result: RoundResult = await step.do(
        `round-${round}`,
        { retries: { limit: 0, delay: '1 second', backoff: 'constant' } },
        async () => withTypingRefresh(discord, replyChannelId, () =>
          this.runOneRound(botId, scope, inputMessages),
        ),
      );

      messages = result.newMessages;
      turnUsage = addUsage(turnUsage, result.usage);
      roundsRun = round + 1;
      if (result.type === 'final') {
        finalText = result.finalText ?? '(no text)';
        break;
      }
    }

    if (!finalText) {
      // Blew through MAX_TOOL_ROUNDS without a final assistant message. The
      // user still gets the fallback below, but capture so we can see which
      // bot is repeatedly getting stuck.
      await captureError(this.env, new Error('agent-chat: exceeded MAX_TOOL_ROUNDS'), {
        source: `${botId}-agent-chat:tool-loop`,
        tags: { bot_id: botId, rounds_run: roundsRun },
      });
      finalText = 'I got stuck in a tool loop. Try again with a simpler request.';
    }

    // record-usage is observability — never let it block delivery of the
    // user's reply. Falls back to {thread_total_usage: turnUsage} so the
    // footer still renders something sensible.
    const turnTotals = await step.do('record-usage', async () => {
      try {
        const res = await stub.fetch('https://internal/workflow/agent/record-usage', {
          method: 'POST',
          body: JSON.stringify({
            thread_id: replyChannelId,
            model: this.env.AGENT_MODEL,
            ...turnUsage,
          }),
        });
        if (!res.ok) return { thread_total_usage: turnUsage };
        return (await res.json()) as { thread_total_usage: RoundUsage };
      } catch {
        return { thread_total_usage: turnUsage };
      }
    });

    const turnCost = computeCost(turnUsage, this.env);
    const threadCost = computeCost(turnTotals.thread_total_usage, this.env);
    const footer = `\n\n_${formatUsd(turnCost.total_usd)} this turn · ${formatUsd(threadCost.total_usd)} thread total_`;
    const finalWithCost = finalText + footer;

    // Post BEFORE persisting the assistant turn. If Discord delivery throws,
    // the workflow aborts and the assistant turn is never saved — so the next
    // turn never sees a message the user didn't receive.
    await step.do('post-final', async () => {
      await discord.postTyping(replyChannelId).catch(() => {});
      await discord.postMessage(replyChannelId, finalWithCost);
    });

    await step.do('save-assistant', async () => {
      const res = await stub.fetch('https://internal/workflow/agent/save-turn', {
        method: 'POST',
        body: JSON.stringify({
          role: 'assistant',
          content: finalText,
          scope_column: scope.column,
          scope_value: scope.value,
        }),
      });
      if (!res.ok) {
        throw new Error(`save-assistant: HTTP ${res.status} ${await res.text()}`);
      }
    });
  }

  private async runOneRound(
    botId: AgentChatParams['botId'],
    scope: ConversationScope,
    messages: any[],
  ): Promise<RoundResult> {
    const spec = getBotSpec(botId);
    const stub = getStubFor(this.env, botId);
    return runAgentRound({
      client: makeLLMClient(this.env),
      model: this.env.AGENT_MODEL,
      tools: spec.tools,
      messages,
      fillDefaultArgs: spec.fillDefaultArgs
        ? (toolName, parsed) => spec.fillDefaultArgs!(toolName, parsed, scope)
        : undefined,
      executeTool: async (name, args) => {
        const res = await stub.fetch('https://internal/workflow/agent/exec-tool', {
          method: 'POST',
          body: JSON.stringify({
            name,
            args,
            scope_column: scope.column,
            scope_value: scope.value,
          }),
        });
        if (!res.ok) {
          // Feed the failure back to the model as a string output rather than
          // throwing — keeps the round-N step alive so the user still gets a
          // reply (and we surface the error inside the conversation).
          return `[tool ${name} failed: HTTP ${res.status}]`;
        }
        const payload = (await res.json()) as { output: string; usage: RoundUsage | null };
        // Round runner accepts either string or {output, usage}. Returning the
        // structured form lets tool-internal LLM spend (kitchen's draft/swap)
        // fold into the round's reported usage.
        return payload.usage
          ? { output: payload.output, usage: payload.usage }
          : payload.output;
      },
      onToolCall: async ({ name, args, output }) => {
        // Best-effort: failing to persist a tool row shouldn't kill the round.
        await stub.fetch('https://internal/workflow/agent/save-turn', {
          method: 'POST',
          body: JSON.stringify({
            role: 'tool',
            content: output,
            tool_call_json: JSON.stringify({ name, args }),
            scope_column: scope.column,
            scope_value: scope.value,
          }),
        }).catch(() => {});
      },
    });
  }
}
