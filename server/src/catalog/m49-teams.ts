/**
 * M49 Teams — follows the M01 Contacts convention verbatim.
 *
 * Data home: typed `teams` table PLUS `records` table, `kind =
 * 'team_membership'` (`parent_id` = team id, `user_id` = member) — the
 * M:N membership relation `entities/model.ts#MODULE_MAP` calls out for
 * this module (carried-forward task-8 guide §10 ruling, NOT a redirect:
 * M49 both writes AND reads `team_membership`). `teams.member_count` is
 * always RECOMPUTED (never incrementally patched) from the LIVE
 * `team_membership` record set after every add/remove — same
 * `recomputeRegisteredCount` precedent as M24 Events.
 *
 * `teams.member_count` vs. `users.team_id`: `entities/seed-content.ts
 * #generateRecords` seeds one `team_membership` record per user matching
 * their OWN `users.team_id` at seed time, so the two start in sync — but
 * `users.team_id` is a separate "primary/home team" pointer this module
 * does not read or write going forward; `add_team_member`/
 * `remove_team_member`/`get_team_workload` operate ONLY on
 * `team_membership` records, per the model note's explicit M:N framing.
 *
 * `teams.description` (the only free-text column) is upgraded to a JSON
 * `{note, assignment_strategy}` sidecar — same "resilient sidecar,
 * normalize legacy plain string" pattern as task-9-b4's `quotes.notes`;
 * seeded teams carry a plain string (`'{teamName} team'`).
 *
 * `get_team_workload` (A09) is a REAL aggregation: for each active member,
 * counts their own open `tasks` (`owner_id`) + open `support_tickets`
 * (`assignee_id`) — never fabricated.
 *
 * `teams` is a plain typed table — no synthHints needed.
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

const MODULE = 'teams';
const MEMBERSHIP_KIND = 'team_membership';
const STRATEGIES = ['round_robin', 'load_balanced', 'manual'] as const;

interface TeamMeta {
  note: string | null;
  assignment_strategy: string | null;
}

function readTeamMeta(row: Row): TeamMeta {
  const raw = row['description'];
  if (typeof raw !== 'string' || raw.length === 0) return { note: null, assignment_strategy: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return { note: (obj['note'] as string | null | undefined) ?? null, assignment_strategy: (obj['assignment_strategy'] as string | null | undefined) ?? null };
    }
    return { note: raw, assignment_strategy: null };
  } catch {
    // legacy plain-string seed shape (e.g. "Sales team").
    return { note: raw, assignment_strategy: null };
  }
}

function writeTeamMeta(db: StoreTx, id: string, meta: TeamMeta, now: number): void {
  db.run(`UPDATE teams SET description = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(meta), now, id]);
}

function getTeamRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM teams WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Team '${id}' does not exist.`);
  return row;
}

function activeMemberUserIds(db: StoreTx, teamId: string): string[] {
  const rows = db.all(`SELECT user_id FROM records WHERE kind = ? AND parent_id = ? AND archived = 0`, [MEMBERSHIP_KIND, teamId]);
  return rows.map((r) => r['user_id'] as string).filter((id): id is string => id !== null);
}

/** Full recompute, never incremental — same precedent as M24's
 * `recomputeRegisteredCount`. */
function recomputeMemberCount(db: StoreTx, teamId: string, now: number): void {
  db.run(
    `UPDATE teams SET member_count = (
       SELECT COUNT(DISTINCT user_id) FROM records WHERE kind = ? AND parent_id = ? AND archived = 0
     ), updated_at = ? WHERE id = ?`,
    [MEMBERSHIP_KIND, teamId, now, teamId],
  );
}

