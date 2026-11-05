/**
 * M06 Tasks — follows the M01 Contacts convention verbatim.
 *
 * Data home: `tasks` table. `create_task` supports `due_date`/`owner_id`/
 * `contact_id` directly (brief-mandated semantic behavior) with real
 * referential checks on `contact_id`/`owner_id`.
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

const MODULE = 'tasks';

interface TaskView {
  id: string;
  name: string;
  title: string;
  status: string;
  priority: string | null;
  due_date: number | null;
  owner_id: string | null;
  contact_id: string | null;
  related_type: string | null;
  related_id: string | null;
  completed_at: number | null;
  description: string | null;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): TaskView {
  return {
    id: row['id'] as string,
    name: row['title'] as string,
    title: row['title'] as string,
    status: row['status'] as string,
    priority: (row['priority'] as string | null) ?? null,
    due_date: (row['due_date'] as number | null) ?? null,
    owner_id: (row['owner_id'] as string | null) ?? null,
    contact_id: (row['contact_id'] as string | null) ?? null,
    related_type: (row['related_type'] as string | null) ?? null,
    related_id: (row['related_id'] as string | null) ?? null,
    completed_at: (row['completed_at'] as number | null) ?? null,
    description: (row['description'] as string | null) ?? null,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getTaskRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Task '${id}' does not exist.`);
  return row;
}

const taskView = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string().nullable(),
  due_date: z.number().nullable(),
  owner_id: z.string().nullable(),
  contact_id: z.string().nullable(),
  related_type: z.string().nullable(),
  related_id: z.string().nullable(),
  completed_at: z.number().nullable(),
  description: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_task -------------------------------------------------------------

const createTaskInput = z.strictObject({
  title: z.string().min(1),
  description: z.string().optional(),
  due_date: z.number().optional(),
  owner_id: z.string().optional(),
  contact_id: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});
type CreateTaskInput = z.infer<typeof createTaskInput>;

const createTask: ActionDef<CreateTaskInput, TaskView> = {
  id: 'M06.A01',
  slug: 'tasks.create_task',
  module: MODULE,
  name: 'Create task',
  description: 'Create a new task, optionally due/owned/linked to a contact.',
  risk: 'write',
  entities: ['tasks'],
  inputSchema: createTaskInput,
  outputSchema: taskView,
  searchCard: {
    synonyms: ['add task', 'new to-do'],
    examplePhrasings: ['Create a follow-up task for tomorrow', 'Add a task to call Jane'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    if (input.contact_id) {
      const c = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
      if (!c) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    }
    const id = nextId(ctx.db, 'tasks', 'task');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO tasks (id, created_at, updated_at, archived, title, status, priority,
        due_date, owner_id, contact_id, related_type, related_id, completed_at, description)
       VALUES (?, ?, ?, 0, ?, 'open', ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      [
        id,
        now,
        now,
        input.title,
        input.priority ?? 'medium',
        input.due_date ?? null,
        input.owner_id ?? null,
        input.contact_id ?? null,
        input.description ?? null,
      ],
    );
    return toView(getTaskRow(ctx.db, id));
  }),
};

// --- A02 get_task_details -------------------------------------------------------

const getTaskDetailsInput = z.strictObject({ id: z.string() });

const getTaskDetails: ActionDef<z.infer<typeof getTaskDetailsInput>, TaskView> = {
  id: 'M06.A02',
  slug: 'tasks.get_task_details',
  module: MODULE,
  name: 'Get task details',
  description: 'Fetch a single task by id.',
  risk: 'read',
  entities: ['tasks'],
  inputSchema: getTaskDetailsInput,
  outputSchema: taskView,
  searchCard: {
    synonyms: ['task details', 'look up task'],
    examplePhrasings: ['Show me task task_12'],
  },
  handler: async (input, ctx) => toView(getTaskRow(ctx.db, input.id)),
};

// --- A03 search_tasks --------------------------------------------------------

const searchTasksInput = z.strictObject({
  query: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  owner_id: z.string().optional(),
  contact_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchTasksInput = z.infer<typeof searchTasksInput>;
const searchTasksOutput = listOutputSchema(taskView);
type SearchTasksOutput = ListOrSpill<TaskView>;

const searchTasks: ActionDef<SearchTasksInput, SearchTasksOutput> = {
  id: 'M06.A03',
  slug: 'tasks.search_tasks',
  module: MODULE,
  name: 'Search tasks',
  description: 'Search non-archived tasks by title and common filters.',
  risk: 'read',
  entities: ['tasks'],
  inputSchema: searchTasksInput,
  outputSchema: searchTasksOutput,
  searchCard: {
    synonyms: ['find tasks', 'list to-dos'],
    examplePhrasings: ['Find my open tasks', 'High priority tasks this week'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. Narrow with status/priority/owner_id/contact_id.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.query) {
      where.push('title LIKE ?');
      params.push(`%${input.query}%`);
    }
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.priority) {
      where.push('priority = ?');
      params.push(input.priority);
    }
    if (input.owner_id) {
      where.push('owner_id = ?');
      params.push(input.owner_id);
    }
    if (input.contact_id) {
      where.push('contact_id = ?');
      params.push(input.contact_id);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM tasks WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM tasks WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'tasks', whereSql, params },
    });
  },
};

// --- A04 update_task_description -----------------------------------------------

const updateTaskDescriptionInput = z.strictObject({ id: z.string(), description: z.string() });

const updateTaskDescription: ActionDef<z.infer<typeof updateTaskDescriptionInput>, TaskView> = {
  id: 'M06.A04',
  slug: 'tasks.update_task_description',
  module: MODULE,
  name: 'Update task description',
  description: "Set a task's description.",
  risk: 'write',
  entities: ['tasks'],
  inputSchema: updateTaskDescriptionInput,
  outputSchema: taskView,
  searchCard: {
    synonyms: ['edit task description', 'update task notes'],
    examplePhrasings: ["Update this task's description"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTaskRow(ctx.db, input.id);
    ctx.db.run(`UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?`, [
      input.description,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getTaskRow(ctx.db, input.id));
  }),
};

// --- A05 assign_task_owner -------------------------------------------------------

const assignTaskOwnerInput = z.strictObject({ id: z.string(), owner_id: z.string() });

const assignTaskOwner: ActionDef<z.infer<typeof assignTaskOwnerInput>, TaskView> = {
  id: 'M06.A05',
  slug: 'tasks.assign_task_owner',
  module: MODULE,
  name: 'Assign task owner',
  description: 'Set the owning user for a task.',
  risk: 'write',
  entities: ['tasks'],
  inputSchema: assignTaskOwnerInput,
  outputSchema: taskView,
  searchCard: {
    synonyms: ['reassign task', 'set task owner'],
    examplePhrasings: ['Assign this task to Dana'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTaskRow(ctx.db, input.id);
    ctx.db.run(`UPDATE tasks SET owner_id = ?, updated_at = ? WHERE id = ?`, [
      input.owner_id,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getTaskRow(ctx.db, input.id));
  }),
};

// --- A06 set_task_due_date -------------------------------------------------------

const setTaskDueDateInput = z.strictObject({ id: z.string(), due_date: z.number() });

const setTaskDueDate: ActionDef<z.infer<typeof setTaskDueDateInput>, TaskView> = {
  id: 'M06.A06',
  slug: 'tasks.set_task_due_date',
  module: MODULE,
  name: 'Set task due date',
  description: 'Set a task due date (epoch ms).',
  risk: 'write',
  entities: ['tasks'],
  inputSchema: setTaskDueDateInput,
  outputSchema: taskView,
  searchCard: {
    synonyms: ['reschedule task', 'change due date'],
    examplePhrasings: ['Move this task due date to next Monday'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTaskRow(ctx.db, input.id);
    ctx.db.run(`UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?`, [
      input.due_date,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getTaskRow(ctx.db, input.id));
  }),
};

// --- A07 set_task_priority -------------------------------------------------------

const setTaskPriorityInput = z.strictObject({ id: z.string(), priority: z.enum(['low', 'medium', 'high']) });

const setTaskPriority: ActionDef<z.infer<typeof setTaskPriorityInput>, TaskView> = {
  id: 'M06.A07',
  slug: 'tasks.set_task_priority',
  module: MODULE,
  name: 'Set task priority',
  description: 'Set a task priority.',
  risk: 'write',
  entities: ['tasks'],
  inputSchema: setTaskPriorityInput,
  outputSchema: taskView,
  searchCard: {
    synonyms: ['change task priority', 'mark high priority'],
    examplePhrasings: ['Make this task high priority'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTaskRow(ctx.db, input.id);
    ctx.db.run(`UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?`, [
      input.priority,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getTaskRow(ctx.db, input.id));
  }),
};

// --- A08 mark_task_complete -------------------------------------------------------

const markTaskCompleteInput = z.strictObject({ id: z.string() });

const markTaskComplete: ActionDef<z.infer<typeof markTaskCompleteInput>, TaskView> = {
  id: 'M06.A08',
  slug: 'tasks.mark_task_complete',
  module: MODULE,
  name: 'Mark task complete',
  description: 'Mark a task completed.',
  risk: 'write',
  entities: ['tasks'],
  inputSchema: markTaskCompleteInput,
  outputSchema: taskView,
  searchCard: {
    synonyms: ['complete task', 'finish task'],
    examplePhrasings: ['Mark this task done'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTaskRow(ctx.db, input.id);
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      input.id,
    ]);
    return toView(getTaskRow(ctx.db, input.id));
  }),
};

// --- A09 reopen_task -------------------------------------------------------------

const reopenTaskInput = z.strictObject({ id: z.string() });

const reopenTask: ActionDef<z.infer<typeof reopenTaskInput>, TaskView> = {
  id: 'M06.A09',
  slug: 'tasks.reopen_task',
  module: MODULE,
  name: 'Reopen task',
  description: 'Reopen a completed or cancelled task.',
  risk: 'write',
  entities: ['tasks'],
  inputSchema: reopenTaskInput,
  outputSchema: taskView,
  searchCard: {
    synonyms: ['undo task completion', 'reopen to-do'],
    examplePhrasings: ['Reopen this task, it is not actually done'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getTaskRow(ctx.db, input.id);
    if (row['status'] === 'open') {
      throw new ActionError('CONFLICT', `Task '${input.id}' is already open.`);
    }
    ctx.db.run(`UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getTaskRow(ctx.db, input.id));
  }),
};

// --- A10 cancel_task -------------------------------------------------------------

const cancelTaskInput = z.strictObject({ id: z.string() });

const cancelTask: ActionDef<z.infer<typeof cancelTaskInput>, TaskView> = {
  id: 'M06.A10',
  slug: 'tasks.cancel_task',
  module: MODULE,
  name: 'Cancel task',
  description: 'Cancel a task.',
  risk: 'destructive',
  entities: ['tasks'],
  inputSchema: cancelTaskInput,
  outputSchema: taskView,
  searchCard: {
    synonyms: ['delete task', 'remove task'],
    examplePhrasings: ['Cancel this task, no longer needed'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getTaskRow(ctx.db, input.id);
    ctx.db.run(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getTaskRow(ctx.db, input.id));
  }),
};

export const m06Tasks: ActionDef[] = [
  createTask as ActionDef,
  getTaskDetails as ActionDef,
  searchTasks as ActionDef,
  updateTaskDescription as ActionDef,
  assignTaskOwner as ActionDef,
  setTaskDueDate as ActionDef,
  setTaskPriority as ActionDef,
  markTaskComplete as ActionDef,
  reopenTask as ActionDef,
  cancelTask as ActionDef,
];

/** Tier-A discrimination: `status` counts (verified: 'completed' → 654, 'open' → 394). */
export const m06DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'tasks.search_tasks',
    paramsA: { status: 'completed' },
    paramsB: { status: 'open' },
    expectDifferentCounts: true,
  },
];

/** All M06 id fields resolve against plain tables — no module-specific hints needed. */
export const m06SynthHints: SynthHints = {};
