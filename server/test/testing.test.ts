import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { synthesizeInput } from '../src/catalog/testing';
import type { ActionDef } from '../src/catalog/types';
import { openCrm, crmDbPath, closeRegistered, type Crm } from '../src/store/db';

const PROFILE = 'test-testing-synth';

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(PROFILE) + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

/** Minimal valid ActionDef for exercising `synthesizeInput` in isolation. */
function fakeDef<I>(inputSchema: z.ZodType<I>, entities: string[] = []): ActionDef<I, unknown> {
  return {
    id: 'TEST.A00',
    slug: 'test.fake_action',
    module: 'test',
    name: 'Fake action',
    description: 'test fixture',
    risk: 'read',
    entities,
    inputSchema,
    outputSchema: z.unknown(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: async () => undefined,
  };
}

let crm: Crm;

beforeAll(() => {
  cleanup();
  crm = openCrm(PROFILE);
  // A mixed-kind `structures` table: id ordering is DELIBERATELY adversarial
  // — the lowest id ('struct_0') is the WRONG kind, so a kind-blind resolver
  // (plain "first row in the table") would pick it, while a kind-aware
  // resolver correctly skips past it to 'struct_1'.
  crm.tx((db) => {
    const rows: Array<[string, string]> = [
      ['struct_0', 'tag'],
      ['struct_1', 'coupon'],
      ['struct_2', 'tag'],
      ['struct_3', 'coupon'],
    ];
    for (const [id, kind] of rows) {
      db.run(
        `INSERT INTO structures (id, created_at, updated_at, archived, kind, name)
         VALUES (?, 1, 1, 0, ?, ?)`,
        [id, kind, `${kind} ${id}`],
      );
    }
    return undefined;
  });
});

afterAll(() => {
  closeRegistered(PROFILE);
  cleanup();
});

describe('synthesizeInput — kind-aware id resolution', () => {
  it('a kind-blind lookup (no hint) would return the wrong-kind row', () => {
    // Characterization check: proves the adversarial fixture actually
    // exercises the bug this feature fixes — the lowest id in the mixed
    // table is a 'tag', not a 'coupon'.
    const row = crm.tx((db) => db.get('SELECT id, kind FROM structures ORDER BY id LIMIT 1'));
    expect(row).toMatchObject({ id: 'struct_0', kind: 'tag' });
  });

  it('resolves a `coupon_id` field to a `kind=\'coupon\'` row via an explicit module-declared hint', () => {
    const def = fakeDef(z.strictObject({ coupon_id: z.string() }));
    const input = crm.tx((db) =>
      synthesizeInput(def, db, { coupon_id: { table: 'structures', kind: 'coupon' } }),
    ) as { coupon_id: string };
    expect(input.coupon_id).toBe('struct_1');

    const resolved = crm.tx((db) =>
      db.get('SELECT kind FROM structures WHERE id = ?', [input.coupon_id]),
    );
    expect(resolved?.['kind']).toBe('coupon');
  });

  it('resolves `coupon_id` correctly via the BUILT-IN default hint even with no explicit hints arg', () => {
    const def = fakeDef(z.strictObject({ coupon_id: z.string() }));
    const input = crm.tx((db) => synthesizeInput(def, db)) as { coupon_id: string };
    expect(input.coupon_id).toBe('struct_1');
  });

  it('two coupon_id-shaped fields on the same action get DISTINCT kind-matching rows', () => {
    const def = fakeDef(
      z.strictObject({ coupon_id: z.string(), other_coupon_id: z.string() }),
    );
    const input = crm.tx((db) =>
      synthesizeInput(def, db, {
        coupon_id: { table: 'structures', kind: 'coupon' },
        other_coupon_id: { table: 'structures', kind: 'coupon' },
      }),
    ) as { coupon_id: string; other_coupon_id: string };
    expect(input.coupon_id).toBe('struct_1');
    expect(input.other_coupon_id).toBe('struct_3');
    expect(input.coupon_id).not.toBe(input.other_coupon_id);
  });

  it('an explicit hint passed into synthesizeInput overrides a built-in default', () => {
    // Override coupon_id to resolve against a DIFFERENT kind ('tag')
    // entirely, proving caller-supplied hints win over DEFAULT_HINTS.
    const def = fakeDef(z.strictObject({ coupon_id: z.string() }));
    const input = crm.tx((db) =>
      synthesizeInput(def, db, { coupon_id: { table: 'structures', kind: 'tag' } }),
    ) as { coupon_id: string };
    expect(input.coupon_id).toBe('struct_0');
  });
});
