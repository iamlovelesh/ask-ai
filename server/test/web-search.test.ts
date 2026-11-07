import { describe, it, expect } from 'vitest';
import { isWebSearchConfigured, webSearch, renderWebResults } from '../src/loop/web-search';

function mockFetch(payload: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({ ok, status, json: async () => payload }) as unknown as Response) as unknown as typeof fetch;
}

describe('web-search enrichment', () => {
  it('is disabled without a provider key, enabled with one', () => {
    expect(isWebSearchConfigured({ apiKey: '' })).toBe(false);
    expect(isWebSearchConfigured({ apiKey: '   ' })).toBe(false);
    expect(isWebSearchConfigured({ apiKey: 'tvly-123' })).toBe(true);
  });

  it('parses provider results into {title,url,snippet}, capped to maxResults', async () => {
    const payload = {
      results: [
        { title: 'Acme raises $50M', url: 'https://news.example/acme', content: 'Acme Corp announced a Series C...' },
        { title: 'Acme hires CFO', url: 'https://news.example/cfo', content: 'New finance chief...' },
        { title: 'extra', url: 'https://x', content: 'should be dropped' },
      ],
    };
    const out = await webSearch('Acme Corp news', { apiKey: 'tvly-123', fetchImpl: mockFetch(payload), maxResults: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'Acme raises $50M', url: 'https://news.example/acme', snippet: 'Acme Corp announced a Series C...' });
  });

  it('throws when unconfigured', async () => {
    await expect(webSearch('x', { apiKey: '' })).rejects.toThrow(/not configured/i);
  });

  it('throws on a non-OK provider response', async () => {
    await expect(webSearch('x', { apiKey: 'k', fetchImpl: mockFetch({}, false, 429) })).rejects.toThrow(/HTTP 429/);
  });

  it('renders results labelled as external/unverified (not CRM, no chips)', () => {
    const r = renderWebResults('Acme', [{ title: 'T', url: 'https://u', snippet: 'S' }]);
    expect(r).toMatch(/EXTERNAL/i);
    expect(r).toContain('https://u');
    expect(renderWebResults('Acme', [])).toMatch(/no results/i);
  });
});