interface TeamView {
  id: string;
  name: string;
  lead_user_id: string | null;
  member_count: number;
  note: string | null;
  assignment_strategy: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): TeamView {
  const meta = readTeamMeta(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    lead_user_id: (row['lead_user_id'] as string | null) ?? null,
    member_count: (row['member_count'] as number | null) ?? 0,
    note: meta.note,
    assignment_strategy: meta.assignment_strategy,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const teamView = z.object({
  id: z.string(),
  name: z.string(),
  lead_user_id: z.string().nullable(),
  member_count: z.number(),
  note: z.string().nullable(),
  assignment_strategy: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_team -----------------------------------------------------

const createTeamInput = z.strictObject({ name: z.string().min(1), note: z.string().optional() });

const createTeam: ActionDef<z.infer<typeof createTeamInput>, TeamView> = {
  id: 'M49.A01',
  slug: 'teams.create_team',
  module: MODULE,
  name: 'Create team',
  description: 'Create a new team.',
  risk: 'write',
  entities: ['teams'],
  inputSchema: createTeamInput,
  outputSchema: teamView,
  searchCard: { synonyms: ['add team', 'new team'], examplePhrasings: ['Create a Customer Success team'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'teams', 'team');
    const now = ctx.clock.now();
    const meta: TeamMeta = { note: input.note ?? null, assignment_strategy: null };
    ctx.db.run(
      `INSERT INTO teams (id, created_at, updated_at, archived, name, lead_user_id, member_count, description)
       VALUES (?, ?, ?, 0, ?, NULL, 0, ?)`,
      [id, now, now, input.name, JSON.stringify(meta)],
    );
    return toView(getTeamRow(ctx.db, id));
  }),
};

// --- A02 get_team_details -----------------------------------------------------

const getTeamDetailsInput = z.strictObject({ id: z.string() });

const getTeamDetails: ActionDef<z.infer<typeof getTeamDetailsInput>, TeamView> = {
  id: 'M49.A02',
  slug: 'teams.get_team_details',
  module: MODULE,
  name: 'Get team details',
  description: 'Fetch a single team by id.',
  risk: 'read',
  entities: ['teams'],
  inputSchema: getTeamDetailsInput,
  outputSchema: teamView,
  searchCard: { synonyms: ['team details', 'look up team'], examplePhrasings: ['Show me this team'] },
  handler: async (input, ctx) => toView(getTeamRow(ctx.db, input.id)),
};

// --- A03 list_teams -----------------------------------------------------

const listTeamsInput = z.strictObject({ limit: z.number().int().min(1).max(50).optional() });
type ListTeamsInput = z.infer<typeof listTeamsInput>;
const listTeamsOutput = listOutputSchema(teamView);
type ListTeamsOutput = ListOrSpill<TeamView>;

const listTeams: ActionDef<ListTeamsInput, ListTeamsOutput> = {
  id: 'M49.A03',
  slug: 'teams.list_teams',
  module: MODULE,
  name: 'List teams',
  description: 'List non-archived teams.',
  risk: 'read',
  entities: ['teams'],
  inputSchema: listTeamsInput,
  outputSchema: listTeamsOutput,
  searchCard: { synonyms: ['all teams', 'show teams'], examplePhrasings: ['List our teams'] },
  handler: async (input, ctx) => {
    const limit = input.limit ?? 50;
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM teams WHERE archived = 0`);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM teams WHERE archived = 0 ORDER BY created_at DESC LIMIT ?`, [limit]);
    return toListOrSpill(rows.map(toView), total);
  },
};

// --- A04 rename_team -----------------------------------------------------

const renameTeamInput = z.strictObject({ id: z.string(), name: z.string().min(1) });

const renameTeam: ActionDef<z.infer<typeof renameTeamInput>, TeamView> = {
  id: 'M49.A04',
  slug: 'teams.rename_team',
  module: MODULE,
  name: 'Rename team',
  description: 'Rename a team.',
  risk: 'write',
  entities: ['teams'],
  inputSchema: renameTeamInput,
  outputSchema: teamView,
  searchCard: { synonyms: ['change team name'], examplePhrasings: ['Rename this team'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTeamRow(ctx.db, input.id);
    ctx.db.run(`UPDATE teams SET name = ?, updated_at = ? WHERE id = ?`, [input.name, ctx.clock.now(), input.id]);
    return toView(getTeamRow(ctx.db, input.id));
  }),
};

// --- A05 add_team_member -----------------------------------------------------

const addTeamMemberInput = z.strictObject({ id: z.string(), user_id: z.string() });
const membershipOutput = z.object({ id: z.string(), name: z.string(), team_id: z.string(), user_id: z.string(), member_count: z.number() });

const addTeamMember: ActionDef<z.infer<typeof addTeamMemberInput>, z.infer<typeof membershipOutput>> = {
  id: 'M49.A05',
  slug: 'teams.add_team_member',
  module: MODULE,
  name: 'Add team member',
  description: 'Add a user as a team member (CONFLICT if already an active member).',
  risk: 'write',
  entities: ['records', 'teams', 'users'],
  inputSchema: addTeamMemberInput,
  outputSchema: membershipOutput,
  searchCard: { synonyms: ['add member', 'add user to team'], examplePhrasings: ['Add this user to the team'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    getTeamRow(ctx.db, input.id);
    const user = ctx.db.get(`SELECT id FROM users WHERE id = ?`, [input.user_id]);
    if (!user) throw new ActionError('NOT_FOUND', `User '${input.user_id}' does not exist.`);
    const existing = ctx.db.get(`SELECT id FROM records WHERE kind = ? AND parent_id = ? AND user_id = ? AND archived = 0`, [
      MEMBERSHIP_KIND,
      input.id,
      input.user_id,
    ]);
    if (existing) throw new ActionError('CONFLICT', `User '${input.user_id}' is already an active member of team '${input.id}'.`);
    const id = nextId(ctx.db, 'records', 'record');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO records (id, created_at, updated_at, archived, kind, parent_id, contact_id, user_id, occurred_at, data)
       VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?, ?)`,
      [id, now, now, MEMBERSHIP_KIND, input.id, input.user_id, now, JSON.stringify({ role: 'member' })],
    );
    recomputeMemberCount(ctx.db, input.id, now);
    const team = getTeamRow(ctx.db, input.id);
    return { id, name: `Membership for user '${input.user_id}'`, team_id: input.id, user_id: input.user_id, member_count: team['member_count'] as number };
  }),
};

// --- A06 remove_team_member -----------------------------------------------------

const removeTeamMemberInput = z.strictObject({ id: z.string(), user_id: z.string() });

const removeTeamMember: ActionDef<z.infer<typeof removeTeamMemberInput>, z.infer<typeof membershipOutput>> = {
  id: 'M49.A06',
  slug: 'teams.remove_team_member',
  module: MODULE,
  name: 'Remove team member',
  description: 'Remove a user from a team (soft-deletes the membership record).',
  risk: 'destructive',
  entities: ['records', 'teams'],
  inputSchema: removeTeamMemberInput,
  outputSchema: membershipOutput,
  searchCard: { synonyms: ['remove member', 'remove user from team'], examplePhrasings: ['Remove this user from the team'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTeamRow(ctx.db, input.id);
    const existing = ctx.db.get(`SELECT id FROM records WHERE kind = ? AND parent_id = ? AND user_id = ? AND archived = 0`, [
      MEMBERSHIP_KIND,
      input.id,
      input.user_id,
    ]);
    if (!existing) throw new ActionError('NOT_FOUND', `User '${input.user_id}' is not an active member of team '${input.id}'.`);
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE records SET archived = 1, updated_at = ? WHERE id = ?`, [now, existing['id']]);
    recomputeMemberCount(ctx.db, input.id, now);
    const team = getTeamRow(ctx.db, input.id);
    return { id: existing['id'] as string, name: `Membership for user '${input.user_id}'`, team_id: input.id, user_id: input.user_id, member_count: team['member_count'] as number };
  }),
};

