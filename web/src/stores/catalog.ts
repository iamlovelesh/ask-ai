/**
 * Action catalog store (Feature B): fetches `GET /admin/catalog` ONCE and
 * caches a `slug → human name` map so every user-facing surface (step rows,
 * confirmation gates) can show an action's human name instead of its raw
 * slug. Until the catalog loads — or for any slug it doesn't carry — callers
 * fall back to `prettifySlug`. The fetch is best-effort: a failure leaves the
 * map empty and every lookup silently falls back, so a missing/again-404ing
 * catalog never breaks the UI.
 */

import { defineStore } from 'pinia';
import { prettifySlug } from '../lib/action-name.js';

interface CatalogAction {
  slug: string;
  name: string;
}
interface CatalogModule {
  module: string;
  actions: CatalogAction[];
}
interface CatalogResponse {
  modules: CatalogModule[];
}

export const useCatalogStore = defineStore('catalog', {
  state: () => ({
    /** slug → human action name, from `/admin/catalog`. */
    names: {} as Record<string, string>,
    loaded: false,
    loading: false,
  }),

  getters: {
    /** The human name for an action slug — the catalog's name when known,
     * else the prettified slug. Returns a function so templates can call
     * `catalog.actionName(step.action)`. */
    actionName(state) {
      return (slug: string): string => {
        if (!slug) return slug;
        return state.names[slug] ?? prettifySlug(slug);
      };
    },
  },

  actions: {
    /** Loads the catalog once. Idempotent: concurrent/repeat calls after a
     * successful (or in-flight) load are no-ops. Best-effort — a failure is
     * swallowed and lookups fall back to `prettifySlug`. */
    async load(): Promise<void> {
      if (this.loaded || this.loading) return;
      this.loading = true;
      try {
        const res = await fetch('/admin/catalog');
        if (!res.ok) throw new Error(`GET /admin/catalog failed: ${res.status}`);
        const body = (await res.json()) as CatalogResponse;
        const map: Record<string, string> = {};
        for (const mod of body.modules ?? []) {
          for (const action of mod.actions ?? []) {
            if (action.slug && action.name) map[action.slug] = action.name;
          }
        }
        this.names = map;
        this.loaded = true;
      } catch {
        // Silent — every lookup falls back to prettifySlug until a later
        // load() succeeds. Allow a retry by leaving `loaded` false.
      } finally {
        this.loading = false;
      }
    },
  },
});
