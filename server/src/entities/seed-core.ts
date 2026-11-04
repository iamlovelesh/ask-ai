/**
 * Core entity generators: teams, users, companies, contacts, structures.
 * These run first because almost every later table references one of them.
 */

import { STRUCTURE_KINDS } from './model.js';
import type { SeedCtx } from './seed-context.js';
import { insert, nextId, pastTimestamp, pick, chance, slugify } from './seed-context.js';
import {
  FIRST_NAMES,
  LAST_NAMES,
  CITIES,
  COMPANY_PREFIXES,
  COMPANY_SUFFIXES,
  INDUSTRIES,
  COMPANY_SIZES,
  EMAIL_DOMAINS,
  LEAD_SOURCES,
  TEAM_NAMES,
} from './seed-data.js';

export interface UserPools {
  allIds: string[];
  salesRepIds: string[];
  activeSalesRepIds: string[];
  supportIds: string[];
  adminIds: string[];
}

export interface StructurePools {
  byKind: Map<string, string[]>;
}

function personName(ctx: SeedCtx): { first: string; last: string; name: string } {
  const first = pick(ctx, FIRST_NAMES);
  const last = pick(ctx, LAST_NAMES);
  return { first, last, name: `${first} ${last}` };
}

export function generateTeams(ctx: SeedCtx): string[] {
  const ids: string[] = [];
  for (const teamName of TEAM_NAMES) {
    const id = nextId(ctx, 'team');
    const createdAt = pastTimestamp(ctx, 720, 400);
    insert(ctx, 'teams', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      name: teamName,
      lead_user_id: null,
      member_count: 0,
      description: `${teamName} team`,
    });
    ids.push(id);
  }
  return ids;
}

/** 18 sales reps (14 active / 4 inactive), 5 admins, 17 support — 40 total. */
export function generateUsers(ctx: SeedCtx, teamIds: string[]): UserPools {
  const allIds: string[] = [];
  const salesRepIds: string[] = [];
  const activeSalesRepIds: string[] = [];
  const supportIds: string[] = [];
  const adminIds: string[] = [];

  function makeUser(role: 'admin' | 'sales_rep' | 'support', active: boolean): string {
    const { first, last, name } = personName(ctx);
    const id = nextId(ctx, 'user');
    const createdAt = pastTimestamp(ctx, 700, 60);
    const lastLoginAt = active ? pastTimestamp(ctx, 30, 0) : pastTimestamp(ctx, 400, 120);
    insert(ctx, 'users', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      name,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@ourcrm.io`,
      role,
      active: active ? 1 : 0,
      team_id: pick(ctx, teamIds),
      title: role === 'admin' ? 'Administrator' : role === 'sales_rep' ? 'Account Executive' : 'Support Specialist',
      phone: `+1-555-${100 + ctx.rng.int(900)}-${1000 + ctx.rng.int(9000)}`,
      last_login_at: lastLoginAt,
    });
    allIds.push(id);
    return id;
  }

  for (let i = 0; i < 14; i++) {
    const id = makeUser('sales_rep', true);
    salesRepIds.push(id);
    activeSalesRepIds.push(id);
  }
  for (let i = 0; i < 4; i++) salesRepIds.push(makeUser('sales_rep', false));
  for (let i = 0; i < 5; i++) adminIds.push(makeUser('admin', chance(ctx, 0.9)));
  for (let i = 0; i < 17; i++) supportIds.push(makeUser('support', chance(ctx, 0.85)));

  // member_count + lead_user_id derived from the actual assignment (real
  // aggregation, not a guess) — a second pass over the StoreTx.
  for (const teamId of teamIds) {
    const rows = ctx.db.all('SELECT id FROM users WHERE team_id = ?', [teamId]);
    const memberIds = rows.map((r) => r['id'] as string);
    const lead = memberIds.length > 0 ? pick(ctx, memberIds) : null;
    ctx.db.run('UPDATE teams SET member_count = ?, lead_user_id = ? WHERE id = ?', [
      memberIds.length,
      lead,
      teamId,
    ]);
  }

  return { allIds, salesRepIds, activeSalesRepIds, supportIds, adminIds };
}

const DAY_WEIGHT = 1000 * 60 * 60 * 24 * 5; // small jitter so updated_at >= created_at

export function generateCompanies(ctx: SeedCtx, ownerIds: string[], count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'co');
    const name = `${pick(ctx, COMPANY_PREFIXES)} ${pick(ctx, COMPANY_SUFFIXES)}`;
    const loc = pick(ctx, CITIES);
    const createdAt = pastTimestamp(ctx, 700, 1);
    insert(ctx, 'companies', {
      id,
      created_at: createdAt,
      updated_at: createdAt + ctx.rng.int(DAY_WEIGHT),
      archived: chance(ctx, 0.02) ? 1 : 0,
      name: `${name} ${1 + ctx.rng.int(999)}`,
      domain: `${slugify(name)}${1 + ctx.rng.int(999)}.com`,
      industry: pick(ctx, INDUSTRIES),
      size: pick(ctx, COMPANY_SIZES),
      owner_id: pick(ctx, ownerIds),
      city: loc.city,
      country: loc.country,
      phone: `+1-555-${100 + ctx.rng.int(900)}-${1000 + ctx.rng.int(9000)}`,
      address: `${1 + ctx.rng.int(9999)} Market St, ${loc.city}`,
      tags: JSON.stringify(chance(ctx, 0.5) ? ['key-account'] : []),
    });
    ids.push(id);
  }
  return ids;
}

export function generateContacts(
  ctx: SeedCtx,
  companyIds: string[],
  ownerIds: string[],
  count: number,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const { first, last, name } = personName(ctx);
    const id = nextId(ctx, 'con');
    const hasCompany = chance(ctx, 0.6);
    const companyId = hasCompany && companyIds.length > 0 ? pick(ctx, companyIds) : null;
    const domain = hasCompany ? null : pick(ctx, EMAIL_DOMAINS);
    const loc = pick(ctx, CITIES);
    const createdAt = pastTimestamp(ctx, 730, 0);
    insert(ctx, 'contacts', {
      id,
      created_at: createdAt,
      updated_at: createdAt + ctx.rng.int(DAY_WEIGHT),
      archived: chance(ctx, 0.02) ? 1 : 0,
      name,
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${ctx.rng.int(9999)}@${domain ?? 'company.com'}`,
      phone: `+1-555-${100 + ctx.rng.int(900)}-${1000 + ctx.rng.int(9000)}`,
      company_id: companyId,
      owner_id: pick(ctx, ownerIds),
      lifecycle_stage: pick(ctx, ['subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist']),
      source: pick(ctx, LEAD_SOURCES),
      city: loc.city,
      country: loc.country,
      address: `${1 + ctx.rng.int(9999)} Main St, ${loc.city}`,
      tags: JSON.stringify(chance(ctx, 0.3) ? ['vip'] : []),
      custom_fields: JSON.stringify({ newsletter: chance(ctx, 0.5) }),
    });
    ids.push(id);
  }
  return ids;
}

