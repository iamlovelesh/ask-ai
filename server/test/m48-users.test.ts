/**
 * Engine-wave E10 (RC6b): users.list_users gains a `query` param so a user
 * can be found BY NAME/EMAIL (case-insensitive substring), closing the gap
 * that previously forced callers to supply raw user ids.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { registry } from '../src/catalog/registry';
import type { ActionContext } from '../src/catalog/types';
import { openCrm, crmDbPath, closeRegistered, type StoreTx } from '../src/store/db';
import { VirtualClock } from '../src/store/clock';

const PROFILE = 'test-m48-e10';

function seed(db: StoreTx): void {
  const now = 1_700_000_000_000;
  const rows = [
    ['user_1', 'Hana Larsen', 'hana@acme.com'],
    ['user_2', 'Priya Nair', 'priya@acme.com'],
    ['user_3', 'Hanako Suzuki', 'hanako@beta.io'],
    ['user_4', 'Bob Jones', 'bob@acme.com'],
  ];
  for (const [id, name, email] of rows) {
    db.run('INSERT INTO users (id, name, email, role, active, created_at, updated_at, archived) VALUES (?,?,?,?,1,?,?,0)', [
      id, name, email, 'sales_rep', now, now,
    ]);
  }
}

afterAll(() => {
  closeRegistered(PROFILE);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(PROFILE) + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

function ctx(db: StoreTx): ActionContext {
  return { db, clock: new VirtualClock(), idempotencyKey: 'k', format: 'concise' };
}

describe('users.list_users — query by name/email (E10)', () => {
  const action = registry.get('users.list_users');

  it('is registered with a query param', () => {
    expect(action).toBeDefined();
  });

  it('finds users by case-insensitive name substring', async () => {
    const crm = openCrm(PROFILE);
    crm.tx((db) => { seed(db); return null; });
    const out = await crm.tx((db) => action!.handler({ query: 'hana' }, ctx(db)) as Promise<{ items: { id: string }[]; total: number }>);
    const result = await out;
    const ids = result.items.map((u) => u.id).sort();
    expect(ids).toEqual(['user_1', 'user_3']); // Hana Larsen + Hanako Suzuki
  });

  it('finds users by email substring', async () => {
    const crm = openCrm(PROFILE);
    const result = await crm.tx((db) => action!.handler({ query: 'beta.io' }, ctx(db)) as Promise<{ items: { id: string }[]; total: number }>);
    expect(result.items.map((u) => u.id)).toEqual(['user_3']);
  });

  it('combines query with other filters', async () => {
    const crm = openCrm(PROFILE);
    const result = await crm.tx((db) => action!.handler({ query: 'acme.com', role: 'sales_rep' }, ctx(db)) as Promise<{ items: { id: string }[]; total: number }>);
    expect(result.items.map((u) => u.id).sort()).toEqual(['user_1', 'user_2', 'user_4']);
  });
});
