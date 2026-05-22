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
import { makeOpenAIClient } from '../runtime/openai';
import { computeCost, formatUsd } from '../runtime/pricing';
import { withTypingRefresh } from '../runtime/typing';
import type { AgentChatParams, ConversationScope } from '../runtime/bot-spec';
import { getBotSpec } from '../runtime/bot-registry';

/**
 * Unified chat workflow used by every bot. Resolves its spec at run time from
 * `params.botId`, then drives the standard turn:
 *
 *   1. initial-typing       — instant feedback while load-context runs
 *   2. load-context         — system prompt + recent history from the DO
 *   3. save-user-turn       — persist the user message
 *   4. round-{N}            — one OpenAI call + tool execution, up to
 *                             MAX_TOOL_ROUNDS. Each round is its own step with
 *                             retries:0 — tool side effects make round-level
 *                             retries unsafe; the OpenAI client retries
 *                             network errors internally.
 *   5. record-usage         — best-effort; failure never blocks delivery
 *   6. save-assistant       — persist the final reply text
 *   7. post-final           — post into the Discord thread; if delivery fails,
 *                             surface `[delivery_failed]` into the conversation
 *                             log so the next turn doesn't replay a phantom
 *                             assistant turn.
 *
 * Replaces the four bot-specific `*SteerWorkflow` classes. URL prefix moved
 * from `/workflow/<bot>/…` to the bot-agnostic `/workflow/agent/…` since each
 * DO is already its own namespace.
 */
export class AgentChatWorkflow extends WorkflowEntrypoint<Env, AgentChatParams> {
  async run(event: WorkflowEvent<AgentChatParams>, step: WorkflowStep) {
    const { botId, replyChannelId, userMessage, scope } = event.payload;
    const discord = new DiscordAPI(this.env.DISCORD_BOT_TOKEN, this.env.DISCORD_APP_ID);
    const stub = stubFor(this.env, botId);

    await step.do('initial-typing', async () => {
      await discord.postTyping(replyChannelId).catch(() => {});
    });

    const ctx = await step.do('load-context', async () => {
      const qs = new URLSearchParams({ scope_column: scope.column, scope_value: scope.value });
      const res = await stub.fetch(`https://internal/workflow/agent/load-context?${qs.toString()}`);
      return (await res.json()) as {
        systemPrompt: string;
        history: { role: 'user' | 'assistant'; content: string }[];
      };
    });

    await step.do('save-user-turn', async () => {
      await stub.fetch('https://internal/workflow/agent/save-turn', {
        method: 'POST',
        body: JSON.stringify({
          role: 'user',
          content: userMessage,
          scope_column: scope.column,
          scope_value: scope.value,
        }),
      });
    });

    let messages: any[] = [
      { role: 'system', content: ctx.systemPrompt },
      ...ctx.history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage },
    ];

    let finalText: string | null = null;
    let turnUsage: RoundUsage = emptyUsage();

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
      if (result.type === 'final') {
        finalText = result.finalText ?? '(no text)';
        break;
      }
    }

    if (!finalText) {
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
            model: this.env.OPENAI_MODEL,
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

    await step.do('save-assistant', async () => {
      await discord.postTyping(replyChannelId).catch(() => {});
      await stub.fetch('https://internal/workflow/agent/save-turn', {
        method: 'POST',
        body: JSON.stringify({
          role: 'assistant',
          content: finalText,
          scope_column: scope.column,
          scope_value: scope.value,
        }),
      });
    });

    await step.do('post-final', async () => {
      await discord.postTyping(replyChannelId).catch(() => {});
      try {
        await discord.postMessage(replyChannelId, finalWithCost);
      } catch (err) {
        // Last-resort: if the reply truly cannot land, surface that into the
        // conversation log so the next turn can see "delivery_failed" instead
        // of replaying a phantom assistant turn.
        await stub.fetch('https://internal/workflow/agent/save-turn', {
          method: 'POST',
          body: JSON.stringify({
            role: 'system',
            content: `[delivery_failed] ${(err as Error).message}`,
            scope_column: scope.column,
            scope_value: scope.value,
          }),
        }).catch(() => {});
        throw err;
      }
    });
  }

  private async runOneRound(
    botId: AgentChatParams['botId'],
    scope: ConversationScope,
    messages: any[],
  ): Promise<RoundResult> {
    const spec = getBotSpec(botId);
    const stub = stubFor(this.env, botId);
    return runAgentRound({
      client: makeOpenAIClient(this.env),
      model: this.env.OPENAI_MODEL,
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
        const payload = (await res.json()) as { output: string; usage: RoundUsage | null };
        // Round runner accepts either string or {output, usage}. Returning the
        // structured form lets tool-internal LLM spend (kitchen's draft/swap)
        // fold into the round's reported usage.
        return payload.usage
          ? { output: payload.output, usage: payload.usage }
          : payload.output;
      },
      onToolCall: async ({ name, args, output }) => {
        await stub.fetch('https://internal/workflow/agent/save-turn', {
          method: 'POST',
          body: JSON.stringify({
            role: 'tool',
            content: output,
            tool_call_json: JSON.stringify({ name, args }),
            scope_column: scope.column,
            scope_value: scope.value,
          }),
        });
      },
    });
  }
}

function stubFor(env: Env, botId: AgentChatParams['botId']): DurableObjectStub {
  const ns =
    botId === 'kitchen' ? env.KITCHEN
    : botId === 'finance' ? env.FINANCE
    : botId === 'tasks' ? env.TASKS
    : env.WORKOUT;
  return ns.get(ns.idFromName('default-household'));
}
