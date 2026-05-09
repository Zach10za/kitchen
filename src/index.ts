import type { Env } from './env';
import { verifyDiscordRequest } from './discord/verify';
import { InteractionType, InteractionResponseType, type Interaction } from './discord/types';
import { DiscordAPI } from './discord/api';
import { prepareChatThread } from './discord/thread';
import { currentOrNextMondayISO } from './util/datetime';
import { captureError } from './error-triage';
import { ALL_BOTS, botForChannel, botForCommand } from './runtime/bot-registry';

export { KitchenDO } from './kitchen-do';
export { FinanceDO } from './finance-do';
export { ApproveWorkflow } from './workflows/approve';
export { SteerWorkflow } from './workflows/steer';
export { FinanceSteerWorkflow } from './workflows/finance-steer';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      // Top-level safety net for throws outside the route's explicit handlers.
      ctx.waitUntil(captureError(env, err, { source: 'fetch:uncaught', tags: { url: request.url } }));
      throw err;
    }
  },

  /**
   * Cron heartbeat: pings every bot DO so each can re-arm alarms, dispatch
   * reminders, or run its scheduled work (e.g. FinanceDO syncs from
   * SimpleFin). Runs hourly. The Discord Gateway connection lives on Fly.io.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const bot of ALL_BOTS) {
      const stub = bot.getStub(env);
      ctx.waitUntil(stub.fetch('https://internal/heartbeat', { method: 'POST' }));
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  // Discord posts all interactions to /interactions
  if (url.pathname === '/interactions' && request.method === 'POST') {
    return handleDiscordInteraction(request, env, ctx);
  }

  // Health check
  if (url.pathname === '/health') {
    return new Response('ok');
  }

  // Discord Gateway relay (running on Fly.io) forwards plain-text messages
  // here via shared-secret HTTPS. We pick the bot owning the channel,
  // anchor a thread to the user's message, and dispatch into that bot.
  if (url.pathname === '/relay/message' && request.method === 'POST') {
    if (!relaySecretValid(request, env)) {
      return new Response('forbidden', { status: 403 });
    }
    const body = (await request.json()) as {
      channelId: string;
      /** Set when the message is inside a thread. The relay resolves the
       *  thread's parent so we can route by the bot owning that channel. */
      parentChannelId?: string | null;
      messageId?: string;
      userMessage: string;
      author?: string;
    };
    if (!body.channelId || !body.messageId || !body.userMessage) {
      return new Response('bad request', { status: 400 });
    }

    // Bot ownership is decided by the parent channel when in a thread, else
    // by the channel itself. Per-channel rate limit + reply target both
    // follow from this.
    const ownerChannelId = body.parentChannelId || body.channelId;
    const bot = botForChannel(env, ownerChannelId);
    if (!bot) {
      // Unknown channel — relay must be misconfigured. Drop with 404 so the
      // relay's logs flag the misrouted message.
      return new Response('channel not registered', { status: 404 });
    }

    const stub = bot.getStub(env);
    const rateRes = await stub.fetch('https://internal/relay-allowed', {
      method: 'POST',
      body: JSON.stringify({ channelId: ownerChannelId }),
    });
    if (!rateRes.ok) {
      return new Response('rate limited', { status: 429 });
    }

    // Two reply paths:
    //  1) Top-level message → open a fresh thread anchored to the user's msg.
    //  2) Already in a thread → reuse that thread, no new thread creation.
    let replyChannelId: string;
    if (body.parentChannelId) {
      replyChannelId = body.channelId;
    } else {
      const discord = new DiscordAPI(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID);
      try {
        replyChannelId = await prepareChatThread({
          discord,
          env,
          channelId: body.channelId,
          parentMessageId: body.messageId,
          titleSeed: body.userMessage,
        });
      } catch (err) {
        ctx.waitUntil(captureError(env, err, { source: 'relay:thread-create' }));
        return new Response('thread create failed', { status: 502 });
      }
    }

    if (bot.id === 'kitchen') {
      ctx.waitUntil(
        env.STEER_WORKFLOW.create({
          params: {
            weekOf: currentOrNextMondayISO(env.TIMEZONE),
            replyChannelId,
            userMessage: body.userMessage,
          },
        })
      );
    } else {
      ctx.waitUntil(
        env.FINANCE_STEER_WORKFLOW.create({
          params: { userMessage: body.userMessage, replyChannelId },
        })
      );
    }

    return Response.json({ ok: true });
  }

  // Admin endpoints. All gated on a separate ADMIN_TOKEN secret (NOT the
  // bot token, which is a live production credential), supplied via the
  // Authorization header so it doesn't leak through CDN/proxy access logs.
  //
  // /admin/dump and /admin/reset accept ?bot=kitchen|finance (default kitchen).
  // Kitchen-specific endpoints (/admin/grocery, /admin/clear-grocery) target
  // KitchenDO regardless. /admin/finance/sync forces a SimpleFin pull.
  //
  // Usage:
  //   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://.../admin/dump
  //   curl -H "Authorization: Bearer $ADMIN_TOKEN" 'https://.../admin/dump?bot=finance'
  //   curl -H "Authorization: Bearer $ADMIN_TOKEN" -X POST https://.../admin/finance/sync
  if (url.pathname.startsWith('/admin/')) {
    if (!checkAdmin(request, env)) {
      return new Response('forbidden', { status: 403 });
    }
    const botParam = url.searchParams.get('bot') === 'finance' ? 'finance' : 'kitchen';
    const stub = botParam === 'finance'
      ? env.FINANCE.get(env.FINANCE.idFromName('default-household'))
      : env.KITCHEN.get(env.KITCHEN.idFromName('default-household'));

    if (url.pathname === '/admin/dump' && request.method === 'GET') {
      return stub.fetch('https://internal/dump');
    }
    if (url.pathname === '/admin/reset' && request.method === 'POST') {
      return stub.fetch('https://internal/reset', { method: 'POST' });
    }
    if (url.pathname === '/admin/finance/sync' && request.method === 'POST') {
      const finance = env.FINANCE.get(env.FINANCE.idFromName('default-household'));
      return finance.fetch('https://internal/sync', { method: 'POST' });
    }
    if (url.pathname === '/admin/grocery' && request.method === 'GET') {
      const weekOf = validateWeekOf(url.searchParams.get('week_of'));
      if (!weekOf) return new Response('invalid week_of', { status: 400 });
      const kitchen = env.KITCHEN.get(env.KITCHEN.idFromName('default-household'));
      return kitchen.fetch(`https://internal/get-grocery?week_of=${weekOf}`);
    }
    if (url.pathname === '/admin/clear-grocery' && request.method === 'POST') {
      const weekOf = validateWeekOf(url.searchParams.get('week_of'));
      if (!weekOf) return new Response('invalid week_of', { status: 400 });
      const kitchen = env.KITCHEN.get(env.KITCHEN.idFromName('default-household'));
      return kitchen.fetch(`https://internal/clear-grocery?week_of=${weekOf}`, { method: 'POST' });
    }
    return new Response('not found', { status: 404 });
  }

  return new Response('not found', { status: 404 });
}

