# Adding a new agent bot

This repo hosts multiple Discord-facing AI bots inside a single Cloudflare Worker — kitchen, finance, tasks, workout. They share infrastructure (the chat workflow, the DO base, conversation/usage/rate-limit tables, cost tracking) and differ only in domain logic (tools, prompt, schema, fast-read commands).

This guide walks through adding a fifth bot end-to-end.

## TL;DR — the five-step recipe

For a thread-scoped bot with no alarms or custom workflows (i.e. shaped like finance, tasks, or workout):

1. Pick an id (e.g. `'reading'`), reserve a Discord channel, set `DISCORD_READING_CHANNEL_ID` as a worker secret.
2. Create `src/reading/` with `prompts.ts`, `tools.ts`, `loop.ts`, `render.ts`, `spec.ts` (the spec file is the only one this guide is opinionated about — the others are domain logic).
3. Create `src/reading-do.ts` — a ~20-line subclass of `AgentDOBase` pointing to your spec.
4. Wire it: add to `BOT_REGISTRY` in `src/runtime/bot-registry.ts`, declare the DO binding in `wrangler.jsonc`, declare `READING: DurableObjectNamespace` in `src/env.ts`, export `ReadingDO` from `src/index.ts`.
5. Register slash commands: add entries to `scripts/register-commands.ts`, run `bun run scripts/register-commands.ts`.

That's it. The chat workflow, cost footer, conversation persistence, rate limiting, fast-read shell, and admin endpoints all come for free.

The rest of this doc explains what each piece does and what hooks are available when your bot doesn't fit the default shape.

---

