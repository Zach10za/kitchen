import type { Env } from './env';
import { verifyDiscordRequest } from './discord/verify';
import { InteractionType, InteractionResponseType, type Interaction } from './discord/types';

export { KitchenDO } from './kitchen-do';
export { ApproveWorkflow } from './workflows/approve';
export { SteerWorkflow } from './workflows/steer';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Discord posts all interactions to /interactions
    if (url.pathname === '/interactions' && request.method === 'POST') {
      return handleDiscordInteraction(request, env, _ctx);
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok');
    }

    // Temporary debug endpoint — gated on the bot token to keep it self-only.
    // Usage: GET /admin/dump?token=<DISCORD_BOT_TOKEN>
    if (url.pathname === '/admin/dump') {
      if (url.searchParams.get('token') !== env.DISCORD_BOT_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const stub = getKitchenStub(env);
      return stub.fetch('https://internal/dump');
    }

    // Reset endpoint — clears all tables EXCEPT settings (profile) and
    // re-arms the alarm. Use with care.
    // Usage: POST /admin/reset?token=<DISCORD_BOT_TOKEN>
    if (url.pathname === '/admin/reset' && request.method === 'POST') {
      if (url.searchParams.get('token') !== env.DISCORD_BOT_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const stub = getKitchenStub(env);
      return stub.fetch('https://internal/reset', { method: 'POST' });
    }

    // Read the full grocery list JSON for inspection.
    if (url.pathname === '/admin/grocery') {
      if (url.searchParams.get('token') !== env.DISCORD_BOT_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const weekOf = url.searchParams.get('week_of');
      if (!weekOf) return new Response('missing week_of', { status: 400 });
      const stub = getKitchenStub(env);
      return stub.fetch(`https://internal/get-grocery?week_of=${weekOf}`);
    }

    // Drop the grocery list for a given week so /approve will rebuild it.
    // Usage: POST /admin/clear-grocery?token=...&week_of=2026-05-04
    if (url.pathname === '/admin/clear-grocery' && request.method === 'POST') {
      if (url.searchParams.get('token') !== env.DISCORD_BOT_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const weekOf = url.searchParams.get('week_of');
      if (!weekOf) return new Response('missing week_of', { status: 400 });
      const stub = getKitchenStub(env);
      return stub.fetch(`https://internal/clear-grocery?week_of=${weekOf}`, { method: 'POST' });
    }

    return new Response('not found', { status: 404 });
  },

  /**
   * Cron heartbeat: ensures the DO alarm stays armed AND dispatches any
   * due reminders (defrost pings, etc.). Runs hourly.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = getKitchenStub(env);
    ctx.waitUntil(stub.fetch('https://internal/heartbeat', { method: 'POST' }));
  },
};

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