// --- A07 assign_team_manager -----------------------------------------------------

const assignTeamManagerInput = z.strictObject({ id: z.string(), user_id: z.string() });

const assignTeamManager: ActionDef<z.infer<typeof assignTeamManagerInput>, TeamView> = {
  id: 'M49.A07',
  slug: 'teams.assign_team_manager',
  module: MODULE,
  name: 'Assign team manager',
  description: "Set a team's manager/lead (validates the user exists).",
  risk: 'write',
  entities: ['teams', 'users'],
  inputSchema: assignTeamManagerInput,
  outputSchema: teamView,
  searchCard: { synonyms: ['set team lead', 'assign manager'], examplePhrasings: ['Make this user the team lead'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTeamRow(ctx.db, input.id);
    const user = ctx.db.get(`SELECT id FROM users WHERE id = ?`, [input.user_id]);
    if (!user) throw new ActionError('NOT_FOUND', `User '${input.user_id}' does not exist.`);
    ctx.db.run(`UPDATE teams SET lead_user_id = ?, updated_at = ? WHERE id = ?`, [input.user_id, ctx.clock.now(), input.id]);
    return toView(getTeamRow(ctx.db, input.id));
  }),
};

// --- A08 set_team_assignment_strategy -----------------------------------------------------

const setTeamAssignmentStrategyInput = z.strictObject({ id: z.string(), strategy: z.enum(STRATEGIES) });

const setTeamAssignmentStrategy: ActionDef<z.infer<typeof setTeamAssignmentStrategyInput>, TeamView> = {
  id: 'M49.A08',
  slug: 'teams.set_team_assignment_strategy',
  module: MODULE,
  name: 'Set team assignment strategy',
  description: "Set how new work is routed to a team's members (round_robin|load_balanced|manual).",
  risk: 'write',
  entities: ['teams'],
  inputSchema: setTeamAssignmentStrategyInput,
  outputSchema: teamView,
  searchCard: { synonyms: ['set routing strategy', 'assignment strategy'], examplePhrasings: ['Use round robin for this team'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTeamRow(ctx.db, input.id);
    const meta = readTeamMeta(row);
    writeTeamMeta(ctx.db, input.id, { ...meta, assignment_strategy: input.strategy }, ctx.clock.now());
    return toView(getTeamRow(ctx.db, input.id));
  }),
};

