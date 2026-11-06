/**
 * M40 Courses — follows the M01 Contacts convention verbatim.
 *
 * Data home: typed `courses` table (`entities/model.ts#MODULE_MAP`).
 * `lessons` (JSON) is upgraded (see `course-lessons.ts`) from the seed's
 * bare lesson array into `{lessons, sections, prerequisite_course_ids}` —
 * `courses` has no dedicated column for sections or prerequisites.
 *
 * `courses` is a plain typed table (NOT kind-discriminated) — the bare
 * `id` field resolves correctly via `entities[0]` with no synthHint
 * needed.
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { Row } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import { nextId } from './next-id.js';
import type { SynthHints } from './synth-hints.js';
import { readCourseConfig, writeCourseConfig, getCourseRow } from './course-lessons.js';

const MODULE = 'courses';
const STATUSES = ['draft', 'published', 'archived'] as const;

interface CourseView {
  id: string;
  name: string;
  status: string;
  instructor_id: string | null;
  category: string | null;
  price_cents: number | null;
  lesson_count: number;
  enrolled_count: number;
  sections: string[];
  prerequisite_course_ids: string[];
  description: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): CourseView {
  const config = readCourseConfig(row);
  return {
    id: row['id'] as string,
    name: row['title'] as string,
    status: row['status'] as string,
    instructor_id: (row['instructor_id'] as string | null) ?? null,
    category: (row['category'] as string | null) ?? null,
    price_cents: (row['price_cents'] as number | null) ?? null,
    lesson_count: config.lessons.length,
    enrolled_count: (row['enrolled_count'] as number | null) ?? 0,
    sections: config.sections,
    prerequisite_course_ids: config.prerequisite_course_ids,
    description: (row['description'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const courseView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  instructor_id: z.string().nullable(),
  category: z.string().nullable(),
  price_cents: z.number().nullable(),
  lesson_count: z.number(),
  enrolled_count: z.number(),
  sections: z.array(z.string()),
  prerequisite_course_ids: z.array(z.string()),
  description: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_course -----------------------------------------------------

const createCourseInput = z.strictObject({
  title: z.string().min(1),
  category: z.string().optional(),
  price_cents: z.number().int().min(0).optional(),
  description: z.string().optional(),
});

const createCourse: ActionDef<z.infer<typeof createCourseInput>, CourseView> = {
  id: 'M40.A01',
  slug: 'courses.create_course',
  module: MODULE,
  name: 'Create course',
  description: 'Create a new course (no lessons yet — add them via lessons.create_lesson).',
  risk: 'write',
  entities: ['courses'],
  inputSchema: createCourseInput,
  outputSchema: courseView,
  searchCard: { synonyms: ['add course', 'new course'], examplePhrasings: ['Create a new onboarding course'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'courses', 'course');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO courses (id, created_at, updated_at, archived, title, status, instructor_id, category,
        price_cents, lesson_count, enrolled_count, lessons, description)
       VALUES (?, ?, ?, 0, ?, 'draft', NULL, ?, ?, 0, 0, ?, ?)`,
      [id, now, now, input.title, input.category ?? null, input.price_cents ?? null, JSON.stringify({ lessons: [], sections: [], prerequisite_course_ids: [] }), input.description ?? null],
    );
    return toView(getCourseRow(ctx.db, id));
  }),
};

// --- A02 get_course_details -----------------------------------------------------

const getCourseDetailsInput = z.strictObject({ id: z.string() });

const getCourseDetails: ActionDef<z.infer<typeof getCourseDetailsInput>, CourseView> = {
  id: 'M40.A02',
  slug: 'courses.get_course_details',
  module: MODULE,
  name: 'Get course details',
  description: 'Fetch a single course by id.',
  risk: 'read',
  entities: ['courses'],
  inputSchema: getCourseDetailsInput,
  outputSchema: courseView,
  searchCard: { synonyms: ['course details', 'look up course'], examplePhrasings: ['Show me this course'] },
  handler: async (input, ctx) => toView(getCourseRow(ctx.db, input.id)),
};

// --- A03 search_courses -----------------------------------------------------

const searchCoursesInput = z.strictObject({
  status: z.enum(STATUSES).optional(),
  instructor_id: z.string().optional(),
  category: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchCoursesInput = z.infer<typeof searchCoursesInput>;
const searchCoursesOutput = listOutputSchema(courseView);
type SearchCoursesOutput = ListOrSpill<CourseView>;

const searchCourses: ActionDef<SearchCoursesInput, SearchCoursesOutput> = {
  id: 'M40.A03',
  slug: 'courses.search_courses',
  module: MODULE,
  name: 'Search courses',
  description: 'Search non-archived courses by status, instructor, category, and title.',
  risk: 'read',
  entities: ['courses'],
  inputSchema: searchCoursesInput,
  outputSchema: searchCoursesOutput,
  searchCard: { synonyms: ['find courses', 'list courses'], examplePhrasings: ['Show me our published courses'] },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.status) {
      where.push('status = ? COLLATE NOCASE');
      params.push(input.status);
    }
    if (input.instructor_id) {
      where.push('instructor_id = ?');
      params.push(input.instructor_id);
    }
    if (input.category) {
      where.push('category = ? COLLATE NOCASE');
      params.push(input.category);
    }
    if (input.query) {
      where.push('title LIKE ?');
      params.push(`%${input.query}%`);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM courses WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM courses WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'courses', whereSql, params },
    });
  },
};

// --- A04 update_course_details -----------------------------------------------------

const updateCourseDetailsInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({
      title: z.string().min(1).optional(),
      category: z.string().optional(),
      price_cents: z.number().int().min(0).optional(),
      description: z.string().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, { message: 'patch must not be empty' }),
});

const updateCourseDetails: ActionDef<z.infer<typeof updateCourseDetailsInput>, CourseView> = {
  id: 'M40.A04',
  slug: 'courses.update_course_details',
  module: MODULE,
  name: 'Update course details',
  description: "Patch a course's editable fields.",
  risk: 'write',
  entities: ['courses'],
  inputSchema: updateCourseDetailsInput,
  outputSchema: courseView,
  searchCard: { synonyms: ['edit course', 'update course'], examplePhrasings: ["Change this course's price"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getCourseRow(ctx.db, input.id);
    const fields = Object.entries(input.patch);
    const setSql = fields.map(([k]) => `${k === 'title' ? 'title' : k} = ?`).join(', ');
    const values = fields.map(([, v]) => v);
    ctx.db.run(`UPDATE courses SET ${setSql}, updated_at = ? WHERE id = ?`, [...values, ctx.clock.now(), input.id]);
    return toView(getCourseRow(ctx.db, input.id));
  }),
};

// --- A05 add_course_section -----------------------------------------------------

const addCourseSectionInput = z.strictObject({ id: z.string(), section: z.string().min(1) });

const addCourseSection: ActionDef<z.infer<typeof addCourseSectionInput>, CourseView> = {
  id: 'M40.A05',
  slug: 'courses.add_course_section',
  module: MODULE,
  name: 'Add course section',
  description: 'Append a new named section to a course.',
  risk: 'write',
  entities: ['courses'],
  inputSchema: addCourseSectionInput,
  outputSchema: courseView,
  searchCard: { synonyms: ['add section', 'new course section'], examplePhrasings: ['Add a "Getting Started" section to this course'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCourseRow(ctx.db, input.id);
    const config = readCourseConfig(row);
    if (config.sections.includes(input.section)) {
      throw new ActionError('CONFLICT', `Course '${input.id}' already has a section named '${input.section}'.`);
    }
    writeCourseConfig(ctx.db, input.id, { ...config, sections: [...config.sections, input.section] }, ctx.clock.now());
    return toView(getCourseRow(ctx.db, input.id));
  }),
};

// --- A06 reorder_course_sections -----------------------------------------------------

const reorderCourseSectionsInput = z.strictObject({ id: z.string(), sections: z.array(z.string().min(1)).min(1) });

const reorderCourseSections: ActionDef<z.infer<typeof reorderCourseSectionsInput>, CourseView> = {
  id: 'M40.A06',
  slug: 'courses.reorder_course_sections',
  module: MODULE,
  name: 'Reorder course sections',
  description: "Replace a course's section order (must be exactly the same set of sections).",
  risk: 'write',
  entities: ['courses'],
  inputSchema: reorderCourseSectionsInput,
  outputSchema: courseView,
  searchCard: { synonyms: ['reorder sections', 'change section order'], examplePhrasings: ['Move the advanced section to the end'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCourseRow(ctx.db, input.id);
    const config = readCourseConfig(row);
    const currentSet = new Set(config.sections);
    const nextSet = new Set(input.sections);
    const sameSet = currentSet.size === nextSet.size && [...currentSet].every((s) => nextSet.has(s));
    if (!sameSet) {
      throw new ActionError('VALIDATION', `New section order must contain exactly the course's existing sections (${config.sections.join(', ')}).`);
    }
    writeCourseConfig(ctx.db, input.id, { ...config, sections: input.sections }, ctx.clock.now());
    return toView(getCourseRow(ctx.db, input.id));
  }),
};

// --- A07 assign_course_instructor -----------------------------------------------------

const assignCourseInstructorInput = z.strictObject({ id: z.string(), instructor_id: z.string() });

const assignCourseInstructor: ActionDef<z.infer<typeof assignCourseInstructorInput>, CourseView> = {
  id: 'M40.A07',
  slug: 'courses.assign_course_instructor',
  module: MODULE,
  name: 'Assign course instructor',
  description: 'Assign the instructor of a course (validates the user exists).',
  risk: 'write',
  entities: ['courses', 'users'],
  inputSchema: assignCourseInstructorInput,
  outputSchema: courseView,
  searchCard: { synonyms: ['set instructor', 'change course instructor'], examplePhrasings: ['Assign Priya to teach this course'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getCourseRow(ctx.db, input.id);
    const user = ctx.db.get(`SELECT id FROM users WHERE id = ?`, [input.instructor_id]);
    if (!user) throw new ActionError('NOT_FOUND', `User '${input.instructor_id}' does not exist.`);
    ctx.db.run(`UPDATE courses SET instructor_id = ?, updated_at = ? WHERE id = ?`, [input.instructor_id, ctx.clock.now(), input.id]);
    return toView(getCourseRow(ctx.db, input.id));
  }),
};

// --- A08 set_course_prerequisites -----------------------------------------------------

const setCoursePrerequisitesInput = z.strictObject({ id: z.string(), prerequisite_course_ids: z.array(z.string()) });

const setCoursePrerequisites: ActionDef<z.infer<typeof setCoursePrerequisitesInput>, CourseView> = {
  id: 'M40.A08',
  slug: 'courses.set_course_prerequisites',
  module: MODULE,
  name: 'Set course prerequisites',
  description: 'Set the list of courses a learner must complete first (validates each exists; refuses self-reference).',
  risk: 'write',
  entities: ['courses'],
  inputSchema: setCoursePrerequisitesInput,
  outputSchema: courseView,
  searchCard: { synonyms: ['set prerequisites', 'required courses'], examplePhrasings: ['Require the basics course before this one'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCourseRow(ctx.db, input.id);
    if (input.prerequisite_course_ids.includes(input.id)) {
      throw new ActionError('CONFLICT', `Course '${input.id}' cannot be its own prerequisite.`);
    }
    for (const pid of input.prerequisite_course_ids) {
      const exists = ctx.db.get(`SELECT id FROM courses WHERE id = ?`, [pid]);
      if (!exists) throw new ActionError('NOT_FOUND', `Course '${pid}' does not exist.`);
    }
    const config = readCourseConfig(row);
    writeCourseConfig(ctx.db, input.id, { ...config, prerequisite_course_ids: input.prerequisite_course_ids }, ctx.clock.now());
    return toView(getCourseRow(ctx.db, input.id));
  }),
};

// --- A09 publish_course -----------------------------------------------------

const publishCourseInput = z.strictObject({ id: z.string() });
const publishCourseOutput = z.object({ id: z.string(), name: z.string(), status: z.literal('published') });

const publishCourse: ActionDef<z.infer<typeof publishCourseInput>, z.infer<typeof publishCourseOutput>> = {
  id: 'M40.A09',
  slug: 'courses.publish_course',
  module: MODULE,
  name: 'Publish course',
  description: 'Publish a course (requires at least one lesson).',
  risk: 'write',
  entities: ['courses'],
  inputSchema: publishCourseInput,
  outputSchema: publishCourseOutput,
  searchCard: { synonyms: ['go live with course', 'publish course'], examplePhrasings: ['Publish this course'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCourseRow(ctx.db, input.id);
    const config = readCourseConfig(row);
    if (config.lessons.length === 0) {
      throw new ActionError('VALIDATION', `Course '${input.id}' needs at least one lesson before it can be published.`);
    }
    ctx.db.run(`UPDATE courses SET status = 'published', updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['title'] as string, status: 'published' as const };
  }),
};

// --- A10 archive_course -----------------------------------------------------

const archiveCourseInput = z.strictObject({ id: z.string() });
const archiveCourseOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const archiveCourse: ActionDef<z.infer<typeof archiveCourseInput>, z.infer<typeof archiveCourseOutput>> = {
  id: 'M40.A10',
  slug: 'courses.archive_course',
  module: MODULE,
  name: 'Archive course',
  description: 'Soft-delete a course.',
  risk: 'destructive',
  entities: ['courses'],
  inputSchema: archiveCourseInput,
  outputSchema: archiveCourseOutput,
  searchCard: { synonyms: ['delete course', 'remove course'], examplePhrasings: ['Archive this course'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCourseRow(ctx.db, input.id);
    ctx.db.run(`UPDATE courses SET archived = 1, updated_at = ? WHERE id = ?`, [ctx.clock.now(), input.id]);
    return { id: input.id, name: row['title'] as string, archived: true as const };
  }),
};

export const m40Courses: ActionDef[] = [
  createCourse as ActionDef,
  getCourseDetails as ActionDef,
  searchCourses as ActionDef,
  updateCourseDetails as ActionDef,
  addCourseSection as ActionDef,
  reorderCourseSections as ActionDef,
  assignCourseInstructor as ActionDef,
  setCoursePrerequisites as ActionDef,
  publishCourse as ActionDef,
  archiveCourse as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live, full-suite run: 'published' → 36, 'draft' → 7 out of
 * 50 seeded courses).
 */
export const m40DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'courses.search_courses',
    paramsA: { status: 'published' },
    paramsB: { status: 'draft' },
    expectDifferentCounts: true,
  },
];

/** `courses` is a plain typed table — no synthHints needed. */
export const m40SynthHints: SynthHints = {};
