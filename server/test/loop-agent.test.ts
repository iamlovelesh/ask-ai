import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runLoopTurn, type LoopSessionDeps, type RunLoopTurnInput } from '../src/loop/agent';
import { StuckTracker } from '../src/loop/tools';
import { costMeter } from '../src/llm/client';
import { __resetIndexForTest } from '../src/agent/retrieval';
import { openEventLog, type EventLog } from '../src/events/log';
import { openSessions, type SessionsDb } from '../src/store/sessions-db';
import { createRefStore, type RefStore, type HydrateResult } from '../src/agent/refs';
import { buildRegistry, type Registry } from '../src/catalog/registry';
import { ActionError, type ActionContext, type ActionDef, type Risk } from '../src/catalog/types';
import type { Crm, StoreTx } from '../src/store/db';
import type { ConfirmBroker } from '../src/agent/executor';
import type { Event } from '../src/events/types';

// --- fake actions (baseline.test.ts convention) --------------------------------

type Handler = (input: Record<string, unknown>, ctx: ActionContext) => Promise<unknown>;

function action(slug: string, risk: Risk, handler: Handler, inputSchema?: z.ZodType<unknown>): ActionDef {
  return {
    id: slug,
    slug,
    module: slug.split('.')[0] as string,
    name: slug,
    description: slug,
    risk,
    entities: [slug.split('.')[0] as string],
    inputSchema: inputSchema ?? z.object({}).catchall(z.unknown()),
    outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler: handler as ActionDef['handler'],
  };
}

const noopTx: StoreTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeCrm: Crm = { tx: (fn) => fn(noopTx), close: () => {} };
const approveAll: ConfirmBroker = { request: async () => true };
const denyAll: ConfirmBroker = { request: async () => false };

// --- scripted OpenRouter wire responses ----------------------------------------

function toolCallResponse(name: string, args: Record<string, unknown>): unknown {
  return {
    id: 'gen', object: 'chat.completion', created: 1, model: 'anthropic/claude-haiku-4.5',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

function textResponse(text: string): unknown {
  return {
    id: 'gen', object: 'chat.completion', created: 2, model: 'anthropic/claude-haiku-4.5',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 },
  };
}

interface Seen { bodies: string[] }

function scriptedFetch(script: unknown[], seen?: Seen): typeof fetch {
  let i = 0;
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    if (seen && init?.body) seen.bodies.push(String(init.body));
    // Deep-clone and uniquify tool-call ids: the SDK rightly refuses to
    // re-execute a call id it has already seen in the conversation history.
    const payload = JSON.parse(JSON.stringify(script[Math.min(i, script.length - 1)])) as {
      choices?: { message?: { tool_calls?: { id: string }[] } }[];
    };
    for (const choice of payload.choices ?? []) {
      for (const tc of choice.message?.tool_calls ?? []) tc.id = `call_${i}_${randomUUID().slice(0, 8)}`;
    }
    i += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

// --- harness --------------------------------------------------------------------

const tmpPaths: string[] = [];
function tmpDbPath(): string {
  const p = join(tmpdir(), `ask-ai-loop-${randomUUID()}.db`);
  tmpPaths.push(p);
  return p;
}

let eventLog: EventLog;
let sessionsDb: SessionsDb;
let refs: RefStore;
const sessionId = 'sess_loop';

beforeEach(() => {
  costMeter.__resetForTest();
  delete process.env['EVAL_BUDGET_USD'];
  __resetIndexForTest();
  const dbPath = tmpDbPath();
  eventLog = openEventLog(dbPath);
  sessionsDb = openSessions(dbPath);
  refs = createRefStore(sessionsDb, sessionId);
});

afterEach(() => {
  eventLog.close();
  sessionsDb.close();
  while (tmpPaths.length) {
    const p = tmpPaths.pop() as string;
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(p + suffix)) rmSync(p + suffix, { force: true });
  }
});

async function drive(
  registry: Registry,
  userText: string,
  script: unknown[],
  overrides: Partial<LoopSessionDeps> = {},
  inputOverrides: Partial<RunLoopTurnInput> = {},
): Promise<Event[]> {
  const events: Event[] = [];
  const input: RunLoopTurnInput = {
    sessionId,
    turnId: `t_${randomUUID()}`,
    userText,
    sessionDeps: { registry, crm: fakeCrm, refs, eventLog, confirm: approveAll, testFetch: scriptedFetch(script), ...overrides },
    ...inputOverrides,
  };
  for await (const ev of runLoopTurn(input)) events.push(ev);
  return events;
}

function typesOf(events: readonly Event[]): string[] {
  return events.map((e) => e.t);
}

function completedOf(events: readonly Event[]): Extract<Event, { t: 'turn.completed' }> {
  const ev = events.find((e) => e.t === 'turn.completed');
  if (!ev || ev.t !== 'turn.completed') throw new Error('no turn.completed');
  return ev;
}

function finalOf(events: readonly Event[]): string {
  const ev = events.find((e) => e.t === 'answer.final');
  if (!ev || ev.t !== 'answer.final') throw new Error('no answer.final');
  return ev.text;
}

// --------------------------------------------------------------------------------

describe('runLoopTurn — read turn', () => {
  it('emits the shared event shape and a done status', async () => {
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]], []);
    const events = await drive(registry, 'find leads', [
      toolCallResponse('leads__search_leads', { query: 'new' }),
      textResponse('Found 1 lead.'),
    ]);
    const types = typesOf(events);
    expect(types[0]).toBe('turn.started');
    expect(types).toContain('step.started');
    expect(types).toContain('step.finished');
    expect(types).toContain('answer.final');
    expect(types[types.length - 2]).toBe('turn.completed');
    expect(types[types.length - 1]).toBe('memory.snapshot');
    expect(completedOf(events).status).toBe('done');
    expect(completedOf(events).metrics.llmCalls).toBe(2);
    expect(finalOf(events)).toBe('Found 1 lead.');
    const started = events.find((e) => e.t === 'step.started');
    expect(started && started.t === 'step.started' ? started.resolvedParams?.[0] : undefined).toEqual({ query: 'new' });
  });

  it('caps max_tokens on every model request (402 pre-auth guard)', async () => {
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'find leads',
      sessionDeps: { registry, crm: fakeCrm, refs, eventLog, confirm: approveAll, testFetch: scriptedFetch([textResponse('None.')], seen) },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const body = JSON.parse(seen.bodies[0] ?? '{}') as Record<string, unknown>;
    expect(body['max_tokens']).toBe(4096);
  });
});

