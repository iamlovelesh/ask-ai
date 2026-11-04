/**
 * Shared `courses.lessons` JSON helpers for M40 Courses and M41 Lessons
 * (task 9 batch 5). `entities/model.ts#MODULE_MAP` collapses M41 into
 * "courses.lessons" — ONE physical JSON column backs both modules:
 *   - M40 Courses CRUDs the course shell (title/status/instructor/category)
 *     plus structural, course-level concerns (sections, prerequisites).
 *   - M41 Lessons CRUDs individual lesson entries inside that same array.
 *
 * DESIGN NOTE (same "upgrade bare array -> richer object, normalize on
 * read" pattern as `product-prices.ts`): `entities/seed-content.ts
 * #generateCourses` seeds `courses.lessons` as a BARE ARRAY of
 * `{id,title,order,duration_min}` entries. M40 additionally needs a
 * `sections: string[]` list (`add_course_section`/`reorder_course_sections`)
 * and a `prerequisite_course_ids: string[]` list (`set_course_prerequisites`)
 * — `courses` has no dedicated column for either. Rather than inventing new
 * DDL, `readCourseConfig` normalizes the legacy bare-array shape into
 * `{lessons, sections: [], prerequisite_course_ids: []}` and every write
 * from this task writes the richer object shape going forward (same
 * precedent as M25/M26's `products.prices` upgrade).
 *
 * LESSON LOOKUP (M41): a lesson has NO own SQL row — `findCourseByLessonId`
 * scans every non-archived course's `lessons` array for a matching id
 * (bounded: `entities/seed.ts#COUNTS.courses` = 50, cheap). This means a
 * lesson `id` field can't be resolved to a real id by
 * `catalog/testing.ts#synthesizeInput` (no SQL table backs it) — every
 * M41 action taking a lesson `id` gets a structurally-synthetic id under
 * smoke and legitimately NOT_FOUNDs (same accepted coverage gap as M26
 * Prices' `price_id` — see task-9-b4-report.md "Concerns" section for the
 * precedent). Logic is real and exercised via `create_lesson`'s own flow
 * (which DOES get a real, resolvable `course_id`).
 */
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';

export interface LessonEntry {
  id: string;
  title: string;
  order: number;
  duration_min: number;
  section: string | null;
  media_asset_id: string | null;
  release_at: number | null;
  completion_criteria: Record<string, unknown> | null;
  published: boolean;
}

export interface CourseConfig {
  lessons: LessonEntry[];
  sections: string[];
  prerequisite_course_ids: string[];
}

function normalizeLesson(raw: Partial<LessonEntry> & { id: string; title: string }): LessonEntry {
  return {
    id: raw.id,
    title: raw.title,
    order: typeof raw.order === 'number' ? raw.order : 0,
    duration_min: typeof raw.duration_min === 'number' ? raw.duration_min : 0,
    section: raw.section ?? null,
    media_asset_id: raw.media_asset_id ?? null,
    release_at: raw.release_at ?? null,
    completion_criteria: raw.completion_criteria ?? null,
    published: raw.published ?? true, // legacy seeded lessons are implicitly "live"
  };
}

export function readCourseConfig(row: Row): CourseConfig {
  const raw = row['lessons'];
  if (typeof raw !== 'string' || raw.length === 0) {
    return { lessons: [], sections: [], prerequisite_course_ids: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // Legacy/seed shape: a bare lesson array.
      return {
        lessons: (parsed as LessonEntry[]).map(normalizeLesson),
        sections: [],
        prerequisite_course_ids: [],
      };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const lessons = Array.isArray(obj['lessons']) ? (obj['lessons'] as LessonEntry[]).map(normalizeLesson) : [];
      const sections = Array.isArray(obj['sections']) ? (obj['sections'] as string[]) : [];
      const prereqs = Array.isArray(obj['prerequisite_course_ids']) ? (obj['prerequisite_course_ids'] as string[]) : [];
      return { lessons, sections, prerequisite_course_ids: prereqs };
    }
    return { lessons: [], sections: [], prerequisite_course_ids: [] };
  } catch {
    return { lessons: [], sections: [], prerequisite_course_ids: [] };
  }
}

export function writeCourseConfig(tx: StoreTx, courseId: string, config: CourseConfig, now: number): void {
  tx.run(`UPDATE courses SET lessons = ?, lesson_count = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify(config),
    config.lessons.length,
    now,
    courseId,
  ]);
}

export function getCourseRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM courses WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Course '${id}' does not exist.`);
  return row;
}

/** Max-based next lesson id (`{courseId}_lsn_{n}`) — same pattern as
 * `product-prices.ts#nextPriceId`. */
export function nextLessonId(entries: readonly LessonEntry[], courseId: string): string {
  const re = new RegExp(`^${courseId}_lsn_(\\d+)$`);
  let maxN = 0;
  for (const entry of entries) {
    const match = re.exec(entry.id);
    if (match) {
      const n = Number(match[1]);
      if (n > maxN) maxN = n;
    }
  }
  return `${courseId}_lsn_${maxN + 1}`;
}

export function getLessonEntry(entries: readonly LessonEntry[], lessonId: string): LessonEntry {
  const entry = entries.find((e) => e.id === lessonId);
  if (!entry) throw new ActionError('NOT_FOUND', `Lesson '${lessonId}' does not exist.`);
  return entry;
}

/** Scan every non-archived course for a lesson id — see module header. */
export function findCourseByLessonId(db: StoreTx, lessonId: string): { course: Row; config: CourseConfig } {
  const rows = db.all(`SELECT * FROM courses WHERE archived = 0`);
  for (const row of rows) {
    const config = readCourseConfig(row);
    if (config.lessons.some((l) => l.id === lessonId)) {
      return { course: row, config };
    }
  }
  throw new ActionError('NOT_FOUND', `Lesson '${lessonId}' does not exist.`);
}
