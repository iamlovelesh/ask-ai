import { describe, it, expect } from 'vitest';
import {
  toListOrSpill,
  captureSpillIdList,
  SPILL_CAP,
  SPILL_IDLIST_CAP,
  type SpillIdCaptureSpec,
} from '../src/catalog/list-output';
import { BUDGETS } from '../src/agent/validator';
import type { Row, StoreTx } from '../src/store/db';

/** A fake `StoreTx` whose `all()` answers `SELECT id FROM <table> WHERE
 * <whereSql> LIMIT ?` against an in-memory id list, honoring the `LIMIT`
 * bind param the way real sqlite does. Good enough to unit-test
 * `captureSpillIdList` without a real DB. */
function fakeDb(ids: readonly string[]): StoreTx {
  return {
    all: (_sql: string, params?: unknown[]) => {
      const limit = Number((params ?? [])[(params ?? []).length - 1]);
      return ids.slice(0, limit).map((id): Row => ({ id }));
    },
    get: () => undefined,
    run: () => ({ changes: 0 }),
  };
}

describe('SPILL_IDLIST_CAP (read-hydration ceiling)', () => {
  it('is 10k — decoupled from write caps, which live at the write sites', () => {
    // Round-5: the old forEachHardCap×2 coupling starved READ hydration
    // (sort/filter/aggregate over 5000 rows died as "incomplete"). Write
    // ceilings are enforced where writes happen (loop data__apply_to_ref:
    // 1000; executor forEach: BUDGETS.forEachHardCap) — the capture cap
    // only bounds memory, and must stay comfortably above the write caps.
    expect(SPILL_IDLIST_CAP).toBe(10_000);
    expect(SPILL_IDLIST_CAP).toBeGreaterThanOrEqual(BUDGETS.forEachHardCap * 2);
  });
});

describe('captureSpillIdList', () => {
  it('returns the full id set when under the cap', () => {
    const ids = Array.from({ length: 165 }, (_, i) => `lead_${i + 1}`);
    const spec: SpillIdCaptureSpec = { db: fakeDb(ids), table: 'leads', whereSql: '1=1', params: [] };
    expect(captureSpillIdList(spec)).toEqual(ids);
  });

  it('abandons the capture (undefined) when the match set exceeds the cap', () => {
    const ids = Array.from({ length: SPILL_IDLIST_CAP + 1 }, (_, i) => `lead_${i + 1}`);
    const spec: SpillIdCaptureSpec = { db: fakeDb(ids), table: 'leads', whereSql: '1=1', params: [] };
    expect(captureSpillIdList(spec)).toBeUndefined();
  });

  it('returns exactly the cap-sized set when the match set is exactly at the cap', () => {
    const ids = Array.from({ length: SPILL_IDLIST_CAP }, (_, i) => `lead_${i + 1}`);
    const spec: SpillIdCaptureSpec = { db: fakeDb(ids), table: 'leads', whereSql: '1=1', params: [] };
    expect(captureSpillIdList(spec)).toHaveLength(SPILL_IDLIST_CAP);
  });
});

describe('toListOrSpill idCapture option', () => {
  it('populates idList on a spill via idCapture', () => {
    const ids = Array.from({ length: 70 }, (_, i) => `c_${i + 1}`);
    const rows = ids.slice(0, 20).map((id) => ({ id }));
    const result = toListOrSpill(rows, 70, {
      idCapture: { db: fakeDb(ids), table: 'contacts', whereSql: '1=1', params: [] },
    });
    expect(result).toMatchObject({ __spill: true, total: 70 });
    expect((result as { idList?: string[] }).idList).toEqual(ids);
  });

  it('leaves idList unset (honest TRUNCATED_INPUT territory) when idCapture is omitted', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `c_${i + 1}` }));
    const result = toListOrSpill(rows, 70);
    expect(result).toMatchObject({ __spill: true, total: 70 });
    expect('idList' in (result as object)).toBe(false);
  });

  it('a pre-computed `hydration` wins over `idCapture` when both are given', () => {
    const ids = Array.from({ length: 70 }, (_, i) => `c_${i + 1}`);
    const rows = ids.slice(0, 20).map((id) => ({ id }));
    const result = toListOrSpill(rows, 70, {
      idCapture: { db: fakeDb(ids), table: 'contacts', whereSql: '1=1', params: [] },
      hydration: { idList: ['explicit_1', 'explicit_2'] },
    });
    expect((result as { idList?: string[] }).idList).toEqual(['explicit_1', 'explicit_2']);
  });

  it('stays inline (no spill, no idList needed) at or under the cap', () => {
    const rows = Array.from({ length: SPILL_CAP }, (_, i) => ({ id: `c_${i + 1}` }));
    const result = toListOrSpill(rows, SPILL_CAP);
    expect('__spill' in (result as object)).toBe(false);
  });
});
