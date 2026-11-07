/**
 * Workflow execution engine.
 *
 * Turns the M16 workflow data model (an ordered list of steps, each a catalog
 * action slug + its params) into something that actually RUNS: it resolves
 * each step against the action registry, validates the step config against the
 * action's own schema, runs the handler against the CRM, and records a per-run
 * history on the workflow. The 500-action catalog IS the step library.
 *
 * Writes execute autonomously — an active workflow is pre-authorized, so steps
 * do NOT go through the interactive confirmation gate. Because steps run via
 * the registry handlers directly (not the agent's tool layer), a workflow's own
 * writes never re-fire triggers, so there is no cascade to bound.
 */

import { randomUUID } from 'node:crypto';
import type { Registry } from '../catalog/registry.js';
import type { Crm } from '../store/db.js';
import { VirtualClock } from '../store/clock.js';
import { parseJsonObject } from '../catalog/json.js';
import { coerceDateParams } from '../loop/date-rail.js';
import type { ActionContext, ActionDef } from '../catalog/types.js';

const WORKFLOW_KIND = 'workflow';
const TRIGGER_KIND = 'trigger';
const MAX_RUNS_KEPT = 20;
const MAX_LOG_KEPT = 100;

/** Slug verb → the generic DB event op. Actions whose verb isn't one of these
 * (e.g. record_payment, search_leads) emit no event. */
const OP_BY_VERB: Record<string, string> = {
  create: 'created', add: 'created',
  update: 'updated', set: 'updated', edit: 'updated', move: 'updated', advance: 'updated',
  delete: 'deleted', remove: 'deleted', archive: 'deleted',
};

function opForSlug(slug: string): string | undefined {
  const verb = slug.split('.')[1]?.split('_')[0];
  return verb ? OP_BY_VERB[verb] : undefined;
}

function singular(entity: string): string {
  if (entity.endsWith('ies')) return `${entity.slice(0, -3)}y`;
  if (entity.endsWith('s')) return entity.slice(0, -1);
  return entity;
}

/** Normalize an event string to `<singular-entity>.<op>` so a trigger's
 * free-text event_type ("lead.created", "leads.create") matches a write. */
function normalizeEvent(raw: string): string {
  const [ent = '', op = ''] = raw.toLowerCase().split('.');
  return `${singular(ent)}.${OP_BY_VERB[op] ?? op}`;
}

function conditionsMatch(conditions: Record<string, unknown>, record: Record<string, unknown>): boolean {
  for (const [key, want] of Object.entries(conditions)) {
    if (!(key in record)) return false;
    if (String(record[key]).toLowerCase() !== String(want).toLowerCase()) return false;
  }
  return true;
}

export interface WorkflowStepDef {
  step_id: string;
  type: string;
  config: Record<string, unknown>;
  order: number;
}

export interface StepResult {
  step_id: string;
  type: string;
  status: 'success' | 'failed';
  error?: string;
}

export type WorkflowRunStatus = 'success' | 'partial' | 'failed' | 'empty';

export interface WorkflowRun {
  run_id: string;
  workflow_id: string;
  trigger: string;
  status: WorkflowRunStatus;
  started_at: number;
  finished_at: number;
  steps: StepResult[];
}

export interface RunWorkflowOptions {
  /** Provenance of the run: 'manual', 'event:<entity>.<op>', 'cron'. */
  trigger: string;
}

export interface WorkflowEngine {
  /** Execute a workflow's steps and record the run. Returns the run, or
   * undefined when the workflow id does not exist. */
  runWorkflow(workflowId: string, opts: RunWorkflowOptions): Promise<WorkflowRun | undefined>;
  /** Fire any active DATABASE_EVENT triggers matching a write (the action +
   * its result record). Called by the tool layer AFTER an agent write commits;
   * workflow-internal writes bypass this, so there is no cascade. Returns the
   * runs that fired (best-effort — never throws). */
  onWrite(action: ActionDef, result: unknown): Promise<WorkflowRun[]>;
}

export interface WorkflowEngineDeps {
  registry: Registry;
  crm: Crm;
  clock: VirtualClock;
}

