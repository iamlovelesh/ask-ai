import { describe, it, expect } from 'vitest';
import { coreOps } from '../src/catalog/core-ops';
import type { ActionContext, ActionDef } from '../src/catalog/types';

// core.filter only — the TRIAGE C5 date-coercion fix. Handler ignores ctx.
const coreFilter = coreOps.find((a) => a.slug === 'core.filter') as ActionDef;
const ctx = {} as ActionContext;

async function filter(
  rows: Array<Record<string, unknown>>,
  field: string,
  op: 'eq' | 'neq' | 'gt' | 'lt' | 'contains',
  value: unknown,
): Promise<Array<Record<string, unknown>>> {
  const out = (await coreFilter.handler({ in: rows, field, op, value }, ctx)) as {
    items: Array<Record<string, unknown>>;
  };
  return out.items;
}

const epoch = (iso: string): number => Date.parse(iso);

describe('core.filter — ISO/epoch date coercion (TRIAGE C5)', () => {
  it('coerces an epoch-ms field vs an ISO-8601 value string (lt)', async () => {
    const rows = [
      { id: 'a', created_at: epoch('2026-09-01T00:00:00Z') }, // before cutoff → kept
      { id: 'b', created_at: epoch('2026-11-01T00:00:00Z') }, // after cutoff → dropped
    ];
    const kept = await filter(rows, 'created_at', 'lt', '2026-10-04T00:00:00Z');
    expect(kept.map((r) => r['id'])).toEqual(['a']);
  });

  it('coerces an epoch-ms field vs an ISO value (gt)', async () => {
    const rows = [
      { id: 'a', created_at: epoch('2026-09-01T00:00:00Z') },
      { id: 'b', created_at: epoch('2026-11-01T00:00:00Z') },
    ];
    const kept = await filter(rows, 'created_at', 'gt', '2026-10-04T00:00:00Z');
    expect(kept.map((r) => r['id'])).toEqual(['b']);
  });

  it('coerces in the reverse direction: ISO-string field vs numeric epoch value', async () => {
    const rows = [
      { id: 'a', due: '2026-09-01T00:00:00Z' },
      { id: 'b', due: '2026-07-01T00:00:00Z' },
    ];
    const kept = await filter(rows, 'due', 'gt', epoch('2026-08-01T00:00:00Z'));
    expect(kept.map((r) => r['id'])).toEqual(['a']);
  });

  it('compares TWO ISO-string operands chronologically (E3 string-side hole, F4b)', async () => {
    // Both the field and the cutoff are ISO strings — previously returned
    // null → excluded EVERY row (the silent all-pass/all-drop class).
    const rows = [
      { id: 'stale1', updated_at: '2026-06-19T00:00:00Z' },
      { id: 'stale2', updated_at: '2026-07-01T00:00:00Z' },
      { id: 'fresh1', updated_at: '2026-10-20T00:00:00Z' },
      { id: 'fresh2', updated_at: '2026-10-25T00:00:00Z' },
    ];
    const kept = await filter(rows, 'updated_at', 'lt', '2026-10-05T10:00:00.000Z');
    expect(kept.map((r) => r['id'])).toEqual(['stale1', 'stale2']);
    const after = await filter(rows, 'updated_at', 'gt', '2026-10-05T10:00:00.000Z');
    expect(after.map((r) => r['id'])).toEqual(['fresh1', 'fresh2']);
  });

  it('accepts a date-only ISO value (no time component)', async () => {
    const rows = [{ id: 'a', created_at: epoch('2026-09-01T00:00:00Z') }];
    const kept = await filter(rows, 'created_at', 'lt', '2026-10-04');
    expect(kept.map((r) => r['id'])).toEqual(['a']);
  });

  it('leaves plain number vs number comparisons unchanged', async () => {
    const rows = [{ id: 'a', n: 3 }, { id: 'b', n: 7 }];
    expect((await filter(rows, 'n', 'gt', 5)).map((r) => r['id'])).toEqual(['b']);
    expect((await filter(rows, 'n', 'lt', 5)).map((r) => r['id'])).toEqual(['a']);
  });

  it('does NOT coerce non-date strings (numeric-looking or arbitrary)', async () => {
    // "5" is not ISO-8601 → no coercion → number-vs-number gate fails → dropped.
    expect(await filter([{ id: 'a', v: '5' }], 'v', 'gt', 3)).toEqual([]);
    // both strings, neither numeric → coercion returns null → dropped.
    expect(await filter([{ id: 'a', name: 'acme' }], 'name', 'gt', 'abbb')).toEqual([]);
    // an ISO field vs a non-numeric, non-ISO string → no coercion → dropped.
    expect(await filter([{ id: 'a', due: '2026-09-01' }], 'due', 'lt', 'soon')).toEqual([]);
  });

  it('eq/neq/contains are unaffected by the date-coercion path', async () => {
    const rows = [{ id: 'a', s: 'hello world' }];
    expect(await filter(rows, 's', 'contains', 'world')).toHaveLength(1);
    expect(await filter(rows, 's', 'eq', 'hello world')).toHaveLength(1);
    expect(await filter(rows, 's', 'neq', 'x')).toHaveLength(1);
  });
});

// --- core.sort (P1: ordinal/superlative resolution) ------------------------

const coreSort = coreOps.find((a) => a.slug === 'core.sort') as ActionDef;

