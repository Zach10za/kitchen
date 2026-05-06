# Kitchen

A meal-planning agent that lives in your Discord. No app to open, no UI to maintain.

The bot drafts a plan every Friday evening, you steer it in chat (slash commands or plain messages), approve when ready, and a grocery list gets posted automatically. During the week you can ask "what now?" for prep instructions, update the pantry as you cook, and get defrost/prep reminders pushed to the channel.

## Architecture

- **Cloudflare Worker** — Discord interaction webhook + cron heartbeat + admin endpoints
- **Durable Object (`KitchenDO`)** — household state in SQLite, weekly draft alarm, due-reminder dispatch, relay rate limiting
- **Cloudflare Workflows** — `ApproveWorkflow` and `SteerWorkflow` run multi-step LLM flows past the Worker CPU budget with per-step retries
- **OpenAI via Cloudflare AI Gateway** — three model tiers (planner / extract / fast) routed through one gateway for caching + observability
- **Fly.io gateway relay** (`gateway-relay/`) — tiny always-on VM holding the Discord Gateway WebSocket, so plain chat messages (no slash command) reach the Worker via signed HTTPS
- **Auto error triage** — exceptions are fingerprinted, deduped, and filed as labeled GitHub issues; no hosted tracker

That's the whole thing — about 4.4k lines of TypeScript, no database, no frontend.

## One-time setup

### 1. Install

```bash
cd ~/Projects/kitchen
bun install
```

(Bun 1.3+. Wrangler is local-installed, not global.)

### 2. Create a Cloudflare AI Gateway

In the Cloudflare dashboard:
- AI > AI Gateway > Create Gateway
- Name: `kitchen`
- Copy the OpenAI endpoint URL (looks like `https://gateway.ai.cloudflare.com/v1/<account>/kitchen/openai`) — this becomes `AI_GATEWAY_URL`

### 3. Create a Discord application + bot

1. https://discord.com/developers/applications → **New Application** ("KitchenBot")
2. Under **General Information**, copy:
   - **Application ID** → `DISCORD_APP_ID`
   - **Public Key** → `DISCORD_PUBLIC_KEY`
3. Under **Bot**:
   - Click **Reset Token** → `DISCORD_BOT_TOKEN`
   - Enable **Message Content Intent** (privileged) — required for the relay to read chat messages
4. Under **OAuth2 > URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Embed Links`, `Read Message History`
   - Open the generated URL, add the bot to your server
5. In Discord, enable **Settings > Advanced > Developer Mode**, then:
   - Right-click your server → **Copy Server ID** → `DISCORD_GUILD_ID`
   - Right-click the channel the bot lives in → **Copy Channel ID** → `DISCORD_CHANNEL_ID`

### 4. Set local secrets for development

```bash
cp .dev.vars.example .dev.vars
# Fill in the values you collected above
```

### 5. Register slash commands (one-time)

```bash
bun run register-commands
```

You should see `/plan`, `/draft`, `/steer`, `/now`, `/pantry`, `/profile`, `/approve`, `/grocery`, `/reminders` registered.

### 6. Deploy the Worker

```bash
bunx wrangler login        # interactive
bunx wrangler deploy
```

Then set production secrets:

```bash
bunx wrangler secret put DISCORD_PUBLIC_KEY
bunx wrangler secret put DISCORD_BOT_TOKEN
bunx wrangler secret put DISCORD_APP_ID
bunx wrangler secret put DISCORD_GUILD_ID
bunx wrangler secret put DISCORD_CHANNEL_ID
bunx wrangler secret put OPENAI_API_KEY
bunx wrangler secret put AI_GATEWAY_URL
bunx wrangler secret put RELAY_SECRET     # any long random string; share with Fly.io relay
bunx wrangler secret put ADMIN_TOKEN      # bearer for /admin/* endpoints
bunx wrangler secret put GITHUB_TOKEN     # fine-grained PAT, Issues:write on the repo (optional; enables auto error triage)
```

Public vars (model IDs, draft schedule, timezone, repo, rate limit) live in `wrangler.jsonc` under `vars` and can be edited directly.

### 7. Point Discord at your Worker

After `wrangler deploy` you'll get a URL like `https://kitchen.<your-subdomain>.workers.dev`.

In the Discord developer portal under your application's **General Information**:
- Set **Interactions Endpoint URL** to `https://kitchen.<your-subdomain>.workers.dev/interactions`
- Discord pings it; if the URL saves, signature verification is working.

### 8. Deploy the gateway relay (Fly.io)

The relay forwards plain-text messages in the kitchen channel to the Worker, so you can steer without typing `/steer` every time.

```bash
cd gateway-relay
fly launch --no-deploy           # accept defaults; app name "kitchen-gateway"
fly secrets set \
  DISCORD_BOT_TOKEN=...          # same token as the Worker
  DISCORD_CHANNEL_ID=...         # same channel ID
  WORKER_URL=https://kitchen.<your-subdomain>.workers.dev \
  RELAY_SECRET=...               # same value as the Worker secret
fly deploy
```

