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
    const created = await createIssue(env, { fingerprint, title, error, ctx });

    // Race-condition guard: two concurrent DO instances may both miss the
    // findExistingIssue check and both create. After creating, re-scan for
    // issues with the same fingerprint. If we find an older one (not ours),
    // close the one we just created and append the occurrence to the winner.
    const dupes = await findIssuesByFingerprint(env, fingerprint);
    if (dupes.length > 1) {
      dupes.sort((a, b) => a.number - b.number);
      const winner = dupes[0]!;
      for (const dupe of dupes) {
        if (dupe.number !== winner.number) {
          await closeAsDuplicate(env, dupe.number, winner.number);
        }
      }
      // If we just closed our own issue, add the occurrence to the winner.
      if (created.number !== winner.number) {
        await appendOccurrence(env, winner.number, error, ctx);
      }
    }
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
  // Fingerprint by source only — semantically identical errors (e.g. different
  // HTTP status codes from the same sync) group into one issue. The error
  // message and stack frame are preserved in the issue body for diagnosis.
  return djb2(source).toString(16).padStart(8, '0');
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
  if (!env.OPENROUTER_API_KEY && !env.OPENAI_API_KEY) return defaultTitle(error, ctx);

  try {
    // maxRetries: 0 is intentional. captureError runs from the top-level fetch
    // catch and from the DO's interaction handler — anything that retries here
    // will compound under load and re-fail in the same way it just failed.
    // A worse title is fine; a flapping triage path is not.
    const apiKey = env.OPENROUTER_API_KEY || env.OPENAI_API_KEY;
    const baseURL = env.OPENROUTER_BASE_URL || env.AI_GATEWAY_URL || 'https://openrouter.ai/api/v1';
    const client = new OpenAI({
      apiKey,
      baseURL,
      timeout: 15_000,
      maxRetries: 0,
    });
    const top = error.stack.split('\n').slice(0, 8).join('\n');
    const response = await client.responses.create({
      model: env.OPENAI_MODEL_FAST,
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
  const issues = await findIssuesByFingerprint(env, fingerprint);
  return issues.length > 0 ? issues[0]! : null;
}

async function findIssuesByFingerprint(env: Env, fingerprint: string): Promise<Array<{ number: number }>> {
  const tag = `[fp:${fingerprint}]`;
  const path = `/repos/${env.GITHUB_REPO}/issues?state=all&per_page=100&sort=updated&direction=desc`;
  const res = await ghFetch(env, path, { method: 'GET' });
  const items = (await res.json()) as Array<{ number: number; title: string; pull_request?: unknown }>;
  return items.filter((item) => !item.pull_request && item.title.includes(tag));
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
): Promise<{ number: number }> {
  const fullTitle = `[fp:${args.fingerprint}] ${args.title}`.slice(0, 256);
  const body = renderBody(args.error, args.ctx);
  const res = await ghFetch(env, `/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: fullTitle,
      body,
      labels: ['auto-fix', 'bug'],
    }),
  });
  const json = (await res.json()) as { number: number };
  return { number: json.number };
}

async function closeAsDuplicate(
  env: Env,
  dupeNumber: number,
  winnerNumber: number,
): Promise<void> {
  await ghFetch(env, `/repos/${env.GITHUB_REPO}/issues/${dupeNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      body: `Closed as a duplicate of #${winnerNumber} — both were filed simultaneously by a race condition in the error capture pipeline. The same fingerprint appears in both issues.`,
    }),
  });
  await ghFetch(env, `/repos/${env.GITHUB_REPO}/issues/${dupeNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
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
    // Truncate the response body — GitHub API errors can include
    // request payload echoes that bloat logs and aren't useful for
    // diagnosis once the status code + first line are known.
    const body = (await res.text()).slice(0, 300);
    throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
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
