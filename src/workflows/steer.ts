import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import OpenAI from 'openai';
import type { Env } from '../env';
import { TOOLS } from '../agent/tools';
import { toResponsesTools } from '../agent/loop';
import { DiscordAPI } from '../discord/api';

interface SteerParams {
  weekOf: string;
  userMessage: string;
  // Slash-command path: edit the deferred interaction response.
  interactionToken?: string;
  // Chat path (Gateway): post a regular message to this channel instead.
  channelId?: string;
  viaChat?: boolean;
}

const MAX_TOOL_ROUNDS = 6;

// Discord's /typing call shows the indicator for ~10s. Refresh well before it
// expires so the indicator stays continuously visible while real work runs.
// If the workflow crashes, the loop stops and the indicator dies ~10s later
// with no message — that absence is the user-visible failure signal.
const TYPING_REFRESH_MS = 7_000;

async function withTypingRefresh<T>(
  discord: DiscordAPI,
  channelId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!channelId) return fn();

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

interface AgentTurnResult {
  type: 'final' | 'continue';
  finalText?: string;
  // Full new input array (Responses API: messages + function_call +
  // function_call_output items). Returned as the FULL array so workflow
  // replay sees a self-contained cached result.
  newMessages: any[];
}

/**
 * Durable /steer flow. Each agent loop iteration is its own step with its own
 * retry budget — slow LLM calls and slow tool calls retry independently
 * instead of taking down the whole conversation.
 *
 * Steps:
 *   1. load-context     — fetch system prompt + recent history from DO
 *   2. save-user-turn   — persist the user's message
 *   3. round-{N}        — one OpenAI call + any tool executions (up to 6 rounds)
 *   4. save-assistant   — persist the final reply
 *   5. post-final       — Discord update
 */
export class SteerWorkflow extends WorkflowEntrypoint<Env, SteerParams> {
  async run(event: WorkflowEvent<SteerParams>, step: WorkflowStep) {
    const { weekOf, interactionToken, channelId, viaChat, userMessage } = event.payload;
    const discord = new DiscordAPI(this.env.DISCORD_BOT_TOKEN, this.env.DISCORD_APP_ID);
    const stub = this.kitchen();

    // Helper that posts the final reply via the right Discord channel.
    // DiscordAPI auto-chunks content over the 2000-char limit.
    const postReply = async (text: string): Promise<void> => {
      if (viaChat && channelId) {
        await discord.postMessage(channelId, text);
      } else if (interactionToken) {
        await discord.editOriginal(interactionToken, text);
      }
    };


    // Step 0: instant feedback — fire typing indicator immediately so the
    // user sees the bot is working while load-context + save-turn run.
    if (viaChat && channelId) {
      await step.do('initial-typing', async () => {
        await discord.postTyping(channelId).catch(() => {});
      });
    }

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

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const inputMessages = messages;
      const result: AgentTurnResult = await step.do(
        `round-${round}`,
        { retries: { limit: 2, delay: '2 seconds', backoff: 'linear' } },
        async () => {
          // Keep typing live for the whole round — LLM + tool execution can
          // easily exceed Discord's ~10s indicator timeout.
          return withTypingRefresh(
            discord,
            viaChat && channelId ? channelId : undefined,
            () => this.runOneRound(inputMessages, weekOf),
          );
        }
      );

      messages = result.newMessages;

      if (result.type === 'final') {
        finalText = result.finalText ?? '(no text)';
        break;
      }
    }

    if (!finalText) {
      finalText = 'I got stuck in a tool loop. Try again with a simpler request.';
    }

    // Persist the assistant's final text. Re-fire typing so the indicator
    // bridges any inter-step gap between the last round and the post below.
    await step.do('save-assistant', async () => {
      if (viaChat && channelId) {
        await discord.postTyping(channelId).catch(() => {});
      }
      await stub.fetch('https://internal/workflow/save-turn', {
        method: 'POST',
        body: JSON.stringify({ week_of: weekOf, role: 'assistant', content: finalText }),
      });
    });

    // Post to Discord (either edit the interaction or post to channel).
    await step.do('post-final', async () => {
      if (viaChat && channelId) {
        await discord.postTyping(channelId).catch(() => {});
      }
      await postReply(finalText!);
    });
  }

  /**
   * One round of the agent loop using OpenAI's Responses API.
   * Designed to be wrapped in step.do for automatic retries on transient failures.
   */
  private async runOneRound(messages: any[], weekOf: string): Promise<AgentTurnResult> {
    const client = this.openai();
    const stub = this.kitchen();

    const response = await client.responses.create({
      model: this.env.OPENAI_MODEL,
      input: messages,
      tools: toResponsesTools(TOOLS),
    });

    const toolCalls = response.output.filter((o: any) => o.type === 'function_call');

    if (toolCalls.length === 0) {
      const finalText = response.output_text || '(no text)';
      const newMessages = [...messages, ...response.output];
      return { type: 'final', finalText, newMessages };
    }

    // Echo every output item back in original order. Reasoning items (rs_...)
    // must accompany their paired function_call items or the next request
    // 400s with "function_call ... was provided without its required
    // 'reasoning' item". Then append function_call_outputs from tool execution.
    const newMessages: any[] = [...messages, ...response.output];

    for (const toolCall of toolCalls as any[]) {
      const args = JSON.parse(toolCall.arguments);
      if (!('week_of' in args) && needsWeekOf(toolCall.name)) {
        args.week_of = weekOf;
      }
      const res = await stub.fetch('https://internal/workflow/exec-tool', {
        method: 'POST',
        body: JSON.stringify({ name: toolCall.name, args }),
      });
      const content = await res.text();
      newMessages.push({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output: content,
      });

      // Persist the tool turn for visibility / debugging in /admin/dump.
      await stub.fetch('https://internal/workflow/save-turn', {
        method: 'POST',
        body: JSON.stringify({
          week_of: weekOf,
          role: 'tool',
          content,
          tool_call_json: JSON.stringify({ name: toolCall.name, args }),
        }),
      });
    }

    return { type: 'continue', newMessages };
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

function needsWeekOf(toolName: string): boolean {
  return [
    'generate_draft',
    'swap_meal',
    'adjust_servings',
    'reschedule_meal',
    'approve_plan',
    'generate_grocery_list',
    'mark_meal_cooked',
    'mark_meal_skipped',
    'show_state',
  ].includes(toolName);
}
