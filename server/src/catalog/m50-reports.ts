/**
 * M50 Reports — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'report'`. `config` is
 * `{ type: string, filters: Record<string,unknown>, date_range: {from,to},
 * grouping: string|null, schedule: {frequency,recipient_emails}|null,
 * last_export: {exported_at}|null }`.
 *
 * `run_report` (A07, EVAL-CRITICAL) executes REAL aggregation for exactly
 * THREE report types (per the brief: "at least 3 real ones; others
 * VALIDATION"):
 *   - `leads_by_source`:   `GROUP BY source` over `leads` (date-ranged on
 *     `created_at`), metric `{count}`.
 *   - `revenue_by_month`:  `succeeded` `payments(kind='payment')`
 *     (date-ranged on `processed_at`) grouped by calendar month (computed
 *     in JS from the epoch-ms timestamp — portable, no SQL `strftime`
 *     dependency), metric `{revenue_cents}`.
 *   - `pipeline_summary`:  `GROUP BY stage` over non-archived
 *     `opportunities` (date-ranged on `created_at`), metrics `{count,
 *     value_cents}`.
 *   Any other `type` throws `VALIDATION('Unsupported report type: …')` —
 *   validated at RUN time (not at `create_saved_report` time), matching
 *   the brief's framing that a report definition can exist before
 *   `run_report` supports its type.
 *
 * `compare_report_periods` (A08) runs the SAME aggregation twice (one per
 * period) and diffs by group key — real, not fabricated.
 * `set_report_grouping`'s `grouping` field is informational/a label only —
 * the actual `GROUP BY` column is FIXED per report type (documented); it
 * does not change `run_report`'s behavior.
 *
 * KIND-BLINDNESS NOTE: `entities[0]` is `'structures'` — the bare `id`
 * field needs an action-scoped synthHint.
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

const MODULE = 'reports';
const KIND = 'report';
const SUPPORTED_TYPES = ['leads_by_source', 'revenue_by_month', 'pipeline_summary'] as const;

function slugify(name: string, id: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'report'}-${id}`;
}

interface DateRange {
  from: number | null;
  to: number | null;
}

interface Schedule {
  frequency: string;
  recipient_emails: string[];
}

interface LastExport {
  exported_at: number;
}

interface ReportConfig {
  type: string;
  filters: Record<string, unknown>;
  date_range: DateRange;
  grouping: string | null;
  schedule: Schedule | null;
  last_export: LastExport | null;
}

function readConfig(row: Row): ReportConfig {
  const config = parseJsonObject(row['config']);
  const range = config['date_range'] && typeof config['date_range'] === 'object' ? (config['date_range'] as Record<string, unknown>) : {};
  const schedule = config['schedule'] && typeof config['schedule'] === 'object' ? (config['schedule'] as Record<string, unknown>) : null;
  const lastExport = config['last_export'] && typeof config['last_export'] === 'object' ? (config['last_export'] as Record<string, unknown>) : null;
  return {
    type: typeof config['type'] === 'string' ? (config['type'] as string) : 'leads_by_source',
    filters: config['filters'] && typeof config['filters'] === 'object' ? (config['filters'] as Record<string, unknown>) : {},
    date_range: { from: (range['from'] as number | null | undefined) ?? null, to: (range['to'] as number | null | undefined) ?? null },
    grouping: (config['grouping'] as string | null | undefined) ?? null,
    schedule: schedule ? { frequency: schedule['frequency'] as string, recipient_emails: Array.isArray(schedule['recipient_emails']) ? (schedule['recipient_emails'] as string[]) : [] } : null,
    last_export: lastExport ? { exported_at: lastExport['exported_at'] as number } : null,
  };
}

function writeConfig(db: StoreTx, id: string, config: ReportConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

function getReportRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Report '${id}' does not exist.`);
  return row;
}

interface ReportRow {
  group: string;
  metrics: Record<string, number>;
}

function monthLabel(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The REAL aggregation engine — shared by `run_report` and
 * `compare_report_periods` so both exercise the identical code path. */
