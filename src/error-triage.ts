import OpenAI from 'openai';
import type { Env } from './env';

/**
 * In-process error capture: dedupes by fingerprint, optionally asks an LLM to
 * write a sharper one-line title, and files (or updates) a GitHub issue with
 * label `auto-fix`. The auto-fix Action picks it up from there.
 *
 * Avoids a separate hosted error tracker — for low volume the only piece
 * worth keeping is "capture + dedupe + open issue", and that's trivial to
 * do directly.
 */
export interface CaptureContext {
  /** Where the error happened — e.g. "interaction:profile" or "alarm:reminder". */
  source: string;
  /** Free-form tags shown in the issue body. Avoid putting user PII here. */
  tags?: Record<string, string | number | undefined>;
}

export async function captureError(env: Env, err: unknown, ctx: CaptureContext): Promise<void> {
  // Auto-fix runtime config — empty repo/token disables capture entirely (e.g.
  // local dev). We never want a failed capture to mask the original error, so
  // every API call is wrapped in its own try/catch.
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return;

  const error = normalizeError(err);
  const fingerprint = computeFingerprint(error, ctx.source);

  try {
    const existing = await findExistingIssue(env, fingerprint);
    if (existing) {
      await appendOccurrence(env, existing.number, error, ctx);
      return;
    }

    const title = await triageTitle(env, error, ctx);
    await createIssue(env, { fingerprint, title, error, ctx });
  } catch (triageErr) {
    console.error('captureError failed', triageErr);
  }
}

interface NormalizedError {
  name: string;
  message: string;
  stack: string;
  topFrame: { file: string; line: number } | null;
}

function normalizeError(err: unknown): NormalizedError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack ?? '',
      topFrame: parseTopFrame(err.stack ?? ''),
    };
  }
  // Non-Error throws (strings, objects). Best-effort.
  const message = typeof err === 'string' ? err : safeStringify(err);
  return { name: 'NonError', message, stack: '', topFrame: null };
}

function parseTopFrame(stack: string): { file: string; line: number } | null {
  // V8-style: "    at functionName (file:line:col)" or "    at file:line:col"
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    const m = line.match(/\(([^)]+):(\d+):(\d+)\)$/) ?? line.match(/at\s+([^\s]+):(\d+):(\d+)$/);
    if (m && m[1] && m[2]) return { file: m[1], line: Number(m[2]) };
  }
  return null;
}

function computeFingerprint(error: NormalizedError, source: string): string {
  // Normalize message: collapse hex/digit runs and UUIDs so e.g.
  // "user 12345 not found" and "user 67890 not found" group together.
  const normalizedMsg = error.message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .slice(0, 200);
  const frame = error.topFrame ? `${error.topFrame.file}:${error.topFrame.line}` : 'unknown';
  const raw = `${source}|${error.name}|${normalizedMsg}|${frame}`;
  return djb2(raw).toString(16).padStart(8, '0');
}

function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  return hash >>> 0; // unsigned
}

async function triageTitle(env: Env, error: NormalizedError, ctx: CaptureContext): Promise<string> {
  // One small LLM call to convert a raw message + stack into a clearer
  // one-liner. Falls back to the raw error message if anything goes wrong —
  // a worse title is much better than failing to file the issue.
  if (!env.OPENAI_API_KEY) return defaultTitle(error, ctx);

  try {
    const client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.AI_GATEWAY_URL || undefined,
      timeout: 15_000,
      maxRetries: 0,
    });
    const top = error.stack.split('\n').slice(0, 8).join('\n');
    const response = await client.responses.create({
      model: 'gpt-5-nano',
      input: [
        {
          role: 'system',
          content:
            'You write concise, specific bug-report titles. One line, ~80 chars max, no quotes, no period. Lead with the user-visible symptom or the failing component, not the exception class.',
        },
        {
          role: 'user',
          content:
            `Error from ${ctx.source}.\n\nMessage: ${error.message}\n\nTop of stack:\n${top}\n\nWrite the title.`,
        },
      ],
    });
    const title = response.output_text?.trim().replace(/^["']|["']$/g, '');
    return title && title.length > 0 ? title.slice(0, 240) : defaultTitle(error, ctx);
  } catch {
    return defaultTitle(error, ctx);
  }
}

function defaultTitle(error: NormalizedError, ctx: CaptureContext): string {
  return `[${ctx.source}] ${error.name}: ${error.message}`.slice(0, 240);
}

async function findExistingIssue(env: Env, fingerprint: string): Promise<{ number: number } | null> {
  const tag = `[fp:${fingerprint}]`;
  const q = encodeURIComponent(`repo:${env.GITHUB_REPO} in:title "${tag}"`);
  const res = await ghFetch(env, `/search/issues?q=${q}&per_page=1`, { method: 'GET' });
  const json = (await res.json()) as { items?: { number: number }[] };
  return json.items?.[0] ?? null;
}

async function appendOccurrence(
  env: Env,
  issueNumber: number,
  error: NormalizedError,
  ctx: CaptureContext,
): Promise<void> {
  const body = [
    `Recurred at ${new Date().toISOString()} from \`${ctx.source}\`.`,
    '',
    '<details><summary>Stack</summary>',
    '',
    '```',
    error.stack || '(no stack)',
    '```',
    '</details>',
  ].join('\n');
  await ghFetch(env, `/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  // Reopen if a previous fix attempt closed it but the bug recurred.
  await ghFetch(env, `/repos/${env.GITHUB_REPO}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'open' }),
  });
}

async function createIssue(
  env: Env,
  args: { fingerprint: string; title: string; error: NormalizedError; ctx: CaptureContext },
): Promise<void> {
  const fullTitle = `[fp:${args.fingerprint}] ${args.title}`.slice(0, 256);
  const body = renderBody(args.error, args.ctx);
  await ghFetch(env, `/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: fullTitle,
      body,
      labels: ['auto-fix', 'bug'],
    }),
  });
}

function renderBody(error: NormalizedError, ctx: CaptureContext): string {
  const tags = ctx.tags
    ? Object.entries(ctx.tags)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `- **${k}:** \`${v}\``)
        .join('\n')
    : '';
  return [
    `**Caught a production error.** The auto-fix Action will pick this up.`,
    '',
    `- **Source:** \`${ctx.source}\``,
    `- **Type:** \`${error.name}\``,
    `- **First seen:** ${new Date().toISOString()}`,
    tags,
    '',
    '### Message',
    '```',
    error.message,
    '```',
    '',
    '### Stack',
    '```',
    error.stack || '(no stack trace)',
    '```',
    '',
    '<sub>Filed automatically. Recurrences are appended as comments and will reopen this issue if it was closed.</sub>',
  ].filter(Boolean).join('\n');
}

async function ghFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kitchen-error-triage',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
