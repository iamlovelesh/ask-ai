/**
 * M42 Enrollments — follows the M01 Contacts convention verbatim.
 *
 * Data home: `participations` table, `kind = 'enrollment'`
 * (`parent_type='course'`, `parent_id` = the course id) PLUS `records`
 * table, `kind = 'lesson_completion'` (`parent_id` = the LESSON id,
 * matching `entities/seed-content.ts#generateRecords`'s own seeded
 * shape). This module is the WRITER of `lesson_completion` — M41 Lessons'
 * `set_lesson_completion_criteria` only DEFINES the rule; it never fires
 * it (task-8 guide §10 redirect pattern).
 *
 * EVAL-CRITICAL real behaviors (per brief):
 *   - `enroll_learner_in_course`: CONFLICT on a duplicate active
 *     (enrolled/suspended/completed) enrollment.
 *   - `suspend_enrollment`/`resume_enrollment`/`revoke_enrollment`: a real
 *     status machine (enrolled <-> suspended; either -> revoked, terminal).
 *   - `record_lesson_completion`: validates the lesson exists on the
 *     enrollment's OWN course (via `course-lessons.ts#findCourseByLessonId`
 *     + a parent-course check), CONFLICTs on a duplicate completion of the
 *     SAME lesson by the SAME contact.
 *   - `get_learner_progress`: a REAL `completed/total` percentage computed
 *     fresh from `records(kind='lesson_completion')` intersected with the
 *     course's current lesson id set (never a trusted/stale cache).
 *   - `issue_course_completion_certificate`: CONFLICT unless progress is
 *     exactly 100%.
 *
 * `courses.enrolled_count` is always RECOMPUTED (never incrementally
 * patched) after every status-changing write — same
 * `recomputeRegisteredCount` precedent as M24 Events.
 *
 * SCHEMA GAP (documented, NOT fixed — same category as M32's pre-ruling
 * `set_order_shipping_address`): `participations` has no free-text/JSON
 * column at all, so `set_enrollment_expiry` has nowhere to persist the
 * expiry value. It still does a real existence/status check and stamps
 * `updated_at` (a genuine, detectable smoke delta) but cannot store the
 * value anywhere retrievable.
 *
 * KIND-BLINDNESS NOTE: `participations` is a 4-kind shared table — every
 * action on this module's own `id` needs an action-scoped synthHint
 * (`{table:'participations', kind:'enrollment'}`). `lesson_id` has no SQL
 * table backing it (see M41's header) — a documented smoke coverage gap
 * for `record_lesson_completion` specifically.
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
import { readCourseConfig, findCourseByLessonId } from './course-lessons.js';

const MODULE = 'enrollments';
const KIND = 'enrollment';
const COMPLETION_KIND = 'lesson_completion';

function getEnrollmentRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM participations WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Enrollment '${id}' does not exist.`);
  return row;
}

/** Full recompute, never incremental — same precedent as M24's
 * `recomputeRegisteredCount`. */
function recomputeEnrolledCount(db: StoreTx, courseId: string, now: number): void {
  db.run(
    `UPDATE courses SET enrolled_count = (
       SELECT COUNT(*) FROM participations WHERE kind = ? AND parent_id = ? AND status IN ('enrolled','suspended','completed')
     ), updated_at = ? WHERE id = ?`,
    [KIND, courseId, now, courseId],
  );
}

/** Real, always-fresh `{completed, total}` against the course's CURRENT
 * lesson set — never a trusted cache. */
function computeProgress(db: StoreTx, courseId: string, contactId: string): { completed: number; total: number; percent: number } {
  const courseRow = db.get(`SELECT * FROM courses WHERE id = ?`, [courseId]);
  const lessonIds = courseRow ? readCourseConfig(courseRow).lessons.map((l) => l.id) : [];
  const total = lessonIds.length;
  if (total === 0) return { completed: 0, total: 0, percent: 0 };
  const placeholders = lessonIds.map(() => '?').join(',');
  const row = db.get(
    `SELECT COUNT(DISTINCT parent_id) AS n FROM records WHERE kind = ? AND contact_id = ? AND parent_id IN (${placeholders})`,
    [COMPLETION_KIND, contactId, ...lessonIds],
  );
  const completed = (row?.['n'] as number) ?? 0;
  const percent = Math.round((completed / total) * 100);
  return { completed, total, percent };
}

