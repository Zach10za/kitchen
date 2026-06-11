# Kitchen

A daily cooking assistant that lives in your Discord. No app to open, no UI to maintain.

Ask "what should I cook today?" and the bot suggests 2–3 dishes drawn from what's actually in your pantry and freezer, your dietary profile, and what you've eaten recently — with a short "need to buy" line for anything missing. Every day at noon it proactively pings you with options, *unless you've already decided* (picked a meal or said it's a date-night / takeout day). Pick one and it saves the recipe, schedules defrost reminders, and decrements your pantry when you cook it. No rigid weekly plan to maintain.

## Architecture

- **Cloudflare Worker** — Discord interaction webhook + cron heartbeat + admin endpoints
- **Durable Object (`KitchenDO`)** — household state in SQLite, daily suggestion alarm, due-reminder dispatch, relay rate limiting
- **Cloudflare Workflow (`AgentChatWorkflow`)** — runs the multi-step LLM tool-loop past the Worker CPU budget with per-step retries; one class serves every bot
- **OpenAI via Cloudflare AI Gateway** — three model tiers (planner / extract / fast) routed through one gateway for caching + observability
- **Fly.io gateway relay** (`gateway-relay/`) — tiny always-on VM holding the Discord Gateway WebSocket, so plain chat messages (no slash command) reach the Worker via signed HTTPS
- **Auto error triage** — exceptions are fingerprinted, deduped, and filed as labeled GitHub issues; no hosted tracker

No database, no frontend.

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
   - If you add a `#finance` channel: right-click → **Copy Channel ID** → `DISCORD_FINANCE_CHANNEL_ID`
   - If you add a `#projects` channel: right-click → **Copy Channel ID** → `DISCORD_TASKS_CHANNEL_ID`
   - If you add a `#workout` channel: right-click → **Copy Channel ID** → `DISCORD_WORKOUT_CHANNEL_ID`

### 4. Set local secrets for development

```bash
cp .dev.vars.example .dev.vars
# Fill in the values you collected above
```

### 5. Register slash commands (one-time)

```bash
bun run register-commands
```

You should see `/cook`, `/chat`, `/now`, `/pantry`, `/profile`, `/reminders`, `/finance`, `/spending`, `/merchant`, `/accounts`, `/finance-sync`, `/projects`, `/projects-open`, `/projects-next`, `/projects-blocked`, `/projects-due`, `/workout`, `/workout-last`, `/workout-prs`, `/workout-week`, `/workout-program`, `/workout-profile` registered.

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
bunx wrangler secret put DISCORD_CHANNEL_ID         # channel the kitchen bot posts daily dinner suggestions to
bunx wrangler secret put DISCORD_FINANCE_CHANNEL_ID  # optional; enables finance bot
bunx wrangler secret put DISCORD_TASKS_CHANNEL_ID    # optional; enables projects bot
bunx wrangler secret put DISCORD_WORKOUT_CHANNEL_ID   # optional; enables workout bot
bunx wrangler secret put OPENAI_API_KEY
bunx wrangler secret put AI_GATEWAY_URL
bunx wrangler secret put RELAY_SECRET     # any long random string; share with Fly.io relay
bunx wrangler secret put ADMIN_TOKEN      # bearer for /admin/* endpoints
bunx wrangler secret put GITHUB_TOKEN     # fine-grained PAT, Issues:write on the repo (optional; enables auto error triage)
bunx wrangler secret put TAVILY_API_KEY   # Tavily search key (optional; powers web_search across all bots — free tier ~1k/mo)
```

Public vars (model IDs, `SUGGEST_HOUR_LOCAL`, `DINNER_HOUR_LOCAL`, timezone, repo, rate limit) live in `wrangler.jsonc` under `vars` and can be edited directly.

### 7. Point Discord at your Worker

After `wrangler deploy` you'll get a URL like `https://kitchen.<your-subdomain>.workers.dev`.

In the Discord developer portal under your application's **General Information**:
- Set **Interactions Endpoint URL** to `https://kitchen.<your-subdomain>.workers.dev/interactions`
- Discord pings it; if the URL saves, signature verification is working.

### 8. Deploy the gateway relay (Fly.io)

The relay forwards plain-text messages in the kitchen channel to the Worker, so you can chat without typing `/chat` every time.

```bash
cd gateway-relay
fly launch --no-deploy           # accept defaults; app name "kitchen-gateway"
fly secrets set \
  DISCORD_BOT_TOKEN=...          # same token as the Worker
  DISCORD_CHANNEL_IDS=<kitchen-id>,<finance-id>,<tasks-id>,<workout-id>   # comma-separated IDs for all bots you want to relay
  WORKER_URL=https://kitchen.<your-subdomain>.workers.dev \
  RELAY_SECRET=...               # same value as the Worker secret
fly deploy
```

The 256 MB shared-CPU VM in `fly.toml` is plenty — it's just a WebSocket client.

### 9. Arm the alarm

The hourly cron arms the DO's daily suggestion alarm on its first tick. To force it now:

```bash
curl -X GET -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://kitchen.<your-subdomain>.workers.dev/admin/dump
# Any DO call wakes the instance and arms the alarm.
```

Or just wait — at the next noon in `America/Los_Angeles` (hour configurable via `SUGGEST_HOUR_LOCAL` / `TIMEZONE`) you'll get dinner suggestions, unless you've already decided that day.

## Day-to-day usage

In your Discord channel, either slash commands:

```
/cook                       suggest 2–3 dinners from what you have right now
/cook message:salmon, 20min suggest around given ingredients / constraints
/chat message:I'll make the salmon one — and log that I cooked it
/now                        what should I be doing in the kitchen right now? (or tonight's options)
/pantry message:bought salmon, bok choy, scallions
/pantry                     (no message) show current pantry
/profile message:I have a wok and don't eat pork
/profile                    (no message) show current profile
/reminders                  show upcoming defrost/prep reminders
```

