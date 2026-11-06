import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useMemoryStore, type MemoryItem } from '../memory.js';

function item(id: string, body: string): MemoryItem {
  return { id, userId: 'user_1', category: 'preference', kind: 'collection', body, source: 'tool', createdAt: 1, updatedAt: 1 };
}

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; json?: unknown }): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const r = handler(String(url), init);
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : null, {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());

describe('useMemoryStore', () => {
  it('fetchMemories populates memories', async () => {
    mockFetch(() => ({ status: 200, json: { memories: [item('m1', 'a'), item('m2', 'b')] } }));
    const store = useMemoryStore();
    await store.fetchMemories();
    expect(store.memories.map((m) => m.body)).toEqual(['a', 'b']);
    expect(store.error).toBeUndefined();
  });

  it('deleteMemory removes the item locally after a 204', async () => {
    const store = useMemoryStore();
    store.memories = [item('m1', 'a'), item('m2', 'b')];
    mockFetch((url, init) => {
      expect(init?.method).toBe('DELETE');
      expect(url).toContain('/api/memories/m1');
      return { status: 204 };
    });
    await store.deleteMemory('m1');
    expect(store.memories.map((m) => m.id)).toEqual(['m2']);
  });

  it('setEnabled updates enabled after a 204', async () => {
    mockFetch(() => ({ status: 204 }));
    const store = useMemoryStore();
    await store.setEnabled(false);
    expect(store.enabled).toBe(false);
  });

  it('a non-OK response leaves state unchanged and records an error', async () => {
    const store = useMemoryStore();
    store.memories = [item('m1', 'a')];
    mockFetch(() => ({ status: 500 }));
    await store.deleteMemory('m1');
    expect(store.memories.map((m) => m.id)).toEqual(['m1']); // unchanged
    expect(store.error).toBeTruthy();
  });
});
