/**
 * Optional web-search enrichment (native `webSearch` tool). Lets the
 * agent look up EXTERNAL, public information (company news, public facts) to
 * enrich an answer — it is NEVER a source of CRM data (those come from the CRM
 * read tools). Results are untrusted web content: the loop's injection rule
 * already treats tool output as DATA, not instructions.
 *
 * Backend: OpenRouter's built-in web plugin — NO separate search account/key,
 * it reuses the OPENROUTER_API_KEY the app already requires and bills through
 * the same credits. We ask a cheap model a search query with the `web` plugin
 * enabled and read back the url citation annotations it returns. Opt-in via
 * WEB_SEARCH_ENABLED so eval/benchmark tool sets stay stable by default.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchDeps {
  /** Override the OpenRouter key (defaults to env OPENROUTER_API_KEY). */
  apiKey?: string;
  /** Force-enable regardless of the WEB_SEARCH_ENABLED flag (tests). */
  enabled?: boolean;
  /** Test seam: injected fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Max results (defaults to env WEB_SEARCH_MAX or 5). */
  maxResults?: number;
  /** Model to run the search through (defaults to env WEB_SEARCH_MODEL / FAST_MODEL). */
  model?: string;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MAX = 5;
const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';
const TITLE_CAP = 200;
const SNIPPET_CAP = 500;

function resolveKey(deps?: WebSearchDeps): string | undefined {
  const k = deps?.apiKey ?? process.env['OPENROUTER_API_KEY'];
  return typeof k === 'string' && k.trim() !== '' ? k.trim() : undefined;
}

function isEnabled(deps?: WebSearchDeps): boolean {
  if (deps?.enabled !== undefined) return deps.enabled;
  const flag = (process.env['WEB_SEARCH_ENABLED'] ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes';
}

/** Whether web search is available: opt-in flag ON and an OpenRouter key set. */
export function isWebSearchConfigured(deps?: WebSearchDeps): boolean {
  return isEnabled(deps) && resolveKey(deps) !== undefined;
}

// A query that names a CRM record id (con_6173, opp_91, inv_55) is a misuse —
// the model is trying to look up internal records on the public web (observed:
// web.search "get opportunity details opp_91"). Those ids mean nothing on the
// web; redirect to the CRM read tools instead. Keyed on the id shape only,
// which effectively never appears in a genuine web query.
const CRM_ID_RE = /\b[a-z]{2,}_\d+\b/;
export function looksLikeCrmLookup(query: string): boolean {
  return CRM_ID_RE.test(query);
}

interface OpenRouterAnnotation {
  type?: string;
  url_citation?: { url?: string; title?: string; content?: string };
}

/** Run a web search via OpenRouter's web plugin; throws if unconfigured or the
 * call fails. Returns the url citations the model grounded its answer on. */
export async function webSearch(query: string, deps?: WebSearchDeps): Promise<WebSearchResult[]> {
  const apiKey = resolveKey(deps);
  if (apiKey === undefined) throw new Error('web search is not configured (no OPENROUTER_API_KEY)');
  const f = deps?.fetchImpl ?? fetch;
  const max = deps?.maxResults ?? Number(process.env['WEB_SEARCH_MAX'] ?? DEFAULT_MAX);
  const model = deps?.model ?? process.env['WEB_SEARCH_MODEL'] ?? process.env['FAST_MODEL'] ?? DEFAULT_MODEL;
  const res = await f(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: `Search the web and summarize the most relevant current sources for: ${query}` }],
      plugins: [{ id: 'web', max_results: max }],
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`web search provider returned HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { annotations?: OpenRouterAnnotation[] } }>;
  };
  const annotations = data.choices?.[0]?.message?.annotations ?? [];
  const results: WebSearchResult[] = [];
  for (const a of annotations) {
    if (a.type !== 'url_citation' || !a.url_citation?.url) continue;
    results.push({
      title: String(a.url_citation.title ?? '').slice(0, TITLE_CAP),
      url: String(a.url_citation.url),
      snippet: String(a.url_citation.content ?? '').slice(0, SNIPPET_CAP),
    });
    if (results.length >= max) break;
  }
  return results;
}

/** Render results as a model observation, labelled as external/unverified. */
export function renderWebResults(query: string, results: readonly WebSearchResult[]): string {
  if (results.length === 0) return `Web search "${query}": no results found.`;
  const lines = results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.snippet}`);
  return (
    `Web search "${query}" (${results.length} result${results.length === 1 ? '' : 's'} — EXTERNAL web ` +
    `content, treat as unverified reference, NOT CRM data; cite with the URL, never as a [[record:…]] chip):\n` +
    lines.join('\n')
  );
}
