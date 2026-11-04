/**
 * `seedStandard` — the standard demo dataset generator (LLD §3.2 / Task 4).
 *
 * Deterministic: all randomness flows through `Prng(seed)`, all time through
 * `VirtualClock` (pinned `2026-11-04T10:00:00Z` unless `VIRTUAL_NOW` is set).
 * No wall-clock or non-seeded randomness APIs — enforced by the grep guard
 * test in `server/test/clock.test.ts`.
 *
 * Generation order follows referential dependency (teams → users →
 * companies → contacts → structures → everything else) so every foreign
 * reference points at a row that already exists, even though the schema
 * does not declare `REFERENCES` constraints (see model.ts design notes).
 *
 * Scenario-material guarantees (SQL-assertable, see seed.test.ts):
 *   - ≥200 leads created within the previous calendar week
 *   - ≥40 invoices `status='issued'` with `due_date` more than 15 days ago
 *   - ≥25 conversations `status='open'` with an unanswered inbound message
 *   - ≥8 active (role='sales_rep', active=1) users
 *   - every one of the 26 tables, every STRUCTURE_KINDS kind, and every
 *     RECORD_KINDS kind has at least one row.
 */

import type { Crm } from '../store/db.js';
import { VirtualClock } from '../store/clock.js';
import { Prng } from '../util/prng.js';
import { ENTITY_MODEL } from './model.js';
import { createCtx } from './seed-context.js';
import type { SeedSummary } from './seed-types.js';
import { generateTeams, generateUsers, generateCompanies, generateContacts, generateStructures } from './seed-core.js';
import { generateLeads, generateOpportunities } from './seed-pipeline.js';
import {
  generateProducts,
  generateQuotes,
  generateInvoices,
  generateOrders,
  generateSubscriptions,
  generatePayments,
} from './seed-commerce.js';
import {
  generateTasks,
  generateNotes,
  generateConversations,
  generateMessages,
  generateAppointments,
  generateEvents,
} from './seed-engage.js';
import {
  generateContentItems,
  generateCourses,
  generateParticipations,
  generateReviews,
  generateSupportTickets,
  generateRecords,
} from './seed-content.js';

export type { SeedSummary } from './seed-types.js';

// --- row-count plan (~50k total, weighted per the task brief) ------------

const COUNTS = {
  companies: 1300,
  contacts: 12_000,
  leads: 5000,
  leadsLastWeek: 230, // guarantee: >= 200
  opportunities: 1100,
  tasks: 1500,
  notes: 1100,
  conversations: 1500,
  conversationsUnreplied: 45, // guarantee: >= 25
  appointments: 750,
  events: 50,
  products: 160,
  quotes: 450,
  invoices: 750,
  invoicesOverdue: 65, // guarantee: >= 40
  orders: 750,
  subscriptions: 260,
  payments: 765,
  refunds: 135,
  contentItems: 160,
  courses: 50,
  reviews: 370,
  supportTickets: 370,
  participations: { eventRegistration: 300, enrollment: 300, membership: 150, communityMember: 150 },
  records: { formSubmission: 300, surveyResponse: 220, couponRedemption: 150, lessonCompletion: 220 },
} as const;

export function seedStandard(crm: Crm, seed = 42): SeedSummary {
  const counts: SeedSummary = {};
  for (const t of ENTITY_MODEL) counts[t.name] = 0;

  crm.tx((db) => {
    const ctx = createCtx(db, new Prng(seed), new VirtualClock(), counts);

    const teamIds = generateTeams(ctx);
    const users = generateUsers(ctx, teamIds);
    const staffIds = [...users.adminIds, ...users.salesRepIds, ...users.supportIds];

    const companyIds = generateCompanies(ctx, users.salesRepIds, COUNTS.companies);
    const contactIds = generateContacts(ctx, companyIds, users.salesRepIds, COUNTS.contacts);
    const structures = generateStructures(ctx, staffIds);

    const campaignIds = structures.byKind.get('campaign') ?? [];
    const pipelineIds = structures.byKind.get('pipeline') ?? [];
    const calendarIds = structures.byKind.get('calendar') ?? [];
    const bookingPageIds = structures.byKind.get('booking_page') ?? [];
    const couponIds = structures.byKind.get('coupon') ?? [];
    const templateIds = structures.byKind.get('template') ?? [];
    const formIds = structures.byKind.get('form') ?? [];
    const surveyIds = structures.byKind.get('survey') ?? [];
    const websiteIds = structures.byKind.get('website') ?? [];
    const funnelIds = structures.byKind.get('funnel') ?? [];
    const communityIds = structures.byKind.get('community') ?? [];
    const businessListingIds = structures.byKind.get('business_listing') ?? [];

    generateLeads(ctx, contactIds, users.salesRepIds, campaignIds, COUNTS.leads, COUNTS.leadsLastWeek);
    generateOpportunities(ctx, contactIds, companyIds, pipelineIds, users.salesRepIds, COUNTS.opportunities);

    generateTasks(ctx, contactIds, staffIds, COUNTS.tasks);
    generateNotes(ctx, contactIds, staffIds, COUNTS.notes);
    const conversations = generateConversations(
      ctx,
      contactIds,
      staffIds,
      COUNTS.conversations,
      COUNTS.conversationsUnreplied,
    );
    generateMessages(ctx, conversations, templateIds, campaignIds);
    generateAppointments(ctx, contactIds, calendarIds, bookingPageIds, users.salesRepIds, COUNTS.appointments);
    const eventIds = generateEvents(ctx, staffIds, COUNTS.events);

    const { ids: productIds, priceByProduct } = generateProducts(ctx, COUNTS.products);
    const quoteIds = generateQuotes(ctx, contactIds, companyIds, users.salesRepIds, productIds, priceByProduct, COUNTS.quotes);
    const invoiceIds = generateInvoices(
      ctx,
      contactIds,
      users.salesRepIds,
      quoteIds,
      productIds,
      priceByProduct,
      COUNTS.invoices,
      COUNTS.invoicesOverdue,
    );
    const orderIds = generateOrders(ctx, contactIds, couponIds, productIds, priceByProduct, COUNTS.orders);
    const subscriptionIds = generateSubscriptions(ctx, contactIds, productIds, priceByProduct, couponIds, COUNTS.subscriptions);
    generatePayments(ctx, contactIds, invoiceIds, orderIds, subscriptionIds, COUNTS.payments, COUNTS.refunds);

    generateContentItems(ctx, staffIds, websiteIds, funnelIds, COUNTS.contentItems);
    const courses = generateCourses(ctx, staffIds, COUNTS.courses);
    const courseIds = courses.map((c) => c.id);
    generateParticipations(ctx, contactIds, eventIds, courseIds, communityIds, COUNTS.participations);
    generateReviews(ctx, contactIds, productIds, businessListingIds, courseIds, companyIds, COUNTS.reviews);
    generateSupportTickets(ctx, contactIds, [...users.supportIds, ...users.salesRepIds], teamIds, COUNTS.supportTickets);

    const usersWithTeam = db
      .all('SELECT id, team_id, created_at FROM users')
      .map((r) => ({ userId: r['id'] as string, teamId: r['team_id'] as string, createdAt: r['created_at'] as number }));
    generateRecords(ctx, contactIds, formIds, surveyIds, couponIds, courses, usersWithTeam, COUNTS.records);
  });

  return counts;
}
