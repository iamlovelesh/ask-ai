/**
 * Optional web-search enrichment (native `webSearch` tool). Lets the
 * agent look up EXTERNAL, public information (company news, public facts) to
 * enrich an answer — it is NEVER a source of CRM data (those come from the CRM
 * read tools). Results are untrusted web content: the loop's injection rule
 * already treats tool output as DATA, not instructions.
 *
 * Disabled unless a provider key is configured, so a deployment without web
 * access simply never sees the tool. Provider: Tavily (a simple LLM-search
 * API); swap the adapter below to use a different provider.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchDeps {
  /** Override the provider key (defaults to env TAVILY_API_KEY). */
  apiKey?: string;
  /** Test seam: injected fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Max results (defaults to env WEB_SEARCH_MAX or 5). */
  maxResults?: number;
}

const ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_MAX = 5;
const TITLE_CAP = 200;
const SNIPPET_CAP = 500;

function resolveKey(deps?: WebSearchDeps): string | undefined {
  const k = deps?.apiKey ?? process.env['TAVILY_API_KEY'];
  return typeof k === 'string' && k.trim() !== '' ? k.trim() : undefined;
}

/** Whether web search is available (a provider key is configured). */
export function isWebSearchConfigured(deps?: WebSearchDeps): boolean {
  return resolveKey(deps) !== undefined;
}

/** Run a web search; throws if unconfigured or the provider call fails. */
export async function webSearch(query: string, deps?: WebSearchDeps): Promise<WebSearchResult[]> {
  const apiKey = resolveKey(deps);
  if (apiKey === undefined) throw new Error('web search is not configured');
  const f = deps?.fetchImpl ?? fetch;
  const max = deps?.maxResults ?? Number(process.env['WEB_SEARCH_MAX'] ?? DEFAULT_MAX);
  const res = await f(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: max, search_depth: 'basic' }),
  });
  if (!res.ok) throw new Error(`web search provider returned HTTP ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, max).map((r) => ({
    title: String(r.title ?? '').slice(0, TITLE_CAP),
    url: String(r.url ?? ''),
    snippet: String(r.content ?? '').slice(0, SNIPPET_CAP),
  }));
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
