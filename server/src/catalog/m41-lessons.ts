/**
 * M41 Lessons — follows the M01 Contacts convention verbatim.
 *
 * Data home: `courses.lessons` (JSON) — see `course-lessons.ts` for the
 * shared read/write/normalize helpers M40 Courses also uses.
 * `lesson_completion` records are written by M42 Enrollments
 * (`record_lesson_completion`), NOT this module — task-8 guide §10's
 * redirect pattern, carried forward verbatim from the brief.
 *
 * STRUCTURAL SMOKE COVERAGE GAP (documented, same category as M26 Prices'
 * `price_id` / M22's `block_id` — see task-9-b4-report.md "Concerns"): a
 * lesson has no own SQL row, so `catalog/testing.ts#synthesizeInput` can't
 * resolve a lesson `id` field to a real lesson. Every action below taking
 * a lesson `id` legitimately NOT_FOUNDs under smoke (a real, non-masked
 * check) rather than exercising its full body — `create_lesson`'s own flow
 * (which takes a real, resolvable `course_id`) DOES exercise the real
 * write path.
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { DiscriminationCheck } from './discrimination.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { SynthHints } from './synth-hints.js';
import {
  type LessonEntry,
  type CourseConfig,
  readCourseConfig,
  writeCourseConfig,
  getCourseRow,
  nextLessonId,
  getLessonEntry,
  findCourseByLessonId,
} from './course-lessons.js';

const MODULE = 'lessons';

const lessonView = z.object({
  id: z.string(),
  name: z.string(),
  course_id: z.string(),
  order: z.number(),
  duration_min: z.number(),
  section: z.string().nullable(),
  media_asset_id: z.string().nullable(),
  release_at: z.number().nullable(),
  completion_criteria: z.record(z.string(), z.unknown()).nullable(),
  published: z.boolean(),
});
type LessonView = z.infer<typeof lessonView>;

function toView(courseId: string, entry: LessonEntry): LessonView {
  return {
    id: entry.id,
    name: entry.title,
    course_id: courseId,
    order: entry.order,
    duration_min: entry.duration_min,
    section: entry.section,
    media_asset_id: entry.media_asset_id,
    release_at: entry.release_at,
    completion_criteria: entry.completion_criteria,
    published: entry.published,
  };
}

function replaceLesson(config: CourseConfig, updated: LessonEntry): CourseConfig {
  return { ...config, lessons: config.lessons.map((l) => (l.id === updated.id ? updated : l)) };
}

// --- A01 create_lesson -----------------------------------------------------

const createLessonInput = z.strictObject({
  course_id: z.string(),
  title: z.string().min(1),
  duration_min: z.number().int().min(1).optional(),
  section: z.string().optional(),
});

const createLesson: ActionDef<z.infer<typeof createLessonInput>, LessonView> = {
  id: 'M41.A01',
  slug: 'lessons.create_lesson',
  module: MODULE,
  name: 'Create lesson',
  description: 'Add a new lesson to a course.',
  risk: 'write',
  entities: ['courses'],
  inputSchema: createLessonInput,
  outputSchema: lessonView,
  searchCard: { synonyms: ['add lesson', 'new lesson'], examplePhrasings: ['Add a lesson about pricing to this course'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const row = getCourseRow(ctx.db, input.course_id);
    const config = readCourseConfig(row);
    const entry: LessonEntry = {
      id: nextLessonId(config.lessons, input.course_id),
      title: input.title,
      order: config.lessons.length + 1,
      duration_min: input.duration_min ?? 10,
      section: input.section ?? null,
      media_asset_id: null,
      release_at: null,
      completion_criteria: null,
      published: false,
    };
    writeCourseConfig(ctx.db, input.course_id, { ...config, lessons: [...config.lessons, entry] }, ctx.clock.now());
    return toView(input.course_id, entry);
  }),
};

// --- A02 get_lesson_details -----------------------------------------------------

const getLessonDetailsInput = z.strictObject({ id: z.string() });

const getLessonDetails: ActionDef<z.infer<typeof getLessonDetailsInput>, LessonView> = {
  id: 'M41.A02',
  slug: 'lessons.get_lesson_details',
  module: MODULE,
  name: 'Get lesson details',
  description: 'Fetch a single lesson by id.',
  risk: 'read',
  entities: ['courses'],
  inputSchema: getLessonDetailsInput,
  outputSchema: lessonView,
  searchCard: { synonyms: ['lesson details', 'look up lesson'], examplePhrasings: ['Show me this lesson'] },
  handler: async (input, ctx) => {
    const { course, config } = findCourseByLessonId(ctx.db, input.id);
    return toView(course['id'] as string, getLessonEntry(config.lessons, input.id));
  },
};

// --- A03 search_lessons -----------------------------------------------------

const searchLessonsInput = z.strictObject({
  course_id: z.string(),
  query: z.string().optional(),
  published: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchLessonsInput = z.infer<typeof searchLessonsInput>;
const searchLessonsOutput = listOutputSchema(lessonView);
type SearchLessonsOutput = ListOrSpill<LessonView>;

const searchLessons: ActionDef<SearchLessonsInput, SearchLessonsOutput> = {
  id: 'M41.A03',
  slug: 'lessons.search_lessons',
  module: MODULE,
  name: 'Search lessons',
  description: "Search a course's lessons by title and publish state.",
  risk: 'read',
  entities: ['courses'],
  inputSchema: searchLessonsInput,
  outputSchema: searchLessonsOutput,
  searchCard: { synonyms: ['find lessons', 'list lessons'], examplePhrasings: ['Show me the published lessons in this course'] },
  handler: async (input, ctx) => {
    const row = getCourseRow(ctx.db, input.course_id);
    const config = readCourseConfig(row);
    let matches = config.lessons;
    if (input.query) {
      const q = input.query.toLowerCase();
      matches = matches.filter((l) => l.title.toLowerCase().includes(q));
    }
    if (input.published !== undefined) {
      matches = matches.filter((l) => l.published === input.published);
    }
    const limit = input.limit ?? 50;
    const sorted = [...matches].sort((a, b) => a.order - b.order);
    return toListOrSpill(sorted.slice(0, limit).map((l) => toView(input.course_id, l)), sorted.length);
  },
};

// --- A04 update_lesson_content -----------------------------------------------------

const updateLessonContentInput = z.strictObject({
  id: z.string(),
  title: z.string().min(1).optional(),
  duration_min: z.number().int().min(1).optional(),
});

const updateLessonContent: ActionDef<z.infer<typeof updateLessonContentInput>, LessonView> = {
  id: 'M41.A04',
  slug: 'lessons.update_lesson_content',
  module: MODULE,
  name: 'Update lesson content',
  description: "Patch a lesson's title/duration.",
  risk: 'write',
  entities: ['courses'],
  inputSchema: updateLessonContentInput,
  outputSchema: lessonView,
  searchCard: { synonyms: ['edit lesson', 'update lesson'], examplePhrasings: ['Fix the title of this lesson'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const { course, config } = findCourseByLessonId(ctx.db, input.id);
    const entry = getLessonEntry(config.lessons, input.id);
    const updated: LessonEntry = { ...entry, title: input.title ?? entry.title, duration_min: input.duration_min ?? entry.duration_min };
    writeCourseConfig(ctx.db, course['id'] as string, replaceLesson(config, updated), ctx.clock.now());
    return toView(course['id'] as string, updated);
  }),
};

// --- A05 attach_lesson_media -----------------------------------------------------

const attachLessonMediaInput = z.strictObject({ id: z.string(), media_asset_id: z.string() });

const attachLessonMedia: ActionDef<z.infer<typeof attachLessonMediaInput>, LessonView> = {
  id: 'M41.A05',
  slug: 'lessons.attach_lesson_media',
  module: MODULE,
  name: 'Attach lesson media',
  description: 'Attach a media asset (e.g. a video) to a lesson (validates the asset exists).',
  risk: 'write',
  entities: ['courses', 'structures'],
  inputSchema: attachLessonMediaInput,
  outputSchema: lessonView,
  searchCard: { synonyms: ['add lesson video', 'attach media'], examplePhrasings: ['Attach this video to the lesson'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const { course, config } = findCourseByLessonId(ctx.db, input.id);
    const asset = ctx.db.get(`SELECT id FROM structures WHERE id = ? AND kind = 'media_asset'`, [input.media_asset_id]);
    if (!asset) throw new ActionError('NOT_FOUND', `Media asset '${input.media_asset_id}' does not exist.`);
    const entry = getLessonEntry(config.lessons, input.id);
    const updated: LessonEntry = { ...entry, media_asset_id: input.media_asset_id };
    writeCourseConfig(ctx.db, course['id'] as string, replaceLesson(config, updated), ctx.clock.now());
    return toView(course['id'] as string, updated);
  }),
};

// --- A06 move_lesson_to_course_section -----------------------------------------------------

const moveLessonToCourseSectionInput = z.strictObject({ id: z.string(), section: z.string().nullable() });

const moveLessonToCourseSection: ActionDef<z.infer<typeof moveLessonToCourseSectionInput>, LessonView> = {
  id: 'M41.A06',
  slug: 'lessons.move_lesson_to_course_section',
  module: MODULE,
  name: 'Move lesson to course section',
  description: "Move a lesson into one of its course's sections (validates the section exists; null = unsectioned).",
  risk: 'write',
  entities: ['courses'],
  inputSchema: moveLessonToCourseSectionInput,
  outputSchema: lessonView,
  searchCard: { synonyms: ['move lesson', 'reassign section'], examplePhrasings: ['Move this lesson into the advanced section'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const { course, config } = findCourseByLessonId(ctx.db, input.id);
    if (input.section !== null && !config.sections.includes(input.section)) {
      throw new ActionError('NOT_FOUND', `Course '${course['id'] as string}' has no section '${input.section}'.`);
    }
    const entry = getLessonEntry(config.lessons, input.id);
    const updated: LessonEntry = { ...entry, section: input.section };
    writeCourseConfig(ctx.db, course['id'] as string, replaceLesson(config, updated), ctx.clock.now());
    return toView(course['id'] as string, updated);
  }),
};

// --- A07 set_lesson_release_schedule -----------------------------------------------------

const setLessonReleaseScheduleInput = z.strictObject({ id: z.string(), release_at: z.number().int().min(0).nullable() });

const setLessonReleaseSchedule: ActionDef<z.infer<typeof setLessonReleaseScheduleInput>, LessonView> = {
  id: 'M41.A07',
  slug: 'lessons.set_lesson_release_schedule',
  module: MODULE,
  name: 'Set lesson release schedule',
  description: 'Set (or clear, with null) the epoch-ms time a lesson becomes available to learners.',
  risk: 'write',
  entities: ['courses'],
  inputSchema: setLessonReleaseScheduleInput,
  outputSchema: lessonView,
  searchCard: { synonyms: ['schedule lesson release', 'drip lesson'], examplePhrasings: ['Release this lesson next week'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const { course, config } = findCourseByLessonId(ctx.db, input.id);
    const entry = getLessonEntry(config.lessons, input.id);
    const updated: LessonEntry = { ...entry, release_at: input.release_at };
    writeCourseConfig(ctx.db, course['id'] as string, replaceLesson(config, updated), ctx.clock.now());
    return toView(course['id'] as string, updated);
  }),
};

// --- A08 set_lesson_completion_criteria -----------------------------------------------------

const setLessonCompletionCriteriaInput = z.strictObject({ id: z.string(), criteria: z.record(z.string(), z.unknown()) });

const setLessonCompletionCriteria: ActionDef<z.infer<typeof setLessonCompletionCriteriaInput>, LessonView> = {
  id: 'M41.A08',
  slug: 'lessons.set_lesson_completion_criteria',
  module: MODULE,
  name: 'Set lesson completion criteria',
  description:
    "Define the rule for when a lesson counts as complete (e.g. {type:'watch_percentage',value:80}). This DEFINES the rule — M42 Enrollments' record_lesson_completion is what actually FIRES it.",
  risk: 'write',
  entities: ['courses'],
  inputSchema: setLessonCompletionCriteriaInput,
  outputSchema: lessonView,
  searchCard: { synonyms: ['set completion rule', 'lesson completion criteria'], examplePhrasings: ['Require 80% watch time to complete this lesson'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const { course, config } = findCourseByLessonId(ctx.db, input.id);
    const entry = getLessonEntry(config.lessons, input.id);
    const updated: LessonEntry = { ...entry, completion_criteria: input.criteria };
    writeCourseConfig(ctx.db, course['id'] as string, replaceLesson(config, updated), ctx.clock.now());
    return toView(course['id'] as string, updated);
  }),
};

// --- A09 publish_lesson -----------------------------------------------------

const publishLessonInput = z.strictObject({ id: z.string() });

const publishLesson: ActionDef<z.infer<typeof publishLessonInput>, LessonView> = {
  id: 'M41.A09',
  slug: 'lessons.publish_lesson',
  module: MODULE,
  name: 'Publish lesson',
  description: 'Publish a lesson so learners can see it.',
  risk: 'write',
  entities: ['courses'],
  inputSchema: publishLessonInput,
  outputSchema: lessonView,
  searchCard: { synonyms: ['go live with lesson', 'publish lesson'], examplePhrasings: ['Publish this lesson'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const { course, config } = findCourseByLessonId(ctx.db, input.id);
    const entry = getLessonEntry(config.lessons, input.id);
    const updated: LessonEntry = { ...entry, published: true };
    writeCourseConfig(ctx.db, course['id'] as string, replaceLesson(config, updated), ctx.clock.now());
    return toView(course['id'] as string, updated);
  }),
};

// --- A10 unpublish_lesson -----------------------------------------------------

const unpublishLessonInput = z.strictObject({ id: z.string() });

const unpublishLesson: ActionDef<z.infer<typeof unpublishLessonInput>, LessonView> = {
  id: 'M41.A10',
  slug: 'lessons.unpublish_lesson',
  module: MODULE,
  name: 'Unpublish lesson',
  description: 'Hide a lesson from learners.',
  risk: 'write',
  entities: ['courses'],
  inputSchema: unpublishLessonInput,
  outputSchema: lessonView,
  searchCard: { synonyms: ['hide lesson', 'unpublish lesson'], examplePhrasings: ['Unpublish this lesson'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const { course, config } = findCourseByLessonId(ctx.db, input.id);
    const entry = getLessonEntry(config.lessons, input.id);
    const updated: LessonEntry = { ...entry, published: false };
    writeCourseConfig(ctx.db, course['id'] as string, replaceLesson(config, updated), ctx.clock.now());
    return toView(course['id'] as string, updated);
  }),
};

export const m41Lessons: ActionDef[] = [
  createLesson as ActionDef,
  getLessonDetails as ActionDef,
  searchLessons as ActionDef,
  updateLessonContent as ActionDef,
  attachLessonMedia as ActionDef,
  moveLessonToCourseSection as ActionDef,
  setLessonReleaseSchedule as ActionDef,
  setLessonCompletionCriteria as ActionDef,
  publishLesson as ActionDef,
  unpublishLesson as ActionDef,
];

/** No catalog-wide list/search action independent of a `course_id` — every
 * lesson-level action is scoped to one course's own lesson array, same
 * convention as M26 Prices (`discriminationChecks: []`). */
export const m41DiscriminationChecks: DiscriminationCheck[] = [];

/** `course_id` already resolves via `testing.ts`'s `DEFAULT_HINTS`
 * (`course_id: {table:'courses'}`). Lesson `id` fields have no SQL table
 * to resolve against — see module header's documented coverage gap. */
export const m41SynthHints: SynthHints = {};