async function handleDiscordInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!valid) return new Response('bad signature', { status: 401 });

  const interaction = JSON.parse(body) as Interaction;

  // Discord pings periodically to verify the endpoint is alive.
  if (interaction.type === InteractionType.PING) {
    return Response.json({ type: InteractionResponseType.PONG });
  }

  // Pick the owning bot by command name. MESSAGE_COMPONENT interactions inherit
  // the bot of the originating slash-command; in practice all current components
  // are kitchen-side, so we route those there.
  const commandName = interaction.data?.name ?? '';
  const bot =
    interaction.type === InteractionType.APPLICATION_COMMAND
      ? botForCommand(commandName)
      : botForCommand(commandName); // (same fallback — extend here once a bot owns components)
  const stub = bot.getStub(env);

  // Fast path: pure-read commands with sub-3s budget skip the defer roundtrip
  // and respond inline. Saves ~600-800ms of perceived latency.
  if (interaction.type === InteractionType.APPLICATION_COMMAND && isFastReadCommand(interaction)) {
    const res = await stub.fetch('https://internal/fast-read', {
      method: 'POST',
      body: JSON.stringify(interaction),
    });
    // /fast-read returns a {content?, embeds?} payload as JSON so we can
    // forward embeds through the immediate Discord interaction response.
    const payload = (await res.json()) as { content?: string; embeds?: unknown[] };
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { ...payload, allowed_mentions: { parse: [] } },
    });
  }

  // Slow path: agent-driven commands defer immediately and follow up later.
  if (
    interaction.type === InteractionType.APPLICATION_COMMAND ||
    interaction.type === InteractionType.MESSAGE_COMPONENT
  ) {
    ctx.waitUntil(
      stub.fetch('https://internal/interaction', {
        method: 'POST',
        body: JSON.stringify(interaction),
      })
    );

    return Response.json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });
  }

  return new Response('unknown interaction type', { status: 400 });
}

/** Commands that never need the LLM — pure database reads. */
function isFastReadCommand(interaction: Interaction): boolean {
  const name = interaction.data?.name;
  const hasMessage = (interaction.data?.options ?? []).some(
    (o) => o.name === 'message' && typeof o.value === 'string' && o.value.trim().length > 0
  );

  switch (name) {
    // Kitchen
    case 'profile':
      return !hasMessage;     // /profile (alone) = read; with message = write
    case 'pantry':
      return !hasMessage;     // /pantry (alone) = read; with message = write
    case 'plan':
      return true;            // /plan always reads existing; use /steer to create
    case 'grocery':
      return false;           // routed through DO so it can split into multiple messages
    case 'reminders':
      return true;            // simple list, fits in one message
    // Finance
    case 'finance':
      return !hasMessage;     // /finance (alone) = read; with message = agent
    case 'spending':
      return true;            // pure read
    case 'merchant':
      return true;            // pure read
    case 'accounts':
      return true;            // pure read
    default:
      return false;
  }
}

/**
 * Constant-time-ish admin auth check via Authorization: Bearer <token> header.
 * Avoids putting secrets in URL query strings (which leak through access logs).
 */
function checkAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const auth = request.headers.get('authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match) return false;
  const token = match[1]!.trim();
  // Length-prefix check so the timing comparison can't leak the right length.
  if (token.length !== env.ADMIN_TOKEN.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ env.ADMIN_TOKEN.charCodeAt(i);
  }
  return result === 0;
}

/** Validate week_of query params before forwarding to the DO. */
function validateWeekOf(input: string | null): string | null {
  if (!input) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(input) ? input : null;
}

/** Constant-time-ish check for the shared relay secret. */
function relaySecretValid(request: Request, env: Env): boolean {
  const got = request.headers.get('x-relay-secret') ?? '';
  const expected = env.RELAY_SECRET ?? '';
  if (!expected || got.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < got.length; i++) {
    result |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}
