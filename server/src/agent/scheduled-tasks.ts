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
}

export interface ScheduleInput {
  id: string;
  sessionId: string;
  dueAt: number;
  instruction: string;
  createdAt: number;
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
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sched_status_due ON scheduled_tasks (status, due_at)`,
];

function rowToTask(r: Record<string, unknown>): ScheduledTask {
  return {
    id: String(r['id']),
    sessionId: String(r['session_id']),
    dueAt: Number(r['due_at']),
    instruction: String(r['instruction']),
    status: r['status'] as ScheduledTaskStatus,
    createdAt: Number(r['created_at']),
  };
}

export function openScheduledTasks(db: SessionsDb): ScheduledTaskStore {
  for (const stmt of DDL) db.run(stmt);

  return {
    schedule(input: ScheduleInput): ScheduledTask {
      db.run(
        `INSERT INTO scheduled_tasks (id, session_id, due_at, instruction, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [input.id, input.sessionId, input.dueAt, input.instruction, input.createdAt],
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
