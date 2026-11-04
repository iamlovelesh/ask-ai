/**
 * Composer (LLD §5, brief interfaces list): turns a finished turn's
 * plan + step results into the final `answer.final` text. PURE TEMPLATES —
 * no LLM call, ever. Every number/name in the rendered text is read
 * straight out of `stepStates` (grounded — no invention).
 */

import type { Plan, Step } from './plan-schema.js';

export type ComposeOutcome = 'done' | 'cancelled' | 'failed' | 'halted' | 'clarify' | 'refused';

export type StepLifecycle = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface ComposeStepState {
  state: StepLifecycle;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ComposeInput {
  outcome: ComposeOutcome;
  plan?: Plan;
  stepStates?: Record<string, ComposeStepState>;
  /** Verbatim for `'clarify'`. */
  question?: string;
  /** Verbatim-ish for `'cancelled'`/`'failed'`/`'halted'`/`'refused'`. Any
   * "nearest capability" hint for `'refused'` is expected to already be
   * folded into this string by the caller (composer has no registry
   * access to compute one itself). */
  reason?: string;
}

function isCoreSlug(action: string): boolean {
  return action.startsWith('core.');
}

/** Row/result count — same convention as `agent/joiner.ts`'s `countOf` and
 * `agent/executor.ts`'s `countRows`. */
function countOf(result: unknown): number {
  if (result === undefined || result === null) return 0;
  if (Array.isArray(result)) return result.length;
  if (typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o['total'] === 'number') return o['total'];
    if (Array.isArray(o['items'])) return o['items'].length;
  }
  return 1;
}

/** A single-record result's display name, when it has one (e.g. a freshly
 * created task/contact/invoice echoing back `{id, name, ...}`). */
function resultDisplayName(result: unknown): string | undefined {
  if (result !== null && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o['name'] === 'string') return o['name'];
    if (typeof o['title'] === 'string') return o['title'];
  }
  return undefined;
}

/** One grounded line per reportable step: a single named record ("created
 * X") when the result carries a name/title and is singular, else a count
 * ("N record(s)"). */
function describeStepResult(step: Step, result: unknown): string {
  const count = countOf(result);
  const name = resultDisplayName(result);
  if (name !== undefined && count <= 1) return `${step.action}: ${name}`;
  return `${step.action}: ${count} record(s)`;
}

interface Grouped {
  doneLines: string[];
  failedLines: string[];
  cancelledIds: string[];
  pendingIds: string[];
}

/** Buckets every NON-core step (core.* ops are internal plumbing, not
 * user-visible actions) by its final `StepLifecycle`, in plan order. */
function groupSteps(plan: Plan | undefined, stepStates: Record<string, ComposeStepState> | undefined): Grouped {
  const grouped: Grouped = { doneLines: [], failedLines: [], cancelledIds: [], pendingIds: [] };
  if (!plan || !stepStates) return grouped;

  for (const step of plan.steps) {
    if (isCoreSlug(step.action)) continue;
    const rec = stepStates[step.id];
    if (!rec) continue;
    switch (rec.state) {
      case 'done':
        grouped.doneLines.push(describeStepResult(step, rec.result));
        break;
      case 'failed':
        grouped.failedLines.push(`${step.action} failed: ${rec.error?.message ?? 'unknown error'}`);
        break;
      case 'cancelled':
        grouped.cancelledIds.push(step.action);
        break;
      case 'pending':
      case 'running':
      case 'skipped':
        grouped.pendingIds.push(step.action);
        break;
      default:
        break;
    }
  }
  return grouped;
}

function renderFailuresSection(failedLines: readonly string[]): string[] {
  if (failedLines.length === 0) return [];
  return ['', 'Failures:', ...failedLines.map((l) => `- ${l}`)];
}

function renderPendingNote(pendingIds: readonly string[]): string[] {
  if (pendingIds.length === 0) return [];
  return ['', `Not reached: ${pendingIds.join(', ')}.`];
}

// --- per-outcome renderers ---------------------------------------------------

function composeDone(input: ComposeInput): string {
  const goal = input.plan?.goal ?? 'your request';
  const { doneLines, failedLines, pendingIds } = groupSteps(input.plan, input.stepStates);
  const lines: string[] = [`Done: ${goal}.`];
  for (const l of doneLines) lines.push(`- ${l}`);
  lines.push(...renderFailuresSection(failedLines));
  lines.push(...renderPendingNote(pendingIds));
  return lines.join('\n');
}

function composeCancelled(input: ComposeInput): string {
  const goal = input.plan?.goal ?? 'the request';
  const { doneLines, cancelledIds } = groupSteps(input.plan, input.stepStates);
  const lines: string[] = [`Cancelled: ${goal} was not completed.`];
  if (input.reason !== undefined) lines.push(input.reason);
  if (cancelledIds.length > 0) lines.push(`Not done: ${cancelledIds.join(', ')}.`);
  if (doneLines.length > 0) {
    lines.push('Already completed before the cancellation:');
    for (const l of doneLines) lines.push(`- ${l}`);
  }
  return lines.join('\n');
}

function composeFailedOrHalted(input: ComposeInput): string {
  const goal = input.plan?.goal ?? 'the request';
  const { doneLines, failedLines, pendingIds } = groupSteps(input.plan, input.stepStates);
  const verb = input.outcome === 'halted' ? 'stopped' : 'failed';
  const lines: string[] = [`Partial result: ${goal} ${verb} partway through.`];
  if (doneLines.length > 0) {
    lines.push('Completed:');
    for (const l of doneLines) lines.push(`- ${l}`);
  }
  lines.push(...renderFailuresSection(failedLines));
  lines.push(...renderPendingNote(pendingIds));
  if (input.reason !== undefined) lines.push('', input.reason);
  return lines.join('\n');
}

function composeClarify(input: ComposeInput): string {
  // Verbatim — no added prefix/suffix (LLD: "exactly one focused question").
  return input.question ?? '';
}

function composeRefused(input: ComposeInput): string {
  return input.reason ?? "I can't help with that.";
}

/**
 * Renders the final answer text for a finished turn (LLD §5 pipeline's
 * `compose` step). PURE: same `input` always renders the same string.
 */
export function compose(input: ComposeInput): string {
  switch (input.outcome) {
    case 'done':
      return composeDone(input);
    case 'cancelled':
      return composeCancelled(input);
    case 'failed':
    case 'halted':
      return composeFailedOrHalted(input);
    case 'clarify':
      return composeClarify(input);
    case 'refused':
      return composeRefused(input);
    default:
      return '';
  }
}