function runAggregation(db: StoreTx, type: string, range: DateRange): ReportRow[] {
  if (type === 'leads_by_source') {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (range.from !== null) {
      where.push('created_at >= ?');
      params.push(range.from);
    }
    if (range.to !== null) {
      where.push('created_at <= ?');
      params.push(range.to);
    }
    const rows = db.all(`SELECT source, COUNT(*) AS n FROM leads WHERE ${where.join(' AND ')} GROUP BY source ORDER BY source ASC`, params);
    return rows.map((r) => ({ group: (r['source'] as string | null) ?? 'unknown', metrics: { count: r['n'] as number } }));
  }
  if (type === 'revenue_by_month') {
    const where: string[] = [`kind = 'payment'`, `status = 'succeeded'`];
    const params: unknown[] = [];
    if (range.from !== null) {
      where.push('processed_at >= ?');
      params.push(range.from);
    }
    if (range.to !== null) {
      where.push('processed_at <= ?');
      params.push(range.to);
    }
    const rows = db.all(`SELECT amount_cents, processed_at FROM payments WHERE ${where.join(' AND ')}`, params);
    const byMonth = new Map<string, number>();
    for (const r of rows) {
      const label = monthLabel(r['processed_at'] as number);
      byMonth.set(label, (byMonth.get(label) ?? 0) + ((r['amount_cents'] as number | null) ?? 0));
    }
    return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([group, revenue]) => ({ group, metrics: { revenue_cents: revenue } }));
  }
  if (type === 'pipeline_summary') {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (range.from !== null) {
      where.push('created_at >= ?');
      params.push(range.from);
    }
    if (range.to !== null) {
      where.push('created_at <= ?');
      params.push(range.to);
    }
    const rows = db.all(
      `SELECT stage, COUNT(*) AS n, SUM(value_cents) AS total FROM opportunities WHERE ${where.join(' AND ')} GROUP BY stage ORDER BY stage ASC`,
      params,
    );
    return rows.map((r) => ({ group: (r['stage'] as string | null) ?? 'unknown', metrics: { count: r['n'] as number, value_cents: (r['total'] as number | null) ?? 0 } }));
  }
  throw new ActionError('VALIDATION', `Unsupported report type: '${type}'. Supported types: ${SUPPORTED_TYPES.join(', ')}.`);
}

interface ReportView {
  id: string;
  name: string;
  status: string;
  type: string;
  filters: Record<string, unknown>;
  date_range: DateRange;
  grouping: string | null;
  schedule: Schedule | null;
  last_export: LastExport | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): ReportView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    ...config,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const dateRangeSchema = z.object({ from: z.number().nullable(), to: z.number().nullable() });
const scheduleSchema = z.object({ frequency: z.string(), recipient_emails: z.array(z.string()) }).nullable();
const lastExportSchema = z.object({ exported_at: z.number() }).nullable();

const reportView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  type: z.string(),
  filters: z.record(z.string(), z.unknown()),
  date_range: dateRangeSchema,
  grouping: z.string().nullable(),
  schedule: scheduleSchema,
  last_export: lastExportSchema,
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

const reportRowSchema = z.object({ group: z.string(), metrics: z.record(z.string(), z.number()) });

// --- A01 create_saved_report -----------------------------------------------------

const createSavedReportInput = z.strictObject({ name: z.string().min(1), type: z.string().min(1) });

const createSavedReport: ActionDef<z.infer<typeof createSavedReportInput>, ReportView> = {
  id: 'M50.A01',
  slug: 'reports.create_saved_report',
  module: MODULE,
  name: 'Create saved report',
  description: `Create a new saved report definition. Supported types for run_report: ${SUPPORTED_TYPES.join(', ')} — other types can be saved but will VALIDATION on run.`,
  risk: 'write',
  entities: ['structures'],
  inputSchema: createSavedReportInput,
  outputSchema: reportView,
  searchCard: { synonyms: ['add report', 'new saved report'], examplePhrasings: ['Create a leads-by-source report'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: ReportConfig = { type: input.type, filters: {}, date_range: { from: null, to: null }, grouping: null, schedule: null, last_export: null };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getReportRow(ctx.db, id));
  }),
};