## Architecture in one diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (src/index.ts)                                │
│  • /interactions ── Discord slash commands                       │
│  • /relay/message ── Fly.io gateway forwards plain-text msgs     │
│  • /admin/* ── dump / reset / sync                               │
└─────────────────────┬────────────────────────────────────────────┘
                      │
                      │ resolves owning bot by channel id or command name
                      │ via runtime/bot-registry.ts
                      │
                      ▼
┌──────────────────────────────────────────────────────────────────┐
│  Per-bot Durable Object (extends AgentDOBase)                    │
│  • SQLite storage (conversation + usage + relay_rate + domain)   │
│  • /interaction ── slash-command dispatch                        │
│  • /fast-read ── synchronous read-only commands                  │
│  • /workflow/agent/* ── chat workflow IO                         │
│  • /heartbeat ── conversation prune + bot-specific tick          │
└─────────────────────┬────────────────────────────────────────────┘
                      │
                      │ chat dispatch creates a workflow
                      │
                      ▼
┌──────────────────────────────────────────────────────────────────┐
│  AgentChatWorkflow (one class, parameterized by botId)           │
│  • initial-typing → load-context → save-user-turn                │
│  • round-{0..MAX_TOOL_ROUNDS} (OpenAI Responses API + tools)     │
│  • record-usage → save-assistant → post-final                    │
└──────────────────────────────────────────────────────────────────┘
```

Two key contracts live in `src/runtime/`:

- **`bot-spec.ts`** — `BotSpec` interface. Each bot supplies one.
- **`agent-do-base.ts`** — `AgentDOBase` abstract class. Each bot's DO extends it.

---

## The `BotSpec` contract

`src/runtime/bot-spec.ts` defines the surface every bot must implement. Look at `src/finance/spec.ts` or `src/tasks/spec.ts` for a minimal working example.

### Required fields

| Field | Type | What it does |
|---|---|---|
| `id` | `BotId` | Unique identifier (`'kitchen'` \| `'finance'` \| etc.). Add yours to the union in `bot-spec.ts`. |
| `channelEnvKey` | `keyof Env` | Env key holding this bot's Discord channel id (e.g. `'DISCORD_FINANCE_CHANNEL_ID'`). |
| `commands` | `ReadonlySet<string>` | Slash command names this bot owns. Used for routing in `botForCommand`. |
| `tools` | `readonly ToolDef[]` | OpenAI function tools (Chat-Completions-style; the runtime converts to Responses API). See [Tools](#tools). |
| `migrations` | `readonly Migration[]` | Append-only SQLite migrations. See [Migrations](#migrations). |
| `resetTables` | `readonly string[]` | Tables wiped by `/admin/reset?bot=<id>`. Children before parents. |
| `buildSystemPrompt` | `(sql, env, scope) => string` | Build the system prompt at chat time. Read whatever current state you want to expose to the model. |
| `executeTool` | `(name, args, ctx) => ToolResult \| Promise<ToolResult>` | Dispatch table for your tools. |
| `fastRead` | `(sql, env, interaction) => MessagePayload \| null` | Synchronous read-only command handler. Return `null` to surface "unknown command." |
| `defaultScope` | `(env, replyChannelId) => ConversationScope` | How to partition conversation history when no richer context is available. |

### Optional fields

| Field | Type | When to use |
|---|---|---|
| `fillDefaultArgs` | `(toolName, parsed, scope) => any` | Backfill args the model often omits. Optional; no bot currently uses it. Return the parsed args unchanged for the no-op path. |

### Example: minimal spec

```ts
// src/reading/spec.ts
import type { BotSpec } from '../runtime/bot-spec';
import { ensureRelayRateSchema } from '../runtime/relay-rate-limit';
import { ensureUsageSchema } from '../runtime/usage';
import { READING_TOOLS } from './tools';
import { executeReadingTool } from './loop';
import { buildReadingSystemPrompt } from './prompts';
import { bookSummaryEmbed } from './render';

export const READING_SPEC: BotSpec = {
  id: 'reading',
  channelEnvKey: 'DISCORD_READING_CHANNEL_ID',
  commands: new Set(['reading', 'reading-now', 'reading-finished']),
  tools: READING_TOOLS,
  resetTables: ['notes', 'books', 'conversation'],

  buildSystemPrompt: (sql, env) => buildReadingSystemPrompt(sql, env.TIMEZONE),
  executeTool: (name, args, ctx) =>
    executeReadingTool(name, args, { sql: ctx.sql }),

  fastRead: (sql, _env, interaction) => {
    const cmd = interaction.data?.name ?? '';
    if (cmd === 'reading') return { embeds: [bookSummaryEmbed(sql)] };
    return null;
  },

  defaultScope: (_env, replyChannelId) => ({ column: 'thread_id', value: replyChannelId }),

  migrations: [
    {
      version: 1,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            author TEXT,
            status TEXT NOT NULL DEFAULT 'reading',
            started_at INTEGER NOT NULL,
            finished_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id TEXT NOT NULL,
            content TEXT NOT NULL,
            ts INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS conversation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tool_call_json TEXT,
            thread_id TEXT,
            ts INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_conv_thread ON conversation(thread_id, id DESC);
        `);
      },
    },
    { version: 2, up: (sql) => ensureRelayRateSchema(sql) },
    { version: 3, up: (sql) => ensureUsageSchema(sql) },
  ],
};
```

---

## Tools

A tool is an OpenAI function-calling tool. Two pieces: the *schema* (what the model sees) and the *executor* (what runs server-side).

### Schema

In `src/<bot>/tools.ts`, export an array of `ToolDef`. Each is either a function tool or a built-in (web_search, code_interpreter).

```ts
import type { ToolDef } from '../runtime/agent-round';

export const READING_TOOLS: readonly ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'add_book',
      description: 'Start tracking a new book.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          author: { type: 'string' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  // Built-in tools — run by OpenAI, not by us. Their usage counts roll into
  // the round automatically. Useful when the model needs to look something up.
  { type: 'web_search' },
];
```

### Executor

In `src/<bot>/loop.ts`, export an `executeXxxTool` function. The signature mirrors the spec's `executeTool` but can take a narrower ctx if the bot doesn't need the full `ToolExecCtx`:

```ts
export interface ReadingToolCtx { sql: SqlStorage }

export function executeReadingTool(name: string, args: any, ctx: ReadingToolCtx): string {
  try {
    switch (name) {
      case 'add_book':       return toolAddBook(args, ctx);
      case 'finish_book':    return toolFinishBook(args, ctx);
      // ... etc
      default:               return `Unknown reading tool: ${name}`;
    }
  } catch (err) {
    return `Tool ${name} failed: ${(err as Error).message}`;
  }
}
```

### Tool return shape

Tools may return either:

- **`string`** — the simple case. The model gets the string as the tool's output.
- **`{ output: string, usage?: RoundUsage }`** — for tools that make their own OpenAI calls and want their token spend folded into the round's reported usage (and thus the user-visible cost footer). Use this if a tool calls the model internally; the cost then shows up in the chat reply's footer.

Use the structured form when your tool calls OpenAI directly. Use the plain string otherwise.

### `fillDefaultArgs` (optional)

If your tools commonly need an arg the model forgets, supply `fillDefaultArgs` on the spec to backfill it after JSON parsing and before `executeTool`. Return the parsed args unchanged for the no-op path (never `undefined`). No bot currently needs it — it's a hook for future bots whose tool schemas declare a required arg the model tends to omit.

---

## System prompt

`buildSystemPrompt(sql, env, scope)` runs at the start of every chat turn. Build whatever string you want from the current SQL state — it's not cached, so reading fresh state is fine and usually correct.

Conventionally lives in `src/<bot>/prompts.ts`:

```ts
export function buildReadingSystemPrompt(sql: SqlStorage, timezone: string): string {
  const activeBooks = sql.exec<BookRow>(
    "SELECT * FROM books WHERE status = 'reading' ORDER BY started_at DESC",
  ).toArray();

  return [
    'You are a reading-tracking assistant.',
    `The user timezone is ${timezone}.`,
    activeBooks.length > 0
      ? `Currently reading:\n${activeBooks.map((b) => `- ${b.title} by ${b.author}`).join('\n')}`
      : 'No books currently in progress.',
    'Use the tools to record books, notes, and reading sessions.',
  ].join('\n\n');
}
```

The scope argument is rarely needed — every bot is thread-scoped today, so you can usually ignore it.

---

## Conversation scope

Conversation history is partitioned by `thread_id`: each Discord thread (or, for a bot's proactive top-level posts, the channel id used as the scope value) is its own context. All four bots use this.

```ts
defaultScope: (_env, replyChannelId) => ({ column: 'thread_id', value: replyChannelId }),
```

The `column` field is a typed enum (currently just `'thread_id'`), so the base class can safely inline it into SQL. `defaultScope(env, replyChannelId)` is called from the worker relay path; a DO's slash-command path may pass an explicit scope when dispatching from `dispatchCommand`.

---

## Migrations

`src/runtime/migrations.ts` runs migrations append-only, gated by `settings.schema_version`. Rules:

1. **Never mutate or remove an existing migration entry.** Deployed DOs may have already applied it.
2. **Always append new entries** with `version: n + 1`.
3. **SQLite has no `ALTER TABLE ADD COLUMN IF NOT EXISTS`** — probe via `PRAGMA table_info(...)` first when adding columns to existing tables.
4. **Shared schemas live in `runtime/`**: call `ensureRelayRateSchema(sql)` and `ensureUsageSchema(sql)` as their own migration entries. Don't inline their CREATE TABLE statements.
5. **DO SQLite does not enable `foreign_keys` PRAGMA.** `REFERENCES` clauses are documentation only; cascades and FK constraints do not fire. Order your `resetTables` to drop children before parents.

The base class auto-creates a `settings` table and tracks `schema_version` there — your migrations don't need to bootstrap that.

---

## Fast-read commands

Discord interactions have a strict 3-second initial-response budget. `fastRead` is the synchronous path for read-only commands that can answer in well under that budget — no LLM call, no thread creation, no workflow.

The Worker checks `isFastReadCommand(interaction)` in `src/index.ts` to decide whether to take the fast path. **You must add your fast-read commands there**, otherwise they'll be routed through the slow defer-then-followup path. Example pattern:

```ts
// src/index.ts → isFastReadCommand
case 'reading':
  return !hasMessage;  // /reading alone = read; with message = chat
case 'reading-now':
  return true;
```

`fastRead(sql, env, interaction)` returns either a `MessagePayload` (`{ content?, embeds? }`) or `null` to surface "unknown command." Don't throw — the base catches and renders a generic error, but a thoughtful in-bot response is better.

---

## Adding the DO class

For a thread-scoped bot with no alarm and no custom routes, this is the entire file:

```ts
// src/reading-do.ts
import type { Env } from './env';
import type { Interaction } from './discord/types';
import { AgentDOBase } from './runtime/agent-do-base';
import { READING_SPEC } from './reading/spec';

export class ReadingDO extends AgentDOBase<Env> {
  protected readonly spec = READING_SPEC;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();  // MUST be called from the subclass constructor.
  }

  protected async dispatchCommand(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value]),
    );

    if (commandName === 'reading' && optionMap.message) {
      const message = String(optionMap.message);
      await this.dispatchChatInteraction(interaction, message, `reading: ${message}`);
      return;
    }

    await this.discord.editOriginal(
      interaction.token,
      `Unknown reading command: \`${commandName}\``,
    );
  }
}
```

### Why `ensureSchema()` is in the subclass constructor

TypeScript's class-field initialization order: abstract `spec` is `undefined` when the base constructor runs. The base can't safely call `runMigrations(this.spec.migrations)` from its own constructor. So the contract is: every subclass calls `super(...)`, then `this.ensureSchema()`. If you forget, the constructor will throw the first time the DO is touched.

### Hooks available on `AgentDOBase`

You can override any of these in your subclass:

| Hook | Default | When to override |
|---|---|---|
| `dispatchCommand(interaction)` | abstract — must implement | Route slash commands to chat, in-process flows, etc. |
| `onHeartbeat()` | no-op | Hourly cron work: refreshing data, dispatching reminders, re-arming alarms. |
| `handleCustomRoute(request, url)` | returns null | Add bot-specific endpoints not covered by the base (kitchen has `/ensure-alarm`). Return null if the path isn't yours. |
| `onReset()` | no-op | Post-cleanup after the base wipes `resetTables`. Kitchen uses it to re-arm the daily suggestion alarm. |
| `customDump()` | empty object | Extend the `/dump` payload with bot-specific snapshots. |
| `alarm()` | none (DurableObject method) | Add if you want a scheduled alarm. Kitchen uses it for the daily dinner-suggestion ping. |

### Helpers available on the base

- `this.openReplyThread(interaction, titleSeed)` — open a Discord thread for the interaction, return the thread channel id.
- `this.dispatchChatInteraction(interaction, userMessage, titleSeed, scopeOverride?)` — open a thread + dispatch chat in one call. Use this for any `<bot> message: ...` flow.
- `this.sql` — raw `SqlStorage` for the DO.
- `this.discord` — `DiscordAPI` client (postMessage, postTyping, editOriginal, etc.).
- `this.env` — typed env.
- `this.ctx` — `DurableObjectState`.

---

## Wiring it all up

### 1. `src/runtime/bot-spec.ts` — add to the `BotId` union

```ts
export type BotId = 'kitchen' | 'finance' | 'tasks' | 'workout' | 'reading';
```

Also update `getStubFor()` to resolve your namespace:

```ts
export function getStubFor(env: Env, id: BotId): DurableObjectStub {
  const ns =
    id === 'kitchen' ? env.KITCHEN
    : id === 'finance' ? env.FINANCE
    : id === 'tasks' ? env.TASKS
    : id === 'workout' ? env.WORKOUT
    : env.READING;
  return ns.get(ns.idFromName('default-household'));
}
```

### 2. `src/runtime/bot-registry.ts` — register the spec

```ts
import { READING_SPEC } from '../reading/spec';

export const BOT_REGISTRY: Record<BotId, BotSpec> = {
  kitchen: KITCHEN_SPEC,
  finance: FINANCE_SPEC,
  tasks: TASKS_SPEC,
  workout: WORKOUT_SPEC,
  reading: READING_SPEC,
};
```

There is a second `stubFor()` helper inside `src/workflows/agent-chat.ts` that mirrors `getStubFor` — update it too. (TODO: consolidate.)

### 3. `src/env.ts` — declare the binding + channel id

```ts
KITCHEN: DurableObjectNamespace;
FINANCE: DurableObjectNamespace;
TASKS: DurableObjectNamespace;
WORKOUT: DurableObjectNamespace;
READING: DurableObjectNamespace;

// ...

DISCORD_READING_CHANNEL_ID: string;
```

### 4. `src/index.ts` — export the DO class

```ts
export { ReadingDO } from './reading-do';
```

### 5. `src/index.ts` — add the admin routing branch

The `/admin/dump` and `/admin/reset` handlers need to know about the new bot. Search for `botParam` in `src/index.ts` and extend the union + stub-picker:

```ts
const botParam = rawBot === 'finance' ? 'finance'
  : rawBot === 'tasks' ? 'tasks'
  : rawBot === 'workout' ? 'workout'
  : rawBot === 'reading' ? 'reading'
  : 'kitchen';
```

### 6. `wrangler.jsonc` — add the DO binding + migration

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "KITCHEN", "class_name": "KitchenDO" },
    { "name": "FINANCE", "class_name": "FinanceDO" },
    { "name": "TASKS", "class_name": "TasksDO" },
    { "name": "WORKOUT", "class_name": "WorkoutDO" },
    { "name": "READING", "class_name": "ReadingDO" },
  ],
},

"migrations": [
  // ... existing entries (DO NOT EDIT) ...
  {
    "tag": "v7",
    "new_sqlite_classes": ["ReadingDO"],
  },
],
```

The `migrations` block is Cloudflare's DO migration history — append-only, never mutate. Pick the next available tag.

Then regenerate types:

```
bun wrangler types
```

### 7. `scripts/register-commands.ts` — declare slash commands

Add entries for every command your bot owns:

```ts
{
  name: 'reading',
  description: 'Track books and reading notes. Without a message shows what you are reading.',
  options: [
    { name: 'message', description: 'What you want to do (omit for a summary)', type: STRING, required: false },
  ],
},
{
  name: 'reading-now',
  description: 'Show currently-reading books',
},
```

Run it once:

```
bun run scripts/register-commands.ts
```

This is idempotent — Discord overwrites by name.

### 8. Worker secret for the channel id

```
bun wrangler secret put DISCORD_READING_CHANNEL_ID
```

(Or add it to `.dev.vars` for local development.)

---

## What you get for free

Once steps 1–8 are done, every one of these works without any per-bot code:

- **`/chat`-style natural-language interaction** via the unified `AgentChatWorkflow` (durable steps, retries, typing indicator, conversation persistence).
- **Cost footer** on every assistant reply (turn + thread total), computed from raw token counts via `runtime/pricing.ts`. Pricing changes via wrangler vars, no code deploy.
- **Per-channel rate limiting** at `/relay/message` (default 30 msgs/hour, configurable via `RELAY_RATE_LIMIT_PER_HOUR`).
- **Conversation pruning** on hourly heartbeat (keeps the 400 most-recent rows per scope partition).
- **Usage logging** to the `usage` table — every turn input/cached/output/reasoning tokens + tool-call counts.
- **Admin endpoints**: `/admin/dump?bot=<id>`, `/admin/reset?bot=<id>`. Both require the `ADMIN_TOKEN` bearer token.
- **Error capture** via `error-triage.ts` — uncaught throws auto-file a GitHub issue with structured tags.
- **Fly.io gateway relay** for plain-text messages (no slash command needed) — just send a message in your bot's channel.
- **Discord thread creation** with auto-titled threads anchored to the user's first message.

---

## Patterns that need the more-advanced shape

If your bot is shaped like kitchen, you'll need more overrides. Reference: `src/kitchen-do.ts`.

### Scheduled work (alarms)

Add an `alarm()` method on your DO and override `onHeartbeat()` to call `this.ensureAlarmSet()`. Kitchen uses this for its daily dinner-suggestion ping.

```ts
async alarm(): Promise<void> {
  try {
    // do your scheduled work
  } finally {
    // Re-arm so this fires again. Define your own helper — kitchen's is
    // `armNextSuggest()`, computed from `nextDailyTime()`.
    await this.armNextSuggest();
  }
}
```

### Custom routes beyond the base

Override `handleCustomRoute(request, url)` to add endpoints. Return `null` if the path isn't yours. Kitchen uses this only for `/ensure-alarm`.

### In-process flows (bypassing the chat workflow)

Some commands don't need conversation history — single-shot LLM calls that just write to SQL. Kitchen's `/pantry message: ...` uses `runPantryFlow` directly from `dispatchCommand` (one structured-extraction call) instead of routing through `AgentChatWorkflow`. The pattern:

```ts
if (commandName === 'pantry' && optionMap.message) {
  const replyChannelId = await this.openReplyThread(interaction, ...);
  await runPantryFlow({ env: this.env, sql: this.sql, discord: this.discord, replyChannelId, userMessage: ... });
  return;
}
```

Use this when the agent loop is overkill — single-call extraction. Everything else (`/cook`, `/now`, `/profile`, `/chat`) routes through `dispatchChatInteraction`.

### Tools that call OpenAI

When a tool needs `ctx.client`, take the full `ToolExecCtx` from the spec — e.g. `{ env, sql, client }`. The base passes a per-call client with a 60s timeout. Tools that call OpenAI should return the structured `{ output, usage }` shape so their spend folds into the round footer. (Kitchen's tools are now pure SQL and return plain strings.)

---

## Testing checklist

Before merging a new bot:

- [ ] `bunx tsc --noEmit` — typecheck clean
- [ ] `bun wrangler deploy --dry-run` — build clean
- [ ] Deploy to Cloudflare
- [ ] Run `bun run scripts/register-commands.ts`
- [ ] In the bot's Discord channel:
  - `/your-bot message: <something>` — verify the chat workflow runs, replies in a thread, shows the cost footer
  - Send a plain-text message — verify the Fly.io relay path also works
  - Bare `/your-bot` (no message) — verify the fast-read summary embed
  - Any other slash commands — verify each one
- [ ] `curl -H "Authorization: Bearer $ADMIN_TOKEN" 'https://.../admin/dump?bot=your-bot'` — verify dump
- [ ] Wait for the hourly cron (or trigger manually) — verify heartbeat pruning + any bot-specific cron work

---

## File map cheat sheet

For a new bot called `reading`:

```
src/
├── reading/
│   ├── spec.ts        ← BotSpec (declarative)
│   ├── prompts.ts     ← buildReadingSystemPrompt
│   ├── tools.ts       ← READING_TOOLS array
│   ├── loop.ts        ← executeReadingTool + helpers
│   └── render.ts      ← embed builders for fast-read commands
├── reading-do.ts      ← ReadingDO extends AgentDOBase
├── runtime/
│   └── bot-registry.ts ← add READING_SPEC to BOT_REGISTRY
├── env.ts             ← add READING binding + DISCORD_READING_CHANNEL_ID
└── index.ts           ← export { ReadingDO }
scripts/
└── register-commands.ts ← add slash command entries
wrangler.jsonc          ← add DO binding + migrations tag
```
