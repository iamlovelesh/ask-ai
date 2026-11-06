/**
 * M34 Tax Rules — follows the M01 Contacts / M09 Smart Lists convention
 * verbatim.
 *
 * Data home: `structures` table, `kind = 'tax_rule'`. `config` (JSON) is
 * `{ rate, region, tax_category, tax_inclusive, exemptions }`. Seeded rows
 * carry the generic placeholder `{seeded:true,kind:'tax_rule'}`
 * (`entities/seed-core.ts`), so every reader falls back to a sane default
 * (rate 0, no region/category/exemptions) when a field is absent — same
 * "config absent" pattern as M05 pipelines' `DEFAULT_STAGES`.
 *
 * DESIGN NOTE — `set_product_tax_category`: this configures which
 * PRODUCT CATEGORY a tax rule applies to (`config.tax_category`), matched
 * against the ALREADY-EXISTING `products.category` column
 * (`entities/model.ts`) — no new storage on `products` is needed or
 * added. It is not a per-product assignment action.
 *
 * `calculate_tax_for_order` (EVAL-CRITICAL) is a real per-line
 * computation: resolves an applicable ACTIVE rule (by explicit
 * `tax_rule_id`, or by matching `config.region` against the input
 * `region`, falling back to a region-less/global rule if one exists),
 * checks the order's contact against the rule's `exemptions`, then taxes
 * each line item whose product's `category` matches the rule's
 * `tax_category` (or every line, if the rule has none). No matching rule
 * is a legitimate real-world outcome (not every region taxes everything)
 * — returns a real zero-tax result with `matched_rule_id: null` rather
 * than throwing.
 *
 * KIND-BLINDNESS NOTE (same as M05/M08/M09/M10/M31): every action on this
 * module's own `id` needs an action-scoped synthHint (`${slug}:id`).
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import { nextId } from './next-id.js';
import type { SynthHints } from './synth-hints.js';
import { parseJsonObject } from './json.js';

const MODULE = 'tax_rules';
const KIND = 'tax_rule';

interface TaxRuleConfig {
  rate: number;
  region: string | null;
  tax_category: string | null;
  tax_inclusive: boolean;
  exemptions: string[];
}

function readTaxRuleConfig(row: Row): TaxRuleConfig {
  const config = parseJsonObject(row['config']);
  return {
    rate: typeof config['rate'] === 'number' ? (config['rate'] as number) : 0,
    region: typeof config['region'] === 'string' ? (config['region'] as string) : null,
    tax_category: typeof config['tax_category'] === 'string' ? (config['tax_category'] as string) : null,
    tax_inclusive: config['tax_inclusive'] === true,
    exemptions: Array.isArray(config['exemptions']) ? (config['exemptions'] as string[]) : [],
  };
}

function writeTaxRuleConfig(tx: StoreTx, id: string, config: TaxRuleConfig, now: number): void {
  tx.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

function getTaxRuleRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Tax rule '${id}' does not exist.`);
  return row;
}

interface TaxRuleView {
  id: string;
  name: string;
  status: string;
  rate: number;
  region: string | null;
  tax_category: string | null;
  tax_inclusive: boolean;
  exemptions: string[];
  description: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): TaxRuleView {
  const config = readTaxRuleConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    rate: config.rate,
    region: config.region,
    tax_category: config.tax_category,
    tax_inclusive: config.tax_inclusive,
    exemptions: config.exemptions,
    description: (row['description'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const taxRuleView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  rate: z.number(),
  region: z.string().nullable(),
  tax_category: z.string().nullable(),
  tax_inclusive: z.boolean(),
  exemptions: z.array(z.string()),
  description: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

function slugify(name: string, id: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${base || 'tax-rule'}-${id}`;
}

// --- A01 create_tax_rule -----------------------------------------------------

const createTaxRuleInput = z.strictObject({
  name: z.string().min(1),
  rate: z.number().min(0).max(1).optional(),
  region: z.string().optional(),
  description: z.string().optional(),
});

const createTaxRule: ActionDef<z.infer<typeof createTaxRuleInput>, TaxRuleView> = {
  id: 'M34.A01',
  slug: 'tax_rules.create_tax_rule',
  module: MODULE,
  name: 'Create tax rule',
  description: 'Create a new tax rule (rate is a fraction, e.g. 0.08 for 8%).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createTaxRuleInput,
  outputSchema: taxRuleView,
  searchCard: {
    synonyms: ['add tax rule', 'new tax rate'],
    examplePhrasings: ['Create an 8% sales tax rule for California'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: TaxRuleConfig = {
      rate: input.rate ?? 0,
      region: input.region ?? null,
      tax_category: null,
      tax_inclusive: false,
      exemptions: [],
    };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config), input.description ?? null],
    );
    return toView(getTaxRuleRow(ctx.db, id));
  }),
};

// --- A02 get_tax_rule -------------------------------------------------

const getTaxRuleInput = z.strictObject({ id: z.string() });

const getTaxRule: ActionDef<z.infer<typeof getTaxRuleInput>, TaxRuleView> = {
  id: 'M34.A02',
  slug: 'tax_rules.get_tax_rule',
  module: MODULE,
  name: 'Get tax rule',
  description: 'Fetch a tax rule by id.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getTaxRuleInput,
  outputSchema: taxRuleView,
  searchCard: {
    synonyms: ['tax rule details', 'look up tax rule'],
    examplePhrasings: ['Show me this tax rule'],
  },
  handler: async (input, ctx) => toView(getTaxRuleRow(ctx.db, input.id)),
};

// --- A03 list_tax_rules -----------------------------------------------------

const listTaxRulesInput = z.strictObject({
  status: z.string().optional(),
  region: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListTaxRulesInput = z.infer<typeof listTaxRulesInput>;
const listTaxRulesOutput = listOutputSchema(taxRuleView);
type ListTaxRulesOutput = ListOrSpill<TaxRuleView>;

const listTaxRules: ActionDef<ListTaxRulesInput, ListTaxRulesOutput> = {
  id: 'M34.A03',
  slug: 'tax_rules.list_tax_rules',
  module: MODULE,
  name: 'List tax rules',
  description: 'List non-archived tax rules.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listTaxRulesInput,
  outputSchema: listTaxRulesOutput,
  searchCard: {
    synonyms: ['all tax rules', 'show tax rates'],
    examplePhrasings: ['List our tax rules'],
  },
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.status) {
      where.push('status = ? COLLATE NOCASE');
      params.push(input.status);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM structures WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    const views = rows.map(toView).filter((v) => !input.region || v.region === input.region);
    // `region` is filtered in JS (it lives inside the JSON config, not a SQL
    // column) — when it's set, `whereSql`/`params` no longer describe the
    // true match set, so idCapture is only safe in the unfiltered branch.
    return toListOrSpill(
      views,
      input.region ? views.length : total,
      input.region ? {} : { idCapture: { db: ctx.db, table: 'structures', whereSql, params } },
    );
  },
};

// --- A04 set_tax_rate -----------------------------------------------------

const setTaxRateInput = z.strictObject({ id: z.string(), rate: z.number().min(0).max(1) });

const setTaxRate: ActionDef<z.infer<typeof setTaxRateInput>, TaxRuleView> = {
  id: 'M34.A04',
  slug: 'tax_rules.set_tax_rate',
  module: MODULE,
  name: 'Set tax rate',
  description: 'Set a tax rule\'s rate (a fraction between 0 and 1).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setTaxRateInput,
  outputSchema: taxRuleView,
  searchCard: {
    synonyms: ['change tax rate', 'update tax percentage'],
    examplePhrasings: ['Change this tax rule to 7.5%'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTaxRuleRow(ctx.db, input.id);
    const config = readTaxRuleConfig(row);
    writeTaxRuleConfig(ctx.db, input.id, { ...config, rate: input.rate }, ctx.clock.now());
    return toView(getTaxRuleRow(ctx.db, input.id));
  }),
};

// --- A05 set_applicable_region -----------------------------------------------------

const setApplicableRegionInput = z.strictObject({ id: z.string(), region: z.string().nullable() });

const setApplicableRegion: ActionDef<z.infer<typeof setApplicableRegionInput>, TaxRuleView> = {
  id: 'M34.A05',
  slug: 'tax_rules.set_applicable_region',
  module: MODULE,
  name: 'Set applicable region',
  description: 'Set the region a tax rule applies to (null = global/catch-all).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setApplicableRegionInput,
  outputSchema: taxRuleView,
  searchCard: {
    synonyms: ['set tax region', 'change tax jurisdiction'],
    examplePhrasings: ['Make this tax rule apply to US-CA'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTaxRuleRow(ctx.db, input.id);
    const config = readTaxRuleConfig(row);
    writeTaxRuleConfig(ctx.db, input.id, { ...config, region: input.region }, ctx.clock.now());
    return toView(getTaxRuleRow(ctx.db, input.id));
  }),
};

// --- A06 set_product_tax_category -----------------------------------------------------

const setProductTaxCategoryInput = z.strictObject({ id: z.string(), tax_category: z.string().nullable() });

const setProductTaxCategory: ActionDef<z.infer<typeof setProductTaxCategoryInput>, TaxRuleView> = {
  id: 'M34.A06',
  slug: 'tax_rules.set_product_tax_category',
  module: MODULE,
  name: 'Set product tax category',
  description:
    'Set which product category (matched against products.category) this tax rule applies to (null = all categories).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setProductTaxCategoryInput,
  outputSchema: taxRuleView,
  searchCard: {
    synonyms: ['scope tax rule to category', 'set taxable category'],
    examplePhrasings: ['Only tax digital goods with this rule'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTaxRuleRow(ctx.db, input.id);
    const config = readTaxRuleConfig(row);
    writeTaxRuleConfig(ctx.db, input.id, { ...config, tax_category: input.tax_category }, ctx.clock.now());
    return toView(getTaxRuleRow(ctx.db, input.id));
  }),
};

// --- A07 set_tax_inclusive_pricing -----------------------------------------------------

const setTaxInclusivePricingInput = z.strictObject({ id: z.string(), tax_inclusive: z.boolean() });

const setTaxInclusivePricing: ActionDef<z.infer<typeof setTaxInclusivePricingInput>, TaxRuleView> = {
  id: 'M34.A07',
  slug: 'tax_rules.set_tax_inclusive_pricing',
  module: MODULE,
  name: 'Set tax-inclusive pricing',
  description: 'Set whether prices under this rule are tax-inclusive (display/informational flag).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setTaxInclusivePricingInput,
  outputSchema: taxRuleView,
  searchCard: {
    synonyms: ['tax inclusive prices', 'toggle tax inclusive'],
    examplePhrasings: ['Make this region\'s prices tax-inclusive'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTaxRuleRow(ctx.db, input.id);
    const config = readTaxRuleConfig(row);
    writeTaxRuleConfig(ctx.db, input.id, { ...config, tax_inclusive: input.tax_inclusive }, ctx.clock.now());
    return toView(getTaxRuleRow(ctx.db, input.id));
  }),
};

// --- A08 record_customer_tax_exemption -----------------------------------------------------

const recordCustomerTaxExemptionInput = z.strictObject({ id: z.string(), contact_id: z.string() });

const recordCustomerTaxExemption: ActionDef<z.infer<typeof recordCustomerTaxExemptionInput>, TaxRuleView> = {
  id: 'M34.A08',
  slug: 'tax_rules.record_customer_tax_exemption',
  module: MODULE,
  name: 'Record customer tax exemption',
  description: 'Exempt a contact from a specific tax rule.',
  risk: 'write',
  entities: ['structures', 'contacts'],
  inputSchema: recordCustomerTaxExemptionInput,
  outputSchema: taxRuleView,
  searchCard: {
    synonyms: ['exempt customer from tax', 'tax exempt'],
    examplePhrasings: ['Mark this customer as tax exempt'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTaxRuleRow(ctx.db, input.id);
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    const config = readTaxRuleConfig(row);
    const exemptions = config.exemptions.includes(input.contact_id)
      ? config.exemptions
      : [...config.exemptions, input.contact_id];
    writeTaxRuleConfig(ctx.db, input.id, { ...config, exemptions }, ctx.clock.now());
    return toView(getTaxRuleRow(ctx.db, input.id));
  }),
};

// --- A09 calculate_tax_for_order -----------------------------------------------------

const calculateTaxForOrderInput = z.strictObject({
  order_id: z.string(),
  region: z.string().optional(),
  tax_rule_id: z.string().optional(),
});
const lineBreakdown = z.object({
  line_item_id: z.string(),
  product_id: z.string().nullable(),
  amount_cents: z.number(),
  taxable: z.boolean(),
  tax_cents: z.number(),
});
const calculateTaxOutput = z.object({
  order_id: z.string(),
  matched_rule_id: z.string().nullable(),
  rate: z.number(),
  region: z.string().nullable(),
  exempt: z.boolean(),
  taxable_subtotal_cents: z.number(),
  tax_cents: z.number(),
  line_breakdown: z.array(lineBreakdown),
});

const calculateTaxForOrder: ActionDef<z.infer<typeof calculateTaxForOrderInput>, z.infer<typeof calculateTaxOutput>> = {
  id: 'M34.A09',
  slug: 'tax_rules.calculate_tax_for_order',
  module: MODULE,
  name: 'Calculate tax for order',
  description:
    "Compute real tax for an order from its line items x an applicable active tax rule's rate (matched by region, or tax_rule_id to force a specific rule). No matching rule returns a real zero-tax result, not an error.",
  risk: 'read',
  entities: ['orders', 'line_items', 'structures', 'products', 'contacts'],
  inputSchema: calculateTaxForOrderInput,
  outputSchema: calculateTaxOutput,
  searchCard: {
    synonyms: ['compute tax', 'how much tax on this order'],
    examplePhrasings: ['How much tax is owed on this order?'],
  },
  handler: async (input, ctx) => {
    const order = ctx.db.get(`SELECT contact_id FROM orders WHERE id = ?`, [input.order_id]);
    if (!order) throw new ActionError('NOT_FOUND', `Order '${input.order_id}' does not exist.`);

    let ruleRow: Row | undefined;
    if (input.tax_rule_id) {
      ruleRow = getTaxRuleRow(ctx.db, input.tax_rule_id);
      if (ruleRow['status'] !== 'active') {
        throw new ActionError('VALIDATION', `Tax rule '${input.tax_rule_id}' is not active.`);
      }
    } else {
      // Fix round 2 (reviewer IMPORTANT): matching via `config LIKE
      // '%"region":...%'` on the raw JSON string silently matched NOTHING
      // against the real template — every seeded tax_rule row's `config`
      // is the generic placeholder `{seeded:true,kind:'tax_rule'}` (no
      // `region` key at all), so neither LIKE pattern (`"region":"<val>"`
      // nor the literal `"region":null`) ever matched a seeded row, and
      // the natural no-tax_rule_id call path always fell through to the
      // (correct-looking but wrong-for-this-data) zero-tax branch. The
      // active universe here is small (≤~20 rows per
      // `entities/seed-core.ts#STRUCTURE_COUNTS.tax_rule`), so fetch all
      // active rows and match in application code via
      // `readTaxRuleConfig` (which already normalizes an absent `region`
      // key to `null`) instead of pattern-matching raw JSON.
      const activeRules = ctx.db
        .all(`SELECT * FROM structures WHERE kind = 'tax_rule' AND status = 'active' AND archived = 0`)
        .map((r) => ({ row: r, config: readTaxRuleConfig(r) }));
      const exactMatch = input.region ? activeRules.find((r) => r.config.region === input.region) : undefined;
      const globalMatch = activeRules.find((r) => r.config.region === null);
      ruleRow = (exactMatch ?? globalMatch)?.row;
    }

    const lineRows = ctx.db.all(
      `SELECT li.id AS id, li.product_id AS product_id, li.amount_cents AS amount_cents, p.category AS category
       FROM line_items li LEFT JOIN products p ON p.id = li.product_id
       WHERE li.parent_type = 'order' AND li.parent_id = ? AND li.archived = 0`,
      [input.order_id],
    );

    if (!ruleRow) {
      return {
        order_id: input.order_id,
        matched_rule_id: null,
        rate: 0,
        region: input.region ?? null,
        exempt: false,
        taxable_subtotal_cents: 0,
        tax_cents: 0,
        line_breakdown: lineRows.map((r) => ({
          line_item_id: r['id'] as string,
          product_id: (r['product_id'] as string | null) ?? null,
          amount_cents: r['amount_cents'] as number,
          taxable: false,
          tax_cents: 0,
        })),
      };
    }

    const config = readTaxRuleConfig(ruleRow);
    const contactId = order['contact_id'] as string;
    const exempt = config.exemptions.includes(contactId);

    let taxableSubtotal = 0;
    const breakdown = lineRows.map((r) => {
      const taxable = !exempt && (config.tax_category === null || r['category'] === config.tax_category);
      const amountCents = r['amount_cents'] as number;
      const taxCents = taxable ? Math.round(amountCents * config.rate) : 0;
      if (taxable) taxableSubtotal += amountCents;
      return {
        line_item_id: r['id'] as string,
        product_id: (r['product_id'] as string | null) ?? null,
        amount_cents: amountCents,
        taxable,
        tax_cents: taxCents,
      };
    });
    const totalTax = breakdown.reduce((sum, b) => sum + b.tax_cents, 0);

    return {
      order_id: input.order_id,
      matched_rule_id: ruleRow['id'] as string,
      rate: config.rate,
      region: config.region,
      exempt,
      taxable_subtotal_cents: taxableSubtotal,
      tax_cents: totalTax,
      line_breakdown: breakdown,
    };
  },
};

// --- A10 deactivate_tax_rule -----------------------------------------------------

const deactivateTaxRuleInput = z.strictObject({ id: z.string() });

const deactivateTaxRule: ActionDef<z.infer<typeof deactivateTaxRuleInput>, TaxRuleView> = {
  id: 'M34.A10',
  slug: 'tax_rules.deactivate_tax_rule',
  module: MODULE,
  name: 'Deactivate tax rule',
  description: 'Deactivate a tax rule.',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: deactivateTaxRuleInput,
  outputSchema: taxRuleView,
  searchCard: {
    synonyms: ['disable tax rule', 'turn off tax rule'],
    examplePhrasings: ['Deactivate this tax rule'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTaxRuleRow(ctx.db, input.id);
    if (row['status'] === 'inactive') {
      throw new ActionError('CONFLICT', `Tax rule '${input.id}' is already inactive.`);
    }
    ctx.db.run(`UPDATE structures SET status = 'inactive', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getTaxRuleRow(ctx.db, input.id));
  }),
};

export const m34TaxRules: ActionDef[] = [
  createTaxRule as ActionDef,
  getTaxRule as ActionDef,
  listTaxRules as ActionDef,
  setTaxRate as ActionDef,
  setApplicableRegion as ActionDef,
  setProductTaxCategory as ActionDef,
  setTaxInclusivePricing as ActionDef,
  recordCustomerTaxExemption as ActionDef,
  calculateTaxForOrder as ActionDef,
  deactivateTaxRule as ActionDef,
];

/** Tier-A discrimination: `status` counts over 10 tax_rule rows (2-way
 * active/inactive) — verified via live `npm run smoke` output: 'active'
 * → 5, 'inactive' → 6. Very thin universe, same category as M08 tags/
 * M16 workflows/M23 booking pages — re-verify if the seed's tax_rule
 * count or status distribution ever changes. */