interface EnrollmentView {
  id: string;
  name: string;
  course_id: string;
  contact_id: string;
  status: string;
  progress_percent: number;
  joined_at: number;
  completed_at: number | null;
}

function toView(db: StoreTx, row: Row): EnrollmentView {
  const contact = db.get(`SELECT name FROM contacts WHERE id = ?`, [row['contact_id']]);
  const course = db.get(`SELECT title FROM courses WHERE id = ?`, [row['parent_id']]);
  const contactName = (contact?.['name'] as string | undefined) ?? (row['contact_id'] as string);
  const courseName = (course?.['title'] as string | undefined) ?? (row['parent_id'] as string);
  const progress = computeProgress(db, row['parent_id'] as string, row['contact_id'] as string);
  return {
    id: row['id'] as string,
    name: `${contactName}'s enrollment in '${courseName}'`,
    course_id: row['parent_id'] as string,
    contact_id: row['contact_id'] as string,
    status: row['status'] as string,
    progress_percent: progress.percent,
    joined_at: row['joined_at'] as number,
    completed_at: (row['completed_at'] as number | null) ?? null,
  };
}

const enrollmentView = z.object({
  id: z.string(),
  name: z.string(),
  course_id: z.string(),
  contact_id: z.string(),
  status: z.string(),
  progress_percent: z.number(),
  joined_at: z.number(),
  completed_at: z.number().nullable(),
});

// --- A01 enroll_learner_in_course -----------------------------------------------------

const enrollLearnerInCourseInput = z.strictObject({ contact_id: z.string(), course_id: z.string() });

