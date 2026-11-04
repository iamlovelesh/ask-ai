/**
 * Content/community/service layer: content_items, courses, participations,
 * reviews, support_tickets, and the generic `records` ledger (covering the
 * five RECORD_KINDS: form_submission, survey_response, coupon_redemption,
 * lesson_completion, team_membership).
 */

import type { SeedCtx } from './seed-context.js';
import { insert, nextId, pastTimestamp, pick, chance, weightedPick, slugify } from './seed-context.js';
import { BLOG_TOPICS, COURSE_TOPICS, PRODUCT_WORDS } from './seed-data.js';

const DAY_MS = 1000 * 60 * 60 * 24;

const CONTENT_KINDS = ['website_page', 'landing_page', 'blog_post'] as const;
const CONTENT_STATUSES = ['draft', 'published', 'archived'] as const;

export function generateContentItems(
  ctx: SeedCtx,
  authorIds: string[],
  websiteIds: string[],
  funnelIds: string[],
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'content');
    const kind = pick(ctx, CONTENT_KINDS);
    const title =
      kind === 'blog_post' ? pick(ctx, BLOG_TOPICS) : `${pick(ctx, PRODUCT_WORDS)} ${kind.replace('_', ' ')}`;
    const slug = slugify(`${title}-${id}`);
    const status = weightedPick(ctx, CONTENT_STATUSES, [0.2, 0.7, 0.1]);
    const createdAt = pastTimestamp(ctx, 400, 0);
    const parentId = kind === 'landing_page' ? pick(ctx, funnelIds) : pick(ctx, websiteIds);
    insert(ctx, 'content_items', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      kind,
      title,
      slug,
      path: `/${slug}`,
      status,
      parent_id: parentId,
      author_id: pick(ctx, authorIds),
      published_at: status === 'published' ? createdAt + ctx.rng.int(5 * DAY_MS) : null,
      views: ctx.rng.int(50_000),
      seo_title: title,
      body: `${title} — seeded content body.`,
    });
  }
}

export interface CourseHandle {
  id: string;
  lessonIds: string[];
}

export function generateCourses(ctx: SeedCtx, instructorIds: string[], count: number): CourseHandle[] {
  const out: CourseHandle[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'course');
    const createdAt = pastTimestamp(ctx, 500, 30);
    const lessonCount = 3 + ctx.rng.int(10);
    const lessons = Array.from({ length: lessonCount }, (_, idx) => ({
      id: `${id}_lsn_${idx + 1}`,
      title: `Lesson ${idx + 1}`,
      order: idx + 1,
      duration_min: 5 + ctx.rng.int(40),
    }));
    insert(ctx, 'courses', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      title: pick(ctx, COURSE_TOPICS),
      status: weightedPick(ctx, ['draft', 'published', 'archived'], [0.15, 0.75, 0.1]),
      instructor_id: pick(ctx, instructorIds),
      category: pick(ctx, PRODUCT_WORDS),
      price_cents: chance(ctx, 0.5) ? 0 : 20_00 + ctx.rng.int(400_00),
      lesson_count: lessonCount,
      enrolled_count: ctx.rng.int(500),
      lessons: JSON.stringify(lessons),
      description: `${pick(ctx, COURSE_TOPICS)} — seeded course.`,
    });
    out.push({ id, lessonIds: lessons.map((l) => l.id) });
  }
  return out;
}

