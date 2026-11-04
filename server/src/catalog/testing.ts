/**
 * `synthesizeInput` — builds a minimal-valid-input value for an `ActionDef`
 * straight from its Zod `inputSchema`, pulling real seeded ids out of the
 * store for anything that looks like a foreign key (task-8 brief
 * deliverable). This is the engine behind `eval/smoke.ts`: every registered
 * action gets exercised with a value its OWN schema accepts, without any
 * module-specific test fixtures.
 *
 * Design notes (see task-8-report.md "MODULE AUTHOR GUIDE" for the full
 * writeup):
 *   - Every declared object key is filled, not just the required ones.
 *     Several handlers enforce "need at least one of several optional
 *     fields" as a runtime/business rule rather than a zod `.refine()`
 *     (e.g. `create_contact` needs `name` OR `first_name`/`last_name`) —
 *     filling every key is the only way a generic synthesizer satisfies
 *     those without per-action special-casing.
 *   - Id-shaped fields (`id`, `*_id`) resolve to a REAL row id already in
 *     the store via `SELECT id FROM <table> [WHERE kind = ?] ... OFFSET
 *     <n>`, not a made-up string — most handlers do an existence check that
 *     would otherwise always throw NOT_FOUND. Multiple id fields pointing
 *     at the SAME (table, kind) within one action (e.g.
 *     `primary_contact_id` / `duplicate_contact_id`) get DISTINCT rows via
 *     a per-call offset counter, so self-referential actions don't
 *     synthesize `primary === duplicate` and spuriously throw CONFLICT.
 *   - Shared "mega-tables" (`structures`/`records`/`participations`) carry
 *     a `kind` discriminator — resolving against them with no kind filter
 *     is kind-blind and can hand back the wrong kind of row entirely.
 *     Callers (`eval/smoke.ts`) pass `MODULE_SYNTH_HINTS`
 *     (`catalog/synth-hints.ts`, module-declared) so id resolution for
 *     those fields filters by the right `kind`. A small built-in set of
 *     hints covers the common `structures`-backed field names already
 *     known at this layer (`coupon_id`, `campaign_id`, …) — explicit hints
 *     passed in override these defaults.
 *   - Enums → first declared option. Numbers → the schema's declared
 *     minimum, or 1. Strings → a field-name-aware stub (email-looking field
 *     names get a valid email, etc.) with a safeParse-validated fallback
 *     ladder.
 */

import { z } from 'zod';
import type { ActionDef } from './types.js';
import type { StoreTx } from '../store/db.js';
import type { SynthHint, SynthHints } from './synth-hints.js';

/**
 * Built-in field name → resolution hint, for ids that don't follow the
 * generic `{noun}_id` → `{noun}s` guess, OR that resolve against a
 * kind-discriminated shared table. These are DEFAULTS — a hint of the same
 * field name passed into `synthesizeInput` (from a module's `synthHints`
 * export, merged via `MODULE_SYNTH_HINTS`) takes precedence.
 */
const DEFAULT_HINTS: Readonly<SynthHints> = {
  contact_id: { table: 'contacts' },
  related_contact_id: { table: 'contacts' },
  primary_contact_id: { table: 'contacts' },
  duplicate_contact_id: { table: 'contacts' },
  company_id: { table: 'companies' },
  lead_id: { table: 'leads' },
  opportunity_id: { table: 'opportunities' },
  owner_id: { table: 'users' },
  user_id: { table: 'users' },
  host_user_id: { table: 'users' },
  lead_user_id: { table: 'users' },
  assignee_id: { table: 'users' },
  author_id: { table: 'users' },
  instructor_id: { table: 'users' },
  team_id: { table: 'teams' },
  task_id: { table: 'tasks' },
  note_id: { table: 'notes' },
  conversation_id: { table: 'conversations' },
  message_id: { table: 'messages' },
  appointment_id: { table: 'appointments' },
  event_id: { table: 'events' },
  product_id: { table: 'products' },
  quote_id: { table: 'quotes' },
  invoice_id: { table: 'invoices' },
  order_id: { table: 'orders' },
  payment_id: { table: 'payments' },
  subscription_id: { table: 'subscriptions' },
  course_id: { table: 'courses' },
  review_id: { table: 'reviews' },
  ticket_id: { table: 'support_tickets' },
  // structures-backed (kind == the field's own base name — STRUCTURE_KINDS
  // in entities/model.ts uses exactly these kind strings):
  calendar_id: { table: 'structures', kind: 'calendar' },
  booking_page_id: { table: 'structures', kind: 'booking_page' },
  coupon_id: { table: 'structures', kind: 'coupon' },
  campaign_id: { table: 'structures', kind: 'campaign' },
  pipeline_id: { table: 'structures', kind: 'pipeline' },
  template_id: { table: 'structures', kind: 'template' },
  workflow_id: { table: 'structures', kind: 'workflow' },
  trigger_id: { table: 'structures', kind: 'trigger' },
  form_id: { table: 'structures', kind: 'form' },
  survey_id: { table: 'structures', kind: 'survey' },
};

function guessHintFromIdField(field: string, hints: Readonly<SynthHints>): SynthHint | undefined {
  const explicit = hints[field] ?? DEFAULT_HINTS[field];
  if (explicit) return explicit;
  if (!field.endsWith('_id')) return undefined;
  const base = field.slice(0, -3);
  const table = base.endsWith('y') ? `${base.slice(0, -1)}ies` : `${base}s`;
  return { table };
}