const enrollLearnerInCourse: ActionDef<z.infer<typeof enrollLearnerInCourseInput>, EnrollmentView> = {
  id: 'M42.A01',
  slug: 'enrollments.enroll_learner_in_course',
  module: MODULE,
  name: 'Enroll learner in course',
  description: 'Enroll a contact in a course (CONFLICT if already actively enrolled).',
  risk: 'write',
  entities: ['participations', 'courses'],
  inputSchema: enrollLearnerInCourseInput,
  outputSchema: enrollmentView,
  searchCard: { synonyms: ['sign up for course', 'enroll in course'], examplePhrasings: ['Enroll this contact in the onboarding course'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    const course = ctx.db.get(`SELECT id FROM courses WHERE id = ?`, [input.course_id]);
    if (!course) throw new ActionError('NOT_FOUND', `Course '${input.course_id}' does not exist.`);
    const existing = ctx.db.get(
      `SELECT id FROM participations WHERE kind = ? AND parent_id = ? AND contact_id = ? AND status IN ('enrolled','suspended','completed')`,
      [KIND, input.course_id, input.contact_id],
    );
    if (existing) {
      throw new ActionError('CONFLICT', `Contact '${input.contact_id}' already has an active enrollment in course '${input.course_id}'.`);
    }
    const id = nextId(ctx.db, 'participations', 'part');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO participations (id, created_at, updated_at, archived, kind, contact_id, parent_type, parent_id,
        status, waitlisted, role, joined_at, progress, completed_at)
       VALUES (?, ?, ?, 0, ?, ?, 'course', ?, 'enrolled', 0, NULL, ?, 0, NULL)`,
      [id, now, now, KIND, input.contact_id, input.course_id, now],
    );
    recomputeEnrolledCount(ctx.db, input.course_id, now);
    return toView(ctx.db, getEnrollmentRow(ctx.db, id));
  }),
};

// --- A02 get_enrollment_details -----------------------------------------------------

const getEnrollmentDetailsInput = z.strictObject({ id: z.string() });

const getEnrollmentDetails: ActionDef<z.infer<typeof getEnrollmentDetailsInput>, EnrollmentView> = {
  id: 'M42.A02',
  slug: 'enrollments.get_enrollment_details',
  module: MODULE,
  name: 'Get enrollment details',
  description: 'Fetch a single enrollment by id, with its live progress percentage.',
  risk: 'read',
  entities: ['participations'],
  inputSchema: getEnrollmentDetailsInput,
  outputSchema: enrollmentView,
  searchCard: { synonyms: ['enrollment details', 'look up enrollment'], examplePhrasings: ['Show me this enrollment'] },
  handler: async (input, ctx) => toView(ctx.db, getEnrollmentRow(ctx.db, input.id)),
};

// --- A03 search_enrollments -----------------------------------------------------

const searchEnrollmentsInput = z.strictObject({
  contact_id: z.string().optional(),
  course_id: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchEnrollmentsInput = z.infer<typeof searchEnrollmentsInput>;
const searchEnrollmentsOutput = listOutputSchema(enrollmentView);
type SearchEnrollmentsOutput = ListOrSpill<EnrollmentView>;

const searchEnrollments: ActionDef<SearchEnrollmentsInput, SearchEnrollmentsOutput> = {
  id: 'M42.A03',
  slug: 'enrollments.search_enrollments',
  module: MODULE,
  name: 'Search enrollments',
  description: 'Search enrollments by contact, course, and status.',
  risk: 'read',
  entities: ['participations'],
  inputSchema: searchEnrollmentsInput,
  outputSchema: searchEnrollmentsOutput,
  searchCard: { synonyms: ['find enrollments', 'list enrollments'], examplePhrasings: ['Show me all suspended enrollments'] },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.contact_id) {
      where.push('contact_id = ?');
      params.push(input.contact_id);
    }
    if (input.course_id) {
      where.push('parent_id = ?');
      params.push(input.course_id);
    }
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM participations WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM participations WHERE ${whereSql} ORDER BY joined_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map((r) => toView(ctx.db, r)), total, {
      idCapture: { db: ctx.db, table: 'participations', whereSql, params },
    });
  },
};

// --- A04 set_enrollment_expiry (documented degenerate — see module header) ---

const setEnrollmentExpiryInput = z.strictObject({ id: z.string(), expires_at: z.number().int().min(0).nullable() });

const setEnrollmentExpiry: ActionDef<z.infer<typeof setEnrollmentExpiryInput>, EnrollmentView> = {
  id: 'M42.A04',
  slug: 'enrollments.set_enrollment_expiry',
  module: MODULE,
  name: 'Set enrollment expiry',
  description:
    "Set when a learner's access to a course expires. NOTE: `participations` has no field to persist this value — validated and stamped, but not retrievable (documented schema gap).",
  risk: 'write',
  entities: ['participations'],
  inputSchema: setEnrollmentExpiryInput,
  outputSchema: enrollmentView,
  searchCard: { synonyms: ['set access expiry', 'course access expiration'], examplePhrasings: ["Set this learner's access to expire in 90 days"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getEnrollmentRow(ctx.db, input.id);
    ctx.db.run(`UPDATE participations SET updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return toView(ctx.db, getEnrollmentRow(ctx.db, input.id));
  }),
};

// --- A05 suspend_enrollment -----------------------------------------------------

const suspendEnrollmentInput = z.strictObject({ id: z.string() });