export const m34DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'tax_rules.list_tax_rules',
    paramsA: { status: 'active' },
    paramsB: { status: 'inactive' },
    expectDifferentCounts: true,
  },
];

/** `entities[0] === 'structures'` with `kind = 'tax_rule'` — every action
 * on this module's own `id` needs an action-scoped hint. */
export const m34SynthHints: SynthHints = {
  // Without this, the generic `{noun}_id` guess resolves `tax_rule_id` to a
  // non-existent `tax_rules` table, falls through to a garbage string, and
  // `calculate_tax_for_order` throws a masked NOT_FOUND before ever
  // reaching its real computation — the exact "entities[0]"-class masking
  // bug task-9-b2/b3 caught elsewhere, here on an OPTIONAL field instead
  // of the bare `id`.
  'tax_rules.calculate_tax_for_order:tax_rule_id': { table: 'structures', kind: KIND },
  'tax_rules.get_tax_rule:id': { table: 'structures', kind: KIND },
  'tax_rules.set_tax_rate:id': { table: 'structures', kind: KIND },
  'tax_rules.set_applicable_region:id': { table: 'structures', kind: KIND },
  'tax_rules.set_product_tax_category:id': { table: 'structures', kind: KIND },
  'tax_rules.set_tax_inclusive_pricing:id': { table: 'structures', kind: KIND },
  'tax_rules.record_customer_tax_exemption:id': { table: 'structures', kind: KIND },
  'tax_rules.deactivate_tax_rule:id': { table: 'structures', kind: KIND },
};
