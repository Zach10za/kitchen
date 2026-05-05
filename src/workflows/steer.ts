import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import OpenAI from 'openai';
import type { Env } from '../env';
import { TOOLS } from '../agent/tools';
import { DiscordAPI } from '../discord/api';

interface SteerParams {
  weekOf: string;
  interactionToken: string;
  userMessage: string;
}

const MAX_TOOL_ROUNDS = 6;

interface AgentTurnResult {
  type: 'final' | 'continue';
  finalText?: string;
  assistantMessage: OpenAI.Chat.Completions.ChatCompletionMessage;
  toolResults: { tool_call_id: string; content: string }[];
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
    const { weekOf, interactionToken, userMessage } = event.payload;
    const discord = new DiscordAPI(this.env.DISCORD_BOT_TOKEN, this.env.DISCORD_APP_ID);
    const stub = this.kitchen();

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

    // Build the running message list. Updated locally in workflow memory; each
    // round-N step is fed the current state via closure capture.
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: ctx.systemPrompt },
      ...ctx.history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage },
    ];

    let finalText: string | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result: AgentTurnResult = await step.do(
        `round-${round}`,
        { retries: { limit: 2, delay: '2 seconds', backoff: 'linear' } },
        async () => this.runOneRound(messages, weekOf)
      );

      // Always advance the message list with the assistant's reply.
      messages.push(result.assistantMessage);

      if (result.type === 'final') {
        finalText = result.finalText ?? '(no text)';
        break;
      }

      // Append tool results (in same order as the model emitted tool calls).
      for (const tr of result.toolResults) {
        messages.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
      }
    }

    if (!finalText) {
      finalText = 'I got stuck in a tool loop. Try again with a simpler request.';
    }

    // Persist the assistant's final text.
    await step.do('save-assistant', async () => {
      await stub.fetch('https://internal/workflow/save-turn', {
        method: 'POST',
        body: JSON.stringify({ week_of: weekOf, role: 'assistant', content: finalText }),
      });
    });

    // Post to Discord.
    await step.do('post-final', async () => {
      await discord.editOriginal(interactionToken, finalText!.slice(0, 2000));
    });
  }

  /**
   * One round of the agent loop: call OpenAI once, execute any tool calls in
   * the response, return results. Designed to be wrapped in step.do for
   * automatic retries on transient failures.
   */
  private async runOneRound(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    weekOf: string
  ): Promise<AgentTurnResult> {
    const client = this.openai();
    const stub = this.kitchen();

    const completion = await client.chat.completions.create({
      model: this.env.OPENAI_MODEL,
      messages,
      tools: TOOLS as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
    });

    const choice = completion.choices[0];
    if (!choice) throw new Error('OpenAI returned no choices');
    const msg = choice.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        type: 'final',
        finalText: msg.content ?? '(no text)',
        assistantMessage: msg,
        toolResults: [],
      };
    }

    // Execute tools sequentially via the DO's exec-tool endpoint. Tools
    // mutate SQL inside the DO so this routes to one consistent state.
    const toolResults: { tool_call_id: string; content: string }[] = [];
    for (const toolCall of msg.tool_calls) {
      if (toolCall.type !== 'function') continue;
      const args = JSON.parse(toolCall.function.arguments);
      // Some tools take week_of; default if not provided.
      if (!('week_of' in args) && needsWeekOf(toolCall.function.name)) {
        args.week_of = weekOf;
      }
      const res = await stub.fetch('https://internal/workflow/exec-tool', {
        method: 'POST',
        body: JSON.stringify({ name: toolCall.function.name, args }),
      });
      const content = await res.text();
      toolResults.push({ tool_call_id: toolCall.id, content });

      // Persist the tool turn for visibility / debugging in /admin/dump.
      await stub.fetch('https://internal/workflow/save-turn', {
        method: 'POST',
        body: JSON.stringify({
          week_of: weekOf,
          role: 'tool',
          content,
          tool_call_json: JSON.stringify({ name: toolCall.function.name, args }),
        }),
      });
    }

    return {
      type: 'continue',
      assistantMessage: msg,
      toolResults,
    };
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