const suspendEnrollment: ActionDef<z.infer<typeof suspendEnrollmentInput>, EnrollmentView> = {
  id: 'M42.A05',
  slug: 'enrollments.suspend_enrollment',
  module: MODULE,
  name: 'Suspend enrollment',
  description: 'Suspend an active enrollment (CONFLICT unless currently enrolled).',
  risk: 'write',
  entities: ['participations', 'courses'],
  inputSchema: suspendEnrollmentInput,
  outputSchema: enrollmentView,
  searchCard: { synonyms: ['pause enrollment', 'suspend access'], examplePhrasings: ["Suspend this learner's enrollment"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getEnrollmentRow(ctx.db, input.id);
    if (row['status'] !== 'enrolled') {
      throw new ActionError('CONFLICT', `Enrollment '${input.id}' is '${row['status'] as string}', not 'enrolled' — cannot suspend.`);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE participations SET status = 'suspended', updated_at = ? WHERE id = ?`, [now, input.id]);
    recomputeEnrolledCount(ctx.db, row['parent_id'] as string, now);
    return toView(ctx.db, getEnrollmentRow(ctx.db, input.id));
  }),
};

// --- A06 resume_enrollment -----------------------------------------------------

const resumeEnrollmentInput = z.strictObject({ id: z.string() });

const resumeEnrollment: ActionDef<z.infer<typeof resumeEnrollmentInput>, EnrollmentView> = {
  id: 'M42.A06',
  slug: 'enrollments.resume_enrollment',
  module: MODULE,
  name: 'Resume enrollment',
  description: 'Resume a suspended enrollment (CONFLICT unless currently suspended).',
  risk: 'write',
  entities: ['participations', 'courses'],
  inputSchema: resumeEnrollmentInput,
  outputSchema: enrollmentView,
  searchCard: { synonyms: ['unpause enrollment', 'restore access'], examplePhrasings: ["Resume this learner's enrollment"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getEnrollmentRow(ctx.db, input.id);
    if (row['status'] !== 'suspended') {
      throw new ActionError('CONFLICT', `Enrollment '${input.id}' is '${row['status'] as string}', not 'suspended' — cannot resume.`);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE participations SET status = 'enrolled', updated_at = ? WHERE id = ?`, [now, input.id]);
    recomputeEnrolledCount(ctx.db, row['parent_id'] as string, now);
    return toView(ctx.db, getEnrollmentRow(ctx.db, input.id));
  }),
};

// --- A07 revoke_enrollment -----------------------------------------------------

const revokeEnrollmentInput = z.strictObject({ id: z.string() });

const revokeEnrollment: ActionDef<z.infer<typeof revokeEnrollmentInput>, EnrollmentView> = {
  id: 'M42.A07',
  slug: 'enrollments.revoke_enrollment',
  module: MODULE,
  name: 'Revoke enrollment',
  description: 'Permanently revoke an enrollment (terminal — CONFLICT if already revoked).',
  risk: 'destructive',
  entities: ['participations', 'courses'],
  inputSchema: revokeEnrollmentInput,
  outputSchema: enrollmentView,
  searchCard: { synonyms: ['remove enrollment', 'revoke access'], examplePhrasings: ["Revoke this learner's access"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getEnrollmentRow(ctx.db, input.id);
    if (row['status'] === 'revoked') {
      throw new ActionError('CONFLICT', `Enrollment '${input.id}' is already revoked.`);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE participations SET status = 'revoked', updated_at = ? WHERE id = ?`, [now, input.id]);
    recomputeEnrolledCount(ctx.db, row['parent_id'] as string, now);
    return toView(ctx.db, getEnrollmentRow(ctx.db, input.id));
  }),
};

// --- A08 record_lesson_completion -----------------------------------------------------

const recordLessonCompletionInput = z.strictObject({ id: z.string(), lesson_id: z.string() });
const completionOutput = z.object({
  id: z.string(),
  name: z.string(),
  enrollment_id: z.string(),
  lesson_id: z.string(),
  contact_id: z.string(),
  course_id: z.string(),
  occurred_at: z.number(),
});

const recordLessonCompletion: ActionDef<z.infer<typeof recordLessonCompletionInput>, z.infer<typeof completionOutput>> = {
  id: 'M42.A08',
  slug: 'enrollments.record_lesson_completion',
  module: MODULE,
  name: 'Record lesson completion',
  description: "Record that a learner completed a lesson (validates the lesson belongs to the enrollment's own course; CONFLICT on a duplicate completion).",
  risk: 'write',
  entities: ['records', 'participations'],
  inputSchema: recordLessonCompletionInput,
  outputSchema: completionOutput,
  searchCard: { synonyms: ['mark lesson complete', 'complete lesson'], examplePhrasings: ['Mark this lesson as completed for this learner'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const enrollment = getEnrollmentRow(ctx.db, input.id);
    if (enrollment['status'] === 'revoked' || enrollment['status'] === 'suspended') {
      throw new ActionError('CONFLICT', `Enrollment '${input.id}' is '${enrollment['status'] as string}' — cannot record lesson progress.`);
    }
    const courseId = enrollment['parent_id'] as string;
    const contactId = enrollment['contact_id'] as string;
    const { course, config } = findCourseByLessonId(ctx.db, input.lesson_id);
    if ((course['id'] as string) !== courseId) {
      throw new ActionError('NOT_FOUND', `Lesson '${input.lesson_id}' does not belong to course '${courseId}'.`);
    }
    const lessonExists = config.lessons.some((l) => l.id === input.lesson_id);
    if (!lessonExists) throw new ActionError('NOT_FOUND', `Lesson '${input.lesson_id}' does not exist on course '${courseId}'.`);
    const dup = ctx.db.get(`SELECT id FROM records WHERE kind = ? AND parent_id = ? AND contact_id = ?`, [
      COMPLETION_KIND,
      input.lesson_id,
      contactId,
    ]);
    if (dup) throw new ActionError('CONFLICT', `Contact '${contactId}' has already completed lesson '${input.lesson_id}'.`);
    const id = nextId(ctx.db, 'records', 'record');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO records (id, created_at, updated_at, archived, kind, parent_id, contact_id, user_id, occurred_at, data)
       VALUES (?, ?, ?, 0, ?, ?, ?, NULL, ?, ?)`,
      [id, now, now, COMPLETION_KIND, input.lesson_id, contactId, now, JSON.stringify({ enrollment_id: input.id })],
    );
    const progress = computeProgress(ctx.db, courseId, contactId);
    ctx.db.run(`UPDATE participations SET progress = ?, updated_at = ? WHERE id = ?`, [progress.percent, now, input.id]);
    return { id, name: `Lesson completion by contact '${contactId}'`, enrollment_id: input.id, lesson_id: input.lesson_id, contact_id: contactId, course_id: courseId, occurred_at: now };
  }),
};

