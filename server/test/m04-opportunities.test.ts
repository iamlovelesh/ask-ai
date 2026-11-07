import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { registry } from '../src/catalog/registry';
import type { ActionContext, StoreTx } from '../src/catalog/types';
import { openCrm, crmDbPath, closeRegistered, type Crm } from '../src/store/db';
import { VirtualClock } from '../src/store/clock';

const PROFILE = 'test-m04';

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

/** Seed a minimal pipeline (no config.stages → default stage set) and one open
 * opportunity on it; returns the opportunity id. */
async function seedOpenOpp(db: StoreTx): Promise<string> {
  db.run(
    `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, config)
     VALUES ('struct_p1', 0, 0, 0, 'pipeline', 'Sales', '{}')`,
  );
  const created = (await def('opportunities.create_opportunity').handler(
    { name: 'Test Deal', pipeline_id: 'struct_p1', value_cents: 100000 },
    ctx(db),
  )) as unknown as { id: string };
  return created.id;
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

describe('move_opportunity_to_stage keeps status consistent with the stage', () => {
  it('moving to closed_won sets status=won (not left open)', async () => {
    const view = await crm.tx(async (db) => {
      const id = await seedOpenOpp(db);
      return def('opportunities.move_opportunity_to_stage').handler({ id, stage: 'closed_won' }, ctx(db));
    });
    expect(view).toMatchObject({ stage: 'closed_won', status: 'won' });
  });

  it('moving to closed_lost sets status=lost', async () => {
    const view = await crm.tx(async (db) => {
      const id = await seedOpenOpp(db);
      return def('opportunities.move_opportunity_to_stage').handler({ id, stage: 'closed_lost' }, ctx(db));
    });
    expect(view).toMatchObject({ stage: 'closed_lost', status: 'lost' });
  });

  it('moving a closed deal back to an active stage reopens it (status=open)', async () => {
    const view = await crm.tx(async (db) => {
      const id = await seedOpenOpp(db);
      await def('opportunities.move_opportunity_to_stage').handler({ id, stage: 'closed_won' }, ctx(db));
      return def('opportunities.move_opportunity_to_stage').handler({ id, stage: 'negotiation' }, ctx(db));
    });
    expect(view).toMatchObject({ stage: 'negotiation', status: 'open' });
  });

  it('moving between two active stages leaves status open, untouched', async () => {
    const view = await crm.tx(async (db) => {
      const id = await seedOpenOpp(db);
      return def('opportunities.move_opportunity_to_stage').handler({ id, stage: 'proposal' }, ctx(db));
    });
    expect(view).toMatchObject({ stage: 'proposal', status: 'open' });
  });
});
