/**
 * Regression test for `catalog/m34-tax_rules.ts#calculateTaxForOrder`'s
 * region/global rule matching (task-9-b4 fix round 2 — reviewer IMPORTANT
 * finding).
 *
 * Original bug: matching was done via `config LIKE '%"region":"<val>"%'`
 * / `config LIKE '%"region":null%'` directly against the raw JSON string.
 * Every SEEDED `tax_rule` row's `config` is the generic placeholder
 * `{seeded:true,kind:'tax_rule'}` (`entities/seed-core.ts#generateStructures`)
 * — it has NO `region` key at all, so neither LIKE pattern ever matched a
 * real seeded row. The natural "no `tax_rule_id`, no `region`" call path
 * — exactly how an agent would ask "what's the tax on this order?" without
 * already knowing a specific rule id — always fell through to the
 * zero-tax/`matched_rule_id:null` branch against the real template, even
 * though active tax rules exist. `npm run smoke` never caught this because
 * `synthesizeInput` always fills the optional `tax_rule_id` field (a
 * `synthHints` entry added in the original submission specifically so
 * smoke wouldn't mask a NOT_FOUND there), so the no-`tax_rule_id` path was
 * never actually exercised by the harness.
 *
 * Fix: fetch all ACTIVE `structures(kind='tax_rule')` rows (a small
 * universe, ≤~20 per `entities/seed-core.ts#STRUCTURE_COUNTS.tax_rule`)
 * and match in application code via `readTaxRuleConfig` (which already
 * normalizes an absent `region` key to `null`), instead of pattern-
 * matching raw JSON.
 *
 * This test runs against a COPY of the real committed template (via
 * `resetCrm`, the same mechanism `eval/smoke.ts` uses) — not a synthetic
 * fixture — so it exercises the exact data shape the bug was found
 * against. Since every seeded tax_rule's rate defaults to 0 (config
 * absent → `readTaxRuleConfig`'s fallback), the test first calls
 * `set_tax_rate` on one seeded active rule to give it a real nonzero rate
 * (otherwise `tax_cents > 0` would be an unfalsifiable assertion no
 * matter whether matching worked) — documented per the reviewer's "set a
 * rate first — whatever makes the assertion meaningful" instruction.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from '../src/catalog/registry';
import type { ActionContext } from '../src/catalog/types';
import { openCrm, crmDbPath, type StoreTx } from '../src/store/db';
import { resetCrm } from '../src/store/reset';
import { VirtualClock } from '../src/store/clock';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(here, '../data/crm-standard.template.db');
const PROFILE = 'test-m34-tax';

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(PROFILE) + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

afterAll(cleanup);

function ctx(db: StoreTx, key: string, nowMs?: number): ActionContext {
  return { db, clock: new VirtualClock(nowMs), idempotencyKey: key, format: 'concise' };
}

function def(slug: string) {
  const d = registry.get(slug);
  if (!d) throw new Error(`action '${slug}' not registered`);
  return d;
}

describe('tax_rules.calculate_tax_for_order — region/global matching against the real template', () => {
  it('matches a real active tax_rule and computes nonzero tax with no tax_rule_id/region given', async () => {
    cleanup();
    await resetCrm(PROFILE, TEMPLATE_PATH);
    const crm = openCrm(PROFILE);
    try {
      // Reads + handler calls each run in their OWN `crm.tx` (matching the
      // rest of the test suite's convention, e.g. m01.test.ts — `tx`'s `fn`
      // is SYNCHRONOUS; an async handler's body still runs to completion
      // synchronously since it contains no real async I/O, but a nested
      // `await` INSIDE one `tx` callback would run after `COMMIT` has
      // already fired, not before).
      const { ruleId, orderId } = crm.tx((db) => {
        const ruleRow = db.get(
          `SELECT id FROM structures WHERE kind = 'tax_rule' AND status = 'active' AND archived = 0 ORDER BY id LIMIT 1`,
        );
        expect(ruleRow).toBeTruthy();
        const orderRow = db.get(
          `SELECT DISTINCT o.id AS id FROM orders o
           JOIN line_items li ON li.parent_type = 'order' AND li.parent_id = o.id
           WHERE o.archived = 0 LIMIT 1`,
        );
        expect(orderRow).toBeTruthy();
        return { ruleId: ruleRow!['id'] as string, orderId: orderRow!['id'] as string };
      });

      // Give the matched rule a real nonzero rate — every seeded tax_rule's
      // rate otherwise defaults to 0 (config absent), which would make
      // `tax_cents > 0` pass/fail for the wrong reason regardless of
      // whether matching worked.
      await crm.tx((db) =>
        def('tax_rules.set_tax_rate').handler({ id: ruleId, rate: 0.08 }, ctx(db, 'k-set-rate')),
      );

      const result = (await crm.tx((db) =>
        def('tax_rules.calculate_tax_for_order').handler({ order_id: orderId }, ctx(db, 'k-calc-tax')),
      )) as { matched_rule_id: string | null; rate: number; tax_cents: number; taxable_subtotal_cents: number };

      expect(result.matched_rule_id).toBe(ruleId);
      expect(result.rate).toBe(0.08);
      expect(result.taxable_subtotal_cents).toBeGreaterThan(0);
      expect(result.tax_cents).toBeGreaterThan(0);
    } finally {
      crm.close();
    }
  });
});
