import type { Env } from './env';
import { verifyDiscordRequest } from './discord/verify';
import { InteractionType, InteractionResponseType, type Interaction } from './discord/types';
import { currentOrNextMondayISO } from './util/datetime';
import { captureError } from './error-triage';

export { KitchenDO } from './kitchen-do';
export { ApproveWorkflow } from './workflows/approve';
export { SteerWorkflow } from './workflows/steer';

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
   * Cron heartbeat: pings KitchenDO (re-arms alarms, dispatches reminders).
   * Runs hourly. The Discord Gateway connection lives on Fly.io now.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const kitchen = getKitchenStub(env);
    ctx.waitUntil(kitchen.fetch('https://internal/heartbeat', { method: 'POST' }));
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
  // to here via shared-secret HTTPS. We spawn a SteerWorkflow with viaChat=true.
  if (url.pathname === '/relay/message' && request.method === 'POST') {
    if (request.headers.get('x-relay-secret') !== env.RELAY_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const body = (await request.json()) as {
      channelId: string;
      userMessage: string;
      author?: string;
    };
    if (!body.channelId || !body.userMessage) {
      return new Response('bad request', { status: 400 });
    }

    ctx.waitUntil(
      env.STEER_WORKFLOW.create({
        params: {
          weekOf: currentOrNextMondayISO(env.TIMEZONE),
          channelId: body.channelId,
          userMessage: body.userMessage,
          viaChat: true,
        },
      })
    );

    return Response.json({ ok: true });
  }

  // Admin endpoints. All gated on a separate ADMIN_TOKEN secret (NOT the
  // bot token, which is a live production credential), supplied via the
  // Authorization header so it doesn't leak through CDN/proxy access logs.
  //
  // Usage:
  //   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://.../admin/dump
  //   curl -H "Authorization: Bearer $ADMIN_TOKEN" -X POST https://.../admin/reset
  if (url.pathname.startsWith('/admin/')) {
    if (!checkAdmin(request, env)) {
      return new Response('forbidden', { status: 403 });
    }
    const stub = getKitchenStub(env);

    if (url.pathname === '/admin/dump' && request.method === 'GET') {
      return stub.fetch('https://internal/dump');
    }
    if (url.pathname === '/admin/reset' && request.method === 'POST') {
      return stub.fetch('https://internal/reset', { method: 'POST' });
    }
    if (url.pathname === '/admin/grocery' && request.method === 'GET') {
      const weekOf = validateWeekOf(url.searchParams.get('week_of'));
      if (!weekOf) return new Response('invalid week_of', { status: 400 });
      return stub.fetch(`https://internal/get-grocery?week_of=${weekOf}`);
    }
    if (url.pathname === '/admin/clear-grocery' && request.method === 'POST') {
      const weekOf = validateWeekOf(url.searchParams.get('week_of'));
      if (!weekOf) return new Response('invalid week_of', { status: 400 });
      return stub.fetch(`https://internal/clear-grocery?week_of=${weekOf}`, { method: 'POST' });
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

  // Fast path: pure-read commands with sub-3s budget skip the defer roundtrip
  // and respond inline. Saves ~600-800ms of perceived latency.
  if (interaction.type === InteractionType.APPLICATION_COMMAND && isFastReadCommand(interaction)) {
    const stub = getKitchenStub(env);
    const res = await stub.fetch('https://internal/fast-read', {
      method: 'POST',
      body: JSON.stringify(interaction),
    });
    const content = await res.text();
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content, allowed_mentions: { parse: [] } },
    });
  }

  // Slow path: agent-driven commands defer immediately and follow up later.
  if (
    interaction.type === InteractionType.APPLICATION_COMMAND ||
    interaction.type === InteractionType.MESSAGE_COMPONENT
  ) {
    const stub = getKitchenStub(env);
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
    default:
      return false;
  }
}

/** Single-tenant for now: one DO per household, fixed name. */
function getKitchenStub(env: Env) {
  const id = env.KITCHEN.idFromName('default-household');
  return env.KITCHEN.get(id);
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
