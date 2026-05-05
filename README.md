# Kitchen

A meal-planning agent that lives in your Discord. No app to open, no UI to maintain.

The bot drafts a plan every Friday evening, you steer it in chat, approve when ready, and a grocery list gets posted Sunday morning. During the week you can ask "what now?" for prep instructions and update the pantry as you cook.

## Architecture

- **Cloudflare Worker** — Discord interaction webhook + cron heartbeat
- **Durable Object (`KitchenDO`)** — household state in SQLite, weekly draft alarm
- **OpenAI via AI Gateway** — recipe generation + tool-use chat loop

That's the whole thing. ~1000 lines of TypeScript, no database, no frontend.

## One-time setup

### 1. Install Wrangler

```bash
cd ~/Projects/kitchen
bun install
```

(`bun` 1.3+ required; uses local-installed Wrangler, not global.)

### 2. Create a Cloudflare AI Gateway

In the Cloudflare dashboard:
- AI > AI Gateway > Create Gateway
- Name: `kitchen`
- Copy the OpenAI endpoint URL (looks like `https://gateway.ai.cloudflare.com/v1/<account>/kitchen/openai`)

### 3. Create a Discord application + bot

1. Go to https://discord.com/developers/applications and click **New Application** ("KitchenBot")
2. Under **General Information**, copy:
   - **Application ID** → `DISCORD_APP_ID`
   - **Public Key** → `DISCORD_PUBLIC_KEY`
3. Under **Bot**, click **Reset Token** and copy → `DISCORD_BOT_TOKEN`
4. Under **OAuth2 > URL Generator**, check:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Embed Links`, `Read Message History`
   - Open the generated URL, add the bot to your server
5. In Discord, enable **Settings > Advanced > Developer Mode**, then:
   - Right-click your server → **Copy Server ID** → `DISCORD_GUILD_ID`
   - Right-click the channel you want bot to post in → **Copy Channel ID** → `DISCORD_CHANNEL_ID`

### 4. Set local secrets for development

```bash
cp .dev.vars.example .dev.vars
# Fill in all the values you collected above
```

### 5. Register slash commands (one-time)

```bash
bun run register-commands
```

You should see `/plan`, `/steer`, `/now`, `/pantry`, `/approve`, `/grocery` registered.

### 6. Deploy

```bash
bunx wrangler login        # interactive
bunx wrangler deploy
```

Then set production secrets (these don't go in wrangler.jsonc):

```bash
bunx wrangler secret put DISCORD_PUBLIC_KEY
bunx wrangler secret put DISCORD_BOT_TOKEN
bunx wrangler secret put DISCORD_APP_ID
bunx wrangler secret put DISCORD_GUILD_ID
bunx wrangler secret put DISCORD_CHANNEL_ID
bunx wrangler secret put OPENAI_API_KEY
bunx wrangler secret put AI_GATEWAY_URL
```

### 7. Point Discord at your Worker

After `wrangler deploy` you'll get a URL like `https://kitchen.<your-subdomain>.workers.dev`.

In the Discord developer portal under your application's **General Information**:
- Set **Interactions Endpoint URL** to `https://kitchen.<your-subdomain>.workers.dev/interactions`
- Discord will ping it; if the URL saves, signature verification is working.

### 8. Arm the alarm

The first time the cron heartbeat fires (top of the hour), the DO arms its weekly draft alarm. To trigger immediately:

```bash
curl -X POST https://kitchen.<your-subdomain>.workers.dev/health
# (no-op, just warms the Worker; the cron will arm the DO within an hour)
```

Or just wait — the next Friday 6pm in `America/Los_Angeles` you'll get a draft.

## Day-to-day usage

In your Discord channel:

```
/plan                    show the current plan or draft a new one
/steer message:swap tue for something with the salmon, and thu needs to be 20 min
/now                     what should i be cooking right now?
/pantry message:bought salmon, bok choy, scallions
/approve                 lock in the plan and get the grocery list
/grocery                 reshow the grocery list
```

Mid-week:
- "didn't make wed, push it to fri" → `/steer`
- "use the leftover chicken thursday" → `/steer`
- "no more soy sauce" → `/pantry`

The bot learns from every steering conversation. After a few weeks the drafts arrive ~80% of the way there.

## Local development

```bash
bun run dev         # wrangler dev with .dev.vars secrets
bun run tail        # stream production logs
bun run typecheck   # type-check without emit
```

For local Discord testing you'll need `cloudflared tunnel` or similar to expose localhost — not usually worth it. Easier to deploy and test against the live Worker.

## Files

```
src/
  index.ts                 Worker entry: routes Discord webhooks
  env.ts                   Env binding types
  kitchen-do.ts            Durable Object: state + alarm + interaction routing
  discord/
    verify.ts              Ed25519 signature verification (Web Crypto, no deps)
    api.ts                 Discord REST helpers
    types.ts               Minimal interaction types
  agent/
    loop.ts                OpenAI tool-use loop + tool implementations
    tools.ts               Tool schemas (this is the agent's API surface)
    prompts.ts             System prompt builder
    render.ts              Plan / recipe / grocery list -> Markdown
scripts/
  register-commands.ts     One-shot slash command registration
```

## What's NOT here (yet)

- Voice (Cloudflare Voice Agents would replace `/now` with a phone call)
- Email export (Cloudflare Email Service for the grocery list)
- Pantry receipt parsing (forward Instacart receipts to an inbound email)
- Mid-week prep reminders (extend the alarm pattern with multi-step Workflow)
- Multi-household / sharing (currently single-tenant, hardcoded to one DO)

Each is a small additive change once the core loop is good.