// --- A02 get_report_definition -----------------------------------------------------

const getReportDefinitionInput = z.strictObject({ id: z.string() });

const getReportDefinition: ActionDef<z.infer<typeof getReportDefinitionInput>, ReportView> = {
  id: 'M50.A02',
  slug: 'reports.get_report_definition',
  module: MODULE,
  name: 'Get report definition',
  description: 'Fetch a saved report definition by id.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getReportDefinitionInput,
  outputSchema: reportView,
  searchCard: { synonyms: ['report details', 'look up report'], examplePhrasings: ['Show me this report definition'] },
  handler: async (input, ctx) => toView(getReportRow(ctx.db, input.id)),
};

// --- A03 list_saved_reports -----------------------------------------------------

const listSavedReportsInput = z.strictObject({ limit: z.number().int().min(1).max(50).optional() });
type ListSavedReportsInput = z.infer<typeof listSavedReportsInput>;
const listSavedReportsOutput = listOutputSchema(reportView);
type ListSavedReportsOutput = ListOrSpill<ReportView>;

const listSavedReports: ActionDef<ListSavedReportsInput, ListSavedReportsOutput> = {
  id: 'M50.A03',
  slug: 'reports.list_saved_reports',
  module: MODULE,
  name: 'List saved reports',
  description: 'List non-archived saved reports.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listSavedReportsInput,
  outputSchema: listSavedReportsOutput,
  searchCard: { synonyms: ['all reports', 'show saved reports'], examplePhrasings: ['List our saved reports'] },
  handler: async (input, ctx) => {
    const limit = input.limit ?? 50;
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM structures WHERE archived = 0 AND kind = ?`, [KIND]);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM structures WHERE archived = 0 AND kind = ? ORDER BY created_at DESC LIMIT ?`, [KIND, limit]);
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'structures', whereSql: 'archived = 0 AND kind = ?', params: [KIND] },
    });
  },
};

// --- A04 update_report_filters -----------------------------------------------------

const updateReportFiltersInput = z.strictObject({ id: z.string(), filters: z.record(z.string(), z.unknown()) });

const updateReportFilters: ActionDef<z.infer<typeof updateReportFiltersInput>, ReportView> = {
  id: 'M50.A04',
  slug: 'reports.update_report_filters',
  module: MODULE,
  name: 'Update report filters',
  description: 'Replace a saved report\'s filters object.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateReportFiltersInput,
  outputSchema: reportView,
  searchCard: { synonyms: ['edit report filters', 'change report filters'], examplePhrasings: ["Update this report's filters"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getReportRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, filters: input.filters }, ctx.clock.now());
    return toView(getReportRow(ctx.db, input.id));
  }),
};

// --- A05 set_report_date_range -----------------------------------------------------

const setReportDateRangeInput = z.strictObject({ id: z.string(), from: z.number().int().min(0).nullable(), to: z.number().int().min(0).nullable() });

const setReportDateRange: ActionDef<z.infer<typeof setReportDateRangeInput>, ReportView> = {
  id: 'M50.A05',
  slug: 'reports.set_report_date_range',
  module: MODULE,
  name: 'Set report date range',
  description: "Set a saved report's date range (both null = unbounded).",
  risk: 'write',
  entities: ['structures'],
  inputSchema: setReportDateRangeInput,
  outputSchema: reportView,
  searchCard: { synonyms: ['set date range', 'change report period'], examplePhrasings: ['Set this report to last quarter'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    if (input.from !== null && input.to !== null && input.from > input.to) {
      throw new ActionError('VALIDATION', '`from` must not be after `to`.');
    }
    const row = getReportRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, date_range: { from: input.from, to: input.to } }, ctx.clock.now());
    return toView(getReportRow(ctx.db, input.id));
  }),
};

// --- A06 set_report_grouping -----------------------------------------------------