export function generateParticipations(
  ctx: SeedCtx,
  contactIds: string[],
  eventIds: string[],
  courseIds: string[],
  communityIds: string[],
  countPerKind: { eventRegistration: number; enrollment: number; membership: number; communityMember: number },
): void {
  for (let i = 0; i < countPerKind.eventRegistration; i++) {
    const id = nextId(ctx, 'part');
    const joinedAt = pastTimestamp(ctx, 200, 0);
    const status = pick(ctx, ['registered', 'attended', 'cancelled', 'no_show']);
    insert(ctx, 'participations', {
      id,
      created_at: joinedAt,
      updated_at: joinedAt,
      archived: 0,
      kind: 'event_registration',
      contact_id: pick(ctx, contactIds),
      parent_type: 'event',
      parent_id: pick(ctx, eventIds),
      status,
      waitlisted: chance(ctx, 0.05) ? 1 : 0,
      role: null,
      joined_at: joinedAt,
      progress: null,
      completed_at: status === 'attended' ? joinedAt + DAY_MS : null,
    });
  }

  for (let i = 0; i < countPerKind.enrollment; i++) {
    const id = nextId(ctx, 'part');
    const joinedAt = pastTimestamp(ctx, 300, 0);
    const status = weightedPick(ctx, ['enrolled', 'completed', 'dropped'], [0.5, 0.3, 0.2]);
    const progress = status === 'completed' ? 100 : status === 'dropped' ? ctx.rng.int(60) : ctx.rng.int(100);
    insert(ctx, 'participations', {
      id,
      created_at: joinedAt,
      updated_at: joinedAt,
      archived: 0,
      kind: 'enrollment',
      contact_id: pick(ctx, contactIds),
      parent_type: 'course',
      parent_id: pick(ctx, courseIds),
      status,
      waitlisted: 0,
      role: null,
      joined_at: joinedAt,
      progress,
      completed_at: status === 'completed' ? joinedAt + ctx.rng.int(60 * DAY_MS) : null,
    });
  }

  for (let i = 0; i < countPerKind.membership; i++) {
    const id = nextId(ctx, 'part');
    const joinedAt = pastTimestamp(ctx, 400, 0);
    const status = chance(ctx, 0.85) ? 'active' : 'cancelled';
    insert(ctx, 'participations', {
      id,
      created_at: joinedAt,
      updated_at: joinedAt,
      archived: 0,
      kind: 'membership',
      contact_id: pick(ctx, contactIds),
      parent_type: 'community',
      parent_id: pick(ctx, communityIds),
      status,
      waitlisted: 0,
      role: null,
      joined_at: joinedAt,
      progress: null,
      completed_at: null,
    });
  }

  for (let i = 0; i < countPerKind.communityMember; i++) {
    const id = nextId(ctx, 'part');
    const joinedAt = pastTimestamp(ctx, 400, 0);
    const status = chance(ctx, 0.92) ? 'active' : 'banned';
    insert(ctx, 'participations', {
      id,
      created_at: joinedAt,
      updated_at: joinedAt,
      archived: 0,
      kind: 'community_member',
      contact_id: pick(ctx, contactIds),
      parent_type: 'community',
      parent_id: pick(ctx, communityIds),
      status,
      waitlisted: 0,
      role: chance(ctx, 0.1) ? 'moderator' : 'member',
      joined_at: joinedAt,
      progress: null,
      completed_at: null,
    });
  }
}

export function generateReviews(
  ctx: SeedCtx,
  contactIds: string[],
  productIds: string[],
  businessListingIds: string[],
  courseIds: string[],
  companyIds: string[],
  count: number,
): void {
  const targets: Record<string, string[]> = {
    product: productIds,
    business_listing: businessListingIds,
    course: courseIds,
    company: companyIds,
  };
  const targetTypes = ['product', 'business_listing', 'course', 'company'] as const;
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'rev');
    const createdAt = pastTimestamp(ctx, 300, 0);
    const targetType = pick(ctx, targetTypes);
    const pool = targets[targetType] ?? [];
    insert(ctx, 'reviews', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      contact_id: pick(ctx, contactIds),
      target_type: targetType,
      target_id: pool.length > 0 ? pick(ctx, pool) : null,
      rating: weightedPick(ctx, [1, 2, 3, 4, 5], [0.05, 0.05, 0.1, 0.3, 0.5]),
      status: weightedPick(ctx, ['pending', 'published', 'rejected'], [0.1, 0.85, 0.05]),
      source: pick(ctx, ['web', 'app', 'email']),
      title: 'Great experience',
      body: 'Seeded review body text describing the experience in detail.',
      response: chance(ctx, 0.3) ? 'Thanks for the feedback!' : null,
    });
  }
}

const SUPPORT_SUBJECTS = [
  'Cannot log in to my account',
  'Billing charge looks incorrect',
  'Feature request: bulk export',
  'Integration webhook failing',
  'Need help migrating data',
  'Report a bug in the dashboard',
];

