import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VirtualClock } from '../src/store/clock';
import { openSessions } from '../src/store/sessions-db';
import { buildTurnTools, StuckTracker, type BuildTurnToolsInput, type LoopExits } from '../src/loop/tools';

/**
 * Regression (observed live): a `session__request_form` turn reported "ran out
 * of time (90s)" after ~157s with `gateWaitMs=undefined`. The form tool awaited
 * the user's submission WITHOUT the gate-wait accounting the other confirmation
 * gates use, so the time the user spent filling the form counted against the
 * compute deadline. These tests pin that the form wait is recorded in
 * `counters.gateWaitMs` (so the loop can subtract it from the deadline).
 */

const paths: string[] = [];
let nowMs = 0;

beforeEach(() => {
  nowMs = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of paths) for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(p + s)) rmSync(p + s, { force: true });
});

function freshExits(): LoopExits {
  return { denied: false, writesLanded: 0, writeActions: new Map(), writeEntities: new Set(), toolOutputs: [], appliedFilters: [], stop: () => {} };
}

const GATE_WAIT_MS = 30_000;

/** A confirm broker that simulates a human taking GATE_WAIT_MS to submit the
 * form, returning the given verdict. */
function slowConfirm(verdict: boolean | { approved: boolean; editedParams?: Record<string, unknown> }): BuildTurnToolsInput['confirm'] {
  return {
    request: async () => {
      nowMs += GATE_WAIT_MS;
      return verdict;
    },
  } as BuildTurnToolsInput['confirm'];
}

function buildInput(confirm: BuildTurnToolsInput['confirm'], counters: BuildTurnToolsInput['counters'], exits: LoopExits): BuildTurnToolsInput {
  const p = join(tmpdir(), `sessions-formtest-${randomUUID()}.db`);
  paths.push(p);
  openSessions(p).close();
  const stubRegistry = { get: () => undefined, all: () => [] } as unknown as BuildTurnToolsInput['registry'];
  return {
    registry: stubRegistry,
    cards: [],
    crm: {} as BuildTurnToolsInput['crm'],
    refs: {} as BuildTurnToolsInput['refs'],
    confirm,
    clock: new VirtualClock(),
    turnId: 't_1',
    emit: () => {},
    sessionCtx: { usedActionSlugs: [], activeModules: [] },
    exits,
    stuck: new StuckTracker(),
    markTtfur: () => {},
    counters,
    planHash: 'h',
    actingUserId: 'user_1',
    knownIds: new Set<string>(),
  };
}

function findTool(tools: ReturnType<typeof buildTurnTools>, name: string): { invoke: (ctx: unknown, input: string) => Promise<unknown> } {
  const t = tools.find((x) => (x as { name?: string }).name === name) as never;
  if (!t) throw new Error(`tool ${name} not built`);
  return t;
}

const FORM_ARGS = {
  title: 'New opportunity details',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'value', label: 'Value', type: 'number', required: true },
    { key: 'stage', label: 'Stage', type: 'text', required: false },
  ],
};

describe('session__request_form gate-wait accounting', () => {
  it('records the time spent waiting on the form in counters.gateWaitMs (submitted)', async () => {
    const counters = { stepsOk: 0, stepsFailed: 0, step: 0, gateWaitMs: 0, virtualReads: 0 };
    const tools = buildTurnTools(
      buildInput(slowConfirm({ approved: true, editedParams: { name: 'Acme deal', value: 1000, stage: 'New' } }), counters, freshExits()),
    );
    const res = (await findTool(tools, 'session__request_form').invoke({}, JSON.stringify(FORM_ARGS))) as string;

    expect(counters.gateWaitMs).toBe(GATE_WAIT_MS);
    expect(res).toContain('Acme deal');
  });

  it('records the wait even when the form is cancelled', async () => {
    const counters = { stepsOk: 0, stepsFailed: 0, step: 0, gateWaitMs: 0, virtualReads: 0 };
    const exits = freshExits();
    const tools = buildTurnTools(buildInput(slowConfirm(false), counters, exits));
    await findTool(tools, 'session__request_form').invoke({}, JSON.stringify(FORM_ARGS));

    expect(counters.gateWaitMs).toBe(GATE_WAIT_MS);
    expect(exits.clarify).toBeDefined();
  });
});