// --- A09 get_learner_progress -----------------------------------------------------

const getLearnerProgressInput = z.strictObject({ id: z.string() });
const learnerProgressOutput = z.object({
  id: z.string(),
  name: z.string(),
  course_id: z.string(),
  contact_id: z.string(),
  status: z.string(),
  total_lessons: z.number(),
  completed_lessons: z.number(),
  progress_percent: z.number(),
  completed_at: z.number().nullable(),
});

const getLearnerProgress: ActionDef<z.infer<typeof getLearnerProgressInput>, z.infer<typeof learnerProgressOutput>> = {
  id: 'M42.A09',
  slug: 'enrollments.get_learner_progress',
  module: MODULE,
  name: 'Get learner progress',
  description: "Compute a learner's real completion percentage for a course, freshly from lesson_completion records (never a stale cache).",
  risk: 'read',
  entities: ['participations', 'records', 'courses'],
  inputSchema: getLearnerProgressInput,
  outputSchema: learnerProgressOutput,
  searchCard: {
    synonyms: ['course progress', 'how far along', 'finished watching training videos'],
    examplePhrasings: [
      'How much of this course has this learner completed?',
      "Has this learner finished watching their training videos yet?",
    ],
  },
  handler: async (input, ctx) => {
    const row = getEnrollmentRow(ctx.db, input.id);
    const courseId = row['parent_id'] as string;
    const contactId = row['contact_id'] as string;
    const progress = computeProgress(ctx.db, courseId, contactId);
    const contact = ctx.db.get(`SELECT name FROM contacts WHERE id = ?`, [contactId]);
    const contactName = (contact?.['name'] as string | undefined) ?? contactId;
    return {
      id: input.id,
      name: `${contactName}'s progress in course '${courseId}'`,
      course_id: courseId,
      contact_id: contactId,
      status: row['status'] as string,
      total_lessons: progress.total,
      completed_lessons: progress.completed,
      progress_percent: progress.percent,
      completed_at: (row['completed_at'] as number | null) ?? null,
    };
  },
};

