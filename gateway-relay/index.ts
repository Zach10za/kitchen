/**
 * Discord Gateway relay for the kitchen bot.
 *
 * Holds a persistent WebSocket connection to Discord's Gateway, receives
 * MESSAGE_CREATE events for the kitchen channel, and forwards them via HTTPS
 * to the Cloudflare Worker. All state and agent logic stays in Cloudflare.
 *
 * Designed to run on a tiny Fly.io VM (256 MB shared CPU is plenty).
 *
 * Required env:
 *   DISCORD_BOT_TOKEN     — bot's authentication token
 *   DISCORD_CHANNEL_IDS   — comma-separated channel IDs to forward (one per bot:
 *                           kitchen, finance, …). Legacy DISCORD_CHANNEL_ID is
 *                           also accepted as a single-channel fallback.
 *   WORKER_URL            — base URL of the Cloudflare Worker (no trailing slash)
 *   RELAY_SECRET          — shared secret between Fly + Worker
 */

const TOKEN = required('DISCORD_BOT_TOKEN');
const CHANNEL_IDS = parseChannelIds();
const WORKER_URL = required('WORKER_URL');
const RELAY_SECRET = required('RELAY_SECRET');

function parseChannelIds(): Set<string> {
  const list = process.env.DISCORD_CHANNEL_IDS ?? process.env.DISCORD_CHANNEL_ID ?? '';
  const ids = list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    console.error('Missing required env: DISCORD_CHANNEL_IDS (or legacy DISCORD_CHANNEL_ID)');
    process.exit(1);
  }
  return new Set(ids);
}

// Intents:
//   GUILDS (1)              — basic guild metadata
//   GUILD_MESSAGES (1<<9)   — receive MESSAGE_CREATE events
//   MESSAGE_CONTENT (1<<15) — see actual message content (privileged)
const INTENTS = 1 | (1 << 9) | (1 << 15);
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// Gateway opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

interface State {
  ws: WebSocket | null;
  heartbeatInterval: number | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  jitterTimer: ReturnType<typeof setTimeout> | null;
  lastSequence: number | null;
  sessionId: string | null;
  resumeUrl: string | null;
  reconnectAttempts: number;
  lastHeartbeatAck: number | null;
}

