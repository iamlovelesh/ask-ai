/**
 * Durable scheduled follow-ups (#8, wait_for model, scoped v1).
 *
 * Instead of refusing time-based requests ("remind me Friday", "follow up next
 * week"), the agent records a DURABLE deferred instruction here — persisted in
 * the sessions DB, so it survives a restart (a plain in-process timer would
 * not). A poller/endpoint reads `due()` once the time passes and surfaces or
 * re-runs the instruction.
 *
 * Scope boundary: this is TIME-BASED deferral (wait-for-duration /
 * wait-until), not mid-run agent suspension or wait-for-arbitrary-event — both
 * of which need machinery beyond this v1. All times are passed in by the
 * caller (never read from the system clock here) to keep it deterministic
 * and testable.
 */

import type { SessionsDb } from '../store/sessions-db.js';

export type ScheduledTaskStatus = 'pending' | 'fired' | 'cancelled';

export interface ScheduledTask {
  id: string;
  sessionId: string;
  /** Epoch ms when the follow-up becomes due. */
  dueAt: number;
  instruction: string;
  status: ScheduledTaskStatus;
  createdAt: number;
  /** The principal that scheduled it (review CRITICAL): the resumed turn runs
   * as THIS role/user, never escalating to admin. */
  role: string;
  userId: string;
  /** When set, firing runs this workflow (via the engine) instead of re-running
   * the agent — a CRON-style scheduled automation. */
  workflowId?: string;
  /** When set with workflowId, the poller reschedules the run every intervalMs
   * (recurring cron). Absent = one-shot. */
  intervalMs?: number;
}

export interface ScheduleInput {
  id: string;
  sessionId: string;
  dueAt: number;
  instruction: string;
  createdAt: number;
  role: string;
  userId: string;
  workflowId?: string;
  intervalMs?: number;
}

export interface ScheduledTaskStore {
  schedule(input: ScheduleInput): ScheduledTask;
  /** Pending tasks whose dueAt <= nowMs, soonest-first (optional limit). */
  due(nowMs: number, limit?: number): ScheduledTask[];
  listPending(sessionId: string): ScheduledTask[];
  markFired(id: string): void;
  cancel(id: string): void;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS scheduled_tasks (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     due_at INTEGER NOT NULL,
     instruction TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL,
     role TEXT NOT NULL DEFAULT 'admin',
     user_id TEXT NOT NULL DEFAULT 'user_1'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sched_status_due ON scheduled_tasks (status, due_at)`,
];

// Idempotent migrations for a table created before the principal columns
// existed — ADD COLUMN throws "duplicate column" once present, which we ignore.
const MIGRATIONS = [
  `ALTER TABLE scheduled_tasks ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`,
  `ALTER TABLE scheduled_tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'user_1'`,
  `ALTER TABLE scheduled_tasks ADD COLUMN workflow_id TEXT`,
  `ALTER TABLE scheduled_tasks ADD COLUMN interval_ms INTEGER`,
];

function rowToTask(r: Record<string, unknown>): ScheduledTask {
  const task: ScheduledTask = {
    id: String(r['id']),
    sessionId: String(r['session_id']),
    dueAt: Number(r['due_at']),
    instruction: String(r['instruction']),
    status: r['status'] as ScheduledTaskStatus,
    createdAt: Number(r['created_at']),
    role: String(r['role'] ?? 'admin'),
    userId: String(r['user_id'] ?? 'user_1'),
  };
  if (r['workflow_id'] != null) task.workflowId = String(r['workflow_id']);
  if (r['interval_ms'] != null) task.intervalMs = Number(r['interval_ms']);
  return task;
}

export function openScheduledTasks(db: SessionsDb): ScheduledTaskStore {
  for (const stmt of DDL) db.run(stmt);
  for (const stmt of MIGRATIONS) {
    try {
      db.run(stmt);
    } catch {
      /* column already exists — expected on an up-to-date table */
    }
  }

  return {
    schedule(input: ScheduleInput): ScheduledTask {
      db.run(
        `INSERT INTO scheduled_tasks (id, session_id, due_at, instruction, status, created_at, role, user_id, workflow_id, interval_ms)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [input.id, input.sessionId, input.dueAt, input.instruction, input.createdAt, input.role, input.userId, input.workflowId ?? null, input.intervalMs ?? null],
      );
      return { ...input, status: 'pending' };
    },

    due(nowMs: number, limit = 100): ScheduledTask[] {
      return db
        .all(
          `SELECT * FROM scheduled_tasks WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?`,
          [nowMs, limit],
        )
        .map(rowToTask);
    },

    listPending(sessionId: string): ScheduledTask[] {
      return db
        .all(
          `SELECT * FROM scheduled_tasks WHERE session_id = ? AND status = 'pending' ORDER BY due_at ASC`,
          [sessionId],
        )
        .map(rowToTask);
    },

    markFired(id: string): void {
      db.run(`UPDATE scheduled_tasks SET status = 'fired' WHERE id = ?`, [id]);
    },

    cancel(id: string): void {
      db.run(`UPDATE scheduled_tasks SET status = 'cancelled' WHERE id = ?`, [id]);
    },
  };
}