const setReportGroupingInput = z.strictObject({ id: z.string(), grouping: z.string().min(1) });

const setReportGrouping: ActionDef<z.infer<typeof setReportGroupingInput>, ReportView> = {
  id: 'M50.A06',
  slug: 'reports.set_report_grouping',
  module: MODULE,
  name: 'Set report grouping',
  description: 'Set an informational grouping label for a report (the actual GROUP BY column used by run_report is fixed per report type).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setReportGroupingInput,
  outputSchema: reportView,
  searchCard: { synonyms: ['set grouping', 'group report by'], examplePhrasings: ['Label this report as grouped by month'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getReportRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, grouping: input.grouping }, ctx.clock.now());
    return toView(getReportRow(ctx.db, input.id));
  }),
};

// --- A07 run_report -----------------------------------------------------

const runReportInput = z.strictObject({ id: z.string() });
const runReportOutput = z.object({ id: z.string(), name: z.string(), type: z.string(), generated_at: z.number(), rows: z.array(reportRowSchema), row_count: z.number() });

const runReport: ActionDef<z.infer<typeof runReportInput>, z.infer<typeof runReportOutput>> = {
  id: 'M50.A07',
  slug: 'reports.run_report',
  module: MODULE,
  name: 'Run report',
  description: `Execute real aggregation for this report's type. Supported: ${SUPPORTED_TYPES.join(', ')} — any other type VALIDATIONs.`,
  risk: 'read',
  entities: ['structures', 'leads', 'payments', 'opportunities'],
  inputSchema: runReportInput,
  outputSchema: runReportOutput,
  searchCard: { synonyms: ['generate report', 'run report now'], examplePhrasings: ['Run this report'] },
  handler: async (input, ctx) => {
    const row = getReportRow(ctx.db, input.id);
    const config = readConfig(row);
    const rows = runAggregation(ctx.db, config.type, config.date_range);
    return { id: input.id, name: row['name'] as string, type: config.type, generated_at: ctx.clock.now(), rows, row_count: rows.length };
  },
};

// --- A08 compare_report_periods -----------------------------------------------------

const periodSchema = z.object({ from: z.number().int().min(0).nullable(), to: z.number().int().min(0).nullable() });
const compareReportPeriodsInput = z.strictObject({ id: z.string(), period_a: periodSchema, period_b: periodSchema });
const diffEntry = z.object({ group: z.string(), a: z.record(z.string(), z.number()), b: z.record(z.string(), z.number()), diff: z.record(z.string(), z.number()) });
const compareOutput = z.object({ id: z.string(), name: z.string(), type: z.string(), rows: z.array(diffEntry) });

const compareReportPeriods: ActionDef<z.infer<typeof compareReportPeriodsInput>, z.infer<typeof compareOutput>> = {
  id: 'M50.A08',
  slug: 'reports.compare_report_periods',
  module: MODULE,
  name: 'Compare report periods',
  description: "Run the same aggregation for two date ranges and diff the results by group key.",
  risk: 'read',
  entities: ['structures', 'leads', 'payments', 'opportunities'],
  inputSchema: compareReportPeriodsInput,
  outputSchema: compareOutput,
  searchCard: { synonyms: ['compare periods', 'period over period'], examplePhrasings: ['Compare this quarter to last quarter'] },
  handler: async (input, ctx) => {
    const row = getReportRow(ctx.db, input.id);
    const config = readConfig(row);
    const rowsA = runAggregation(ctx.db, config.type, input.period_a);
    const rowsB = runAggregation(ctx.db, config.type, input.period_b);
    const groups = new Set([...rowsA.map((r) => r.group), ...rowsB.map((r) => r.group)]);
    const byGroupA = new Map(rowsA.map((r) => [r.group, r.metrics] as const));
    const byGroupB = new Map(rowsB.map((r) => [r.group, r.metrics] as const));
    const diffRows = [...groups].sort().map((group) => {
      const a = byGroupA.get(group) ?? {};
      const b = byGroupB.get(group) ?? {};
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      const diff: Record<string, number> = {};
      for (const k of keys) diff[k] = (b[k] ?? 0) - (a[k] ?? 0);
      return { group, a, b, diff };
    });
    return { id: input.id, name: row['name'] as string, type: config.type, rows: diffRows };
  },
};

