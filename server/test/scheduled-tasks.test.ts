import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openSessions } from '../src/store/sessions-db';
import { openScheduledTasks, type ScheduledTaskStore } from '../src/agent/scheduled-tasks';

const DAY = 86_400_000;
const NOW = 1_762_000_000_000;

describe('ScheduledTaskStore (#8 suspension/wait)', () => {
  let store: ScheduledTaskStore;
  const sid = 'sess_1';

  beforeEach(() => {
    const db = openSessions(`/tmp/sched-${randomUUID()}.db`);
    db.run('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)', [sid, NOW, NOW]);
    store = openScheduledTasks(db);
  });

  function schedule(dueAt: number, instruction: string, role = 'admin', userId = 'user_1'): string {
    const id = `task_${randomUUID()}`;
    store.schedule({ id, sessionId: sid, dueAt, instruction, createdAt: NOW, role, userId });
    return id;
  }

  it('persists an optional workflowId + intervalMs (cron workflow runs)', () => {
    const id = `task_${randomUUID()}`;
    store.schedule({ id, sessionId: sid, dueAt: NOW - DAY, instruction: 'run workflow', createdAt: NOW, role: 'admin', userId: 'user_1', workflowId: 'wf_7', intervalMs: DAY });
    const [task] = store.due(NOW);
    expect(task?.workflowId).toBe('wf_7');
    expect(task?.intervalMs).toBe(DAY);
  });

  it('leaves workflowId/intervalMs undefined for a plain reminder task', () => {
    schedule(NOW - DAY, 'plain reminder');
    const [task] = store.due(NOW);
    expect(task?.workflowId).toBeUndefined();
    expect(task?.intervalMs).toBeUndefined();
  });

  it('persists the scheduling principal (role + userId) for non-escalating resume', () => {
    schedule(NOW - DAY, 'viewer reminder', 'viewer', 'user_7');
    const [task] = store.due(NOW);
    expect(task?.role).toBe('viewer');
    expect(task?.userId).toBe('user_7');
  });

  it('returns only tasks whose due time has passed from due()', () => {
    schedule(NOW - DAY, 'overdue one');
    const future = schedule(NOW + DAY, 'later one');
    const due = store.due(NOW);
    expect(due.map((t) => t.instruction)).toEqual(['overdue one']);
    expect(due.some((t) => t.id === future)).toBe(false);
  });

  it('lists all pending tasks for a session regardless of due time', () => {
    schedule(NOW - DAY, 'a');
    schedule(NOW + DAY, 'b');
    expect(store.listPending(sid)).toHaveLength(2);
  });

  it('markFired removes a task from due() and listPending()', () => {
    const id = schedule(NOW - DAY, 'fire me');
    store.markFired(id);
    expect(store.due(NOW)).toHaveLength(0);
    expect(store.listPending(sid)).toHaveLength(0);
  });

  it('cancel removes a pending task from both queries', () => {
    const id = schedule(NOW + DAY, 'cancel me');
    store.cancel(id);
    expect(store.listPending(sid)).toHaveLength(0);
  });

  it('due() orders soonest-first and respects the limit', () => {
    schedule(NOW - DAY, 'second');
    schedule(NOW - 2 * DAY, 'first');
    const due = store.due(NOW, 1);
    expect(due).toHaveLength(1);
    expect(due[0]!.instruction).toBe('first');
  });

  it('persists across a fresh store handle on the same file (durable)', () => {
    const path = `/tmp/sched-${randomUUID()}.db`;
    const db1 = openSessions(path);
    db1.run('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)', ['s2', NOW, NOW]);
    openScheduledTasks(db1).schedule({ id: 'task_x', sessionId: 's2', dueAt: NOW - DAY, instruction: 'survive', createdAt: NOW, role: 'admin', userId: 'user_1' });
    const store2 = openScheduledTasks(openSessions(path));
    expect(store2.due(NOW).map((t) => t.instruction)).toContain('survive');
  });
});
