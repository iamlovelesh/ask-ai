/**
 * Leads + opportunities. Leads carry the "scenario-material guarantee":
 * at least `minLastWeek` leads created within the previous calendar week,
 * spread naturally across the week with mixed sources/owners.
 */

import type { SeedCtx } from './seed-context.js';
import { insert, nextId, pastTimestamp, withinLastWeek, pick, chance } from './seed-context.js';
import { LEAD_SOURCES } from './seed-data.js';

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'disqualified'] as const;

function insertLead(
  ctx: SeedCtx,
  createdAt: number,
  contactIds: string[],
  ownerIds: string[],
  campaignIds: string[],
  statusPool: readonly string[],
): void {
  const id = nextId(ctx, 'lead');
  insert(ctx, 'leads', {
    id,
    created_at: createdAt,
    updated_at: createdAt + ctx.rng.int(1000 * 60 * 60 * 24 * 3),
    archived: 0,
    name: `Lead ${id}`,
    contact_id: chance(ctx, 0.5) && contactIds.length > 0 ? pick(ctx, contactIds) : null,
    source: pick(ctx, LEAD_SOURCES),
    status: pick(ctx, statusPool),
    score: ctx.rng.int(101),
    owner_id: pick(ctx, ownerIds),
    campaign_id: chance(ctx, 0.7) && campaignIds.length > 0 ? pick(ctx, campaignIds) : null,
    value_cents: 50_00 + ctx.rng.int(500_00),
    notes: chance(ctx, 0.3) ? 'Inbound interest, needs qualification.' : null,
  });
}

/**
 * `minLastWeek` leads are explicitly timestamped within the previous
 * calendar week (spread across all 7 days/hours via the PRNG, with normal
 * source/owner/status variety) — a deterministic floor on top of the
 * organic distribution, mirroring real pipelines where recent weeks carry
 * more fresh, unqualified volume than older cohorts.
 */
export function generateLeads(
  ctx: SeedCtx,
  contactIds: string[],
  ownerIds: string[],
  campaignIds: string[],
  total: number,
  minLastWeek: number,
): void {
  for (let i = 0; i < minLastWeek; i++) {
    insertLead(ctx, withinLastWeek(ctx), contactIds, ownerIds, campaignIds, ['new', 'new', 'contacted']);
  }
  for (let i = minLastWeek; i < total; i++) {
    const createdAt = pastTimestamp(ctx, 400, 0);
    insertLead(ctx, createdAt, contactIds, ownerIds, campaignIds, LEAD_STATUSES);
  }
}

const STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost'] as const;

export function generateOpportunities(
  ctx: SeedCtx,
  contactIds: string[],
  companyIds: string[],
  pipelineIds: string[],
  ownerIds: string[],
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'opp');
    const stage = pick(ctx, STAGES);
    const status = stage === 'closed_won' ? 'won' : stage === 'closed_lost' ? 'lost' : 'open';
    const createdAt = pastTimestamp(ctx, 365, 0);
    insert(ctx, 'opportunities', {
      id,
      created_at: createdAt,
      updated_at: createdAt + ctx.rng.int(1000 * 60 * 60 * 24 * 10),
      archived: 0,
      name: `Opportunity ${id}`,
      contact_id: contactIds.length > 0 ? pick(ctx, contactIds) : null,
      company_id: chance(ctx, 0.6) && companyIds.length > 0 ? pick(ctx, companyIds) : null,
      pipeline_id: pipelineIds.length > 0 ? pick(ctx, pipelineIds) : null,
      stage,
      status,
      value_cents: 1000_00 + ctx.rng.int(50_000_00),
      owner_id: pick(ctx, ownerIds),
      expected_close_date: ctx.now + (ctx.rng.int(180) - 60) * 24 * 60 * 60 * 1000,
      probability: status === 'won' ? 100 : status === 'lost' ? 0 : 10 + ctx.rng.int(80),
    });
  }
}