async function sortBy(
  rows: Array<Record<string, unknown>>,
  field: string,
  direction: 'asc' | 'desc',
): Promise<Array<Record<string, unknown>>> {
  const out = (await coreSort.handler({ in: rows, field, direction }, ctx)) as {
    items: Array<Record<string, unknown>>;
  };
  return out.items;
}

describe('core.sort — ordinal/superlative resolution (P1)', () => {
  it('"oldest" = ascending by date resolves the true minimum at items[0], not list order', async () => {
    // Arrival order deliberately puts the NEWEST first (the NF1 trap).
    const rows = [
      { id: 'ticket_113', created_at: epoch('2026-09-17T00:00:00Z') }, // newest, arrives first
      { id: 'ticket_280', created_at: epoch('2026-08-01T00:00:00Z') },
      { id: 'ticket_362', created_at: epoch('2026-06-13T00:00:00Z') }, // oldest
    ];
    const asc = await sortBy(rows, 'created_at', 'asc');
    expect(asc[0]?.['id']).toBe('ticket_362');
    const desc = await sortBy(rows, 'created_at', 'desc');
    expect(desc[0]?.['id']).toBe('ticket_113');
  });

  it('sorts ISO-8601 date strings chronologically (not lexically same as numbers)', async () => {
    const rows = [
      { id: 'b', updated_at: '2026-07-23T09:47:18Z' },
      { id: 'a', updated_at: '2026-05-09T00:11:48Z' },
      { id: 'c', updated_at: '2026-10-25T00:00:00Z' },
    ];
    expect((await sortBy(rows, 'updated_at', 'asc')).map((r) => r['id'])).toEqual(['a', 'b', 'c']);
  });

  it('"biggest" = descending by amount resolves the real max', async () => {
    const rows = [
      { id: 'inv_6', owed_cents: 402311 },
      { id: 'inv_688', owed_cents: 1051142 }, // true biggest
      { id: 'inv_25', owed_cents: 283462 },
    ];
    expect((await sortBy(rows, 'owed_cents', 'desc'))[0]?.['id']).toBe('inv_688');
  });

  it('rows missing the field sort LAST in both directions (never masquerade as extremum)', async () => {
    const rows = [
      { id: 'has1', score: 10 },
      { id: 'missing', other: 1 },
      { id: 'has2', score: 50 },
    ];
    expect((await sortBy(rows, 'score', 'asc')).map((r) => r['id'])).toEqual(['has1', 'has2', 'missing']);
    expect((await sortBy(rows, 'score', 'desc')).map((r) => r['id'])).toEqual(['has2', 'has1', 'missing']);
  });

  it('does not mutate the input array', async () => {
    const rows = [{ id: 'a', n: 2 }, { id: 'b', n: 1 }];
    await sortBy(rows, 'n', 'asc');
    expect(rows.map((r) => r['id'])).toEqual(['a', 'b']);
  });
});

// --- core.compute (P3: derived-metric honesty) -----------------------------

const coreCompute = coreOps.find((a) => a.slug === 'core.compute') as ActionDef;

async function compute(
  rows: Array<Record<string, unknown>>,
  left: string,
  op: 'subtract' | 'add' | 'multiply' | 'divide',
  right: string | number,
  as: string,
): Promise<Array<Record<string, unknown>>> {
  const out = (await coreCompute.handler({ in: rows, left, op, right, as }, ctx)) as {
    items: Array<Record<string, unknown>>;
  };
  return out.items;
}

describe('core.compute — derived per-row field (P3)', () => {
  it('amount owed = total_cents subtract amount_paid_cents (field right operand)', async () => {
    const rows = [
      { id: 'inv_1', total_cents: 10000, amount_paid_cents: 3000 },
      { id: 'inv_2', total_cents: 5000, amount_paid_cents: 0 },
    ];
    const out = await compute(rows, 'total_cents', 'subtract', 'amount_paid_cents', 'owed_cents');
    expect(out.map((r) => r['owed_cents'])).toEqual([7000, 5000]);
  });

  it('treats a nullish operand as 0 (unpaid invoice → owed = total)', async () => {
    const rows = [{ id: 'inv_3', total_cents: 8000, amount_paid_cents: null }];
    const out = await compute(rows, 'total_cents', 'subtract', 'amount_paid_cents', 'owed_cents');
    expect(out[0]?.['owed_cents']).toBe(8000);
  });

  it('supports a numeric literal right operand and other ops', async () => {
    const rows = [{ id: 'a', n: 10 }];
    expect((await compute(rows, 'n', 'multiply', 2, 'd'))[0]?.['d']).toBe(20);
    expect((await compute(rows, 'n', 'add', 5, 'd'))[0]?.['d']).toBe(15);
    expect((await compute(rows, 'n', 'divide', 0, 'd'))[0]?.['d']).toBe(null); // div-by-zero → null
  });

  it('non-numeric operand → null (downstream pluck surfaces honest "couldn\'t compute")', async () => {
    const rows = [{ id: 'a', left: 'not a number', amount_paid_cents: 10 }];
    const out = await compute(rows, 'left', 'subtract', 'amount_paid_cents', 'owed');
    expect(out[0]?.['owed']).toBe(null);
  });

  it('does not mutate input rows (adds a new field on copies)', async () => {
    const rows = [{ id: 'a', total_cents: 100, amount_paid_cents: 40 }];
    await compute(rows, 'total_cents', 'subtract', 'amount_paid_cents', 'owed_cents');
    expect('owed_cents' in rows[0]!).toBe(false);
  });
});
