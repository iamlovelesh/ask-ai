import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { buildRegistry } from '../src/catalog/registry';
import type { ActionDef } from '../src/catalog/types';
import { openCrm, crmDbPath, closeRegistered, type Crm } from '../src/store/db';
import { VirtualClock } from '../src/store/clock';
import { createWorkflowEngine } from '../src/agent/workflow-engine';

const PROFILE = 'test-wf-engine';

function cleanup(): void {
  for (const s of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(PROFILE) + s;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

/** Minimal ActionDef for engine tests — handler side effect is observable via `calls`. */
function testAction(slug: string, handler: ActionDef['handler']): ActionDef {
  return {
    id: slug, slug, module: slug.split('.')[0] as string, name: slug, description: slug,
    risk: 'write', entities: [slug.split('.')[0] as string],
    inputSchema: z.object({}).catchall(z.unknown()) as unknown as ActionDef['inputSchema'],
    outputSchema: z.unknown(), searchCard: { synonyms: [], examplePhrasings: [] },
    handler,
  };
}

let crm: Crm;
const calls: string[] = [];
const registry = buildRegistry(
  [[
    testAction('test.ok', async (input) => { calls.push(`ok:${JSON.stringify(input)}`); return { done: true }; }),
    testAction('test.boom', async () => { throw new Error('kaboom'); }),
  ]],
  [],
);

/** Seed a workflow row directly in `structures`. */
function seedWorkflow(id: string, steps: Array<{ type: string; config?: Record<string, unknown> }>, status = 'active'): void {
  const stepDefs = steps.map((s, i) => ({ step_id: `step_${i + 1}`, type: s.type, config: s.config ?? {}, order: i + 1 }));
  crm.tx((db) =>
    db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status, config)
       VALUES (?, ?, ?, 0, 'workflow', ?, ?, ?, ?)`,
      [id, 1000, 1000, id, id, status, JSON.stringify({ steps: stepDefs, execution_log: [] })],
    ),
  );
}

beforeEach(() => {
  cleanup();
  crm = openCrm(PROFILE);
  calls.length = 0;
});
afterAll(() => { closeRegistered(PROFILE); cleanup(); });

describe('workflow engine — runWorkflow', () => {
  it('runs every step via the catalog and records a success run', async () => {
    seedWorkflow('wf_1', [{ type: 'test.ok', config: { a: 1 } }, { type: 'test.ok', config: { a: 2 } }]);
    const engine = createWorkflowEngine({ registry, crm, clock: new VirtualClock() });
    const run = await engine.runWorkflow('wf_1', { trigger: 'manual' });
    expect(run?.status).toBe('success');
    expect(run?.steps).toHaveLength(2);
    expect(run?.steps.every((s) => s.status === 'success')).toBe(true);
    expect(calls).toEqual(['ok:{"a":1}', 'ok:{"a":2}']); // both handlers ran, in order
  });

  it('marks a run partial when some steps fail, and continues past the failure', async () => {
    seedWorkflow('wf_2', [{ type: 'test.ok' }, { type: 'test.boom' }, { type: 'test.ok' }]);
    const engine = createWorkflowEngine({ registry, crm, clock: new VirtualClock() });
    const run = await engine.runWorkflow('wf_2', { trigger: 'manual' });
    expect(run?.status).toBe('partial');
    expect(run?.steps.map((s) => s.status)).toEqual(['success', 'failed', 'success']);
    expect(run?.steps[1]?.error).toMatch(/kaboom/);
    expect(calls).toHaveLength(2); // both test.ok ran despite the middle failure
  });

  it('fails a step whose type is not a known action', async () => {
    seedWorkflow('wf_3', [{ type: 'nope.not_real' }]);
    const engine = createWorkflowEngine({ registry, crm, clock: new VirtualClock() });
    const run = await engine.runWorkflow('wf_3', { trigger: 'manual' });
    expect(run?.status).toBe('failed');
    expect(run?.steps[0]?.error).toMatch(/unknown action/i);
  });

  it('persists the run into the workflow so history can read it', async () => {
    seedWorkflow('wf_4', [{ type: 'test.ok' }]);
    const engine = createWorkflowEngine({ registry, crm, clock: new VirtualClock() });
    await engine.runWorkflow('wf_4', { trigger: 'event:lead.created' });
    const row = crm.tx((db) => db.get(`SELECT config FROM structures WHERE id = ?`, ['wf_4']));
    const config = JSON.parse(String(row?.['config'] ?? '{}'));
    expect(config.runs).toHaveLength(1);
    expect(config.runs[0].trigger).toBe('event:lead.created');
    expect(config.runs[0].status).toBe('success');
  });

  it('returns undefined for a workflow that does not exist', async () => {
    const engine = createWorkflowEngine({ registry, crm, clock: new VirtualClock() });
    expect(await engine.runWorkflow('wf_missing', { trigger: 'manual' })).toBeUndefined();
  });

  it('records an empty run for a workflow with no steps', async () => {
    seedWorkflow('wf_5', []);
    const engine = createWorkflowEngine({ registry, crm, clock: new VirtualClock() });
    const run = await engine.runWorkflow('wf_5', { trigger: 'manual' });
    expect(run?.status).toBe('empty');
    expect(run?.steps).toHaveLength(0);
  });
});