Tell the bot you're not cooking ("date night tonight", "ordering in") and it records a
no-cook day — silencing that day's noon ping. Say you made a dish and it logs the recipe
and decrements your pantry.

In your `#finance` channel:

```
/finance                 quick 30d spending summary
/finance message:...     ask anything about spending, accounts, or trends
/spending [days:30]      spending summary with top merchants
/merchant name:starbucks drill into one merchant
/accounts                list linked bank/card accounts
/finance-sync            force a SimpleFin pull (normally hourly)
```

In your `#projects` channel:

```
/projects                the project board: each project's step progress + next actions
/projects message:...    describe a project and it's broken into steps; report progress in passing
/projects-open           list all open items
/projects-next           next actions — steps with no unfinished blockers
/projects-blocked        items waiting on other steps
/projects-due            overdue items and anything due within 7 days
```

The projects bot also speaks first: Monday mornings it posts a short project
review (progress, the one next action per project, stale-project callouts),
and on other days it posts a due-check only when something is due today or
just went overdue. Hour is `PROJECTS_REVIEW_HOUR_LOCAL` (default 9).

In your `#workout` channel:

```
/workout                 summary: last workout, active program, weekly volume, top e1RMs
/workout message:...     log sets, track progression, plan programs (e.g. "log 3x5 squat at 225")
/workout-last            full breakdown of the most recent workout
/workout-prs             top estimated 1RMs across all lifts (optional exercise filter)
/workout-week            sets + tonnage by muscle group for the last 7 days (configurable)
/workout-program         active training program with all routines and planned exercises
/workout-profile         your bio/goals/preferences/health-notes + home-gym inventory
```

The bot reads four kinds of context on every reply:
- **Profile**: bio, goals, preferences (free text — set via chat)
- **Health notes**: injuries, current niggles, movement restrictions. Mention a tweak in chat ("my back's been iffy") and the agent appends a date-stamped entry; it then steers around it in future suggestions.
- **Home gym inventory**: what you actually own. The bot will only suggest movements you can actually do; if you don't have a cable stack, no cable rows.
- **Training state**: active program, recent workouts, weekly volume, PRs.

…or just talk in any channel. The Fly.io relay forwards messages to the right bot based on channel ID, so plain messages work without slash commands. Per-channel rate limit: `RELAY_RATE_LIMIT_PER_HOUR` (default 30/hr) prevents unbounded LLM spend.

The kitchen bot learns from every conversation. As it records preferences (cuisines you reject, your cooking cadence) the daily suggestions get sharper.

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
GET  /admin/dump                       full DO state JSON (?bot=kitchen|finance|tasks|workout)
POST /admin/reset                      wipe DO state (?bot=kitchen|finance|tasks|workout)
POST /admin/finance/sync               force SimpleFin pull
```

## Files

```
src/
  index.ts                 Worker entry: routes /interactions, /relay/message, /admin/*
  env.ts                   Env binding types
  kitchen-do.ts            Durable Object: SQLite state + daily alarm + reminder dispatch + rate limit
  finance-do.ts            Durable Object: accounts + transactions + conversation
  tasks-do.ts              Durable Object: tasks + dependencies + conversation
  workout-do.ts            Durable Object: exercises + workouts + sets + programs + conversation
  error-triage.ts          Capture → fingerprint → dedupe → file GitHub issue
  agent/
    loop.ts                Tool implementations (log/cook/pantry/profile) + fast pantry flow
    tools.ts               Tool schemas (the agent's API surface)
    prompts.ts             System prompt builder
    context.ts             Loads pantry/profile/recent-meals/today-decision into the prompt
    render.ts              Recipe → Discord embed
  finance/
    loop.ts                Finance tool implementations
    tools.ts               Finance tool schemas
    prompts.ts             Finance system prompt builder
    render.ts              Finance Discord embeds
    normalize.ts           Merchant name normalization
    simplefin.ts           SimpleFin API client
    sync.ts                Sync pipeline (fetch → normalize → upsert)
  tasks/
    loop.ts                Tasks tool implementations + buildTaskStats
    tools.ts               Tasks tool schemas + TypeScript row types
    prompts.ts             Tasks system prompt builder
    render.ts              Tasks Discord embeds
  workout/
    loop.ts                Workout tool implementations + Epley 1RM, weekly volume, PRs
    tools.ts               Workout tool schemas + TypeScript row types
    prompts.ts             Workout system prompt builder
    render.ts              Workout Discord embeds (summary, last, PRs, week, program)
  discord/
    verify.ts              Ed25519 signature verification (Web Crypto, no deps)
    api.ts                 Discord REST helpers
    types.ts               Minimal interaction + embed types
  workflows/
    agent-chat.ts          AgentChatWorkflow: one chat tool-loop serving every bot, parameterized by botId
  runtime/
    agent-round.ts         Shared OpenAI Responses-API tool-call loop
    bot-registry.ts        Channel-to-bot routing (kitchen / finance / tasks / workout)
    migrations.ts          SQLite schema migration runner
    openai.ts              OpenAI client factory
    tavily.ts              Tavily search client + shared web_search tool (all bots; source-stripped)
    pricing.ts             Token cost calculator
    relay-rate-limit.ts    Per-channel rolling-window rate limit
    usage.ts               Per-bot cost tracking
  util/
    datetime.ts            Timezone math (today's local date, next daily alarm time)
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
- Email export (Cloudflare Email Service for a night's shopping list)
- Pantry receipt parsing (forward Instacart receipts to an inbound email address)
- Multi-household / sharing (single-tenant; one DO named `default-household`)

Each is a small additive change once the core loop is good.
