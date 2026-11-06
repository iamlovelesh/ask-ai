/**
 * Pinia store for the Memories panel (memory-layer design §4.8). All server
 * I/O for memory management lives here; the panel component reads state and
 * calls actions. Mirrors the session store's plain `fetch('/api/...')` +
 * `res.ok` convention.
 */

import { defineStore } from 'pinia';

export type MemoryCategory = 'preference' | 'fact' | 'goal' | 'context';

export interface MemoryItem {
  id: string;
  userId: string;
  category: MemoryCategory;
  kind: 'profile' | 'collection';
  key?: string;
  body: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

interface MemoryState {
  memories: MemoryItem[];
  enabled: boolean;
  loading: boolean;
  error?: string;
}

export const useMemoryStore = defineStore('memory', {
  state: (): MemoryState => ({ memories: [], enabled: true, loading: false, error: undefined }),
  actions: {
    async fetchMemories(): Promise<void> {
      this.loading = true;
      this.error = undefined;
      try {
        const res = await fetch('/api/memories');
        if (!res.ok) throw new Error(`GET /api/memories failed: ${res.status}`);
        const data = (await res.json()) as { memories: MemoryItem[] };
        this.memories = data.memories;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'failed to load memories';
      } finally {
        this.loading = false;
      }
    },

    async fetchSettings(): Promise<void> {
      this.error = undefined;
      try {
        const res = await fetch('/api/memories/settings');
        if (!res.ok) throw new Error(`GET /api/memories/settings failed: ${res.status}`);
        const data = (await res.json()) as { enabled: boolean };
        this.enabled = data.enabled;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'failed to load settings';
      }
    },

    async updateMemory(id: string, patch: { body?: string; category?: MemoryCategory }): Promise<void> {
      this.error = undefined;
      try {
        const res = await fetch(`/api/memories/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`PATCH /api/memories/${id} failed: ${res.status}`);
        const updated = (await res.json()) as MemoryItem;
        this.memories = this.memories.map((m) => (m.id === id ? updated : m));
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'failed to update memory';
      }
    },

    async deleteMemory(id: string): Promise<void> {
      this.error = undefined;
      try {
        const res = await fetch(`/api/memories/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`DELETE /api/memories/${id} failed: ${res.status}`);
        this.memories = this.memories.filter((m) => m.id !== id);
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'failed to delete memory';
      }
    },

    async setEnabled(enabled: boolean): Promise<void> {
      this.error = undefined;
      try {
        const res = await fetch('/api/memories/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) throw new Error(`PUT /api/memories/settings failed: ${res.status}`);
        this.enabled = enabled;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'failed to update setting';
      }
    },

    async setIncognito(sessionId: string, incognito: boolean): Promise<void> {
      this.error = undefined;
      try {
        const res = await fetch(`/api/sessions/${sessionId}/incognito`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ incognito }),
        });
        if (!res.ok) throw new Error(`PUT incognito failed: ${res.status}`);
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'failed to update incognito';
      }
    },
  },
});
