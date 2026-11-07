import { describe, it, expect } from 'vitest';
import { isWebSearchConfigured, webSearch, renderWebResults, looksLikeCrmLookup } from '../src/loop/web-search';

function mockFetch(payload: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({ ok, status, json: async () => payload }) as unknown as Response) as unknown as typeof fetch;
}

// OpenRouter web-plugin response: citations ride on message.annotations.
function orResponse(cites: Array<{ url: string; title: string; content: string }>) {
  return {
    choices: [
      {
        message: {
          content: 'summary',
          annotations: cites.map((c) => ({ type: 'url_citation', url_citation: c })),
        },
      },
    ],
  };
}

describe('web-search enrichment (OpenRouter web plugin)', () => {
  it('is available only when enabled AND an OpenRouter key is present', () => {
    expect(isWebSearchConfigured({ enabled: false, apiKey: 'sk-or-1' })).toBe(false); // flag off
    expect(isWebSearchConfigured({ enabled: true, apiKey: '' })).toBe(false); // no key
    expect(isWebSearchConfigured({ enabled: true, apiKey: 'sk-or-1' })).toBe(true);
  });

  it('parses OpenRouter url_citation annotations into {title,url,snippet}, capped', async () => {
    const payload = orResponse([
      { title: 'Acme raises $50M', url: 'https://news.example/acme', content: 'Series C...' },
      { title: 'Acme hires CFO', url: 'https://news.example/cfo', content: 'New finance chief...' },
      { title: 'extra', url: 'https://x', content: 'dropped' },
    ]);
    const out = await webSearch('Acme Corp news', { apiKey: 'sk-or-1', enabled: true, fetchImpl: mockFetch(payload), maxResults: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'Acme raises $50M', url: 'https://news.example/acme', snippet: 'Series C...' });
  });

  it('ignores non-citation annotations and returns [] when there are none', async () => {
    const out = await webSearch('x', { apiKey: 'sk-or-1', enabled: true, fetchImpl: mockFetch(orResponse([])) });
    expect(out).toEqual([]);
  });

  it('throws when no OpenRouter key', async () => {
    await expect(webSearch('x', { apiKey: '' })).rejects.toThrow(/not configured/i);
  });

  it('throws on a non-OK provider response', async () => {
    await expect(webSearch('x', { apiKey: 'sk-or-1', fetchImpl: mockFetch({}, false, 429) })).rejects.toThrow(/HTTP 429/);
  });

  it('flags a query that names CRM record ids as a misuse (route to CRM tools)', () => {
    expect(looksLikeCrmLookup('get opportunity details opp_91 opp_768')).toBe(true);
    expect(looksLikeCrmLookup('everything about con_6173')).toBe(true);
    expect(looksLikeCrmLookup('invoice inv_55 status')).toBe(true);
    // genuine external queries are NOT flagged
    expect(looksLikeCrmLookup('latest news on Acme Corp')).toBe(false);
    expect(looksLikeCrmLookup('Tesla company revenue 2026')).toBe(false);
    expect(looksLikeCrmLookup('who is the CEO of Stripe')).toBe(false);
  });

  it('renders results labelled as external/unverified (not CRM, no chips)', () => {
    const r = renderWebResults('Acme', [{ title: 'T', url: 'https://u', snippet: 'S' }]);
    expect(r).toMatch(/EXTERNAL/i);
    expect(r).toContain('https://u');
    expect(renderWebResults('Acme', [])).toMatch(/no results/i);
  });
});
