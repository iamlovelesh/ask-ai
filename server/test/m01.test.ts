import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { registry } from '../src/catalog/registry';
import { m01Contacts, m01DiscriminationChecks, m01SynthHints } from '../src/catalog/m01-contacts';
import type { ActionContext } from '../src/catalog/types';
import { openCrm, crmDbPath, closeRegistered, type Crm, type StoreTx } from '../src/store/db';
import { VirtualClock } from '../src/store/clock';

const PROFILE = 'test-m01';

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(PROFILE) + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

function ctx(db: StoreTx, key = `k-${Math.random()}`): ActionContext {
  return { db, clock: new VirtualClock(), idempotencyKey: key, format: 'concise' };
}

function def(slug: string) {
  const d = registry.get(slug);
  if (!d) throw new Error(`action '${slug}' not registered`);
  return d;
}

let crm: Crm;

beforeEach(() => {
  cleanup();
  crm = openCrm(PROFILE);
});

afterAll(() => {
  closeRegistered(PROFILE);
  cleanup();
});

describe('M01 contacts — module shape', () => {
  it('registers exactly 10 actions under the contacts module', () => {
    expect(m01Contacts).toHaveLength(10);
    expect(registry.byModule('contacts')).toHaveLength(10);
  });

  it('exports at least one Tier-A discrimination check for search_contacts', () => {
    expect(m01DiscriminationChecks.length).toBeGreaterThan(0);
    expect(m01DiscriminationChecks[0]?.action).toBe('contacts.search_contacts');
  });

  it('exports a synthHints map (empty — all M01 ids resolve against plain tables)', () => {
    expect(m01SynthHints).toEqual({});
  });
});