// --- A09 get_team_workload -----------------------------------------------------

const getTeamWorkloadInput = z.strictObject({ id: z.string() });
const workloadEntry = z.object({ id: z.string(), name: z.string(), user_id: z.string(), open_tasks: z.number(), open_tickets: z.number(), total: z.number() });
const getTeamWorkloadOutput = listOutputSchema(workloadEntry);
type GetTeamWorkloadOutput = ListOrSpill<z.infer<typeof workloadEntry>>;

const getTeamWorkload: ActionDef<z.infer<typeof getTeamWorkloadInput>, GetTeamWorkloadOutput> = {
  id: 'M49.A09',
  slug: 'teams.get_team_workload',
  module: MODULE,
  name: 'Get team workload',
  description: "Compute each active member's real open-task/open-ticket counts.",
  risk: 'read',
  entities: ['teams', 'records', 'tasks', 'support_tickets'],
  inputSchema: getTeamWorkloadInput,
  outputSchema: getTeamWorkloadOutput,
  searchCard: { synonyms: ['team workload', 'who is overloaded'], examplePhrasings: ["What's this team's current workload?"] },
  handler: async (input, ctx) => {
    getTeamRow(ctx.db, input.id);
    const userIds = activeMemberUserIds(ctx.db, input.id);
    const entries = userIds.map((userId) => {
      const user = ctx.db.get(`SELECT name FROM users WHERE id = ?`, [userId]);
      const userName = (user?.['name'] as string | undefined) ?? userId;
      const tasks = ctx.db.get(`SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND status IN ('open','in_progress')`, [userId]);
      const tickets = ctx.db.get(`SELECT COUNT(*) AS n FROM support_tickets WHERE assignee_id = ? AND status IN ('open','pending')`, [userId]);
      const openTasks = (tasks?.['n'] as number) ?? 0;
      const openTickets = (tickets?.['n'] as number) ?? 0;
      return { id: userId, name: userName, user_id: userId, open_tasks: openTasks, open_tickets: openTickets, total: openTasks + openTickets };
    });
    entries.sort((a, b) => b.total - a.total);
    return toListOrSpill(entries.slice(0, 50), entries.length);
  },
};

// --- A10 archive_team -----------------------------------------------------

const archiveTeamInput = z.strictObject({ id: z.string() });
const archiveTeamOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const archiveTeam: ActionDef<z.infer<typeof archiveTeamInput>, z.infer<typeof archiveTeamOutput>> = {
  id: 'M49.A10',
  slug: 'teams.archive_team',
  module: MODULE,
  name: 'Archive team',
  description: 'Soft-delete a team (CONFLICT if it still has active members — remove them first).',
  risk: 'destructive',
  entities: ['teams'],
  inputSchema: archiveTeamInput,
  outputSchema: archiveTeamOutput,
  searchCard: { synonyms: ['delete team', 'remove team'], examplePhrasings: ['Archive this team'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTeamRow(ctx.db, input.id);
    const memberCount = (row['member_count'] as number | null) ?? 0;
    if (memberCount > 0) {
      throw new ActionError('CONFLICT', `Team '${input.id}' still has ${memberCount} active member(s) — remove them before archiving.`);
    }
    ctx.db.run(`UPDATE teams SET archived = 1, updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['name'] as string, archived: true as const };
  }),
};

export const m49Teams: ActionDef[] = [
  createTeam as ActionDef,
  getTeamDetails as ActionDef,
  listTeams as ActionDef,
  renameTeam as ActionDef,
  addTeamMember as ActionDef,
  removeTeamMember as ActionDef,
  assignTeamManager as ActionDef,
  setTeamAssignmentStrategy as ActionDef,
  getTeamWorkload as ActionDef,
  archiveTeam as ActionDef,
];

/** No catalog-wide filterable column on `teams` beyond `archived` (always
 * applied) — 6 seeded teams, too thin a universe for a reliable two-value
 * discrimination check; `discriminationChecks: []`, same convention as
 * M26 Prices. */
export const m49DiscriminationChecks: DiscriminationCheck[] = [];

/**
 * `teams` is a plain typed table — most actions' bare `id` resolves
 * correctly via `entities[0]`. `add_team_member`/`remove_team_member` are
 * the exception: their `entities` list `records` FIRST (the action's
 * write target), but the bare `id` field means the TEAM id — needs a
 * scoped hint overriding the `entities[0]` fallback (same pattern as
 * M47's `add_internal_ticket_note`).
 */
export const m49SynthHints: SynthHints = {
  'teams.add_team_member:id': { table: 'teams' },
  'teams.remove_team_member:id': { table: 'teams' },
};
