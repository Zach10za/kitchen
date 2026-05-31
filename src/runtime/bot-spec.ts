/**
 * Per-bot contract. Every agent bot in this Worker — kitchen, finance, tasks,
 * workout, future ones — supplies a `BotSpec` describing its tools, prompt,
 * fast-read handler, conversation scoping, and schema migrations.
 *
 * `AgentDOBase` consumes specs to expose universal chat endpoints; the single
 * `AgentChatWorkflow` consumes them to drive the agent loop. Bot routing in
 * `runtime/bot-registry.ts` is built from the spec list so adding a bot is one
 * spec file + one DO subclass.
 */

import type OpenAI from 'openai';
import type { Env } from '../env';
import type { Interaction, MessagePayload } from '../discord/types';
import type { ToolDef, ToolResult } from './agent-round';
import type { Migration } from './migrations';

export type BotId = 'kitchen' | 'finance' | 'tasks' | 'workout';

/**
 * How a bot partitions conversation history in its `conversation` table.
 *
 * Every bot uses `thread_id` — each Discord thread (or, for proactive posts,
 * the channel itself) is its own conversation context. The column name is a
 * closed enum so it's safe to inline into SQL.
 */
export interface ConversationScope {
  column: 'thread_id';
  value: string;
}

/** Context every tool implementation receives. Tools use what they need;
 *  some bots' tools call OpenAI internally and need `client`, others only
 *  touch sql + timezone. */
export interface ToolExecCtx {
  env: Env;
  sql: SqlStorage;
  client: OpenAI;
  timezone: string;
  scope: ConversationScope;
}

/** Payload for `AgentChatWorkflow`. Carries enough state for the workflow to
 *  resolve the right DO + tools + system prompt + conversation slice. */
export interface AgentChatParams {
  botId: BotId;
  userMessage: string;
  /** Discord channel id to post replies into — always a thread channel id. */
  replyChannelId: string;
  scope: ConversationScope;
}

export interface BotSpec {
  readonly id: BotId;
  /** Env key for the Discord channel this bot owns. Resolved at runtime so
   *  test envs can stub a different channel id without changing the spec. */
  readonly channelEnvKey: keyof Env;
  /** Slash-command names this bot owns. Grep-friendly source of truth. */
  readonly commands: ReadonlySet<string>;
  readonly tools: readonly ToolDef[];
  /** Schema migrations specific to this bot. Append-only. The base class
   *  takes care of `runMigrations(sql, spec.migrations)` from the constructor. */
  readonly migrations: readonly Migration[];
  /** Tables wiped by /admin/reset (in deletion order). The base class iterates
   *  this list, then issues a /reset:after hook for any per-bot post-cleanup. */
  readonly resetTables: readonly string[];
  /** Which `conversation` column the bot partitions by. Always `thread_id`
   *  today; retained as a field so the contract stays explicit per bot. */
  readonly scopeColumn: 'thread_id';

  buildSystemPrompt(sql: SqlStorage, env: Env, scope: ConversationScope): string;

  executeTool(name: string, args: Record<string, unknown>, ctx: ToolExecCtx): Promise<ToolResult> | ToolResult;

  /** Synchronous read-only command handler. Return null for unknown commands
   *  so the base class can surface a clear error. */
  fastRead(sql: SqlStorage, env: Env, interaction: Interaction): MessagePayload | null;

  /** Default scope for a reply channel — the thread (or channel) the reply
   *  lands in. Callers may pass an explicit scope to dispatchChat instead. */
  defaultScope(env: Env, replyChannelId: string): ConversationScope;

  /** Optional: rewrite parsed tool args before execution to backfill context
   *  the model commonly omits. Returning the parsed args unchanged is the
   *  no-op path; never return `undefined`. No bot currently uses this. */
  fillDefaultArgs?(
    toolName: string,
    parsed: Record<string, unknown>,
    scope: ConversationScope,
  ): Record<string, unknown>;
}

/** Resolve a DO stub by spec id. Single-tenant for now — every bot uses the
 *  `default-household` instance name. */
export function getStubFor(env: Env, id: BotId): DurableObjectStub {
  const ns =
    id === 'kitchen' ? env.KITCHEN
    : id === 'finance' ? env.FINANCE
    : id === 'tasks' ? env.TASKS
    : env.WORKOUT;
  return ns.get(ns.idFromName('default-household'));
}