describe('runLoopTurn — date rail end to end', () => {
  it('coerces ISO strings to epoch before the handler and echoes the resolved range', async () => {
    let got: Record<string, unknown> | undefined;
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async (input) => { got = input; return { items: [], total: 0 }; }, z.object({ created_after: z.number() }))]],
      [],
    );
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'leads created today',
      sessionDeps: {
        registry, crm: fakeCrm, refs, eventLog, confirm: approveAll,
        testFetch: scriptedFetch([toolCallResponse('leads__search_leads', { created_after: '2026-11-04T00:00:00Z' }), textResponse('None found.')], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    expect(got?.['created_after']).toBe(Date.parse('2026-11-04T00:00:00Z'));
    const started = events.find((e) => e.t === 'step.started');
    expect(started && started.t === 'step.started' ? started.resolvedParams?.[0]?.['created_after'] : undefined).toBe(Date.parse('2026-11-04T00:00:00Z'));
    // the second model call's request body carries the tool result with the echo
    const followUp = seen.bodies[1] ?? '';
    expect(followUp).toContain('created_after');
    expect(followUp).toContain('2026-11-04T00:00:00');
  });
});

describe('runLoopTurn — confirmation gate', () => {
  const bulk = () =>
    buildRegistry([[action('invoices.send_reminders', 'bulk', async () => ({ sent: 165 }))]], []);

  it('approved: handler invoked exactly once after confirmation.resolved', async () => {
    let invocations = 0;
    const registry = buildRegistry([[action('invoices.send_reminders', 'bulk', async () => { invocations += 1; return { sent: 165 }; })]], []);
    const events = await drive(registry, 'send reminders', [
      toolCallResponse('invoices__send_reminders', { ids: ['inv_1', 'inv_2'] }),
      textResponse('Sent reminders.'),
    ]);
    expect(invocations).toBe(1);
    const types = typesOf(events);
    expect(types).toContain('confirmation.required');
    expect(types).toContain('confirmation.resolved');
    expect(types.indexOf('confirmation.required')).toBeLessThan(types.indexOf('step.started'));
    expect(completedOf(events).status).toBe('done');
  });

  it('denied: handler never invoked, DENIED observation fed back, status cancelled with zero writes', async () => {
    let invocations = 0;
    const registry = buildRegistry([[action('invoices.send_reminders', 'bulk', async () => { invocations += 1; return { sent: 165 }; })]], []);
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'send reminders',
      sessionDeps: {
        registry, crm: fakeCrm, refs, eventLog, confirm: denyAll,
        testFetch: scriptedFetch([toolCallResponse('invoices__send_reminders', {}), textResponse('Okay — I did not send anything.')], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    expect(invocations).toBe(0);
    const followUp = seen.bodies[1] ?? '';
    expect(followUp).toContain('DENIED');
    expect(followUp).toContain('NOT executed');
    expect(completedOf(events).status).toBe('cancelled');
    expect(finalOf(events)).toBe('Okay — I did not send anything.');
    expect(typesOf(events)).not.toContain('step.started');
  });

  it('gate description pluralizes without double-s', async () => {
    const registry = buildRegistry([[{ ...action('tasks.cancel_task', 'bulk', async () => ({})), entities: ['tasks'] }]], []);
    const events = await drive(registry, 'cancel tasks', [
      toolCallResponse('tasks__cancel_task', { ids: ['t1', 't2', 't3', 't4'] }),
      textResponse('Cancelled.'),
    ]);
    const req = events.find((e) => e.t === 'confirmation.required');
    const description = req && req.t === 'confirmation.required' ? req.scope.description : '';
    expect(description).toContain('4 tasks');
    expect(description).not.toContain('taskss');
  });
});

describe('runLoopTurn — honest exits', () => {
  const registry = () => buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);

  it('session__ask_user ends the turn with status clarify and the question verbatim', async () => {
    const events = await drive(registry(), 'reschedule Lucia Kims appointment', [
      toolCallResponse('session__ask_user', { question: 'Which Lucia Kim do you mean? There are 8.' }),
    ]);
    expect(completedOf(events).status).toBe('clarify');
    expect(finalOf(events)).toBe('Which Lucia Kim do you mean? There are 8.');
  });

  it('session__refuse ends the turn with status refused and the specific reason', async () => {
    const events = await drive(registry(), 'tag all leads as hot', [
      toolCallResponse('session__refuse', { reason: 'There is no action for tagging leads in this CRM.' }),
    ]);
    expect(completedOf(events).status).toBe('refused');
    expect(finalOf(events)).toBe('There is no action for tagging leads in this CRM.');
  });
});

describe('runLoopTurn — ref data tools', () => {
  function refsWithRows(rows: Record<string, unknown>[], complete: boolean): RefStore {
    return {
      put: refs.put.bind(refs),
      get: refs.get.bind(refs),
      resolve: () => ({ ids: rows.map((r) => String(r['id'])), missing: 0, total: rows.length }),
      hydrate: (): HydrateResult => ({ rows, complete, total: rows.length }),
      markAllStale: () => {},
    };
  }

  const rows = Array.from({ length: 60 }, (_, i) => ({ id: `opp_${i}`, value_cents: (i + 1) * 100 }));

  it('data__sort_ref returns the true max row from the hydrated full set', async () => {
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'biggest opportunity',
      sessionDeps: {
        registry: buildRegistry([[action('opportunities.search', 'read', async () => ({ items: [], total: 60 }))]], []),
        crm: fakeCrm, refs: refsWithRows(rows, true), eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('data__sort_ref', { ref: 'r_t1_s1', field: 'value_cents', direction: 'desc', limit: 1 }),
          textResponse('The biggest is opp_59.'),
        ], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const followUp = seen.bodies[1] ?? '';
    expect(followUp).toContain('opp_59');
    expect(followUp).toContain('6000');
    expect(completedOf(events).status).toBe('done');
  });

  it('data__aggregate_ref computes a true average, not the sum', async () => {
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'average value',
      sessionDeps: {
        registry: buildRegistry([[action('opportunities.search', 'read', async () => ({ items: [], total: 60 }))]], []),
        crm: fakeCrm, refs: refsWithRows(rows, true), eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('data__aggregate_ref', { ref: 'r_t1_s1', field: 'value_cents', op: 'avg' }),
          textResponse('Average is $30.50.'),
        ], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const followUp = seen.bodies[1] ?? '';
    // avg of 100..6000 step 100 = 3050
    expect(followUp).toContain('3050');
    expect(followUp).not.toContain('183000');
  });

  it('incomplete handles produce an honest refusal observation, no rows', async () => {
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'biggest',
      sessionDeps: {
        registry: buildRegistry([[action('opportunities.search', 'read', async () => ({ items: [], total: 60 }))]], []),
        crm: fakeCrm, refs: refsWithRows(rows.slice(0, 20), false), eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('data__sort_ref', { ref: 'r_t1_s1', field: 'value_cents', direction: 'desc', limit: 1 }),
          textResponse('Cannot answer exactly.'),
        ], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const followUp = seen.bodies[1] ?? '';
    expect(followUp).toMatch(/incomplete/i);
    expect(followUp).not.toContain('opp_19');
  });
});

describe('runLoopTurn — catalog search escape hatch', () => {
  it('returns rendered cards without any registry dispatch', async () => {
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'do something unusual',
      sessionDeps: {
        registry, crm: fakeCrm, refs, eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('catalog__search_actions', { query: 'search leads' }),
          textResponse('Okay.'),
        ], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    expect(typesOf(events)).not.toContain('step.started');
    expect(completedOf(events).status).toBe('done');
  });
});

describe('StuckTracker', () => {
  it('escalates ok -> ok -> hint -> stop for identical action+error', () => {
    const tracker = new StuckTracker();
    expect(tracker.record('leads.update', 'VALIDATION')).toBe('ok');
    expect(tracker.record('leads.update', 'VALIDATION')).toBe('ok');
    expect(tracker.record('leads.update', 'VALIDATION')).toBe('hint');
    expect(tracker.record('leads.update', 'VALIDATION')).toBe('stop');
  });

  it('different error codes track separately', () => {
    const tracker = new StuckTracker();
    tracker.record('leads.update', 'VALIDATION');
    tracker.record('leads.update', 'VALIDATION');
    expect(tracker.record('leads.update', 'NOT_FOUND')).toBe('ok');
  });
});

describe('runLoopTurn — loop safety', () => {
  it('four identical failing calls finalize failed with an honest message', async () => {
    const registry = buildRegistry(
      [[action('leads.update_lead', 'write', async () => { throw new ActionError('VALIDATION', 'bad field'); })]],
      [],
    );
    const events = await drive(registry, 'update the lead', [
      toolCallResponse('leads__update_lead', { id: 'l1' }),
    ]);
    expect(completedOf(events).status).toBe('failed');
    expect(finalOf(events)).toMatch(/same error|repeatedly|stuck/i);
    expect(events.filter((e) => e.t === 'step.failed').length).toBeGreaterThanOrEqual(3);
  });

  it('step cap finalizes failed honestly without burning the full deadline', async () => {
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
    let n = 0;
    const script = () => toolCallResponse('leads__search_leads', { query: `q${n++}` });
    const events = await drive(
      registry,
      'loop forever',
      Array.from({ length: 13 }, script),
      {},
      { budget: { maxTurns: 3, deadlineMs: 30_000 } },
    );
    expect(completedOf(events).status).toBe('failed');
    expect(finalOf(events)).toMatch(/could not finish|step limit/i);
  });

  it('deadline breach finalizes failed honestly', async () => {
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
    const slowScript = [textResponse('late')];
    const seen: Seen = { bodies: [] };
    let first = true;
    const slowFetch: typeof fetch = (async (_i: string | URL | Request, init?: RequestInit) => {
      if (seen && init?.body) seen.bodies.push(String(init.body));
      if (first) { first = false; await new Promise((r) => setTimeout(r, 1200)); }
      return new Response(JSON.stringify(slowScript[0]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'hello',
      sessionDeps: { registry, crm: fakeCrm, refs, eventLog, confirm: approveAll, testFetch: slowFetch },
      budget: { maxTurns: 3, deadlineMs: 150 },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    expect(completedOf(events).status).toBe('failed');
    expect(finalOf(events)).toMatch(/time|deadline/i);
  });
});