function readSteps(configJson: unknown): WorkflowStepDef[] {
  const config = parseJsonObject(configJson);
  const raw = Array.isArray(config['steps']) ? (config['steps'] as WorkflowStepDef[]) : [];
  return [...raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function createWorkflowEngine(deps: WorkflowEngineDeps): WorkflowEngine {
  const { registry, crm, clock } = deps;

  async function runWorkflow(workflowId: string, opts: RunWorkflowOptions): Promise<WorkflowRun | undefined> {
    const row = crm.tx((db) => db.get(`SELECT config FROM structures WHERE id = ? AND kind = ?`, [workflowId, WORKFLOW_KIND]));
    if (!row) return undefined;

    const steps = readSteps(row['config']);
    const runId = `run_${randomUUID()}`;
    const startedAt = clock.now();
    const results: StepResult[] = [];

    for (const step of steps) {
      const action = registry.get(step.type);
      if (!action) {
        results.push({ step_id: step.step_id, type: step.type, status: 'failed', error: `unknown action "${step.type}"` });
        continue;
      }
      const coerced = coerceDateParams(step.config ?? {}, clock.now()).params;
      const parsed = action.inputSchema.safeParse(coerced);
      if (!parsed.success) {
        results.push({ step_id: step.step_id, type: step.type, status: 'failed', error: 'invalid step config for this action' });
        continue;
      }
      try {
        await crm.tx((db) =>
          action.handler(parsed.data, { db, clock, idempotencyKey: `wf:${runId}:${step.step_id}`, format: 'concise' } satisfies ActionContext),
        );
        results.push({ step_id: step.step_id, type: step.type, status: 'success' });
      } catch (err) {
        results.push({ step_id: step.step_id, type: step.type, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }

    const finishedAt = clock.now();
    const okCount = results.filter((r) => r.status === 'success').length;
    const status: WorkflowRunStatus =
      steps.length === 0 ? 'empty' : okCount === steps.length ? 'success' : okCount === 0 ? 'failed' : 'partial';
    const run: WorkflowRun = {
      run_id: runId,
      workflow_id: workflowId,
      trigger: opts.trigger,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      steps: results,
    };

    // Persist the run onto the workflow (newest first, capped). execution_log
    // kept for back-compat with the existing M16 degenerate history shape.
    crm.tx((db) => {
      const fresh = parseJsonObject(db.get(`SELECT config FROM structures WHERE id = ?`, [workflowId])?.['config']);
      const priorRuns = Array.isArray(fresh['runs']) ? (fresh['runs'] as WorkflowRun[]) : [];
      const priorLog = Array.isArray(fresh['execution_log']) ? (fresh['execution_log'] as unknown[]) : [];
      const logEntries = results.map((r) => ({ at: finishedAt, step_id: r.step_id, status: r.status }));
      const next = {
        ...fresh,
        runs: [run, ...priorRuns].slice(0, MAX_RUNS_KEPT),
        execution_log: [...logEntries, ...priorLog].slice(0, MAX_LOG_KEPT),
      };
      db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(next), finishedAt, workflowId]);
    });

    return run;
  }

  async function onWrite(action: ActionDef, result: unknown): Promise<WorkflowRun[]> {
    try {
      const op = opForSlug(action.slug);
      const entity = action.entities[0];
      if (!op || !entity || entity === 'structures') return [];
      const writeEvent = normalizeEvent(`${entity}.${op}`);
      const record = result !== null && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : {};

      const triggers = crm.tx((db) => db.all(`SELECT config FROM structures WHERE kind = ? AND status = 'active'`, [TRIGGER_KIND]));
      const workflowIds: string[] = [];
      for (const t of triggers) {
        const cfg = parseJsonObject(t['config']);
        const eventType = cfg['event_type'];
        if (typeof eventType !== 'string' || normalizeEvent(eventType) !== writeEvent) continue;
        const conditions = cfg['conditions'] && typeof cfg['conditions'] === 'object' ? (cfg['conditions'] as Record<string, unknown>) : {};
        if (!conditionsMatch(conditions, record)) continue;
        const wf = cfg['workflow_id'];
        if (typeof wf === 'string' && wf.length > 0) workflowIds.push(wf);
      }

      const runs: WorkflowRun[] = [];
      for (const wf of workflowIds) {
        const run = await runWorkflow(wf, { trigger: `event:${writeEvent}` });
        if (run) runs.push(run);
      }
      return runs;
    } catch {
      // Firing is best-effort — a trigger/workflow problem must never break the
      // agent's own write that caused the event.
      return [];
    }
  }

  return { runWorkflow, onWrite };
}