// --- A09 export_report_results -----------------------------------------------------

const exportReportResultsInput = z.strictObject({ id: z.string() });
const exportOutput = z.object({ id: z.string(), name: z.string(), exported_at: z.number(), row_count: z.number() });

const exportReportResults: ActionDef<z.infer<typeof exportReportResultsInput>, z.infer<typeof exportOutput>> = {
  id: 'M50.A09',
  slug: 'reports.export_report_results',
  module: MODULE,
  name: 'Export report results',
  description: 'Run the report and mark it exported (stamps `last_export.exported_at`).',
  risk: 'write',
  entities: ['structures', 'leads', 'payments', 'opportunities'],
  inputSchema: exportReportResultsInput,
  outputSchema: exportOutput,
  searchCard: { synonyms: ['export report', 'download report'], examplePhrasings: ['Export this report'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getReportRow(ctx.db, input.id);
    const config = readConfig(row);
    const rows = runAggregation(ctx.db, config.type, config.date_range);
    const now = ctx.clock.now();
    writeConfig(ctx.db, input.id, { ...config, last_export: { exported_at: now } }, now);
    return { id: input.id, name: row['name'] as string, exported_at: now, row_count: rows.length };
  }),
};

// --- A10 schedule_report_delivery -----------------------------------------------------

const scheduleReportDeliveryInput = z.strictObject({
  id: z.string(),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  recipient_emails: z.array(z.string().email()).min(1),
});

const scheduleReportDelivery: ActionDef<z.infer<typeof scheduleReportDeliveryInput>, ReportView> = {
  id: 'M50.A10',
  slug: 'reports.schedule_report_delivery',
  module: MODULE,
  name: 'Schedule report delivery',
  description: 'Schedule recurring email delivery of a report (stores the schedule config — no background scheduler fires it in this task).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: scheduleReportDeliveryInput,
  outputSchema: reportView,
  searchCard: { synonyms: ['schedule report', 'email report weekly'], examplePhrasings: ['Email this report to the team every Monday'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getReportRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, schedule: { frequency: input.frequency, recipient_emails: input.recipient_emails } }, ctx.clock.now());
    return toView(getReportRow(ctx.db, input.id));
  }),
};

export const m50Reports: ActionDef[] = [
  createSavedReport as ActionDef,
  getReportDefinition as ActionDef,
  listSavedReports as ActionDef,
  updateReportFilters as ActionDef,
  setReportDateRange as ActionDef,
  setReportGrouping as ActionDef,
  runReport as ActionDef,
  compareReportPeriods as ActionDef,
  exportReportResults as ActionDef,
  scheduleReportDelivery as ActionDef,
];

/** No catalog-wide filterable column independent of `id` in this module's
 * 10 actions (every report-shaped action takes a specific report `id`) —
 * same convention as M26 Prices (`discriminationChecks: []`). */
export const m50DiscriminationChecks: DiscriminationCheck[] = [];

/** `entities[0] === 'structures'` with `kind = 'report'` — every action
 * on this module's own `id` needs an action-scoped hint. */
export const m50SynthHints: SynthHints = {
  'reports.get_report_definition:id': { table: 'structures', kind: KIND },
  'reports.update_report_filters:id': { table: 'structures', kind: KIND },
  'reports.set_report_date_range:id': { table: 'structures', kind: KIND },
  'reports.set_report_grouping:id': { table: 'structures', kind: KIND },
  'reports.run_report:id': { table: 'structures', kind: KIND },
  'reports.compare_report_periods:id': { table: 'structures', kind: KIND },
  'reports.export_report_results:id': { table: 'structures', kind: KIND },
  'reports.schedule_report_delivery:id': { table: 'structures', kind: KIND },
};
