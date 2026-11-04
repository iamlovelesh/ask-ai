/**
 * M44 Memberships — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'membership_plan'` (the plan
 * definition — price/interval/entitlements) PLUS `participations` table,
 * `kind = 'membership'` (`parent_type='membership_plan'`, `parent_id` = the
 * plan id).
 *
 * SCHEMA COMPLETION (task-9 batch-5, see `entities/model.ts#MODULE_MAP`'s
 * M44 comment for the full writeup): the original note only listed
 * `participations(membership)`, with no data home at all for the PLAN
 * definition — inconsistent with every other "definition + per-member
 * relationship" module (M05/M18/M31/M43 all pair a `structures` kind with
 * a relationship table). Added `membership_plan` to `STRUCTURE_KINDS`/
 * `STRUCTURE_COUNTS`/`STATUS_BY_KIND` (`seed-core.ts`) and repointed
 * `participations(membership)`'s seeded `parent_id` at a real
 * `structures(membership_plan)` row (`seed-content.ts
 * #generateParticipations` previously pointed it at a `community` row —
 * also fixed). Required a `npm run seed` regeneration (committed
 * alongside this batch's code, same category as task-9-b4's
 * `orders.shipping_address` controller ruling).
 *
 * COLUMN REUSE (targeted, not a generic sidecar): `participations` has NO
 * free-text/JSON column at all. `grant_membership_to_contact`/
 * `set_membership_expiry`/`check_member_access` repurpose the generic
 * `completed_at` INT column to store `expires_at` — unlike `enrollment`'s
 * `completed_at` (a real "when did they finish" marker other M42 actions
 * read), NO other action reads/writes `completed_at` for the `membership`
 * kind, so this is a targeted, documented reuse rather than a generic
 * sidecar hack (and needs no new DDL).
 *
 * KIND-BLINDNESS NOTE: `structures`/`participations` are both shared
 * tables — every action needs an action-scoped synthHint.
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

const MODULE = 'memberships';
const PLAN_KIND = 'membership_plan';
const MEMBER_KIND = 'membership';

function slugify(name: string, id: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'plan'}-${id}`;
}

interface PlanConfig {
  price_cents: number;
  interval: string;
  entitlements: string[];
  description: string | null;
}

function readPlanConfig(row: Row): PlanConfig {
  const config = parseJsonObject(row['config']);
  return {
    price_cents: typeof config['price_cents'] === 'number' ? (config['price_cents'] as number) : 0,
    interval: typeof config['interval'] === 'string' ? (config['interval'] as string) : 'month',
    entitlements: Array.isArray(config['entitlements']) ? (config['entitlements'] as string[]) : [],
    description: (config['description'] as string | null | undefined) ?? null,
  };
}

function writePlanConfig(db: StoreTx, id: string, config: PlanConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

function getPlanRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, PLAN_KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Membership plan '${id}' does not exist.`);
  return row;
}

function getMembershipRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM participations WHERE id = ? AND kind = ?`, [id, MEMBER_KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Membership '${id}' does not exist.`);
  return row;
}

function countActiveMembers(db: StoreTx, planId: string): number {
  const row = db.get(`SELECT COUNT(*) AS n FROM participations WHERE kind = ? AND parent_id = ? AND status = 'active'`, [
    MEMBER_KIND,
    planId,
  ]);
  return (row?.['n'] as number) ?? 0;
}

interface PlanView {
  id: string;
  name: string;
  status: string;
  price_cents: number;
  interval: string;
  entitlements: string[];
  member_count: number;
  description: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toPlanView(db: StoreTx, row: Row): PlanView {
  const config = readPlanConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    price_cents: config.price_cents,
    interval: config.interval,
    entitlements: config.entitlements,
    member_count: countActiveMembers(db, row['id'] as string),
    description: config.description,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const planView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  price_cents: z.number(),
  interval: z.string(),
  entitlements: z.array(z.string()),
  member_count: z.number(),
  description: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

interface MembershipView {
  id: string;
  name: string;
  plan_id: string;
  contact_id: string;
  status: string;
  expires_at: number | null;
  joined_at: number;
}

function toMembershipView(db: StoreTx, row: Row): MembershipView {
  const contact = db.get(`SELECT name FROM contacts WHERE id = ?`, [row['contact_id']]);
  const plan = db.get(`SELECT name FROM structures WHERE id = ?`, [row['parent_id']]);
  const contactName = (contact?.['name'] as string | undefined) ?? (row['contact_id'] as string);
  const planName = (plan?.['name'] as string | undefined) ?? (row['parent_id'] as string);
  return {
    id: row['id'] as string,
    name: `${contactName}'s membership in '${planName}'`,
    plan_id: row['parent_id'] as string,
    contact_id: row['contact_id'] as string,
    status: row['status'] as string,
    expires_at: (row['completed_at'] as number | null) ?? null,
    joined_at: row['joined_at'] as number,
  };
}

const membershipView = z.object({
  id: z.string(),
  name: z.string(),
  plan_id: z.string(),
  contact_id: z.string(),
  status: z.string(),
  expires_at: z.number().nullable(),
  joined_at: z.number(),
});

// --- A01 create_membership_plan -----------------------------------------------------

const createMembershipPlanInput = z.strictObject({
  name: z.string().min(1),
  price_cents: z.number().int().min(0).optional(),
  interval: z.enum(['day', 'week', 'month', 'year']).optional(),
});

const createMembershipPlan: ActionDef<z.infer<typeof createMembershipPlanInput>, PlanView> = {
  id: 'M44.A01',
  slug: 'memberships.create_membership_plan',
  module: MODULE,
  name: 'Create membership plan',
  description: 'Create a new membership plan.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createMembershipPlanInput,
  outputSchema: planView,
  searchCard: { synonyms: ['add membership plan', 'new plan'], examplePhrasings: ['Create a Pro membership plan'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: PlanConfig = { price_cents: input.price_cents ?? 0, interval: input.interval ?? 'month', entitlements: [], description: null };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, PLAN_KIND, input.name, slugify(input.name, id), PLAN_KIND, JSON.stringify(config)],
    );
    return toPlanView(ctx.db, getPlanRow(ctx.db, id));
  }),
};

// --- A02 get_membership_plan -----------------------------------------------------

const getMembershipPlanInput = z.strictObject({ id: z.string() });

const getMembershipPlan: ActionDef<z.infer<typeof getMembershipPlanInput>, PlanView> = {
  id: 'M44.A02',
  slug: 'memberships.get_membership_plan',
  module: MODULE,
  name: 'Get membership plan',
  description: 'Fetch a membership plan and its live member count.',
  risk: 'read',
  entities: ['structures', 'participations'],
  inputSchema: getMembershipPlanInput,
  outputSchema: planView,
  searchCard: { synonyms: ['plan details', 'look up membership plan'], examplePhrasings: ['Show me this membership plan'] },
  handler: async (input, ctx) => toPlanView(ctx.db, getPlanRow(ctx.db, input.id)),
};

// --- A03 list_membership_plans -----------------------------------------------------

const listMembershipPlansInput = z.strictObject({ status: z.string().optional(), limit: z.number().int().min(1).max(50).optional() });
type ListMembershipPlansInput = z.infer<typeof listMembershipPlansInput>;
const listMembershipPlansOutput = listOutputSchema(planView);
type ListMembershipPlansOutput = ListOrSpill<PlanView>;

const listMembershipPlans: ActionDef<ListMembershipPlansInput, ListMembershipPlansOutput> = {
  id: 'M44.A03',
  slug: 'memberships.list_membership_plans',
  module: MODULE,
  name: 'List membership plans',
  description: 'List non-archived membership plans.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: listMembershipPlansInput,
  outputSchema: listMembershipPlansOutput,
  searchCard: { synonyms: ['all plans', 'show membership plans'], examplePhrasings: ['List our membership plans'] },
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [PLAN_KIND];
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM structures WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map((r) => toPlanView(ctx.db, r)), total);
  },
};

// --- A04 update_plan_description -----------------------------------------------------

const updatePlanDescriptionInput = z.strictObject({ id: z.string(), description: z.string() });

const updatePlanDescription: ActionDef<z.infer<typeof updatePlanDescriptionInput>, PlanView> = {
  id: 'M44.A04',
  slug: 'memberships.update_plan_description',
  module: MODULE,
  name: 'Update plan description',
  description: "Update a membership plan's description.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updatePlanDescriptionInput,
  outputSchema: planView,
  searchCard: { synonyms: ['edit plan description'], examplePhrasings: ["Update this plan's description"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPlanRow(ctx.db, input.id);
    const config = readPlanConfig(row);
    writePlanConfig(ctx.db, input.id, { ...config, description: input.description }, ctx.clock.now());
    return toPlanView(ctx.db, getPlanRow(ctx.db, input.id));
  }),
};

// --- A05 add_plan_entitlement -----------------------------------------------------

const addPlanEntitlementInput = z.strictObject({ id: z.string(), entitlement: z.string().min(1) });

const addPlanEntitlement: ActionDef<z.infer<typeof addPlanEntitlementInput>, PlanView> = {
  id: 'M44.A05',
  slug: 'memberships.add_plan_entitlement',
  module: MODULE,
  name: 'Add plan entitlement',
  description: 'Add an entitlement to a membership plan.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: addPlanEntitlementInput,
  outputSchema: planView,
  searchCard: { synonyms: ['add entitlement', 'grant plan feature'], examplePhrasings: ['Add premium support to this plan'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPlanRow(ctx.db, input.id);
    const config = readPlanConfig(row);
    if (config.entitlements.includes(input.entitlement)) {
      throw new ActionError('CONFLICT', `Plan '${input.id}' already has entitlement '${input.entitlement}'.`);
    }
    writePlanConfig(ctx.db, input.id, { ...config, entitlements: [...config.entitlements, input.entitlement] }, ctx.clock.now());
    return toPlanView(ctx.db, getPlanRow(ctx.db, input.id));
  }),
};

// --- A06 remove_plan_entitlement -----------------------------------------------------

const removePlanEntitlementInput = z.strictObject({ id: z.string(), entitlement: z.string().min(1) });

const removePlanEntitlement: ActionDef<z.infer<typeof removePlanEntitlementInput>, PlanView> = {
  id: 'M44.A06',
  slug: 'memberships.remove_plan_entitlement',
  module: MODULE,
  name: 'Remove plan entitlement',
  description: 'Remove an entitlement from a membership plan.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: removePlanEntitlementInput,
  outputSchema: planView,
  searchCard: { synonyms: ['remove entitlement', 'revoke plan feature'], examplePhrasings: ['Remove premium support from this plan'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getPlanRow(ctx.db, input.id);
    const config = readPlanConfig(row);
    if (!config.entitlements.includes(input.entitlement)) {
      throw new ActionError('NOT_FOUND', `Plan '${input.id}' has no entitlement '${input.entitlement}'.`);
    }
    writePlanConfig(ctx.db, input.id, { ...config, entitlements: config.entitlements.filter((e) => e !== input.entitlement) }, ctx.clock.now());
    return toPlanView(ctx.db, getPlanRow(ctx.db, input.id));
  }),
};

// --- A07 grant_membership_to_contact -----------------------------------------------------

const grantMembershipToContactInput = z.strictObject({ id: z.string(), contact_id: z.string(), expires_at: z.number().int().min(0).nullable().optional() });

const grantMembershipToContact: ActionDef<z.infer<typeof grantMembershipToContactInput>, MembershipView> = {
  id: 'M44.A07',
  slug: 'memberships.grant_membership_to_contact',
  module: MODULE,
  name: 'Grant membership to contact',
  description: 'Grant a contact active membership in a plan (CONFLICT if already active).',
  risk: 'write',
  entities: ['participations', 'structures'],
  inputSchema: grantMembershipToContactInput,
  outputSchema: membershipView,
  searchCard: { synonyms: ['grant membership', 'add member to plan'], examplePhrasings: ['Grant this contact Pro membership'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getPlanRow(ctx.db, input.id);
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    const existing = ctx.db.get(`SELECT id FROM participations WHERE kind = ? AND parent_id = ? AND contact_id = ? AND status = 'active'`, [
      MEMBER_KIND,
      input.id,
      input.contact_id,
    ]);
    if (existing) throw new ActionError('CONFLICT', `Contact '${input.contact_id}' already has an active membership in plan '${input.id}'.`);
    const id = nextId(ctx.db, 'participations', 'part');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO participations (id, created_at, updated_at, archived, kind, contact_id, parent_type, parent_id,
        status, waitlisted, role, joined_at, progress, completed_at)
       VALUES (?, ?, ?, 0, ?, ?, 'membership_plan', ?, 'active', 0, NULL, ?, NULL, ?)`,
      [id, now, now, MEMBER_KIND, input.contact_id, input.id, now, input.expires_at ?? null],
    );
    return toMembershipView(ctx.db, getMembershipRow(ctx.db, id));
  }),
};

// --- A08 set_membership_expiry -----------------------------------------------------

const setMembershipExpiryInput = z.strictObject({ id: z.string(), expires_at: z.number().int().min(0).nullable() });

const setMembershipExpiry: ActionDef<z.infer<typeof setMembershipExpiryInput>, MembershipView> = {
  id: 'M44.A08',
  slug: 'memberships.set_membership_expiry',
  module: MODULE,
  name: 'Set membership expiry',
  description: "Set (or clear, with null) a membership's expiry time.",
  risk: 'write',
  entities: ['participations'],
  inputSchema: setMembershipExpiryInput,
  outputSchema: membershipView,
  searchCard: { synonyms: ['set expiry date', 'change membership expiration'], examplePhrasings: ['Extend this membership by a year'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getMembershipRow(ctx.db, input.id);
    ctx.db.run(`UPDATE participations SET completed_at = ?, updated_at = ? WHERE id = ?`, [input.expires_at, ctx.clock.now(), input.id]);
    return toMembershipView(ctx.db, getMembershipRow(ctx.db, input.id));
  }),
};

// --- A09 revoke_membership -----------------------------------------------------

const revokeMembershipInput = z.strictObject({ id: z.string() });

const revokeMembership: ActionDef<z.infer<typeof revokeMembershipInput>, MembershipView> = {
  id: 'M44.A09',
  slug: 'memberships.revoke_membership',
  module: MODULE,
  name: 'Revoke membership',
  description: 'Revoke a membership (CONFLICT if already revoked).',
  risk: 'destructive',
  entities: ['participations'],
  inputSchema: revokeMembershipInput,
  outputSchema: membershipView,
  searchCard: { synonyms: ['cancel membership', 'remove member'], examplePhrasings: ['Revoke this membership'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getMembershipRow(ctx.db, input.id);
    if (row['status'] === 'revoked') throw new ActionError('CONFLICT', `Membership '${input.id}' is already revoked.`);
    ctx.db.run(`UPDATE participations SET status = 'revoked', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toMembershipView(ctx.db, getMembershipRow(ctx.db, input.id));
  }),
};

// --- A10 check_member_access -----------------------------------------------------

const checkMemberAccessInput = z.strictObject({ id: z.string() });
const accessOutput = z.object({
  id: z.string(),
  name: z.string(),
  plan_id: z.string(),
  contact_id: z.string(),
  status: z.string(),
  has_access: z.boolean(),
  expires_at: z.number().nullable(),
});

const checkMemberAccess: ActionDef<z.infer<typeof checkMemberAccessInput>, z.infer<typeof accessOutput>> = {
  id: 'M44.A10',
  slug: 'memberships.check_member_access',
  module: MODULE,
  name: 'Check member access',
  description: "Compute whether a membership currently grants access (active AND not expired).",
  risk: 'read',
  entities: ['participations'],
  inputSchema: checkMemberAccessInput,
  outputSchema: accessOutput,
  searchCard: { synonyms: ['check access', 'is membership active'], examplePhrasings: ['Does this contact still have access?'] },
  handler: async (input, ctx) => {
    const row = getMembershipRow(ctx.db, input.id);
    const expiresAt = (row['completed_at'] as number | null) ?? null;
    const now = ctx.clock.now();
    const hasAccess = row['status'] === 'active' && (expiresAt === null || expiresAt > now);
    return {
      id: input.id,
      name: `Access check for membership '${input.id}'`,
      plan_id: row['parent_id'] as string,
      contact_id: row['contact_id'] as string,
      status: row['status'] as string,
      has_access: hasAccess,
      expires_at: expiresAt,
    };
  },
};

export const m44Memberships: ActionDef[] = [
  createMembershipPlan as ActionDef,
  getMembershipPlan as ActionDef,
  listMembershipPlans as ActionDef,
  updatePlanDescription as ActionDef,
  addPlanEntitlement as ActionDef,
  removePlanEntitlement as ActionDef,
  grantMembershipToContact as ActionDef,
  setMembershipExpiry as ActionDef,
  revokeMembership as ActionDef,
  checkMemberAccess as ActionDef,
];

/**
 * No reliable Tier-A discrimination check: `membership_plan` is a thin,
 * freshly-added universe (15 seeded rows, `status` only ever
 * 'active'|'archived') and this module's OWN `create_membership_plan`
 * (always `status='active'`) shrinks whatever margin exists by exactly 1
 * every smoke run — verified live: the seeded split is close enough
 * (7 archived / 8 active) that a single create flips it to an 8-vs-8 tie,
 * failing the check. Same "thin universe" convention as M26 Prices/M41
 * Lessons/M43 Communities/M49 Teams — `discriminationChecks: []` rather
 * than a check that can spuriously fail depending on execution order.
 */
export const m44DiscriminationChecks: DiscriminationCheck[] = [];

/** `structures`/`participations` are both shared, kind-discriminated
 * tables — every action needs an action-scoped hint. */
export const m44SynthHints: SynthHints = {
  'memberships.get_membership_plan:id': { table: 'structures', kind: PLAN_KIND },
  'memberships.update_plan_description:id': { table: 'structures', kind: PLAN_KIND },
  'memberships.add_plan_entitlement:id': { table: 'structures', kind: PLAN_KIND },
  'memberships.remove_plan_entitlement:id': { table: 'structures', kind: PLAN_KIND },
  'memberships.grant_membership_to_contact:id': { table: 'structures', kind: PLAN_KIND },
  'memberships.set_membership_expiry:id': { table: 'participations', kind: MEMBER_KIND },
  'memberships.revoke_membership:id': { table: 'participations', kind: MEMBER_KIND },
  'memberships.check_member_access:id': { table: 'participations', kind: MEMBER_KIND },
};
