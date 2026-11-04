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
 *     the store via `SELECT id FROM <table> ... OFFSET <n>`, not a made-up
 *     string — most handlers do an existence check that would otherwise
 *     always throw NOT_FOUND. Multiple id fields pointing at the SAME table
 *     within one action (e.g. `primary_contact_id` / `duplicate_contact_id`)
 *     get DISTINCT rows via a per-call offset counter, so self-referential
 *     actions don't synthesize `primary === duplicate` and spuriously throw
 *     CONFLICT.
 *   - Enums → first declared option. Numbers → the schema's declared
 *     minimum, or 1. Strings → a field-name-aware stub (email-looking field
 *     names get a valid email, etc.) with a safeParse-validated fallback
 *     ladder.
 */

import { z } from 'zod';
import type { ActionDef } from './types.js';
import type { StoreTx } from '../store/db.js';

/** Field name → literal table name, for ids that don't follow the generic `{noun}_id` → `{noun}s` guess. */
const ID_FIELD_TABLE: Readonly<Record<string, string>> = {
  contact_id: 'contacts',
  related_contact_id: 'contacts',
  primary_contact_id: 'contacts',
  duplicate_contact_id: 'contacts',
  company_id: 'companies',
  lead_id: 'leads',
  opportunity_id: 'opportunities',
  owner_id: 'users',
  user_id: 'users',
  host_user_id: 'users',
  lead_user_id: 'users',
  assignee_id: 'users',
  author_id: 'users',
  instructor_id: 'users',
  team_id: 'teams',
  task_id: 'tasks',
  note_id: 'notes',
  conversation_id: 'conversations',
  message_id: 'messages',
  appointment_id: 'appointments',
  calendar_id: 'structures',
  booking_page_id: 'structures',
  event_id: 'events',
  product_id: 'products',
  quote_id: 'quotes',
  invoice_id: 'invoices',
  order_id: 'orders',
  payment_id: 'payments',
  subscription_id: 'subscriptions',
  coupon_id: 'structures',
  campaign_id: 'structures',
  pipeline_id: 'structures',
  template_id: 'structures',
  workflow_id: 'structures',
  trigger_id: 'structures',
  form_id: 'structures',
  survey_id: 'structures',
  course_id: 'courses',
  review_id: 'reviews',
  ticket_id: 'support_tickets',
};

function guessTableFromIdField(field: string): string | undefined {
  const mapped = ID_FIELD_TABLE[field];
  if (mapped) return mapped;
  if (!field.endsWith('_id')) return undefined;
  const base = field.slice(0, -3);
  return base.endsWith('y') ? `${base.slice(0, -1)}ies` : `${base}s`;
}

interface SynthCtx {
  tx: StoreTx;
  /** `def.entities` — used to resolve the bare `id` field. */
  entities: readonly string[];
  /** Per-synthesize-call offsets so repeated ids on the same table come back distinct. */
  usedOffsets: Map<string, number>;
  fieldName?: string;
}

function seededId(ctx: SynthCtx, table: string): string | undefined {
  const offset = ctx.usedOffsets.get(table) ?? 0;
  try {
    const row = ctx.tx.get(`SELECT id FROM ${table} ORDER BY id LIMIT 1 OFFSET ?`, [offset]);
    if (!row) return undefined;
    ctx.usedOffsets.set(table, offset + 1);
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
    const table = field === 'id' ? ctx.entities[0] : guessTableFromIdField(field);
    if (table) {
      const id = seededId(ctx, table);
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
 * id-shaped fields against real rows in `tx`. Throws (with the action slug
 * and the zod validation issues) if the synthesized value still fails the
 * schema — that's a signal the schema has a constraint these heuristics
 * don't cover, not a silent harness bug.
 */
export function synthesizeInput(def: ActionDef, tx: StoreTx): unknown {
  const ctx: SynthCtx = { tx, entities: def.entities, usedOffsets: new Map() };
  const candidate = synthesizeValue(def.inputSchema as z.ZodTypeAny, ctx);
  const result = (def.inputSchema as z.ZodTypeAny).safeParse(candidate);
  if (!result.success) {
    throw new Error(
      `synthesizeInput: could not build valid input for '${def.slug}': ${result.error.message}`,
    );
  }
  return result.data;
}
