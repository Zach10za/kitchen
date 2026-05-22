import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import OpenAI from 'openai';
import type { Env } from '../env';
import { DiscordAPI } from '../discord/api';
import { MAX_TOOL_ROUNDS, runAgentRound, type RoundResult } from '../agent/round';
import { emptyUsage, addUsage, type RoundUsage } from '../runtime/agent-round';
import { computeCost, formatUsd } from '../runtime/pricing';
import { withTypingRefresh } from '../runtime/typing';

interface SteerParams {
  weekOf: string;
  userMessage: string;
  /** Channel id to post the reply into — always a thread channel id now. */
  replyChannelId: string;
}

// RoundResult from agent/round provides the same shape; alias kept for clarity.
type AgentTurnResult = RoundResult;

/**
 * Durable /steer flow. Each agent loop iteration is its own step with its own
 * retry budget — slow LLM calls and slow tool calls retry independently
 * instead of taking down the whole conversation.
 *
 * All output goes into the thread identified by replyChannelId, which the
 * caller (DO interaction handler or worker /relay/message handler) creates
 * before invoking the workflow.
 *
 * Steps:
 *   1. load-context     — fetch system prompt + recent history from DO
 *   2. save-user-turn   — persist the user's message
 *   3. round-{N}        — one OpenAI call + any tool executions (up to 6 rounds)
 *   4. save-assistant   — persist the final reply
 *   5. post-final       — post reply into the thread
 */
export class SteerWorkflow extends WorkflowEntrypoint<Env, SteerParams> {
  async run(event: WorkflowEvent<SteerParams>, step: WorkflowStep) {
    const { weekOf, replyChannelId, userMessage } = event.payload;
    const discord = new DiscordAPI(this.env.DISCORD_BOT_TOKEN, this.env.DISCORD_APP_ID);
    const stub = this.kitchen();

    // Step 0: instant feedback — fire typing indicator immediately so the
    // user sees the bot is working while load-context + save-turn run.
    await step.do('initial-typing', async () => {
      await discord.postTyping(replyChannelId).catch(() => {});
    });

    // Step 1: load context from DO
    const ctx = await step.do('load-context', async () => {
      const res = await stub.fetch(`https://internal/workflow/load-context?week_of=${weekOf}`);
      return (await res.json()) as {
        systemPrompt: string;
        history: { role: 'user' | 'assistant'; content: string }[];
      };
    });

    // Step 2: persist the user's turn
    await step.do('save-user-turn', async () => {
      await stub.fetch('https://internal/workflow/save-turn', {
        method: 'POST',
        body: JSON.stringify({ week_of: weekOf, role: 'user', content: userMessage }),
      });
    });

    // Build the running message list. Each round.do receives the current
    // messages and returns the FULL new messages array (input + appended).
    // We assign rather than mutate so workflow replays (which return the
    // cached step result) don't re-append on top of the same array.
    let messages: any[] = [
      { role: 'system', content: ctx.systemPrompt },
      ...ctx.history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage },
    ];

    let finalText: string | null = null;
    let turnUsage: RoundUsage = emptyUsage();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const inputMessages = messages;
      // No step-level retries: a round's tool executions have already-applied
      // side effects in the DO. Retrying would re-call OpenAI (which is
      // stochastic), produce different tool calls, and re-execute the prior
      // tools. The OpenAI client has its own internal maxRetries for
      // transient network failures.
      const result: AgentTurnResult = await step.do(
        `round-${round}`,
        { retries: { limit: 0, delay: '1 second', backoff: 'constant' } },
        async () => {
          // Keep typing live for the whole round — LLM + tool execution can
          // easily exceed Discord's ~10s indicator timeout.
          return withTypingRefresh(discord, replyChannelId, () =>
            this.runOneRound(inputMessages, weekOf),
          );
        }
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

    // Record turn usage and pull running thread total for the cost footer.
    // Same pattern as FinanceSteerWorkflow — the DO computes thread totals
    // from raw counts so retroactive pricing changes flow through.
    const threadId = replyChannelId;
    // record-usage is observability — never let a transient failure block
    // delivery of the user's reply. Falls back to the local turnUsage so the
    // footer still renders something sensible.
    const turnTotals = await step.do('record-usage', async () => {
      try {
        const res = await stub.fetch('https://internal/workflow/record-usage', {
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
    const finalWithCost = `${finalText}\n\n_${formatUsd(turnCost.total_usd)} this turn · ${formatUsd(threadCost.total_usd)} thread total_`;

    // Persist the assistant's final text. Re-fire typing so the indicator
    // bridges any inter-step gap between the last round and the post below.
    await step.do('save-assistant', async () => {
      await discord.postTyping(replyChannelId).catch(() => {});
      await stub.fetch('https://internal/workflow/save-turn', {
        method: 'POST',
        body: JSON.stringify({ week_of: weekOf, role: 'assistant', content: finalText }),
      });
    });

    await step.do('post-final', async () => {
      await discord.postTyping(replyChannelId).catch(() => {});
      await discord.postMessage(replyChannelId, finalWithCost);
    });
  }

  /**
   * One round of the agent loop using OpenAI's Responses API.
   * Designed to be wrapped in step.do for automatic retries on transient failures.
   *
   * Tool execution + per-tool turn persistence both run inside the DO via
   * /workflow/exec-tool and /workflow/save-turn — that keeps the SQL writes
   * transactional with the running tool and avoids exposing SqlStorage to
   * the workflow runtime.
   */
  private async runOneRound(messages: any[], weekOf: string): Promise<AgentTurnResult> {
    const stub = this.kitchen();
    return runAgentRound({
      client: this.openai(),
      model: this.env.OPENAI_MODEL,
      messages,
      weekOf,
      executeTool: async (name, args) => {
        const res = await stub.fetch('https://internal/workflow/exec-tool', {
          method: 'POST',
          body: JSON.stringify({ name, args }),
        });
        // /exec-tool now returns { output, usage|null } so tool-internal LLM
        // costs (generate_draft, swap_meal) can roll into the round's total.
        const json = (await res.json()) as { output: string; usage: RoundUsage | null };
        return json.usage ? { output: json.output, usage: json.usage } : json.output;
      },
      onToolCall: async ({ name, args, output }) => {
        await stub.fetch('https://internal/workflow/save-turn', {
          method: 'POST',
          body: JSON.stringify({
            week_of: weekOf,
            role: 'tool',
            content: output,
            tool_call_json: JSON.stringify({ name, args }),
          }),
        });
      },
    });
  }

  private kitchen() {
    const id = this.env.KITCHEN.idFromName('default-household');
    return this.env.KITCHEN.get(id);
  }

  private openai(): OpenAI {
    return new OpenAI({
      apiKey: this.env.OPENAI_API_KEY,
      baseURL: this.env.AI_GATEWAY_URL || undefined,
      timeout: 180_000,
      maxRetries: 1,
    });
  }
}
