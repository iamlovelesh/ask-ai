import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../session.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('useSessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('send() surfaces a 409 as a toast, not a connection-dropped banner, and clears the running flag', async () => {
    const store = useSessionStore();
    store.activeId = 'sess_1';
    store.ensureChat('sess_1');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/messages')) {
          return jsonResponse(409, { error: 'turn_in_progress' });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await store.send('hello');

    const chat = store.chats['sess_1'];
    expect(chat.running).toBe(false);
    expect(chat.error).toBeNull(); // a 409 is a toast, not a reconnect banner
    expect(store.toasts.map((t) => t.text)).toContain('A turn is already running.');
  });

  it('send() refuses to start a second turn locally while one is already marked running', async () => {
    const store = useSessionStore();
    store.activeId = 'sess_2';
    const chat = store.ensureChat('sess_2');
    chat.running = true;

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await store.send('hello again');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.toasts.map((t) => t.text)).toContain('A turn is already running.');
  });

  it('confirm() optimistically marks the pending confirmation resolved before the network call settles', async () => {
    const store = useSessionStore();
    store.activeId = 'sess_3';
    const chat = store.ensureChat('sess_3');
    chat.turns.push({
      turnId: 't1',
      userText: 'do the risky thing',
      stepOrder: ['s1'],
      steps: {},
      activity: [],
      deltaText: '',
      pendingConfirm: {
        confirmId: 'c1',
        stepId: 's1',
        scope: { actions: ['leads.delete_lead'], affectedCount: 3, targetSample: ['a', 'b'], description: 'Delete 3 leads' },
        resolved: false,
      },
    });
    chat.turnIndex['t1'] = 0;

    let resolvedBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        resolvedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return jsonResponse(204, {});
      }),
    );

    const confirmPromise = store.confirm('c1', true);
    // Synchronous optimistic update — happens before the fetch resolves.
    expect(chat.turns[0].pendingConfirm?.resolved).toBe(true);
    await confirmPromise;
    expect(resolvedBody).toEqual({ approved: true });
  });

  it('loadSessions() sets serverUnreachable on a network failure and clears it on success', async () => {
    const store = useSessionStore();

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    await store.loadSessions();
    expect(store.serverUnreachable).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, [])));
    await store.loadSessions();
    expect(store.serverUnreachable).toBe(false);
  });
});
