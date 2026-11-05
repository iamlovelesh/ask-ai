import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { registry } from '../src/catalog/registry';
import type { ActionContext } from '../src/catalog/types';
import { openCrm, crmDbPath, closeRegistered, type Crm, type StoreTx } from '../src/store/db';
import { VirtualClock } from '../src/store/clock';

// P7a: date-range + amount filters on invoices.search_invoices so
// "how much did we invoice in October" / "invoices over $5000" resolve to a
// real query instead of UNKNOWN_PARAM repair-exhaustion (billing R-F7, N10).

const PROFILE = 'test-m28-filters';

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(PROFILE) + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

function ctx(db: StoreTx, key = `k-${Math.random()}`): ActionContext {
  return { db, clock: new VirtualClock(), idempotencyKey: key, format: 'concise' };
}

const ms = (iso: string): number => Date.parse(iso);

function insertInvoice(
  db: StoreTx,
  row: { id: string; number: string; total_cents: number; issued_at: number | null; status?: string },
): void {
  db.run(
    `INSERT INTO invoices (id, created_at, updated_at, archived, number, contact_id, status,
      total_cents, amount_paid_cents, due_date, issued_at, paid_at, quote_id, owner_id, currency)
     VALUES (?, 0, 0, 0, ?, 'con_1', ?, ?, 0, NULL, ?, NULL, NULL, 'user_1', 'USD')`,
    [row.id, row.number, row.status ?? 'issued', row.total_cents, row.issued_at],
  );
}

let crm: Crm;

beforeEach(() => {
  cleanup();
  crm = openCrm(PROFILE);
  crm.tx((db) => {
    db.run('DELETE FROM invoices', []);
    insertInvoice(db, { id: 'inv_oct_a', number: 'INV-9001', total_cents: 200000, issued_at: ms('2026-10-05T00:00:00Z') });
    insertInvoice(db, { id: 'inv_oct_b', number: 'INV-9002', total_cents: 700000, issued_at: ms('2026-10-20T00:00:00Z') });
    insertInvoice(db, { id: 'inv_nov', number: 'INV-9003', total_cents: 100000, issued_at: ms('2026-11-02T00:00:00Z') });
    insertInvoice(db, { id: 'inv_sep', number: 'INV-9004', total_cents: 900000, issued_at: ms('2026-09-15T00:00:00Z') });
    return undefined;
  });
});

afterAll(() => {
  closeRegistered(PROFILE);
  cleanup();
});

function def(slug: string) {
  const d = registry.get(slug);
  if (!d) throw new Error(`action '${slug}' not registered`);
  return d;
}

async function search(params: Record<string, unknown>): Promise<{ items: Array<{ id: string }>; total: number }> {
  return crm.tx((db) =>
    def('invoices.search_invoices').handler(params, ctx(db)),
  ) as Promise<{ items: Array<{ id: string }>; total: number }>;
}

describe('invoices.search_invoices — P7a date/amount filters', () => {
  it('exposes the new params on the input schema', () => {
    const shape = (def('invoices.search_invoices').inputSchema as { shape: Record<string, unknown> }).shape;
    for (const k of ['issued_after', 'issued_before', 'min_amount_cents', 'max_amount_cents']) {
      expect(k in shape).toBe(true);
    }
  });

  it('filters by issue-date range ("invoiced in October")', async () => {
    const res = await search({ issued_after: ms('2026-10-01T00:00:00Z'), issued_before: ms('2026-11-01T00:00:00Z') });
    expect(res.total).toBe(2);
    expect(res.items.map((r) => r.id).sort()).toEqual(['inv_oct_a', 'inv_oct_b']);
  });

  it('filters by minimum amount ("invoices over $5000" = 500000 cents)', async () => {
    const res = await search({ min_amount_cents: 500000 });
    expect(res.items.map((r) => r.id).sort()).toEqual(['inv_oct_b', 'inv_sep']);
  });

  it('combines a date range with an amount floor', async () => {
    const res = await search({ issued_after: ms('2026-10-01T00:00:00Z'), issued_before: ms('2026-11-01T00:00:00Z'), min_amount_cents: 500000 });
    expect(res.items.map((r) => r.id)).toEqual(['inv_oct_b']);
  });
});
