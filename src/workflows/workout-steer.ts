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
import { WORKOUT_TOOLS } from '../workout/tools';

interface WorkoutSteerParams {
  userMessage: string;
  replyChannelId: string;
}

/**
 * Durable workout agent flow. Same structure as TasksSteerWorkflow / FinanceSteerWorkflow
 * — IO endpoints under /workflow/workout/, tool list is WORKOUT_TOOLS.
 *
 * Steps:
 *   1. initial-typing  — show the typing indicator before doing anything slow
 *   2. load-context    — system prompt + recent history from WorkoutDO
 *   3. save-user-turn  — persist the user's message
 *   4. round-{N}       — one OpenAI call + any tool executions (up to MAX_TOOL_ROUNDS)
 *                        Each round has its own retry budget so slow LLM calls
 *                        don't take down the conversation.
 *   5. record-usage    — best-effort; failure does not block delivery
 *   6. save-assistant  — persist the final reply text
 *   7. post-final      — post the reply (with cost footer) into the Discord thread
 */
export class WorkoutSteerWorkflow extends WorkflowEntrypoint<Env, WorkoutSteerParams> {
  async run(event: WorkflowEvent<WorkoutSteerParams>, step: WorkflowStep) {
    const { replyChannelId, userMessage } = event.payload;
    const discord = new DiscordAPI(this.env.DISCORD_BOT_TOKEN, this.env.DISCORD_APP_ID);
    const stub = this.workout();
    const threadId = replyChannelId;

    await step.do('initial-typing', async () => {
      await discord.postTyping(replyChannelId).catch(() => {});
    });

    const ctx = await step.do('load-context', async () => {
      const res = await stub.fetch(
        `https://internal/workflow/workout/load-context?thread_id=${encodeURIComponent(threadId)}`,
      );
      return (await res.json()) as {
        systemPrompt: string;
        history: { role: 'user' | 'assistant'; content: string }[];
      };
    });

    await step.do('save-user-turn', async () => {
      await stub.fetch('https://internal/workflow/workout/save-turn', {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: userMessage, thread_id: threadId }),
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
      // retries:0 — see comment in steer.ts. Tool side effects make a
      // round-level retry unsafe.
      const result: RoundResult = await step.do(
        `round-${round}`,
        { retries: { limit: 0, delay: '1 second', backoff: 'constant' } },
        async () => withTypingRefresh(discord, replyChannelId, () => this.runOneRound(inputMessages, threadId)),
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
        const res = await stub.fetch('https://internal/workflow/workout/record-usage', {
          method: 'POST',
          body: JSON.stringify({
            thread_id: threadId,
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
      await stub.fetch('https://internal/workflow/workout/save-turn', {
        method: 'POST',
        body: JSON.stringify({ role: 'assistant', content: finalText, thread_id: threadId }),
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
        await stub.fetch('https://internal/workflow/workout/save-turn', {
          method: 'POST',
          body: JSON.stringify({
            role: 'system',
            content: `[delivery_failed] ${(err as Error).message}`,
            thread_id: threadId,
          }),
        }).catch(() => {});
        throw err;
      }
    });
  }

  private async runOneRound(messages: any[], threadId: string): Promise<RoundResult> {
    const stub = this.workout();
    return runAgentRound({
      client: makeOpenAIClient(this.env),
      model: this.env.OPENAI_MODEL,
      tools: WORKOUT_TOOLS,
      messages,
      executeTool: async (name, args) => {
        const res = await stub.fetch('https://internal/workflow/workout/exec-tool', {
          method: 'POST',
          body: JSON.stringify({ name, args }),
        });
        return await res.text();
      },
      onToolCall: async ({ name, args, output }) => {
        await stub.fetch('https://internal/workflow/workout/save-turn', {
          method: 'POST',
          body: JSON.stringify({
            role: 'tool',
            content: output,
            tool_call_json: JSON.stringify({ name, args }),
            thread_id: threadId,
          }),
        });
      },
    });
  }

  private workout() {
    return this.env.WORKOUT.get(this.env.WORKOUT.idFromName('default-household'));
  }
}
