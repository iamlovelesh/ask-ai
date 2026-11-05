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