The 256 MB shared-CPU VM in `fly.toml` is plenty — it's just a WebSocket client.

### 9. Arm the alarm

The hourly cron arms the DO's weekly draft alarm on its first tick. To force it now:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://kitchen.<your-subdomain>.workers.dev/admin/dump
# Any DO call wakes the instance and arms the alarm.
```

Or just wait — the next Friday 6pm in `America/Los_Angeles` (configurable via `DRAFT_DAY` / `DRAFT_HOUR_LOCAL` / `TIMEZONE`) you'll get a draft.

## Day-to-day usage

In your Discord channel, either slash commands:

```
/plan                    show the current plan
/draft notes:<optional>  generate a fresh plan for next week (~10–15s, live progress)
/steer message:swap tue for something with the salmon, and thu needs to be 20 min
/now                     what should I be cooking right now?
/pantry message:bought salmon, bok choy, scallions
/pantry                  (no message) show current pantry
/profile message:I have a wok and don't eat pork
/profile                 (no message) show current profile
/approve                 lock in the plan and post a grocery list
/grocery                 reshow the grocery list
/reminders               show upcoming defrost/prep reminders
```

…or just talk in the channel. The Fly.io relay forwards messages to a `SteerWorkflow`, so:

- "didn't make wed, push it to fri"
- "use the leftover chicken thursday"
- "no more soy sauce — drop the stir fry"

…all work without any slash command. Per-channel rate limit: `RELAY_RATE_LIMIT_PER_HOUR` (default 30/hr) prevents a compromised relay from driving unbounded LLM spend.

The bot learns from every steering conversation. After a few weeks the drafts arrive ~80% of the way there.

## Local development

```bash
bun run dev         # wrangler dev with .dev.vars
bun run tail        # stream production logs
bun run typecheck   # tsc --noEmit
```

For end-to-end testing of Discord interactions you'll need a tunnel (`cloudflared tunnel`) — usually easier to deploy and test live.

## Admin endpoints

All gated on `Authorization: Bearer $ADMIN_TOKEN` (separate from the bot token so an admin curl can never leak it via URL access logs):

```
GET  /admin/dump                       full DO state JSON
POST /admin/reset                      wipe DO state
GET  /admin/grocery?week_of=YYYY-MM-DD
POST /admin/clear-grocery?week_of=YYYY-MM-DD
```

## Files

```
src/
  index.ts                 Worker entry: routes /interactions, /relay/message, /admin/*
  env.ts                   Env binding types
  kitchen-do.ts            Durable Object: SQLite state + alarm + reminder dispatch + rate limit
  error-triage.ts          Capture → fingerprint → dedupe → file GitHub issue
  agent/
    loop.ts                OpenAI tool-use loop + tool implementations
    tools.ts               Tool schemas (the agent's API surface)
    schemas.ts             JSON schemas for structured-output extraction
    prompts.ts             System prompt builder
    context.ts             Builds per-command system prompts from DO state
    render.ts              Plan / recipe / grocery list → Discord embeds
    round.ts               Servings rounding helpers
  discord/
    verify.ts              Ed25519 signature verification (Web Crypto, no deps)
    api.ts                 Discord REST helpers
    types.ts               Minimal interaction + embed types
  workflows/
    approve.ts             ApproveWorkflow: per-recipe shopping → combined grocery list
    steer.ts               SteerWorkflow: chat-driven plan edits with progress updates
  util/
    datetime.ts            Timezone math (next-Monday, draft alarm time, cook time)
gateway-relay/
  index.ts                 Discord Gateway WebSocket client → HTTPS forwarder
  fly.toml, Dockerfile     Fly.io deployment
scripts/
  register-commands.ts     One-shot slash command registration
```

## Observability

Workers Logs and Workers Traces are both enabled at `head_sampling_rate: 1` (100%) in `wrangler.jsonc`:

- **Logs** — every `console.*` and uncaught exception, viewable in the Cloudflare dashboard's Observability tab. 7-day retention on free tier; lower the sampling rate if volume gets noisy.
- **Traces** — distributed spans across `fetch` → DO → Workflow steps → sub-fetches. Great for pinpointing which tool call in the agent loop blew the budget.
- **Auto-triage** — set `GITHUB_TOKEN` + `GITHUB_REPO` and exceptions get filed as deduped GitHub issues with the `auto-fix` label. Empty values disable capture entirely (e.g. for local dev).

## What's NOT here (yet)

- Voice (Cloudflare Voice Agents could replace `/now` with a phone call)
- Email export (Cloudflare Email Service for the grocery list)
- Pantry receipt parsing (forward Instacart receipts to an inbound email address)
- Multi-household / sharing (single-tenant; one DO named `default-household`)

Each is a small additive change once the core loop is good.
