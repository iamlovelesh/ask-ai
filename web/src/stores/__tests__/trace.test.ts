import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../session.js';
import type { Span } from '../../lib/trace.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const FIXTURE_SPANS: Span[] = [
  { id: 'span_1', turnId: 't1', kind: 'llm', name: 'plan', startedAt: 0, endedAt: 100, ms: 100, tokensIn: 10, tokensOut: 5, costUsd: 0.001 },
];

describe('useSessionStore.loadTrace (Task 19 TraceView)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('fetches GET /api/traces/:turnId and caches the spans', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('/api/traces/t1');
      return jsonResponse(200, { spans: FIXTURE_SPANS });
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = useSessionStore();
    await store.loadTrace('t1');

    expect(store.traces['t1']).toEqual({ spans: FIXTURE_SPANS, loading: false, error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch a trace already cached for the same turnId', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { spans: FIXTURE_SPANS }));
    vi.stubGlobal('fetch', fetchMock);

    const store = useSessionStore();
    await store.loadTrace('t1');
    await store.loadTrace('t1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sets a user-facing error and empties spans on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })));

    const store = useSessionStore();
    await store.loadTrace('t1');

    expect(store.traces['t1'].error).toBe('Could not load the span trace.');
    expect(store.traces['t1'].spans).toEqual([]);
    expect(store.traces['t1'].loading).toBe(false);
  });

  it('sets a user-facing error on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));

    const store = useSessionStore();
    await store.loadTrace('t1');

    expect(store.traces['t1'].error).toBe('Could not load the span trace.');
  });

  it('a turn with zero recorded spans caches an empty, non-error result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { spans: [] })));

    const store = useSessionStore();
    await store.loadTrace('t2');

    expect(store.traces['t2']).toEqual({ spans: [], loading: false, error: null });
  });
});
