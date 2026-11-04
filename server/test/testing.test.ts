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

describe('synthesizeInput — action-scoped (`${slug}:${field}`) hint precedence (task 9 addition)', () => {
  // Adversarial fixture: a flat `widget_id` hint and a `${slug}:widget_id`
  // scoped hint point at DIFFERENT kinds (tag vs coupon), which resolve to
  // DIFFERENT rows in the mixed-kind `structures` table from `beforeAll`
  // above (struct_0/struct_2 = tag, struct_1/struct_3 = coupon). This is
  // exactly the shape task 9 batch 1 needed for M05/M08/M09/M10, whose bare
  // `id` field all share `entities[0] === 'structures'` but a DIFFERENT
  // `kind` each — a flat field-name-keyed hint can't disambiguate between
  // them once merged into one `MODULE_SYNTH_HINTS` object, so the scoped
  // key must win for ITS OWN slug while a different slug using the same
  // field name still falls back to the flat hint.
  const hints = {
    widget_id: { table: 'structures', kind: 'tag' },
    'test.action_scoped:widget_id': { table: 'structures', kind: 'coupon' },
  } as const;

  it('(a) the action-scoped hint wins for the slug it names', () => {
    const def = fakeDef(z.strictObject({ widget_id: z.string() }));
    def.slug = 'test.action_scoped';
    const input = crm.tx((db) => synthesizeInput(def, db, hints)) as { widget_id: string };
    expect(input.widget_id).toBe('struct_1'); // kind='coupon', NOT the flat hint's 'tag'

    const resolved = crm.tx((db) => db.get('SELECT kind FROM structures WHERE id = ?', [input.widget_id]));
    expect(resolved?.['kind']).toBe('coupon');
  });

  it('(b) a DIFFERENT slug using the same field name falls back to the flat field-name hint', () => {
    const def = fakeDef(z.strictObject({ widget_id: z.string() }));
    def.slug = 'test.action_other'; // no scoped entry for this slug in `hints`
    const input = crm.tx((db) => synthesizeInput(def, db, hints)) as { widget_id: string };
    expect(input.widget_id).toBe('struct_0'); // kind='tag', per the flat hint

    const resolved = crm.tx((db) => db.get('SELECT kind FROM structures WHERE id = ?', [input.widget_id]));
    expect(resolved?.['kind']).toBe('tag');
  });

  it('(c) absence of both a scoped AND a flat hint falls back to the entities[0] guess (kind-blind)', () => {
    // Bare `id` field, no hints at all — resolution falls all the way
    // through to `{table: entities[0]}` with no kind filter, so it picks
    // whatever row is lowest by id regardless of kind (the same
    // kind-blind behavior the `beforeAll` fixture's first `it` block
    // characterizes for the unscoped case).
    const def = fakeDef(z.strictObject({ id: z.string() }), ['structures']);
    def.slug = 'test.action_bare';
    const input = crm.tx((db) => synthesizeInput(def, db, {})) as { id: string };
    expect(input.id).toBe('struct_0');
  });
});

describe('synthesizeInput — column-aware hint resolution (`SynthHint.column`, task 9 batch 2 addition)', () => {
  // `messages` (M12 SMS / M13 Email) is a second "shared mega-table" case:
  // it's discriminated by a `channel` column, not `kind` — `SynthHint`'s
  // `column` field (defaults to `'kind'` when omitted) names that column
  // explicitly. Adversarial fixture: id ordering is DELIBERATE — the
  // lowest id ('msg_0') is the WRONG channel ('sms'), so a column-blind
  // resolver (or one that still hardcoded `WHERE kind = ?`, which would
  // outright fail against a table with no `kind` column) would never
  // correctly land on an 'email' row, while a column-aware resolver
  // correctly skips past it to 'msg_1'.
  beforeAll(() => {
    crm.tx((db) => {
      const rows: Array<[string, string]> = [
        ['msg_0', 'sms'],
        ['msg_1', 'email'],
        ['msg_2', 'sms'],
        ['msg_3', 'email'],
      ];
      for (const [id, channel] of rows) {
        db.run(
          `INSERT INTO messages (id, created_at, updated_at, archived, channel)
           VALUES (?, 1, 1, 0, ?)`,
          [id, channel],
        );
      }
      return undefined;
    });
  });

  it('characterization: the lexicographically-first `messages` row is channel=\'sms\'', () => {
    const row = crm.tx((db) => db.get('SELECT id, channel FROM messages ORDER BY id LIMIT 1'));
    expect(row).toMatchObject({ id: 'msg_0', channel: 'sms' });
  });

  it("resolves a `message_id` field to a channel='email' row via an explicit `column:'channel'` hint", () => {
    const def = fakeDef(z.strictObject({ message_id: z.string() }));
    const input = crm.tx((db) =>
      synthesizeInput(def, db, {
        message_id: { table: 'messages', kind: 'email', column: 'channel' },
      }),
    ) as { message_id: string };
    // NOT 'msg_0' — the lexicographically-first row overall is the WRONG
    // channel; the column-aware hint must skip past it.
    expect(input.message_id).toBe('msg_1');

    const resolved = crm.tx((db) =>
      db.get('SELECT channel FROM messages WHERE id = ?', [input.message_id]),
    );
    expect(resolved?.['channel']).toBe('email');
  });

  it('omitting `column` still defaults to `\'kind\'` behavior on a `structures` fixture (backward-compat pin)', () => {
    // Reuses the adversarial `structures` fixture from the outer
    // `beforeAll` (struct_0/struct_2 = 'tag', struct_1/struct_3 =
    // 'coupon') — a hint with NO `column` field must behave EXACTLY as it
    // did before this task's `SynthHint.column` addition: filter on the
    // `kind` column. Pins that every pre-existing (M02-M10) hint, which
    // never declares `column`, is unaffected by this change.
    const def = fakeDef(z.strictObject({ widget_id: z.string() }));
    const input = crm.tx((db) =>
      synthesizeInput(def, db, { widget_id: { table: 'structures', kind: 'coupon' } }),
    ) as { widget_id: string };
    expect(input.widget_id).toBe('struct_1');

    const resolved = crm.tx((db) =>
      db.get('SELECT kind FROM structures WHERE id = ?', [input.widget_id]),
    );
    expect(resolved?.['kind']).toBe('coupon');
  });
});
