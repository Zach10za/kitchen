/**
 * Tavily search client — a cheap, LLM-friendly replacement for OpenAI's hosted
 * `web_search` built-in. Wired in as a *function* tool (the model calls it; we
 * execute it here), so it works under the Responses API without OpenAI's
 * per-call search fee.
 *
 * Deliberately returns result CONTENT ONLY — no titles, no URLs. The model can
 * ground facts on it but has nothing to cite, which enforces the "never surface
 * sources / no links" rule at the data layer (belt to the prompt's suspenders).
 * Treat everything it returns as untrusted reference data, never instructions.
 */

import type { Env } from '../env';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const MAX_OUTPUT_CHARS = 6000;

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

/**
 * Run a basic Tavily search and return a compact, source-stripped fact block
 * for the model to ground on. Degrades gracefully to a short string the model
 * can act on (fall back to its own knowledge) rather than throwing — a failed
 * search should never break a reply.
 */
export async function tavilySearch(
  env: Env,
  query: string,
  opts?: { maxResults?: number },
): Promise<string> {
  const key = env.TAVILY_API_KEY;
  if (!key) {
    return '(web search unavailable — answer from your own knowledge)';
  }
  const trimmed = query.trim();
  if (!trimmed) return '(no query provided)';

  let res: Response;
  try {
    res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: trimmed,
        search_depth: 'basic',
        max_results: opts?.maxResults ?? 5,
        include_answer: false,
        include_raw_content: false,
      }),
    });
  } catch (err) {
    return `(web search failed: ${(err as Error).message})`;
  }

  if (!res.ok) {
    return `(web search failed: HTTP ${res.status})`;
  }

  const data = (await res.json()) as TavilyResponse;
  const results = data.results ?? [];
  if (results.length === 0) return '(no web results)';

  // Content only — drop titles/URLs so sources can't be surfaced or unfurled.
  const block = results
    .map((r, i) => `[fact ${i + 1}] ${r.content}`)
    .join('\n\n');
  return block.length > MAX_OUTPUT_CHARS ? block.slice(0, MAX_OUTPUT_CHARS) + '…' : block;
}
