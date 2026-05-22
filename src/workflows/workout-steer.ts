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
import { WORKOUT_TOOLS } from '../workout/tools';

interface WorkoutSteerParams {
  userMessage: string;
  replyChannelId: string;
}

const TYPING_REFRESH_MS = 7_000;

async function withTypingRefresh<T>(
  discord: DiscordAPI,
  channelId: string,
  fn: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  const refresh = (async () => {
    while (!stopped) {
      await discord.postTyping(channelId).catch(() => {});
      const start = Date.now();
      while (!stopped && Date.now() - start < TYPING_REFRESH_MS) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  })();
  try {
    return await fn();
  } finally {
    stopped = true;
    await refresh.catch(() => {});
  }
}

/**
 * Durable workout agent flow. Mirrors TasksSteerWorkflow exactly — IO endpoints
 * are under /workflow/workout/ and the tool list is WORKOUT_TOOLS. Each agent
 * loop iteration is its own step with retries so slow LLM calls don't take
 * down the conversation.
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
      const result: RoundResult = await step.do(
        `round-${round}`,
        { retries: { limit: 2, delay: '2 seconds', backoff: 'linear' } },
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

    const turnTotals = await step.do('record-usage', async () => {
      const res = await stub.fetch('https://internal/workflow/workout/record-usage', {
        method: 'POST',
        body: JSON.stringify({
          thread_id: threadId,
          model: this.env.OPENAI_MODEL,
          ...turnUsage,
        }),
      });
      return (await res.json()) as { thread_total_usage: RoundUsage };
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
      await discord.postMessage(replyChannelId, finalWithCost);
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
