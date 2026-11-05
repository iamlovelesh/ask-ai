import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../session.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Builds an SSE response body that yields `frames` (each a complete,
 * already-`\n\n`-terminated wire frame string) one per `pull()`, then
 * either errors (simulating a mid-stream drop) or closes cleanly. */
function sseBody(frames: string[], opts: { thenError?: boolean } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(encoder.encode(frames[i]));
        i += 1;
        return;
      }
      if (opts.thenError) {
        controller.error(new Error('simulated mid-stream drop'));
        return;
      }
      controller.close();
    },
  });
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

  // --- Reviewer finding #1: send-failure classification + reconnect cap ---

  it('send(): a pre-stream network failure (zero frames) is a send failure, never routed to reconnect()', async () => {
    const store = useSessionStore();
    store.activeId = 'sess_a';
    const chat = store.ensureChat('sess_a');
    const reconnectSpy = vi.spyOn(store, 'reconnect').mockResolvedValue();

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));

    await store.send('hello');

    expect(reconnectSpy).not.toHaveBeenCalled();
    expect(chat.running).toBe(false);
    expect(chat.error).toBeNull(); // NOT the reconnect banner
    expect(chat.sendError).toBe('Failed to send — could not reach the server.');
    expect(chat.lastFailedText).toBe('hello');
  });

  it('send(): a non-409 HTTP error with zero frames is also a send failure, not a reconnect', async () => {
    const store = useSessionStore();
    store.activeId = 'sess_b';
    const chat = store.ensureChat('sess_b');
    const reconnectSpy = vi.spyOn(store, 'reconnect').mockResolvedValue();

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })));

    await store.send('hi');

    expect(reconnectSpy).not.toHaveBeenCalled();
    expect(chat.sendError).toBe('Failed to send — the server returned HTTP 500.');
    expect(chat.lastFailedText).toBe('hi');
  });

  it('send(): a mid-stream drop (>=1 frame received) hands off to reconnect(), not a send-failure banner', async () => {
    const store = useSessionStore();
    store.activeId = 'sess_c';
    const chat = store.ensureChat('sess_c');
    const reconnectSpy = vi.spyOn(store, 'reconnect').mockResolvedValue();

    const frame =
      'id: 1\nevent: turn.started\ndata: {"seq":1,"t":"turn.started","turnId":"t1","sessionId":"sess_c","userText":"hi","ts":0}\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: sseBody([frame], { thenError: true }) })));

    await store.send('hi');

    expect(reconnectSpy).toHaveBeenCalledWith('sess_c');
    expect(chat.sendError).toBeNull();
    expect(chat.lastFailedText).toBeNull();
    expect(chat.lastSeq).toBe(1); // the one frame that DID arrive was folded before the drop
  });

  it('retrySend() resubmits the text that failed to ever reach the server', async () => {
    const store = useSessionStore();
    store.activeId = 'sess_f';
    store.ensureChat('sess_f');

    // First call (the initial send) rejects outright; every call after
    // that succeeds — including the retried send AND the background
    // `refreshSessionMeta()` GET /api/sessions a successful send triggers.
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      callCount += 1;
      if (callCount === 1) throw new TypeError('Failed to fetch');
      if (String(url).includes('/messages')) return { ok: true, body: sseBody([]) };
      return jsonResponse(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);

    await store.send('retry me');
    expect(store.chats['sess_f'].sendError).not.toBeNull();

    const messagesCallsBefore = fetchMock.mock.calls.filter(([u]) => String(u).includes('/messages')).length;
    await store.retrySend();
    const messagesCallsAfter = fetchMock.mock.calls.filter(([u]) => String(u).includes('/messages')).length;

    expect(messagesCallsAfter).toBe(messagesCallsBefore + 1); // retrySend actually re-POSTed
    expect(store.chats['sess_f'].sendError).toBeNull();
  });

  it('reconnect(): bails with a manual-retry banner after exactly MAX_RECONNECT_ATTEMPTS on a persistent failure', async () => {
    vi.useFakeTimers();
    try {
      const store = useSessionStore();
      const chat = store.ensureChat('sess_d');
      chat.running = true;
      chat.lastSeq = 3;

      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          callCount += 1;
          throw new Error('ECONNREFUSED');
        }),
      );

      const pending = store.reconnect('sess_d');
      await vi.runAllTimersAsync();
      await pending;

      expect(callCount).toBe(5);
      expect(chat.reconnecting).toBe(false);
      expect(chat.error).toMatch(/Lost connection/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnect(): a hung GET /stream (opens, never yields, never closes) is aborted by the per-attempt timeout instead of hanging forever', async () => {
    vi.useFakeTimers();
    try {
      const store = useSessionStore();
      const chat = store.ensureChat('sess_e');
      chat.running = true;
      chat.lastSeq = 7;

      let attempts = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: RequestInit) => {
          attempts += 1;
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
            // Otherwise never settles — simulates a stream that opened but
            // never produces a frame and never closes.
          });
        }),
      );

      const pending = store.reconnect('sess_e');
      await vi.runAllTimersAsync();
      await pending;

      expect(attempts).toBe(5); // each hang was bounded, so all 5 attempts actually ran
      expect(chat.error).toMatch(/Lost connection/);
    } finally {
      vi.useRealTimers();
    }
  });
});