export function generateSupportTickets(
  ctx: SeedCtx,
  contactIds: string[],
  assigneeIds: string[],
  teamIds: string[],
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const id = nextId(ctx, 'ticket');
    const createdAt = pastTimestamp(ctx, 150, 0);
    const status = weightedPick(ctx, ['open', 'pending', 'resolved', 'closed'], [0.2, 0.15, 0.25, 0.4]);
    const firstResponseAt = status === 'open' && chance(ctx, 0.3) ? null : createdAt + ctx.rng.int(2 * DAY_MS);
    insert(ctx, 'support_tickets', {
      id,
      created_at: createdAt,
      updated_at: createdAt,
      archived: 0,
      subject: pick(ctx, SUPPORT_SUBJECTS),
      contact_id: pick(ctx, contactIds),
      status,
      priority: pick(ctx, ['low', 'medium', 'high', 'urgent']),
      assignee_id: pick(ctx, assigneeIds),
      team_id: pick(ctx, teamIds),
      channel: pick(ctx, ['email', 'chat', 'phone']),
      first_response_at: firstResponseAt,
      resolved_at: status === 'resolved' || status === 'closed' ? createdAt + ctx.rng.int(5 * DAY_MS) : null,
      description: 'Seeded support ticket description.',
    });
  }
}

export function generateRecords(
  ctx: SeedCtx,
  contactIds: string[],
  formIds: string[],
  surveyIds: string[],
  couponIds: string[],
  courses: CourseHandle[],
  usersWithTeam: { userId: string; teamId: string; createdAt: number }[],
  counts: { formSubmission: number; surveyResponse: number; couponRedemption: number; lessonCompletion: number },
): void {
  for (let i = 0; i < counts.formSubmission; i++) {
    const id = nextId(ctx, 'record');
    const occurredAt = pastTimestamp(ctx, 200, 0);
    insert(ctx, 'records', {
      id,
      created_at: occurredAt,
      updated_at: occurredAt,
      archived: 0,
      kind: 'form_submission',
      parent_id: pick(ctx, formIds),
      contact_id: chance(ctx, 0.8) ? pick(ctx, contactIds) : null,
      user_id: null,
      occurred_at: occurredAt,
      data: JSON.stringify({ fields: { message: 'Seeded submission' } }),
    });
  }

  for (let i = 0; i < counts.surveyResponse; i++) {
    const id = nextId(ctx, 'record');
    const occurredAt = pastTimestamp(ctx, 200, 0);
    insert(ctx, 'records', {
      id,
      created_at: occurredAt,
      updated_at: occurredAt,
      archived: 0,
      kind: 'survey_response',
      parent_id: pick(ctx, surveyIds),
      contact_id: pick(ctx, contactIds),
      user_id: null,
      occurred_at: occurredAt,
      data: JSON.stringify({ answers: { satisfaction: 1 + ctx.rng.int(5) } }),
    });
  }

  for (let i = 0; i < counts.couponRedemption; i++) {
    const id = nextId(ctx, 'record');
    const occurredAt = pastTimestamp(ctx, 150, 0);
    insert(ctx, 'records', {
      id,
      created_at: occurredAt,
      updated_at: occurredAt,
      archived: 0,
      kind: 'coupon_redemption',
      parent_id: pick(ctx, couponIds),
      contact_id: pick(ctx, contactIds),
      user_id: null,
      occurred_at: occurredAt,
      data: JSON.stringify({ discount_cents: 500 + ctx.rng.int(4500) }),
    });
  }

  const lessonPool = courses.flatMap((c) => c.lessonIds);
  for (let i = 0; i < counts.lessonCompletion; i++) {
    const id = nextId(ctx, 'record');
    const occurredAt = pastTimestamp(ctx, 150, 0);
    insert(ctx, 'records', {
      id,
      created_at: occurredAt,
      updated_at: occurredAt,
      archived: 0,
      kind: 'lesson_completion',
      parent_id: lessonPool.length > 0 ? pick(ctx, lessonPool) : null,
      contact_id: pick(ctx, contactIds),
      user_id: null,
      occurred_at: occurredAt,
      data: JSON.stringify({ duration_min: 5 + ctx.rng.int(40) }),
    });
  }

  for (const u of usersWithTeam) {
    const id = nextId(ctx, 'record');
    insert(ctx, 'records', {
      id,
      created_at: u.createdAt,
      updated_at: u.createdAt,
      archived: 0,
      kind: 'team_membership',
      parent_id: u.teamId,
      contact_id: null,
      user_id: u.userId,
      occurred_at: u.createdAt,
      data: JSON.stringify({ role: 'member' }),
    });
  }
}