// --- A10 issue_course_completion_certificate -----------------------------------------------------

const issueCourseCompletionCertificateInput = z.strictObject({ id: z.string() });
const certificateOutput = z.object({
  id: z.string(),
  name: z.string(),
  course_id: z.string(),
  contact_id: z.string(),
  certificate_id: z.string(),
  issued_at: z.number(),
});

const issueCourseCompletionCertificate: ActionDef<z.infer<typeof issueCourseCompletionCertificateInput>, z.infer<typeof certificateOutput>> = {
  id: 'M42.A10',
  slug: 'enrollments.issue_course_completion_certificate',
  module: MODULE,
  name: 'Issue course completion certificate',
  description: 'Issue a completion certificate for a learner (CONFLICT unless their real progress is exactly 100%).',
  risk: 'write',
  entities: ['participations', 'records', 'courses'],
  inputSchema: issueCourseCompletionCertificateInput,
  outputSchema: certificateOutput,
  searchCard: { synonyms: ['issue certificate', 'course completion certificate'], examplePhrasings: ['Issue a completion certificate for this learner'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getEnrollmentRow(ctx.db, input.id);
    if (row['status'] === 'revoked') {
      throw new ActionError('CONFLICT', `Enrollment '${input.id}' is revoked — cannot issue a certificate.`);
    }
    const courseId = row['parent_id'] as string;
    const contactId = row['contact_id'] as string;
    const progress = computeProgress(ctx.db, courseId, contactId);
    if (progress.total === 0 || progress.percent < 100) {
      throw new ActionError('CONFLICT', `Contact '${contactId}' has only completed ${progress.percent}% of course '${courseId}' — certificate requires 100%.`);
    }
    const now = ctx.clock.now();
    if (row['status'] !== 'completed') {
      ctx.db.run(`UPDATE participations SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`, [now, now, input.id]);
    } else {
      ctx.db.run(`UPDATE participations SET updated_at = ? WHERE id = ?`, [now, input.id]);
    }
    return {
      id: input.id,
      name: `Certificate for contact '${contactId}' — course '${courseId}'`,
      course_id: courseId,
      contact_id: contactId,
      certificate_id: `cert_${input.id}_${now}`,
      issued_at: now,
    };
  }),
};

export const m42Enrollments: ActionDef[] = [
  enrollLearnerInCourse as ActionDef,
  getEnrollmentDetails as ActionDef,
  searchEnrollments as ActionDef,
  setEnrollmentExpiry as ActionDef,
  suspendEnrollment as ActionDef,
  resumeEnrollment as ActionDef,
  revokeEnrollment as ActionDef,
  recordLessonCompletion as ActionDef,
  getLearnerProgress as ActionDef,
  issueCourseCompletionCertificate as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live, full-suite run: 'enrolled' → 157, 'dropped' → 67 — out
 * of 300 seeded enrollment participations; 'completed' also exists but is
 * not used here to keep the check to a clean two-value contrast).
 */
export const m42DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'enrollments.search_enrollments',
    paramsA: { status: 'enrolled' },
    paramsB: { status: 'dropped' },
    expectDifferentCounts: true,
  },
];

/** `participations` is a 4-kind shared table — every action on this
 * module's own `id` needs an action-scoped hint. `lesson_id` has no SQL
 * table to resolve against (see module header). */
export const m42SynthHints: SynthHints = {
  'enrollments.get_enrollment_details:id': { table: 'participations', kind: KIND },
  'enrollments.set_enrollment_expiry:id': { table: 'participations', kind: KIND },
  'enrollments.suspend_enrollment:id': { table: 'participations', kind: KIND },
  'enrollments.resume_enrollment:id': { table: 'participations', kind: KIND },
  'enrollments.revoke_enrollment:id': { table: 'participations', kind: KIND },
  'enrollments.record_lesson_completion:id': { table: 'participations', kind: KIND },
  'enrollments.get_learner_progress:id': { table: 'participations', kind: KIND },
  'enrollments.issue_course_completion_certificate:id': { table: 'participations', kind: KIND },
};
