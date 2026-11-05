/**
 * M48 Users — follows the M01 Contacts convention verbatim.
 *
 * Data home: typed `users` table (`entities/model.ts#MODULE_MAP`).
 *
 * `deactivate_user` (A07, documented judgment call per the brief): blocks
 * with `CONFLICT` if the user owns any OPEN assignment — an open/
 * in_progress `tasks` row (`owner_id`) or an open/pending `support_tickets`
 * row (`assignee_id`). Rationale: deactivating a user who still owns live
 * work silently orphans it (no other action reassigns on deactivation);
 * the caller must reassign first. `reactivate_user` has no such guard
 * (reactivating never orphans anything).
 *
 * `list_user_permissions` (A09, documented judgment call per the brief): a
 * STATIC role -> permissions map (not a per-call fabrication) —
 *   - admin:     manage_users, manage_billing, manage_all_records, view_reports
 *   - sales_rep: manage_contacts, manage_deals, view_reports
 *   - support:   manage_tickets, view_contacts
 *   - (no role): [] (a role-revoked user has no permissions)
 *
 * `view_user_audit_activity` (A10): a REAL merged read across `tasks`
 * (owner_id), `notes` (author_id), and `support_tickets` (assignee_id)
 * referencing this user — each source SQL-bounded (`LIMIT 200`) before
 * merge-sort, same SQL-bounded-before-spill pattern as M01's activity
 * timeline.
 *
 * `users` is a plain typed table — no synthHints needed.
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { Row, StoreTx } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import { nextId } from './next-id.js';
import type { SynthHints } from './synth-hints.js';

const MODULE = 'users';
const ROLES = ['admin', 'sales_rep', 'support'] as const;

const PERMISSIONS_BY_ROLE: Record<string, readonly string[]> = {
  admin: ['manage_users', 'manage_billing', 'manage_all_records', 'view_reports'],
  sales_rep: ['manage_contacts', 'manage_deals', 'view_reports'],
  support: ['manage_tickets', 'view_contacts'],
};

function getUserRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM users WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `User '${id}' does not exist.`);
  return row;
}

function countOpenAssignments(db: StoreTx, userId: string): number {
  const tasks = db.get(`SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND status IN ('open','in_progress')`, [userId]);
  const tickets = db.get(`SELECT COUNT(*) AS n FROM support_tickets WHERE assignee_id = ? AND status IN ('open','pending')`, [userId]);
  return ((tasks?.['n'] as number) ?? 0) + ((tickets?.['n'] as number) ?? 0);
}

interface UserView {
  id: string;
  name: string;
  email: string;
  role: string | null;
  active: boolean;
  team_id: string | null;
  title: string | null;
  phone: string | null;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): UserView {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    email: row['email'] as string,
    role: (row['role'] as string | null) ?? null,
    active: row['active'] === 1,
    team_id: (row['team_id'] as string | null) ?? null,
    title: (row['title'] as string | null) ?? null,
    phone: (row['phone'] as string | null) ?? null,
    last_login_at: (row['last_login_at'] as number | null) ?? null,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const userView = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string().nullable(),
  active: z.boolean(),
  team_id: z.string().nullable(),
  title: z.string().nullable(),
  phone: z.string().nullable(),
  last_login_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 invite_user -----------------------------------------------------

const inviteUserInput = z.strictObject({ name: z.string().min(1), email: z.string().email(), role: z.enum(ROLES), team_id: z.string().optional() });

const inviteUser: ActionDef<z.infer<typeof inviteUserInput>, UserView> = {
  id: 'M48.A01',
  slug: 'users.invite_user',
  module: MODULE,
  name: 'Invite user',
  description: 'Invite (provision) a new user. Immediate in this simulated environment — no pending-invite state is tracked.',
  risk: 'write',
  entities: ['users', 'teams'],
  inputSchema: inviteUserInput,
  outputSchema: userView,
  searchCard: { synonyms: ['add user', 'invite teammate'], examplePhrasings: ['Invite a new support rep'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    if (input.team_id) {
      const team = ctx.db.get(`SELECT id FROM teams WHERE id = ?`, [input.team_id]);
      if (!team) throw new ActionError('NOT_FOUND', `Team '${input.team_id}' does not exist.`);
    }
    const id = nextId(ctx.db, 'users', 'user');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO users (id, created_at, updated_at, archived, name, email, role, active, team_id, title, phone, last_login_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, 1, ?, NULL, NULL, NULL)`,
      [id, now, now, input.name, input.email, input.role, input.team_id ?? null],
    );
    return toView(getUserRow(ctx.db, id));
  }),
};

// --- A02 get_user_profile -----------------------------------------------------

const getUserProfileInput = z.strictObject({ id: z.string() });

const getUserProfile: ActionDef<z.infer<typeof getUserProfileInput>, UserView> = {
  id: 'M48.A02',
  slug: 'users.get_user_profile',
  module: MODULE,
  name: 'Get user profile',
  description: 'Fetch a single user by id.',
  risk: 'read',
  entities: ['users'],
  inputSchema: getUserProfileInput,
  outputSchema: userView,
  searchCard: { synonyms: ['user details', 'look up user'], examplePhrasings: ['Show me this user'] },
  handler: async (input, ctx) => toView(getUserRow(ctx.db, input.id)),
};

// --- A03 list_users -----------------------------------------------------

const listUsersInput = z.strictObject({
  // engine-wave E10 (RC6b): find a user BY NAME/EMAIL — the capability gap
  // that forced users to hand over raw user ids. Case-insensitive substring
  // over name OR email, mirroring other modules' search `query` param.
  query: z.string().optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  team_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListUsersInput = z.infer<typeof listUsersInput>;
const listUsersOutput = listOutputSchema(userView);
type ListUsersOutput = ListOrSpill<UserView>;

const listUsers: ActionDef<ListUsersInput, ListUsersOutput> = {
  id: 'M48.A03',
  slug: 'users.list_users',
  module: MODULE,
  name: 'List users',
  description: 'List or find non-archived users by name/email (query), role, active state, and team.',
  risk: 'read',
  entities: ['users'],
  inputSchema: listUsersInput,
  outputSchema: listUsersOutput,
  searchCard: {
    synonyms: ['all users', 'show team members', 'find user', 'user by name', 'look up user'],
    examplePhrasings: ['List all active sales reps', 'Find the user named Hana Larsen', "What's Priya's user id"],
  },
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.query) {
      where.push('(LOWER(name) LIKE ? OR LOWER(email) LIKE ?)');
      const like = `%${input.query.toLowerCase()}%`;
      params.push(like, like);
    }
    if (input.role) {
      where.push('role = ?');
      params.push(input.role);
    }
    if (input.active !== undefined) {
      where.push('active = ?');
      params.push(input.active ? 1 : 0);
    }
    if (input.team_id) {
      where.push('team_id = ?');
      params.push(input.team_id);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM users WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM users WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'users', whereSql, params },
    });
  },
};

// --- A04 update_user_profile -----------------------------------------------------

const updateUserProfileInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({ name: z.string().min(1).optional(), title: z.string().optional(), phone: z.string().optional() })
    .refine((p) => Object.keys(p).length > 0, { message: 'patch must not be empty' }),
});

const updateUserProfile: ActionDef<z.infer<typeof updateUserProfileInput>, UserView> = {
  id: 'M48.A04',
  slug: 'users.update_user_profile',
  module: MODULE,
  name: 'Update user profile',
  description: "Patch a user's name/title/phone.",
  risk: 'write',
  entities: ['users'],
  inputSchema: updateUserProfileInput,
  outputSchema: userView,
  searchCard: { synonyms: ['edit user profile', 'update user'], examplePhrasings: ["Update this user's title"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getUserRow(ctx.db, input.id);
    const fields = Object.entries(input.patch);
    const setSql = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([, v]) => v);
    ctx.db.run(`UPDATE users SET ${setSql}, updated_at = ? WHERE id = ?`, [...values, ctx.clock.now(), input.id]);
    return toView(getUserRow(ctx.db, input.id));
  }),
};

// --- A05 assign_user_role -----------------------------------------------------

const assignUserRoleInput = z.strictObject({ id: z.string(), role: z.enum(ROLES) });

const assignUserRole: ActionDef<z.infer<typeof assignUserRoleInput>, UserView> = {
  id: 'M48.A05',
  slug: 'users.assign_user_role',
  module: MODULE,
  name: 'Assign user role',
  description: 'Set a user\'s role (admin|sales_rep|support).',
  risk: 'write',
  entities: ['users'],
  inputSchema: assignUserRoleInput,
  outputSchema: userView,
  searchCard: { synonyms: ['set role', 'promote user'], examplePhrasings: ['Make this user an admin'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getUserRow(ctx.db, input.id);
    ctx.db.run(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, [input.role, ctx.clock.now(), input.id]);
    return toView(getUserRow(ctx.db, input.id));
  }),
};

// --- A06 revoke_user_role -----------------------------------------------------

const revokeUserRoleInput = z.strictObject({ id: z.string(), role: z.enum(ROLES) });

const revokeUserRole: ActionDef<z.infer<typeof revokeUserRoleInput>, UserView> = {
  id: 'M48.A06',
  slug: 'users.revoke_user_role',
  module: MODULE,
  name: 'Revoke user role',
  description: "Revoke a user's CURRENT role (CONFLICT if their current role doesn't match), leaving them roleless.",
  risk: 'write',
  entities: ['users'],
  inputSchema: revokeUserRoleInput,
  outputSchema: userView,
  searchCard: { synonyms: ['remove role', 'demote user'], examplePhrasings: ["Revoke this user's admin role"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getUserRow(ctx.db, input.id);
    if (row['role'] !== input.role) {
      throw new ActionError('CONFLICT', `User '${input.id}'s current role is '${row['role'] as string | null}', not '${input.role}'.`);
    }
    ctx.db.run(`UPDATE users SET role = NULL, updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getUserRow(ctx.db, input.id));
  }),
};

// --- A07 deactivate_user -----------------------------------------------------

const deactivateUserInput = z.strictObject({ id: z.string() });

const deactivateUser: ActionDef<z.infer<typeof deactivateUserInput>, UserView> = {
  id: 'M48.A07',
  slug: 'users.deactivate_user',
  module: MODULE,
  name: 'Deactivate user',
  description: 'Deactivate a user (CONFLICT if they still own open tasks/tickets — reassign those first).',
  risk: 'destructive',
  entities: ['users', 'tasks', 'support_tickets'],
  inputSchema: deactivateUserInput,
  outputSchema: userView,
  searchCard: {
    synonyms: ['disable user', 'offboard user', 'lock out of their account'],
    examplePhrasings: ['Deactivate this user', 'Lock this person out of their account'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getUserRow(ctx.db, input.id);
    if (row['active'] === 0) throw new ActionError('CONFLICT', `User '${input.id}' is already inactive.`);
    const openCount = countOpenAssignments(ctx.db, input.id);
    if (openCount > 0) {
      throw new ActionError('CONFLICT', `User '${input.id}' still owns ${openCount} open task(s)/ticket(s) — reassign them before deactivating.`);
    }
    ctx.db.run(`UPDATE users SET active = 0, updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getUserRow(ctx.db, input.id));
  }),
};

// --- A08 reactivate_user -----------------------------------------------------

const reactivateUserInput = z.strictObject({ id: z.string() });

const reactivateUser: ActionDef<z.infer<typeof reactivateUserInput>, UserView> = {
  id: 'M48.A08',
  slug: 'users.reactivate_user',
  module: MODULE,
  name: 'Reactivate user',
  description: 'Reactivate a deactivated user (CONFLICT if already active).',
  risk: 'write',
  entities: ['users'],
  inputSchema: reactivateUserInput,
  outputSchema: userView,
  searchCard: { synonyms: ['re-enable user', 'restore user access'], examplePhrasings: ['Reactivate this user'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getUserRow(ctx.db, input.id);
    if (row['active'] === 1) throw new ActionError('CONFLICT', `User '${input.id}' is already active.`);
    ctx.db.run(`UPDATE users SET active = 1, updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(getUserRow(ctx.db, input.id));
  }),
};

// --- A09 list_user_permissions -----------------------------------------------------

const listUserPermissionsInput = z.strictObject({ id: z.string() });
const permissionsOutput = z.object({ id: z.string(), name: z.string(), role: z.string().nullable(), permissions: z.array(z.string()) });

const listUserPermissions: ActionDef<z.infer<typeof listUserPermissionsInput>, z.infer<typeof permissionsOutput>> = {
  id: 'M48.A09',
  slug: 'users.list_user_permissions',
  module: MODULE,
  name: 'List user permissions',
  description: "Derive a user's permission list from their role (a static, documented role->permissions map).",
  risk: 'read',
  entities: ['users'],
  inputSchema: listUserPermissionsInput,
  outputSchema: permissionsOutput,
  searchCard: { synonyms: ['user permissions', 'what can this user do'], examplePhrasings: ['What can this user do?'] },
  handler: async (input, ctx) => {
    const row = getUserRow(ctx.db, input.id);
    const role = (row['role'] as string | null) ?? null;
    const permissions = role ? PERMISSIONS_BY_ROLE[role] ?? [] : [];
    return { id: input.id, name: row['name'] as string, role, permissions: [...permissions] };
  },
};

// --- A10 view_user_audit_activity -----------------------------------------------------

const viewUserAuditActivityInput = z.strictObject({ id: z.string(), limit: z.number().int().min(1).max(50).optional() });
const activityEntry = z.object({ id: z.string(), name: z.string(), source: z.string(), summary: z.string(), occurred_at: z.number() });
const activityOutput = listOutputSchema(activityEntry);
type ActivityOutput = ListOrSpill<z.infer<typeof activityEntry>>;

const viewUserAuditActivity: ActionDef<z.infer<typeof viewUserAuditActivityInput>, ActivityOutput> = {
  id: 'M48.A10',
  slug: 'users.view_user_audit_activity',
  module: MODULE,
  name: 'View user audit activity',
  description: 'Real merged activity feed for a user: tasks they own, notes they authored, tickets assigned to them (each source LIMIT 200, merge-sorted).',
  risk: 'read',
  entities: ['users', 'tasks', 'notes', 'support_tickets'],
  inputSchema: viewUserAuditActivityInput,
  outputSchema: activityOutput,
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  searchCard: { synonyms: ['user activity', 'audit trail'], examplePhrasings: ["What has this user been doing?"] },
  handler: async (input, ctx) => {
    getUserRow(ctx.db, input.id);
    const limit = input.limit ?? 50;
    const taskRows = ctx.db.all(`SELECT id, title, updated_at FROM tasks WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 200`, [input.id]);
    const noteRows = ctx.db.all(`SELECT id, body, updated_at FROM notes WHERE author_id = ? ORDER BY updated_at DESC LIMIT 200`, [input.id]);
    const ticketRows = ctx.db.all(`SELECT id, subject, updated_at FROM support_tickets WHERE assignee_id = ? ORDER BY updated_at DESC LIMIT 200`, [
      input.id,
    ]);
    const taskCount = ctx.db.get(`SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ?`, [input.id]);
    const noteCount = ctx.db.get(`SELECT COUNT(*) AS n FROM notes WHERE author_id = ?`, [input.id]);
    const ticketCount = ctx.db.get(`SELECT COUNT(*) AS n FROM support_tickets WHERE assignee_id = ?`, [input.id]);
    const total = ((taskCount?.['n'] as number) ?? 0) + ((noteCount?.['n'] as number) ?? 0) + ((ticketCount?.['n'] as number) ?? 0);
    const merged = [
      ...taskRows.map((r) => ({ id: r['id'] as string, name: `Task: ${r['title'] as string}`, source: 'tasks', summary: `Owns task '${r['title'] as string}'`, occurred_at: r['updated_at'] as number })),
      ...noteRows.map((r) => ({ id: r['id'] as string, name: `Note`, source: 'notes', summary: `Authored a note: ${(r['body'] as string).slice(0, 60)}`, occurred_at: r['updated_at'] as number })),
      ...ticketRows.map((r) => ({ id: r['id'] as string, name: `Ticket: ${r['subject'] as string}`, source: 'support_tickets', summary: `Assigned ticket '${r['subject'] as string}'`, occurred_at: r['updated_at'] as number })),
    ].sort((a, b) => b.occurred_at - a.occurred_at);
    return toListOrSpill(merged.slice(0, limit), total);
  },
};

export const m48Users: ActionDef[] = [
  inviteUser as ActionDef,
  getUserProfile as ActionDef,
  listUsers as ActionDef,
  updateUserProfile as ActionDef,
  assignUserRole as ActionDef,
  revokeUserRole as ActionDef,
  deactivateUser as ActionDef,
  reactivateUser as ActionDef,
  listUserPermissions as ActionDef,
  viewUserAuditActivity as ActionDef,
];

/**
 * Tier-A discrimination: `active` counts against the standard template
 * (verified live: active=true -> 33, active=false -> 7 out of 40 seeded
 * users). Deliberately NOT `role` (18 sales_rep vs 17 support) — this
 * module's own `assign_user_role`/`revoke_user_role`/`invite_user` can
 * each shift a role count by 1, and a full `npm run smoke` run executes
 * ALL actions (across every module) before any discrimination check runs,
 * so a 1-row margin reliably ties under the real full-suite run (caught
 * live: `18 vs 17` exact-tied at `17 vs 17` after `assign_user_role`
 * moved one sales_rep to admin). `active`'s 26-row margin comfortably
 * survives `deactivate_user`/`reactivate_user` each moving at most 1 row.
 */
export const m48DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'users.list_users',
    paramsA: { active: true },
    paramsB: { active: false },
    expectDifferentCounts: true,
  },
];

/** `users` is a plain typed table — no synthHints needed. */
export const m48SynthHints: SynthHints = {};
