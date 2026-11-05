import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registry, buildRegistry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import { ActionError } from '../src/catalog/types';
import type { ActionDef, ActionContext } from '../src/catalog/types';
import { openCrm, crmDbPath, closeRegistered, type Crm } from '../src/store/db';
import { VirtualClock } from '../src/store/clock';

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(here, '../src/catalog/catalog.json');

interface CatalogEntry {
  id: string;
  module: string;
  moduleName: string;
  name: string;
  slug: string;
}

function noopCtx(): ActionContext {
  return {
    db: { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) },
    clock: new VirtualClock(),
    idempotencyKey: 'test',
    format: 'concise',
  };
}

describe('catalog.json', () => {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as CatalogEntry[];

  it('has exactly 500 entries', () => {
    expect(catalog).toHaveLength(500);
  });

  it('has 50 modules of exactly 10 actions each', () => {
    const counts = new Map<string, number>();
    for (const entry of catalog) {
      counts.set(entry.module, (counts.get(entry.module) ?? 0) + 1);
    }
    expect(counts.size).toBe(50);
    for (const [module, count] of counts) {
      expect(count, `module '${module}' should have 10 actions`).toBe(10);
    }
  });

  it('has unique ids and unique slugs', () => {
    const ids = new Set(catalog.map((e) => e.id));
    const slugs = new Set(catalog.map((e) => e.slug));
    expect(ids.size).toBe(catalog.length);
    expect(slugs.size).toBe(catalog.length);
  });

  it('every entry has the required shape', () => {
    for (const entry of catalog) {
      expect(entry.id).toMatch(/^M\d{2}\.A\d{2}$/);
      expect(entry.module).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(entry.moduleName.length).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.slug.startsWith(`${entry.module}.`)).toBe(true);
      expect(entry.slug).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Registry', () => {
  it('loads the sample module (M01 contacts) and exposes it via byModule()', () => {
    const contactsActions = registry.byModule('contacts');
    expect(contactsActions).toHaveLength(10);
    expect(contactsActions.map((a) => a.slug)).toContain('contacts.create_contact');
  });

  it('get() resolves a known slug and returns undefined for unknown slugs', () => {
    expect(registry.get('contacts.create_contact')?.id).toBe('M01.A01');
    expect(registry.get('nope.does_not_exist')).toBeUndefined();
  });

  it('all() includes module actions and the 8 core ops', () => {
    const all = registry.all();
    const coreSlugs = all.filter((a) => a.module === 'core').map((a) => a.slug);
    expect(coreSlugs.sort()).toEqual(
      [
        'core.anti_join',
        'core.compute',
        'core.distribute',
        'core.exclude_by',
        'core.filter',
        'core.join',
        'core.pluck',
        'core.sort',
      ].sort(),
    );
    expect(all.length).toBeGreaterThanOrEqual(10 + 8);
  });

  it('byModule() for an unknown module returns an empty array', () => {
    expect(registry.byModule('does_not_exist')).toEqual([]);
  });

  it('buildRegistry() rejects duplicate slugs', () => {
    const dupe: ActionDef = { ...(registry.get('contacts.create_contact') as ActionDef) };
    expect(() => buildRegistry([[dupe, { ...dupe, id: 'M99.A01' }]], [])).toThrow(
      /Duplicate action slug 'contacts.create_contact'/,
    );
  });
});

describe('core ops', () => {
  function op(slug: string): ActionDef {
    const def = coreOps.find((o) => o.slug === slug);
    if (!def) throw new Error(`core op '${slug}' not found`);
    return def;
  }

  it('core.filter keeps rows matching the predicate', async () => {
    const result = await op('core.filter').handler(
      { in: [{ status: 'open' }, { status: 'closed' }], field: 'status', op: 'eq', value: 'open' },
      noopCtx(),
    );
    expect(result).toEqual({ items: [{ status: 'open' }] });
  });

  it('core.exclude_by removes rows matching the predicate', async () => {
    const result = await op('core.exclude_by').handler(
      { in: [{ n: 1 }, { n: 2 }, { n: 3 }], field: 'n', op: 'gt', value: 1 },
      noopCtx(),
    );
    expect(result).toEqual({ items: [{ n: 1 }] });
  });

  it('core.anti_join matches the brief example exactly', async () => {
    const result = await op('core.anti_join').handler(
      {
        in: [{ id: 1 }, { id: 2 }],
        key: 'id',
        exclude: [{ cid: 2 }],
        excludeKey: 'cid',
      },
      noopCtx(),
    );
    expect(result).toEqual({ items: [{ id: 1 }] });
  });

  it('core.join enriches matching rows and nulls unmatched ones', async () => {
    const result = await op('core.join').handler(
      {
        in: [{ contact_id: 'c1' }, { contact_id: 'c2' }],
        key: 'contact_id',
        with: [{ id: 'c1', name: 'Ann' }],
        withKey: 'id',
        as: 'contact',
      },
      noopCtx(),
    );
    expect(result).toEqual({
      items: [
        { contact_id: 'c1', contact: { id: 'c1', name: 'Ann' } },
        { contact_id: 'c2', contact: null },
      ],
    });
  });

  it('core.pluck extracts a flat array of the given field', async () => {
    const result = await op('core.pluck').handler(
      { in: [{ id: 'a' }, { id: 'b' }], field: 'id' },
      noopCtx(),
    );
    expect(result).toEqual({ items: ['a', 'b'] });
  });

  it('core.distribute round-robins items across assignees with the normative shape', async () => {
    const result = await op('core.distribute').handler(
      {
        items: [{ id: 'lead1' }, { id: 'lead2' }, { id: 'lead3' }],
        across: ['rep_a', 'rep_b'],
        strategy: 'round_robin',
      },
      noopCtx(),
    );
    expect(result).toEqual({
      items: [
        { item: { id: 'lead1' }, assignee: 'rep_a' },
        { item: { id: 'lead2' }, assignee: 'rep_b' },
        { item: { id: 'lead3' }, assignee: 'rep_a' },
      ],
    });
  });

  it('core.distribute returns no items when there are no assignees', async () => {
    const result = await op('core.distribute').handler(
      { items: [{ id: 'lead1' }], across: [], strategy: 'round_robin' },
      noopCtx(),
    );
    expect(result).toEqual({ items: [] });
  });
});

describe('M01 contacts module — end-to-end against a real CRM store', () => {
  const PROFILE = 'test-registry';
  let crm: Crm;

  function cleanup(): void {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const p = crmDbPath(PROFILE) + suffix;
      if (existsSync(p)) rmSync(p, { force: true });
    }
  }

  beforeAll(() => {
    cleanup();
    crm = openCrm(PROFILE);
  });

  afterAll(() => {
    closeRegistered(PROFILE);
    cleanup();
  });

  it('create_contact → get_contact_details → search_contacts → archive_contact round-trips', async () => {
    const createDef = registry.get('contacts.create_contact');
    const getDef = registry.get('contacts.get_contact_details');
    const searchDef = registry.get('contacts.search_contacts');
    const archiveDef = registry.get('contacts.archive_contact');
    expect(createDef && getDef && searchDef && archiveDef).toBeTruthy();

    const created = await crm.tx(async (db) => {
      const ctx: ActionContext = { db, clock: new VirtualClock(), idempotencyKey: 'k1', format: 'concise' };
      return createDef!.handler({ name: 'Ada Lovelace', email: 'ada@example.com' }, ctx);
    });
    expect((created as { id: string }).id).toMatch(/^con_\d+$/);

    const fetched = await crm.tx(async (db) => {
      const ctx: ActionContext = { db, clock: new VirtualClock(), idempotencyKey: 'k2', format: 'concise' };
      return getDef!.handler({ id: (created as { id: string }).id }, ctx);
    });
    expect((fetched as { name: string }).name).toBe('Ada Lovelace');

    const found = await crm.tx(async (db) => {
      const ctx: ActionContext = { db, clock: new VirtualClock(), idempotencyKey: 'k3', format: 'concise' };
      return searchDef!.handler({ query: 'Lovelace' }, ctx);
    });
    expect((found as { total: number }).total).toBeGreaterThanOrEqual(1);

    const archived = await crm.tx(async (db) => {
      const ctx: ActionContext = { db, clock: new VirtualClock(), idempotencyKey: 'k4', format: 'concise' };
      return archiveDef!.handler({ id: (created as { id: string }).id }, ctx);
    });
    expect(archived).toEqual({
      id: (created as { id: string }).id,
      name: 'Ada Lovelace',
      archived: true,
    });
  });

  it('get_contact_details throws a NOT_FOUND ActionError for a missing id', async () => {
    const getDef = registry.get('contacts.get_contact_details')!;
    await expect(
      crm.tx(async (db) => {
        const ctx: ActionContext = { db, clock: new VirtualClock(), idempotencyKey: 'k5', format: 'concise' };
        return getDef.handler({ id: 'con_does_not_exist' }, ctx);
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<ActionError>);
  });
});