const STATUS_BY_KIND: Record<string, readonly string[]> = {
  smart_list: ['active', 'inactive'],
  custom_field: ['active', 'inactive'],
  template: ['active', 'archived'],
  campaign: ['active', 'paused', 'completed'],
  workflow: ['active', 'inactive', 'draft'],
  trigger: ['active', 'inactive'],
  form: ['published', 'draft'],
  survey: ['published', 'draft'],
  pipeline: ['active', 'archived'],
  calendar: ['active', 'inactive'],
  booking_page: ['published', 'draft'],
  coupon: ['active', 'expired', 'disabled'],
  tax_rule: ['active', 'inactive'],
  website: ['published', 'draft'],
  funnel: ['published', 'draft'],
  media_asset: ['active', 'archived'],
  community: ['active', 'archived'],
  membership_plan: ['active', 'archived'],
  business_listing: ['published', 'pending'],
  report: ['active', 'archived'],
  tag: ['active'],
};

/** Per-kind row counts for `structures`; every STRUCTURE_KINDS entry > 0. */
const STRUCTURE_COUNTS: Record<string, number> = {
  smart_list: 20,
  custom_field: 20,
  template: 30,
  campaign: 25,
  workflow: 20,
  trigger: 20,
  form: 15,
  survey: 15,
  pipeline: 10,
  calendar: 10,
  booking_page: 10,
  coupon: 25,
  tax_rule: 10,
  website: 10,
  funnel: 15,
  media_asset: 40,
  community: 10,
  membership_plan: 15,
  business_listing: 30,
  report: 15,
  tag: 30,
};

export function generateStructures(ctx: SeedCtx, ownerIds: string[]): StructurePools {
  const byKind = new Map<string, string[]>();
  for (const kind of STRUCTURE_KINDS) {
    const ids: string[] = [];
    const n = STRUCTURE_COUNTS[kind] ?? 10;
    const statuses = STATUS_BY_KIND[kind] ?? ['active'];
    for (let i = 0; i < n; i++) {
      const id = nextId(ctx, 'struct');
      const name = `${kind.replace(/_/g, ' ')} ${i + 1}`;
      const createdAt = pastTimestamp(ctx, 600, 0);
      insert(ctx, 'structures', {
        id,
        created_at: createdAt,
        updated_at: createdAt + ctx.rng.int(DAY_WEIGHT),
        archived: 0,
        kind,
        name,
        slug: kind === 'coupon' ? `SAVE${10 + ctx.rng.int(40)}-${id}` : `${slugify(name)}-${id}`,
        status: pick(ctx, statuses),
        owner_id: pick(ctx, ownerIds),
        parent_id: null,
        category: kind,
        config: JSON.stringify({ seeded: true, kind }),
        description: `Seeded ${kind.replace(/_/g, ' ')} #${i + 1}`,
      });
      ids.push(id);
    }
    byKind.set(kind, ids);
  }
  return { byKind };
}
