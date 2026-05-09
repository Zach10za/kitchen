/**
 * Kitchen-flavored wrapper around the generic runtime tool-loop round.
 * Hardcodes the kitchen TOOLS list and backfills `week_of` for tools whose
 * schema declares it as required. Other bots use `runtime/agent-round.ts`
 * directly with their own tools.
 */

import {
  runAgentRound as runRound,
  MAX_TOOL_ROUNDS as MAX_RUNTIME,
  type RoundResult,
  type RunRoundArgs as RuntimeRunRoundArgs,
} from '../runtime/agent-round';
import { TOOLS } from './tools';

export const MAX_TOOL_ROUNDS = MAX_RUNTIME;
export type { RoundResult };

export interface RunRoundArgs {
  client: RuntimeRunRoundArgs['client'];
  model: string;
  messages: any[];
  /** Filled in for tools whose schema has a week_of param when the model omitted it. */
  weekOf: string;
  executeTool: (name: string, args: any) => Promise<string>;
  onToolCall?: (call: { name: string; args: any; output: string }) => Promise<void>;
}

export async function runAgentRound(args: RunRoundArgs): Promise<RoundResult> {
  return runRound({
    client: args.client,
    model: args.model,
    tools: TOOLS,
    messages: args.messages,
    executeTool: args.executeTool,
    onToolCall: args.onToolCall,
    fillDefaultArgs: (name, parsed) => {
      if (!('week_of' in parsed) && needsWeekOf(name)) {
        return { ...parsed, week_of: args.weekOf };
      }
      return parsed;
    },
  });
}

/** Tools whose schema declares week_of as required — used to backfill if missing. */
export function needsWeekOf(toolName: string): boolean {
  return [
    'generate_draft',
    'swap_meal',
    'adjust_servings',
    'reschedule_meal',
    'mark_meal_cooked',
    'mark_meal_skipped',
    'show_state',
  ].includes(toolName);
}