interface SynthCtx {
  tx: StoreTx;
  /** `def.entities` — used to resolve the bare `id` field. */
  entities: readonly string[];
  /** module-declared hints, take precedence over `DEFAULT_HINTS`. */
  hints: Readonly<SynthHints>;
  /** Per-synthesize-call offsets, keyed by `table:kind`, so repeated ids on
   * the same (table, kind) come back distinct. */
  usedOffsets: Map<string, number>;
  fieldName?: string;
}

function seededId(ctx: SynthCtx, hint: SynthHint): string | undefined {
  const offsetKey = `${hint.table}:${hint.kind ?? ''}`;
  const offset = ctx.usedOffsets.get(offsetKey) ?? 0;
  try {
    const sql = hint.kind
      ? `SELECT id FROM ${hint.table} WHERE kind = ? ORDER BY id LIMIT 1 OFFSET ?`
      : `SELECT id FROM ${hint.table} ORDER BY id LIMIT 1 OFFSET ?`;
    const params = hint.kind ? [hint.kind, offset] : [offset];
    const row = ctx.tx.get(sql, params);
    if (!row) return undefined;
    ctx.usedOffsets.set(offsetKey, offset + 1);
    return row['id'] as string;
  } catch {
    return undefined;
  }
}

function fieldNameCandidates(field: string): string[] {
  const lower = field.toLowerCase();
  const base = ['smoke-test-value', 'Smoke Test Value'];
  if (lower.includes('email')) return ['smoke.test@example.com', ...base];
  if (lower.includes('phone')) return ['+15555550123', ...base];
  if (lower.includes('url') || lower.includes('link')) return ['https://example.com/smoke', ...base];
  if (lower.includes('slug')) return ['smoke-test-slug', ...base];
  return base;
}

function stringValueFor(ctx: SynthCtx, schema: z.ZodString): string {
  const field = ctx.fieldName ?? '';
  if (field === 'id' || field.endsWith('_id')) {
    const hint =
      field === 'id'
        ? (ctx.entities[0] ? { table: ctx.entities[0] } : undefined)
        : guessHintFromIdField(field, ctx.hints);
    if (hint) {
      const id = seededId(ctx, hint);
      if (id) return id;
    }
  }
  for (const candidate of fieldNameCandidates(field)) {
    if (schema.safeParse(candidate).success) return candidate;
  }
  return 'smoke-test-value';
}

function numberValueFor(schema: z.ZodNumber): number {
  const min = (schema as unknown as { minValue?: number | null }).minValue;
  const max = (schema as unknown as { maxValue?: number | null }).maxValue;
  const candidates = [min ?? 1, 1, 0, max ?? 10, 10];
  for (const candidate of candidates) {
    if (schema.safeParse(candidate).success) return candidate;
  }
  return min ?? 1;
}

function synthesizeValue(schema: z.ZodTypeAny, ctx: SynthCtx): unknown {
  if (schema instanceof z.ZodOptional) {
    return synthesizeValue(schema.unwrap() as z.ZodTypeAny, ctx);
  }
  if (schema instanceof z.ZodDefault) {
    return synthesizeValue(schema.unwrap() as z.ZodTypeAny, ctx);
  }
  if (schema instanceof z.ZodNullable) {
    return synthesizeValue(schema.unwrap() as z.ZodTypeAny, ctx);
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const out: Record<string, unknown> = {};
    for (const [key, sub] of Object.entries(shape)) {
      out[key] = synthesizeValue(sub, { ...ctx, fieldName: key });
    }
    return out;
  }

  if (schema instanceof z.ZodString) return stringValueFor(ctx, schema);
  if (schema instanceof z.ZodNumber) return numberValueFor(schema);
  if (schema instanceof z.ZodBoolean) return true;
  if (schema instanceof z.ZodEnum) {
    const options = schema.options as unknown[];
    return options[0];
  }
  if (schema instanceof z.ZodLiteral) return (schema as unknown as { value: unknown }).value;
  if (schema instanceof z.ZodArray) {
    return [synthesizeValue(schema.element as z.ZodTypeAny, ctx)];
  }
  if (schema instanceof z.ZodRecord) return {};
  if (schema instanceof z.ZodUnion) {
    const options = (schema as unknown as { options: z.ZodTypeAny[] }).options;
    const first = options[0];
    return first ? synthesizeValue(first, ctx) : undefined;
  }
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return {};
  return undefined;
}

/**
 * Build a minimal-valid-input value for `def.inputSchema`, resolving
 * id-shaped fields against real rows in `tx`. `hints` (typically
 * `MODULE_SYNTH_HINTS` from `module-index.ts`) supplies module-declared
 * `{table, kind}` resolution for fields backed by a kind-discriminated
 * shared table (`structures`/`records`/`participations`) — pass it
 * whenever the action you're synthesizing for might touch one of those.
 *
 * Throws (with the action slug and the zod validation issues) if the
 * synthesized value still fails the schema — that's a signal the schema
 * has a constraint these heuristics don't cover, not a silent harness bug.
 */
export function synthesizeInput(
  def: ActionDef,
  tx: StoreTx,
  hints: Readonly<SynthHints> = {},
): unknown {
  const ctx: SynthCtx = { tx, entities: def.entities, hints, usedOffsets: new Map() };
  const candidate = synthesizeValue(def.inputSchema as z.ZodTypeAny, ctx);
  const result = (def.inputSchema as z.ZodTypeAny).safeParse(candidate);
  if (!result.success) {
    throw new Error(
      `synthesizeInput: could not build valid input for '${def.slug}': ${result.error.message}`,
    );
  }
  return result.data;
}