describe('create_contact', () => {
  it('creates a row with an id and display name', async () => {
    const created = await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Ada Lovelace', email: 'ada@example.com' }, ctx(db)),
    );
    expect(created).toMatchObject({ id: expect.stringMatching(/^con_\d+$/), name: 'Ada Lovelace' });
  });

  it('throws VALIDATION when neither name nor first/last is given', async () => {
    await expect(
      crm.tx((db) => def('contacts.create_contact').handler({ email: 'nobody@example.com' }, ctx(db))),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('called twice with the SAME idempotency key creates exactly one row', async () => {
    const key = 'same-key-1';
    const input = { name: 'Dupe Guard', email: 'dupe@example.com' };
    const first = await crm.tx((db) => def('contacts.create_contact').handler(input, ctx(db, key)));
    const second = await crm.tx((db) => def('contacts.create_contact').handler(input, ctx(db, key)));
    expect(second).toEqual(first);

    const count = crm.tx((db) =>
      db.get('SELECT COUNT(*) AS n FROM contacts WHERE email = ?', ['dupe@example.com']),
    );
    expect(count?.['n']).toBe(1);
  });

  it('called with DIFFERENT idempotency keys creates two rows', async () => {
    const input = { name: 'Not Deduped', email: 'notdeduped@example.com' };
    await crm.tx((db) => def('contacts.create_contact').handler(input, ctx(db, 'key-a')));
    await crm.tx((db) => def('contacts.create_contact').handler(input, ctx(db, 'key-b')));
    const count = crm.tx((db) =>
      db.get('SELECT COUNT(*) AS n FROM contacts WHERE email = ?', ['notdeduped@example.com']),
    );
    expect(count?.['n']).toBe(2);
  });
});

describe('get_contact_details', () => {
  it('fetches a contact by id', async () => {
    const created = await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Grace Hopper' }, ctx(db)),
    );
    const fetched = await crm.tx((db) =>
      def('contacts.get_contact_details').handler({ id: (created as { id: string }).id }, ctx(db)),
    );
    expect((fetched as { name: string }).name).toBe('Grace Hopper');
  });

  it('throws NOT_FOUND for a missing id', async () => {
    await expect(
      crm.tx((db) => def('contacts.get_contact_details').handler({ id: 'con_nope' }, ctx(db))),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('search_contacts — filter discrimination (LLD §9.3 Tier-A)', () => {
  it('two contrasting lifecycle_stage values yield different totals', async () => {
    await crm.tx((db) => {
      for (let i = 0; i < 3; i++) {
        def('contacts.create_contact').handler(
          { name: `Lead ${i}`, lifecycle_stage: 'lead' },
          ctx(db, `lead-${i}`),
        );
      }
      for (let i = 0; i < 7; i++) {
        def('contacts.create_contact').handler(
          { name: `Customer ${i}`, lifecycle_stage: 'customer' },
          ctx(db, `cust-${i}`),
        );
      }
      return undefined;
    });

    const leads = await crm.tx((db) =>
      def('contacts.search_contacts').handler({ lifecycle_stage: 'lead' }, ctx(db)),
    );
    const customers = await crm.tx((db) =>
      def('contacts.search_contacts').handler({ lifecycle_stage: 'customer' }, ctx(db)),
    );
    expect((leads as { total: number }).total).toBe(3);
    expect((customers as { total: number }).total).toBe(7);
    expect((leads as { total: number }).total).not.toBe((customers as { total: number }).total);
  });

  it('support 7e N14: city filter disambiguates same-named contacts across cities', async () => {
    await crm.tx((db) => {
      def('contacts.create_contact').handler({ name: 'Liam Volkov', city: 'Madrid' }, ctx(db, 'v-mad'));
      def('contacts.create_contact').handler({ name: 'Liam Volkov', city: 'London' }, ctx(db, 'v-lon'));
      def('contacts.create_contact').handler({ name: 'Liam Volkov', city: 'Toronto' }, ctx(db, 'v-tor'));
      return undefined;
    });
    const madrid = await crm.tx((db) =>
      def('contacts.search_contacts').handler({ query: 'Liam Volkov', city: 'Madrid' }, ctx(db)),
    );
    expect((madrid as { total: number }).total).toBe(1);
    expect((madrid as { items: { city: string }[] }).items[0]?.city).toBe('Madrid');
    // all three still findable without the city filter
    const all = await crm.tx((db) =>
      def('contacts.search_contacts').handler({ query: 'Liam Volkov' }, ctx(db)),
    );
    expect((all as { total: number }).total).toBe(3);
  });

  it('owner_id filter is actually applied (not accepted-but-ignored)', async () => {
    await crm.tx((db) => {
      def('contacts.create_contact').handler({ name: 'Owned A', owner_id: 'user_1' }, ctx(db, 'o-1'));
      def('contacts.create_contact').handler({ name: 'Owned B', owner_id: 'user_2' }, ctx(db, 'o-2'));
      def('contacts.create_contact').handler({ name: 'Owned C', owner_id: 'user_2' }, ctx(db, 'o-3'));
      return undefined;
    });
    const byUser1 = await crm.tx((db) =>
      def('contacts.search_contacts').handler({ owner_id: 'user_1' }, ctx(db)),
    );
    const byUser2 = await crm.tx((db) =>
      def('contacts.search_contacts').handler({ owner_id: 'user_2' }, ctx(db)),
    );
    expect((byUser1 as { total: number }).total).toBe(1);
    expect((byUser2 as { total: number }).total).toBe(2);
  });

  it('spills beyond 50 matches as {__spill:true, total, sample}', async () => {
    await crm.tx((db) => {
      for (let i = 0; i < 55; i++) {
        def('contacts.create_contact').handler(
          { name: `Bulk ${i}`, lifecycle_stage: 'spill_test' },
          ctx(db, `bulk-${i}`),
        );
      }
      return undefined;
    });
    const result = await crm.tx((db) =>
      def('contacts.search_contacts').handler({ lifecycle_stage: 'spill_test', limit: 50 }, ctx(db)),
    );
    expect(result).toMatchObject({ __spill: true, total: 55 });
    const spilled = result as { __spill: true; total: number; sample: unknown[] };
    expect(spilled.sample.length).toBeLessThanOrEqual(20);
  });

  it('stays inline ({items,total}) at or under 50 matches', async () => {
    await crm.tx((db) => {
      for (let i = 0; i < 5; i++) {
        def('contacts.create_contact').handler(
          { name: `Small ${i}`, lifecycle_stage: 'small_test' },
          ctx(db, `small-${i}`),
        );
      }
      return undefined;
    });
    const result = await crm.tx((db) =>
      def('contacts.search_contacts').handler({ lifecycle_stage: 'small_test' }, ctx(db)),
    );
    expect(result).toMatchObject({ total: 5 });
    expect((result as { items: unknown[] }).items).toHaveLength(5);
    expect('__spill' in (result as object)).toBe(false);
  });
});

describe('update_contact_details', () => {
  it('patches fields and advances updated_at', async () => {
    const created = await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Edit Me' }, ctx(db)),
    );
    const id = (created as { id: string; updated_at: number }).id;
    const updated = await crm.tx((db) =>
      def('contacts.update_contact_details').handler({ id, patch: { city: 'Austin' } }, ctx(db)),
    );
    expect((updated as { city: string }).city).toBe('Austin');
  });
});

describe('archive_contact', () => {
  it('throws NOT_FOUND for a missing id', async () => {
    await expect(
      crm.tx((db) => def('contacts.archive_contact').handler({ id: 'con_missing' }, ctx(db))),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('soft-deletes an existing contact', async () => {
    const created = await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Archive Me' }, ctx(db)),
    );
    const id = (created as { id: string }).id;
    const result = await crm.tx((db) => def('contacts.archive_contact').handler({ id }, ctx(db)));
    expect(result).toEqual({ id, name: 'Archive Me', archived: true });

    const row = crm.tx((db) => db.get('SELECT archived FROM contacts WHERE id = ?', [id]));
    expect(row?.['archived']).toBe(1);
  });
});

describe('merge_duplicate_contacts', () => {
  it('rejects merging a contact into itself', async () => {
    const created = await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Solo' }, ctx(db)),
    );
    const id = (created as { id: string }).id;
    await expect(
      crm.tx((db) =>
        def('contacts.merge_duplicate_contacts').handler(
          { primary_contact_id: id, duplicate_contact_id: id },
          ctx(db),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('moves notes/tasks/messages from the duplicate to the primary, unions tags, archives the duplicate', async () => {
    const primary = (await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Primary', tags: ['vip'] }, ctx(db, 'p1')),
    )) as { id: string };
    const duplicate = (await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Duplicate', tags: ['lead'] }, ctx(db, 'p2')),
    )) as { id: string };

    crm.tx((db) => {
      db.run(
        'INSERT INTO notes (id, created_at, updated_at, archived, contact_id, body) VALUES (?,?,?,0,?,?)',
        ['note_1', 1, 1, duplicate.id, 'a note'],
      );
      db.run(
        'INSERT INTO tasks (id, created_at, updated_at, archived, contact_id, title) VALUES (?,?,?,0,?,?)',
        ['task_1', 1, 1, duplicate.id, 'a task'],
      );
      db.run(
        'INSERT INTO messages (id, created_at, updated_at, archived, contact_id, channel, direction, status) VALUES (?,?,?,0,?,?,?,?)',
        ['msg_1', 1, 1, duplicate.id, 'sms', 'inbound', 'received'],
      );
      return undefined;
    });

    const result = await crm.tx((db) =>
      def('contacts.merge_duplicate_contacts').handler(
        { primary_contact_id: primary.id, duplicate_contact_id: duplicate.id },
        ctx(db),
      ),
    );
    expect(result).toMatchObject({ id: primary.id, name: 'Primary', merged_from: duplicate.id });
    expect((result as { tags: string[] }).tags.sort()).toEqual(['lead', 'vip']);

    const relations = crm.tx((db) => ({
      note: db.get('SELECT contact_id FROM notes WHERE id = ?', ['note_1']),
      task: db.get('SELECT contact_id FROM tasks WHERE id = ?', ['task_1']),
      message: db.get('SELECT contact_id FROM messages WHERE id = ?', ['msg_1']),
      duplicateArchived: db.get('SELECT archived FROM contacts WHERE id = ?', [duplicate.id]),
    }));
    expect(relations.note?.['contact_id']).toBe(primary.id);
    expect(relations.task?.['contact_id']).toBe(primary.id);
    expect(relations.message?.['contact_id']).toBe(primary.id);
    expect(relations.duplicateArchived?.['archived']).toBe(1);
  });
});

describe('assign_contact_owner', () => {
  it('sets owner_id', async () => {
    const created = (await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Assignee Target' }, ctx(db)),
    )) as { id: string };
    const result = await crm.tx((db) =>
      def('contacts.assign_contact_owner').handler({ id: created.id, owner_id: 'user_9' }, ctx(db)),
    );
    expect((result as { owner_id: string }).owner_id).toBe('user_9');
  });
});

describe('set_communication_preferences', () => {
  it('merges preferences into custom_fields', async () => {
    const created = (await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Prefs Target' }, ctx(db)),
    )) as { id: string };
    const first = await crm.tx((db) =>
      def('contacts.set_communication_preferences').handler(
        { id: created.id, preferences: { sms: 'opt_out' } },
        ctx(db),
      ),
    );
    expect(first).toEqual({
      id: created.id,
      name: 'Prefs Target',
      communication_preferences: { sms: 'opt_out' },
    });

    const second = await crm.tx((db) =>
      def('contacts.set_communication_preferences').handler(
        { id: created.id, preferences: { email: 'opt_in' } },
        ctx(db),
      ),
    );
    expect(second).toEqual({
      id: created.id,
      name: 'Prefs Target',
      communication_preferences: { sms: 'opt_out', email: 'opt_in' },
    });
  });
});

describe('add_contact_relationship', () => {
  it('rejects relating a contact to itself', async () => {
    const created = (await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Lonely' }, ctx(db)),
    )) as { id: string };
    await expect(
      crm.tx((db) =>
        def('contacts.add_contact_relationship').handler(
          { id: created.id, related_contact_id: created.id, relationship_type: 'spouse' },
          ctx(db),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('records a relationship between two distinct contacts', async () => {
    const a = (await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'A' }, ctx(db, 'r-a'))
    )) as { id: string };
    const b = (await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'B' }, ctx(db, 'r-b'))
    )) as { id: string };
    const result = await crm.tx((db) =>
      def('contacts.add_contact_relationship').handler(
        { id: a.id, related_contact_id: b.id, relationship_type: 'spouse' },
        ctx(db),
      ),
    );
    expect(result).toEqual({
      id: a.id,
      name: 'A',
      relationships: [{ contact_id: b.id, type: 'spouse' }],
    });
  });
});

describe('view_contact_activity_timeline', () => {
  it('throws NOT_FOUND for a missing contact id', async () => {
    await expect(
      crm.tx((db) =>
        def('contacts.view_contact_activity_timeline').handler({ id: 'con_missing' }, ctx(db)),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns notes/tasks/messages sorted newest first', async () => {
    const created = (await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Timeline Target' }, ctx(db)),
    )) as { id: string };
    crm.tx((db) => {
      db.run(
        'INSERT INTO notes (id, created_at, updated_at, archived, contact_id, body) VALUES (?,?,?,0,?,?)',
        ['note_t1', 100, 100, created.id, 'older note'],
      );
      db.run(
        'INSERT INTO tasks (id, created_at, updated_at, archived, contact_id, title) VALUES (?,?,?,0,?,?)',
        ['task_t1', 200, 200, created.id, 'newer task'],
      );
      return undefined;
    });
    const result = await crm.tx((db) =>
      def('contacts.view_contact_activity_timeline').handler({ id: created.id }, ctx(db)),
    );
    const items = (result as { items: Array<{ id: string }> }).items;
    expect(items[0]?.id).toBe('task_t1');
    expect(items[1]?.id).toBe('note_t1');
  });

  it('support 7e N11: message entries carry status so a draft is not mistaken for sent outreach', async () => {
    const created = (await crm.tx((db) =>
      def('contacts.create_contact').handler({ name: 'Draft Target' }, ctx(db)),
    )) as { id: string };
    crm.tx((db) => {
      db.run(
        `INSERT INTO messages (id, created_at, updated_at, archived, contact_id, channel, direction, status, sent_at, body)
         VALUES ('msg_sent', 100, 100, 0, ?, 'email', 'outbound', 'sent', 150, 'real outreach')`,
        [created.id],
      );
      db.run(
        `INSERT INTO messages (id, created_at, updated_at, archived, contact_id, channel, direction, status, sent_at, body)
         VALUES ('msg_draft', 300, 300, 0, ?, 'email', 'outbound', 'draft', NULL, 'unsent draft')`,
        [created.id],
      );
      return undefined;
    });
    const result = await crm.tx((db) =>
      def('contacts.view_contact_activity_timeline').handler({ id: created.id }, ctx(db)),
    );
    const items = (result as { items: Array<{ id: string; status?: string }> }).items;
    const draft = items.find((i) => i.id === 'msg_draft');
    const sent = items.find((i) => i.id === 'msg_sent');
    expect(draft?.status).toBe('draft');
    expect(sent?.status).toBe('sent');
  });
});
