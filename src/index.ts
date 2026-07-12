import type { Env } from './env';
import { verifyDiscordRequest } from './discord/verify';
import { InteractionType, InteractionResponseType, type Interaction } from './discord/types';
import { DiscordAPI } from './discord/api';
import { prepareChatThread } from './discord/thread';
import { captureError } from './error-triage';
import { ALL_BOTS, botForChannel, botForCommand, getStub, dispatchChat } from './runtime/bot-registry';
import { constantTimeEquals } from './runtime/timing-safe';

export { KitchenDO } from './kitchen-do';
export { FinanceDO } from './finance-do';
export { TasksDO } from './tasks-do';
export { WorkoutDO } from './workout-do';
export { AgentChatWorkflow } from './workflows/agent-chat';

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
      const stub = getStub(env, bot.id);
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
    // follow from this. `??` not `||` so an explicit "" doesn't fall through.
    const ownerChannelId = body.parentChannelId ?? body.channelId;
    const bot = botForChannel(env, ownerChannelId);
    if (!bot) {
      // Unknown channel — relay must be misconfigured. Drop with 404 so the
      // relay's logs flag the misrouted message.
      return new Response('channel not registered', { status: 404 });
    }

    const stub = getStub(env, bot.id);
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

    // Dispatch into the unified AgentChatWorkflow. The registry resolves the
    // bot's default conversation scope (thread_id — the reply thread).
    ctx.waitUntil(dispatchChat(env, bot.id, body.userMessage, replyChannelId));

    return Response.json({ ok: true });
  }

  // Admin endpoints. All gated on a separate ADMIN_TOKEN secret (NOT the
  // bot token, which is a live production credential), supplied via the
  // Authorization header so it doesn't leak through CDN/proxy access logs.
  //
  // /admin/dump and /admin/reset accept ?bot=kitchen|finance|tasks|workout
  // (default kitchen). /admin/finance/sync forces a SimpleFin pull.
  //
  // Usage:
  //   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://.../admin/dump
  //   curl -H "Authorization: Bearer $ADMIN_TOKEN" 'https://.../admin/dump?bot=workout'
  //   curl -H "Authorization: Bearer $ADMIN_TOKEN" -X POST https://.../admin/finance/sync
  if (url.pathname.startsWith('/admin/')) {
    if (!checkAdmin(request, env)) {
      return new Response('forbidden', { status: 403 });
    }
    const rawBot = url.searchParams.get('bot');
    const botParam: 'kitchen' | 'finance' | 'tasks' | 'workout' =
      rawBot === 'finance' ? 'finance'
      : rawBot === 'tasks' ? 'tasks'
      : rawBot === 'workout' ? 'workout'
      : 'kitchen';
    const stub =
      botParam === 'finance'
        ? env.FINANCE.get(env.FINANCE.idFromName('default-household'))
        : botParam === 'tasks'
        ? env.TASKS.get(env.TASKS.idFromName('default-household'))
        : botParam === 'workout'
        ? env.WORKOUT.get(env.WORKOUT.idFromName('default-household'))
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

  // Pick the owning bot by command name. MESSAGE_COMPONENT interactions
  // currently always come from kitchen-owned UIs; if another bot ever
  // introduces components, attach the owning bot id to `custom_id` and
  // branch here. Until then a single lookup covers both paths.
  const commandName = interaction.data?.name ?? '';
  const bot = botForCommand(commandName);
  const stub = getStub(env, bot.id);

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
    // The DO's own handler wraps dispatchCommand in try/catch + captureError,
    // but a failure in DO *construction* (migrations, schema bootstrap, field
    // initializers) throws before that handler runs and rejects this subrequest.
    // Without a catch here that rejection vanishes into waitUntil — the user
    // gets an eternal "thinking…" and nothing is filed. Catch it so the failure
    // is triaged and the user sees an error instead of a hang.
    ctx.waitUntil(
      stub.fetch('https://internal/interaction', {
        method: 'POST',
        body: JSON.stringify(interaction),
      }).then(async (res) => {
        if (!res.ok) throw new Error(`interaction subrequest: HTTP ${res.status}`);
      }).catch(async (err) => {
        await captureError(env, err, {
          source: `interaction-dispatch:${interaction.data?.name ?? 'unknown'}`,
          tags: { interaction_type: interaction.type },
        });
        await new DiscordAPI(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID)
          .editOriginal(interaction.token, `Something broke starting that up: ${(err as Error).message}`)
          .catch(() => {});
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
    case 'reminders':
      return true;            // simple list, fits in one message
    case 'grocery':
      return !hasMessage;     // /grocery (alone) = read; with message = agent
    case 'cookbook':
      return true;            // pure read
    // Finance
    case 'finance':
      return !hasMessage;     // /finance (alone) = read; with message = agent
    case 'spending':
      return true;            // pure read
    case 'merchant':
      return true;            // pure read
    case 'accounts':
      return true;            // pure read
    // Projects
    case 'projects':
      return !hasMessage;     // /projects (alone) = board; with message = agent
    case 'projects-open':
      return true;            // pure read
    case 'projects-next':
      return true;            // pure read
    case 'projects-blocked':
      return true;            // pure read
    case 'projects-due':
      return true;            // pure read
    // Workout
    case 'workout':
      return !hasMessage;     // /workout (alone) = summary; with message = agent
    case 'workout-today':
      return true;            // pure read
    case 'workout-last':
      return true;            // pure read
    case 'workout-prs':
      return true;            // pure read
    case 'workout-week':
      return true;            // pure read
    case 'workout-program':
      return true;            // pure read
    case 'workout-profile':
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
  return constantTimeEquals(match[1]!.trim(), env.ADMIN_TOKEN);
}

/** Constant-time-ish check for the shared relay secret. */
function relaySecretValid(request: Request, env: Env): boolean {
  return constantTimeEquals(
    request.headers.get('x-relay-secret') ?? '',
    env.RELAY_SECRET ?? '',
  );
}
