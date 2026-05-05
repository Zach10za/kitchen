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
 *   DISCORD_CHANNEL_ID    — kitchen channel ID (we filter by this)
 *   WORKER_URL            — base URL of the Cloudflare Worker (no trailing slash)
 *   RELAY_SECRET          — shared secret between Fly + Worker
 */

const TOKEN = required('DISCORD_BOT_TOKEN');
const CHANNEL_ID = required('DISCORD_CHANNEL_ID');
const WORKER_URL = required('WORKER_URL');
const RELAY_SECRET = required('RELAY_SECRET');

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

async function forwardMessage(msg: any): Promise<void> {
  // Filter: only kitchen channel
  if (msg.channel_id !== CHANNEL_ID) return;
  // Filter: ignore bot messages (including ourselves)
  if (msg.author?.bot) return;
  // Filter: ignore empty messages (embed-only, attachments without text)
  const content = (msg.content ?? '').trim();
  if (!content) return;

  console.log(`Forwarding from ${msg.author?.username}: ${content.slice(0, 80)}`);

  try {
    const res = await fetch(`${WORKER_URL}/relay/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Secret': RELAY_SECRET,
      },
      body: JSON.stringify({
        channelId: msg.channel_id,
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
    const healthy = state.ws?.readyState === WebSocket.OPEN && (
      !state.lastHeartbeatAck || Date.now() - state.lastHeartbeatAck < 90_000
    );
    return Response.json(
      {
        status: healthy ? 'ok' : 'unhealthy',
        connected: state.ws?.readyState === WebSocket.OPEN,
        sessionId: state.sessionId,
        lastSequence: state.lastSequence,
        lastHeartbeatAck: state.lastHeartbeatAck
          ? new Date(state.lastHeartbeatAck).toISOString()
          : null,
        reconnectAttempts: state.reconnectAttempts,
      },
      { status: healthy ? 200 : 503 }
    );
  },
});

console.log(`Health server listening on :${healthPort}`);
console.log(`Worker URL: ${WORKER_URL}`);
console.log(`Channel ID: ${CHANNEL_ID}`);

// Kick off the gateway connection
connect();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing gateway');
  cleanupTimers();
  state.ws?.close(1000, 'shutdown');
  setTimeout(() => process.exit(0), 1000);
});
