import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useCatalogStore } from '../catalog.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const CATALOG = {
  modules: [
    {
      module: 'invoices',
      actions: [
        { slug: 'invoices.search_invoices', name: 'Search invoices' },
        { slug: 'invoices.send_invoice_reminder', name: 'Send invoice reminder' },
      ],
    },
  ],
};

describe('useCatalogStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('load() caches the slug→name map and actionName resolves from it', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, CATALOG));
    vi.stubGlobal('fetch', fetchSpy);

    const store = useCatalogStore();
    await store.load();

    expect(store.loaded).toBe(true);
    expect(store.actionName('invoices.search_invoices')).toBe('Search invoices');
    // A slug not in the catalog falls back to the prettified form.
    expect(store.actionName('leads.assign_lead_owner')).toBe('Assign lead owner');
  });

  it('load() is idempotent — a second call does not re-fetch', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, CATALOG));
    vi.stubGlobal('fetch', fetchSpy);

    const store = useCatalogStore();
    await store.load();
    await store.load();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch leaves the map empty and falls back silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));

    const store = useCatalogStore();
    await store.load();

    expect(store.loaded).toBe(false);
    // Falls back to prettify since the catalog never loaded.
    expect(store.actionName('contacts.merge_contacts')).toBe('Merge contacts');
  });
});