const state: State = {
  ws: null,
  heartbeatInterval: null,
  heartbeatTimer: null,
  jitterTimer: null,
  lastSequence: null,
  sessionId: null,
  resumeUrl: null,
  reconnectAttempts: 0,
  lastHeartbeatAck: null,
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

function connect(): void {
  const useResume = !!(state.sessionId && state.resumeUrl && state.lastSequence !== null);
  const url = useResume ? state.resumeUrl! : GATEWAY_URL;
  console.log(`Gateway: connecting (resume=${useResume})`);

  const ws = new WebSocket(url);
  state.ws = ws;
  state.reconnectAttempts++;

  ws.addEventListener('open', () => {
    console.log('Gateway: socket open');
  });

  ws.addEventListener('message', (event) => {
    onMessage(typeof event.data === 'string' ? event.data : '', useResume);
  });

  ws.addEventListener('close', (event) => {
    console.warn(`Gateway: closed code=${event.code} reason=${event.reason}`);
    cleanupTimers();
    state.ws = null;

    // Discord close codes 4004, 4010-4014 are non-recoverable.
    const nonRecoverable = [4004, 4010, 4011, 4012, 4013, 4014];
    if (nonRecoverable.includes(event.code)) {
      console.error('Gateway: non-recoverable close code, exiting');
      process.exit(1);
    }

    // Exponential backoff for reconnect, capped at 60s.
    const backoff = Math.min(60_000, 1000 * Math.pow(2, Math.min(state.reconnectAttempts, 6)));
    console.log(`Gateway: reconnecting in ${backoff}ms`);
    setTimeout(connect, backoff);
  });

  ws.addEventListener('error', (err) => {
    console.error('Gateway: socket error', err);
    // Close handler will fire next.
  });
}

function onMessage(data: string, isResume: boolean): void {
  if (!data) return;
  let payload: { op: number; d: any; s?: number | null; t?: string | null };
  try {
    payload = JSON.parse(data);
  } catch {
    console.error('Gateway: bad JSON');
    return;
  }

  if (payload.s !== null && payload.s !== undefined) {
    state.lastSequence = payload.s;
  }

  switch (payload.op) {
    case OP_HELLO: {
      const interval = payload.d.heartbeat_interval as number;
      state.heartbeatInterval = interval;
      const jitter = Math.random() * interval;
      state.jitterTimer = setTimeout(() => {
        sendHeartbeat();
        state.heartbeatTimer = setInterval(sendHeartbeat, interval);
      }, jitter);
      if (isResume) sendResume();
      else sendIdentify();
      break;
    }
    case OP_HEARTBEAT_ACK:
      state.lastHeartbeatAck = Date.now();
      break;
    case OP_HEARTBEAT:
      sendHeartbeat();
      break;
    case OP_RECONNECT:
      console.log('Gateway: server requested reconnect');
      state.ws?.close(4000, 'reconnect requested');
      break;
    case OP_INVALID_SESSION:
      console.warn('Gateway: invalid session, full re-identify');
      state.sessionId = null;
      state.lastSequence = null;
      state.resumeUrl = null;
      // Discord asks for a 1-5s wait before re-identifying.
      setTimeout(() => state.ws?.close(4000, 'invalid session'), 1000 + Math.random() * 4000);
      break;
    case OP_DISPATCH:
      handleDispatch(payload.t!, payload.d);
      break;
  }
}

function handleDispatch(eventType: string, data: any): void {
  if (eventType === 'READY') {
    state.sessionId = data.session_id;
    state.resumeUrl = `${data.resume_gateway_url}/?v=10&encoding=json`;
    state.reconnectAttempts = 0;
    console.log(`Gateway: READY (session ${state.sessionId})`);
    return;
  }
  if (eventType === 'RESUMED') {
    // Reset reconnect counter on successful resume so the exponential
    // backoff doesn't accumulate from past flaps.
    state.reconnectAttempts = 0;
    console.log('Gateway: RESUMED');
    return;
  }
  if (eventType === 'MESSAGE_CREATE') {
    forwardMessage(data);
  }
  // Ignore everything else (typing, presence, reactions, ...)
}

/**
 * Cache for thread→parent_id lookups. Discord channel IDs are stable, so once
 * we've classified a thread we don't need to ask again. Negative results
 * (channel is unrelated to a watched parent) are cached as null to avoid
 * re-querying every relay event for chatty unrelated channels.
 *
 * Bounded by THREAD_CACHE_MAX with simple FIFO eviction — otherwise this
 * grows unbounded for the lifetime of the process as new threads are
 * created and old ones archive.
 */
const THREAD_CACHE_MAX = 1000;
const threadParentCache = new Map<string, string | null>();
/** Channel types from Discord docs: 10/11/12 are thread types. */
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

function cacheThreadParent(channelId: string, parent: string | null): void {
  if (threadParentCache.size >= THREAD_CACHE_MAX) {
    // FIFO: drop the oldest entry. Map preserves insertion order.
    const oldest = threadParentCache.keys().next().value;
    if (oldest !== undefined) threadParentCache.delete(oldest);
  }
  threadParentCache.set(channelId, parent);
}

async function resolveThreadParent(channelId: string): Promise<string | null> {
  if (threadParentCache.has(channelId)) {
    return threadParentCache.get(channelId)!;
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${TOKEN}` },
    });
    if (!res.ok) {
      // 403/404 happen for channels in guilds we're not in, etc. Cache null.
      cacheThreadParent(channelId, null);
      return null;
    }
    const json = (await res.json()) as { type: number; parent_id?: string | null };
    const parent = THREAD_CHANNEL_TYPES.has(json.type) ? json.parent_id ?? null : null;
    cacheThreadParent(channelId, parent);
    return parent;
  } catch (err) {
    console.warn(`resolveThreadParent failed for ${channelId}:`, err);
    return null;
  }
}

async function forwardMessage(msg: any): Promise<void> {
  // Ignore bot messages (including our own replies).
  if (msg.author?.bot) return;
  // Ignore empty messages (embed-only, attachments without text).
  const content = (msg.content ?? '').trim();
  if (!content) return;

  // Two paths:
  //  1) Top-level message in a watched channel → forward as-is.
  //  2) Message in a thread whose parent is watched → forward with parentChannelId
  //     so the Worker can reply inside the thread instead of opening a new one.
  let parentChannelId: string | null = null;
  if (!CHANNEL_IDS.has(msg.channel_id)) {
    parentChannelId = await resolveThreadParent(msg.channel_id);
    if (!parentChannelId || !CHANNEL_IDS.has(parentChannelId)) return;
  }

  const where = parentChannelId ? `thread of ${parentChannelId}` : 'channel';
  console.log(`Forwarding from ${msg.author?.username} (${where}): ${content.slice(0, 80)}`);

  try {
    const res = await fetch(`${WORKER_URL}/relay/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Secret': RELAY_SECRET,
      },
      body: JSON.stringify({
        channelId: msg.channel_id,
        parentChannelId,
        messageId: msg.id,
        author: msg.author?.username,
        userMessage: content,
      }),
    });
    if (!res.ok) {
      console.error(`Forward failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('Forward error:', err);
  }
}

function sendIdentify(): void {
  send({
    op: OP_IDENTIFY,
    d: {
      token: TOKEN,
      intents: INTENTS,
      properties: {
        os: 'linux',
        browser: 'kitchen-relay',
        device: 'kitchen-relay',
      },
      compress: false,
    },
  });
}

function sendResume(): void {
  send({
    op: OP_RESUME,
    d: { token: TOKEN, session_id: state.sessionId, seq: state.lastSequence },
  });
}

function sendHeartbeat(): void {
  // Discord spec: if we don't receive a HEARTBEAT_ACK between heartbeats, the
  // connection is zombied and we must close it with a non-1000 code so the
  // session can be resumed. Without this check a silently-dead socket would
  // sit indefinitely.
  if (
    state.lastHeartbeatAck !== null &&
    state.heartbeatInterval !== null &&
    Date.now() - state.lastHeartbeatAck > state.heartbeatInterval + 5_000
  ) {
    console.warn('Gateway: zombied (no ACK within heartbeat interval), forcing reconnect');
    try { state.ws?.close(4000, 'zombied connection'); } catch {}
    return;
  }
  send({ op: OP_HEARTBEAT, d: state.lastSequence });
}

function send(payload: object): void {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

function cleanupTimers(): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  if (state.jitterTimer) {
    clearTimeout(state.jitterTimer);
    state.jitterTimer = null;
  }
}

// ─── Health check HTTP server ─────────────────────────────────────────
// Fly checks this to verify the process is alive. Also useful for ad-hoc
// curl checks ("is my gateway alive?").

const healthPort = parseInt(process.env.PORT || '8080', 10);

Bun.serve({
  port: healthPort,
  fetch(_req) {
    // Healthy only if we're connected AND have seen at least one ACK AND that
    // ACK is recent. The previous `!state.lastHeartbeatAck` short-circuit
    // made the check pass at startup before any ACK had been received.
    const connected = state.ws?.readyState === WebSocket.OPEN;
    const recentAck =
      state.lastHeartbeatAck !== null &&
      Date.now() - state.lastHeartbeatAck < 90_000;
    const healthy = connected && recentAck;
    return Response.json(
      {
        status: healthy ? 'ok' : 'unhealthy',
        connected,
        sessionId: state.sessionId,
        lastSequence: state.lastSequence,
        lastHeartbeatAck: state.lastHeartbeatAck
          ? new Date(state.lastHeartbeatAck).toISOString()
          : null,
        reconnectAttempts: state.reconnectAttempts,
        threadCacheSize: threadParentCache.size,
      },
      { status: healthy ? 200 : 503 }
    );
  },
});

console.log(`Health server listening on :${healthPort}`);
console.log(`Worker URL: ${WORKER_URL}`);
console.log(`Channel IDs: ${[...CHANNEL_IDS].join(', ')}`);

// Kick off the gateway connection
connect();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing gateway');
  cleanupTimers();
  state.ws?.close(1000, 'shutdown');
  setTimeout(() => process.exit(0), 1000);
});
