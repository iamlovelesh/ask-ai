import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runLoopTurn, type LoopSessionDeps, type RunLoopTurnInput } from '../src/loop/agent';
import { StuckTracker } from '../src/loop/tools';
import { widenForModel } from '../src/loop/date-rail';
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

describe('runLoopTurn — null-optional scrub (round-5 F31/F32 root)', () => {
  it('drops null values for optional params instead of failing validation or inventing', async () => {
    let got: Record<string, unknown> | undefined;
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async (input) => { got = input; return { items: [], total: 0 }; },
        z.object({ query: z.string().optional(), status: z.string().optional(), limit: z.number().optional() }))]],
      [],
    );
    await drive(registry, 'all leads', [
      toolCallResponse('leads__search_leads', { query: null as unknown as string, status: null as unknown as string, limit: 50 }),
      textResponse('ok'),
    ]);
    expect(got).toEqual({ limit: 50 });
  });

  it('model-facing schema allows null on optional enum fields (so models never invent values)', () => {
    const schema = z.object({ priority: z.enum(['low', 'high']).optional(), id: z.string() });
    const wide = widenForModel(schema);
    expect(wide.safeParse({ priority: null, id: 'x' }).success).toBe(true);
    expect(wide.safeParse({ priority: 'low', id: 'x' }).success).toBe(true);
    expect(wide.safeParse({ priority: 'purple', id: 'x' }).success).toBe(false);
  });
});

describe('runLoopTurn — write-id provenance firewall (round-5 support CRITICAL)', () => {
  it('rejects a write whose id-shaped target never appeared in any observation or user text', async () => {
    let invoked = 0;
    const registry = buildRegistry(
      [[
        action('tasks.search_tasks', 'read', async () => ({ items: [{ id: 'task_55' }], total: 1 })),
        action('tasks.set_task_due_date', 'write', async () => { invoked += 1; return {}; }, z.object({ id: z.string(), due_at: z.union([z.number(), z.string()]) })),
      ]],
      [],
    );
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'fix the due date on my task',
      sessionDeps: {
        registry, crm: fakeCrm, refs, eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('tasks__search_tasks', {}),
          toolCallResponse('tasks__set_task_due_date', { id: 'task_1', due_at: '2026-11-06T00:00:00Z' }),
          toolCallResponse('tasks__set_task_due_date', { id: 'task_55', due_at: '2026-11-06T00:00:00Z' }),
          textResponse('Fixed.'),
        ], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    expect(invoked).toBe(1); // task_1 (hallucinated) blocked; task_55 (seen in results) allowed
    const obs = seen.bodies[2] ?? '';
    expect(obs).toMatch(/task_1.*(never appeared|not seen|look it up|search)/i);
  });

  it('allows a write to an id the USER typed', async () => {
    let invoked = 0;
    const registry = buildRegistry(
      [[action('tasks.set_task_due_date', 'write', async () => { invoked += 1; return {}; }, z.object({ id: z.string() }))]],
      [],
    );
    await drive(registry, 'set due date on task_77', [
      toolCallResponse('tasks__set_task_due_date', { id: 'task_77' }),
      textResponse('ok'),
    ]);
    expect(invoked).toBe(1);
  });
});

describe('runLoopTurn — identity param substitution (round-4 billing C1)', () => {
  it("replaces literal 'me' in *_user_id/assignee/owner params with the acting user id", async () => {
    let got: Record<string, unknown> | undefined;
    const registry = buildRegistry(
      [[action('appointments.search', 'read', async (input) => { got = input; return { items: [], total: 0 }; },
        z.object({ host_user_id: z.string().optional(), assignee_id: z.string().optional() }))]],
      [],
    );
    await drive(registry, 'my appointments today', [
      toolCallResponse('appointments__search', { host_user_id: 'me', assignee_id: 'current_user' }),
      textResponse('ok'),
    ]);
    expect(got).toEqual({ host_user_id: 'user_1', assignee_id: 'user_1' });
  });
});

describe('runLoopTurn — wildcard filter scrub (round-4 F24)', () => {
  it("drops '*'/'all'/'any'/'' placeholder values from optional params before dispatch", async () => {
    let got: Record<string, unknown> | undefined;
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async (input) => { got = input; return { items: [], total: 0 }; },
        z.object({ query: z.string().optional(), status: z.string().optional(), source: z.string().optional(), limit: z.number().optional() }))]],
      [],
    );
    const events = await drive(registry, 'show all leads', [
      toolCallResponse('leads__search_leads', { query: '*', status: 'all', source: 'ANY', limit: 50 }),
      textResponse('Found them.'),
    ]);
    expect(got).toEqual({ limit: 50 });
    const started = events.find((e) => e.t === 'step.started');
    expect(started && started.t === 'step.started' ? started.resolvedParams?.[0] : undefined).toEqual({ limit: 50 });
  });

  it('leaves legitimate values untouched', async () => {
    let got: Record<string, unknown> | undefined;
    const registry = buildRegistry(
      [[action('leads.search_leads', 'read', async (input) => { got = input; return { items: [], total: 0 }; },
        z.object({ status: z.string().optional() }))]],
      [],
    );
    await drive(registry, 'new leads', [
      toolCallResponse('leads__search_leads', { status: 'new' }),
      textResponse('ok'),
    ]);
    expect(got).toEqual({ status: 'new' });
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

describe('runLoopTurn — observation rendering rails (round-4 support findings)', () => {
  it('renders date-shaped epoch fields as ISO strings in observations so the model never hand-converts', async () => {
    const registry = buildRegistry(
      [[action('tickets.search', 'read', async () => ({ items: [{ id: 't1', created_at: 1781344800000 }], total: 1 }))]],
      [],
    );
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'oldest ticket',
      sessionDeps: { registry, crm: fakeCrm, refs, eventLog, confirm: approveAll, testFetch: scriptedFetch([toolCallResponse('tickets__search', {}), textResponse('ok')], seen) },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const obs = seen.bodies[1] ?? '';
    expect(obs).toContain('2026-06-13');
    expect(obs).not.toContain('1781344800000');
  });

  it('mints a ref for complete inline list results so aggregate/sort/filter work on small sets too', async () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ id: `inv_${i}`, total_cents: (i + 1) * 100 }));
    const registry = buildRegistry([[action('invoices.search', 'read', async () => ({ items: rows, total: 14 }))]], []);
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: 't_9', userText: 'how much is owed',
      sessionDeps: { registry, crm: fakeCrm, refs, eventLog, confirm: approveAll, testFetch: scriptedFetch([toolCallResponse('invoices__search', {}), textResponse('ok')], seen) },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const obs = seen.bodies[1] ?? '';
    expect(obs).toMatch(/\[ref r_t9_s1\]/);
    const handle = refs.get('r_t9_s1');
    expect(handle?.idList).toHaveLength(14);
    expect(handle?.total).toBe(14);
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

  it('singular count with a plural entity noun reads naturally', async () => {
    const registry = buildRegistry([[{ ...action('invoices.send_reminder', 'bulk', async () => ({})), entities: ['invoices'] }]], []);
    const events = await drive(registry, 'remind inv_1', [
      toolCallResponse('invoices__send_reminder', { id: 'inv_1' }),
      textResponse('ok'),
    ]);
    const req = events.find((e) => e.t === 'confirmation.required');
    const description = req && req.t === 'confirmation.required' ? req.scope.description : '';
    expect(description).toContain('1 invoice');
    expect(description).not.toContain('1 invoices');
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

describe('runLoopTurn — deterministic status inference', () => {
  it('a question-shaped answer WITHOUT a trailing question mark still completes as clarify', async () => {
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
    const events = await drive(registry, 'add a note to the contact', [
      textResponse('I need to clarify which contact you mean. Could you provide either:\n- the name\n- the email'),
    ]);
    expect(completedOf(events).status).toBe('clarify');
  });

  it('a plain-text final answer that is a question completes as clarify', async () => {
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
    const events = await drive(registry, 'reschedule the appointment', [
      textResponse('Which Lucia Kim do you mean — there are 8 contacts with that name?'),
    ]);
    expect(completedOf(events).status).toBe('clarify');
  });

  it('a turn with failed steps and zero successes completes as failed', async () => {
    const registry = buildRegistry(
      [[action('invoices.record_payment', 'write', async () => { throw new ActionError('NOT_FOUND', 'no such invoice'); })]],
      [],
    );
    const events = await drive(registry, 'record a payment', [
      toolCallResponse('invoices__record_payment', { id: 'inv_999' }),
      textResponse('I was unable to record the payment — the invoice was not found.'),
    ]);
    expect(completedOf(events).status).toBe('failed');
    expect(finalOf(events)).toContain('unable');
  });

  it('a successful turn whose answer merely mentions an earlier retry stays done', async () => {
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [{ id: 'l1' }], total: 1 }))]], []);
    const events = await drive(registry, 'find leads', [
      toolCallResponse('leads__search_leads', { query: 'x' }),
      textResponse('Found 1 lead.'),
    ]);
    expect(completedOf(events).status).toBe('done');
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

  it('data__aggregate_ref supports subtract_field for owed-style derived metrics (round-5 billing F1)', async () => {
    const owedRows = Array.from({ length: 4 }, (_, i) => ({ id: `inv_${i}`, total_cents: 1000, amount_paid_cents: 250 }));
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'average owed',
      sessionDeps: {
        registry: buildRegistry([[action('invoices.search', 'read', async () => ({ items: [], total: 4 }))]], []),
        crm: fakeCrm,
        refs: {
          put: refs.put.bind(refs), get: refs.get.bind(refs),
          resolve: () => ({ ids: owedRows.map((r) => r.id), missing: 0, total: 4 }),
          hydrate: (): HydrateResult => ({ rows: owedRows, complete: true, total: 4 }),
          markAllStale: () => {},
        },
        eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('data__aggregate_ref', { ref: 'r_t1_s1', field: 'total_cents', subtract_field: 'amount_paid_cents', op: 'avg' }),
          textResponse('$7.50'),
        ], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const obs = seen.bodies[1] ?? '';
    expect(obs).toContain('750'); // avg of (1000-250)
    expect(obs).not.toContain('1000');
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

describe('runLoopTurn — spill-to-ref full-set hydration (C1)', () => {
  it('a spill carrying idList hydrates complete through the REAL ref store and sort_ref answers exactly', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: `opp_${i}`, value_cents: (i + 1) * 100 }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const realTx: StoreTx = {
      all: (sql: string, params?: unknown[]) =>
        (params ?? []).map((id) => byId.get(String(id))).filter((r): r is { id: string; value_cents: number } => r !== undefined),
      get: () => undefined,
      run: () => ({ changes: 0 }),
    };
    const crmWithRows: Crm = { tx: (fn) => fn(realTx), close: () => {} };
    const spillAction = {
      ...action('opportunities.search_opportunities', 'read', async () => ({
        __spill: true,
        total: 60,
        sample: rows.slice(0, 20),
        idList: rows.map((r) => r.id),
      })),
      entities: ['opportunities'],
    };
    const registry = buildRegistry([[spillAction]], []);
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: 't_1', userText: 'which opportunity is biggest',
      sessionDeps: {
        registry, crm: crmWithRows, refs, eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('opportunities__search_opportunities', {}),
          toolCallResponse('data__sort_ref', { ref: 'r_t1_s1', field: 'value_cents', direction: 'desc', limit: 1 }),
          textResponse('The biggest is opp_59 at $60.00.'),
        ], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const sortObservation = seen.bodies[2] ?? '';
    expect(sortObservation).toContain('opp_59');
    expect(sortObservation).toContain('6000');
    expect(sortObservation).not.toMatch(/incomplete/i);
    expect(completedOf(events).status).toBe('done');
  });
});

describe('runLoopTurn — sort_ref typed ordering (I8)', () => {
  const stringRows = [
    { id: 'a', name: 'Zoe' }, { id: 'b', name: 'Anna' }, { id: 'c', name: 'Mia' },
  ];
  function refsWith(rows: Record<string, unknown>[]): RefStore {
    return {
      put: refs.put.bind(refs), get: refs.get.bind(refs),
      resolve: () => ({ ids: rows.map((r) => String(r['id'])), missing: 0, total: rows.length }),
      hydrate: (): HydrateResult => ({ rows, complete: true, total: rows.length }),
      markAllStale: () => {},
    };
  }

  it('sorts string fields lexicographically instead of returning NaN order', async () => {
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'first contact alphabetically',
      sessionDeps: {
        registry: buildRegistry([[action('contacts.search', 'read', async () => ({ items: [], total: 3 }))]], []),
        crm: fakeCrm, refs: refsWith(stringRows), eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('data__sort_ref', { ref: 'r_t1_s1', field: 'name', direction: 'asc', limit: 1 }),
          textResponse('Anna.'),
        ], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const obs = seen.bodies[1] ?? '';
    expect(obs).toContain('Anna');
    expect(obs).not.toContain('Zoe');
  });

  it('a field absent from every row gets an honest error, not a confident sort', async () => {
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'sort by ghost field',
      sessionDeps: {
        registry: buildRegistry([[action('contacts.search', 'read', async () => ({ items: [], total: 3 }))]], []),
        crm: fakeCrm, refs: refsWith(stringRows), eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('data__sort_ref', { ref: 'r_t1_s1', field: 'value_cents', direction: 'desc', limit: 1 }),
          textResponse('ok'),
        ], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const obs = seen.bodies[1] ?? '';
    expect(obs).not.toMatch(/Sorted 3 records/);
    expect(obs).toMatch(/no .*values|not present|missing/i);
  });
});

describe('runLoopTurn — data__filter_ref', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: `con_${i}`, last_activity_at: i * 1000, status: i % 2 === 0 ? 'open' : 'closed' }));
  function refsWithHydrate(): RefStore {
    const put = refs.put.bind(refs);
    return {
      put, get: refs.get.bind(refs),
      resolve: () => ({ ids: rows.map((r) => String(r.id)), missing: 0, total: rows.length }),
      hydrate: (): HydrateResult => ({ rows, complete: true, total: rows.length }),
      markAllStale: () => {},
    };
  }

  it('filters the complete set server-side and reports the exact count', async () => {
    const seen: Seen = { bodies: [] };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'contacts inactive since x',
      sessionDeps: {
        registry: buildRegistry([[action('contacts.search', 'read', async () => ({ items: [], total: 60 }))]], []),
        crm: fakeCrm, refs: refsWithHydrate(), eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('data__filter_ref', { ref: 'r_t1_s1', field: 'last_activity_at', op: 'lt', value: 10_000 }),
          textResponse('10 inactive contacts.'),
        ], seen),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    const obs = seen.bodies[1] ?? '';
    expect(obs).toContain('10');
    expect(obs).toMatch(/matched/i);
    expect(completedOf(events).status).toBe('done');
  });
});

describe('runLoopTurn — data__apply_to_ref bulk writes (round-4 billing)', () => {
  it('applies a write action to every record behind a ref through ONE confirmation gate', async () => {
    const rows = Array.from({ length: 165 }, (_, i) => ({ id: `inv_${i}` }));
    let handlerCalls = 0;
    const sendAction = action('invoices.send_invoice_reminder', 'write', async () => { handlerCalls += 1; return { sent: 1 }; },
      z.object({ id: z.string() }));
    const registry = buildRegistry([[sendAction]], []);
    const refsWith: RefStore = {
      put: refs.put.bind(refs), get: () => ({ ref: 'r_t1_s1', action: 'x', turnId: 't_1', stepId: 's1', entityType: 'invoices', total: rows.length, idList: rows.map((r) => r.id), sample: rows.slice(0, 20), createdAt: 0, stale: false } as ReturnType<RefStore['get']> & object),
      resolve: () => ({ ids: rows.map((r) => r.id), missing: 0, total: rows.length }),
      hydrate: (): HydrateResult => ({ rows, complete: true, total: rows.length }),
      markAllStale: () => {},
    };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'send reminders for all overdue',
      sessionDeps: {
        registry, crm: fakeCrm, refs: refsWith, eventLog, confirm: approveAll,
        testFetch: scriptedFetch([
          toolCallResponse('data__apply_to_ref', { ref: 'r_t1_s1', action: 'invoices__send_invoice_reminder', id_param: 'id' }),
          textResponse('Sent 165 reminders.'),
        ]),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    expect(handlerCalls).toBe(165);
    const req = events.find((e) => e.t === 'confirmation.required');
    expect(req && req.t === 'confirmation.required' ? req.scope.affectedCount : 0).toBe(165);
    expect(events.filter((e) => e.t === 'confirmation.required')).toHaveLength(1);
    expect(completedOf(events).status).toBe('done');
  });

  it('denied apply_to_ref never invokes the handler', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `inv_${i}` }));
    let handlerCalls = 0;
    const sendAction = action('invoices.send_invoice_reminder', 'write', async () => { handlerCalls += 1; return {}; }, z.object({ id: z.string() }));
    const registry = buildRegistry([[sendAction]], []);
    const refsWith: RefStore = {
      put: refs.put.bind(refs), get: refs.get.bind(refs),
      resolve: () => ({ ids: rows.map((r) => r.id), missing: 0, total: rows.length }),
      hydrate: (): HydrateResult => ({ rows, complete: true, total: rows.length }),
      markAllStale: () => {},
    };
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'send reminders',
      sessionDeps: {
        registry, crm: fakeCrm, refs: refsWith, eventLog, confirm: denyAll,
        testFetch: scriptedFetch([
          toolCallResponse('data__apply_to_ref', { ref: 'r_t1_s1', action: 'invoices__send_invoice_reminder', id_param: 'id' }),
          textResponse('Nothing sent.'),
        ]),
      },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    expect(handlerCalls).toBe(0);
    expect(completedOf(events).status).toBe('cancelled');
  });
});

describe('runLoopTurn — catalog search escape hatch', () => {
  it('BINDS discovered actions mid-run so the model can call them on the next step', async () => {
    // >24 actions (no full-bind); the needed action is neither session-used
    // nor found by text retrieval — only catalog__search_actions reaches it.
    const filler = Array.from({ length: 28 }, (_, i) =>
      action(`aa_mod${String(i).padStart(2, '0')}.noop`, 'read', async () => ({ items: [], total: 0 })));
    let created = 0;
    const createTask = action('zz_tasks.create_task', 'write', async () => { created += 1; return { id: 'task_1' }; });
    const registry = buildRegistry([[...filler, createTask]], []);
    const events = await drive(registry, 'make a follow-up task', [
      toolCallResponse('catalog__search_actions', { query: 'create task' }),
      toolCallResponse('zz_tasks__create_task', { title: 'Follow up' }),
      textResponse('Created the follow-up task.'),
    ]);
    expect(created).toBe(1);
    expect(completedOf(events).status).toBe('done');
    const started = events.filter((e) => e.t === 'step.started');
    expect(started.some((e) => e.t === 'step.started' && e.action === 'zz_tasks.create_task')).toBe(true);
  });

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

describe('runLoopTurn — transient retry rail', () => {
  it('retries a TRANSIENT handler failure once and succeeds', async () => {
    let n = 0;
    const registry = buildRegistry(
      [[action('invoices.send_reminder', 'write', async () => {
        n += 1;
        if (n === 1) throw new ActionError('TRANSIENT', 'blip');
        return { sent: 1 };
      })]],
      [],
    );
    const events = await drive(registry, 'send the reminder for inv_1', [
      toolCallResponse('invoices__send_reminder', { id: 'inv_1' }),
      textResponse('Reminder sent.'),
    ]);
    expect(n).toBe(2);
    expect(completedOf(events).status).toBe('done');
    expect(typesOf(events)).toContain('step.finished');
    expect(events.filter((e) => e.t === 'step.failed')).toHaveLength(0);
  });

  it('a TRANSIENT failure that persists after the retry surfaces as a failed step', async () => {
    let n = 0;
    const registry = buildRegistry(
      [[action('invoices.send_reminder', 'write', async () => { n += 1; throw new ActionError('TRANSIENT', 'blip'); })]],
      [],
    );
    const events = await drive(registry, 'send the reminder for inv_1', [
      toolCallResponse('invoices__send_reminder', { id: 'inv_1' }),
      textResponse('Could not send it.'),
    ]);
    expect(n).toBe(2);
    expect(events.filter((e) => e.t === 'step.failed')).toHaveLength(1);
  });
});

describe('runLoopTurn — follow-up tool binding (I10)', () => {
  it('binds actions used earlier in the session even when retrieval misses on terse follow-ups', async () => {
    // >24 actions so the full-bind shortcut does not apply; the needed
    // action sorts LAST alphabetically so a naive first-24 fallback drops it.
    const filler = Array.from({ length: 28 }, (_, i) =>
      action(`aa_mod${String(i).padStart(2, '0')}.noop`, 'read', async () => ({ items: [], total: 0 })));
    const reassign = action('zz_tickets.reassign_ticket', 'write', async () => ({ ok: true }));
    const registry = buildRegistry([[...filler, reassign]], []);
    // seed a prior completed turn that used the action
    const prior = `t_prior`;
    eventLog.append(sessionId, { t: 'turn.started', turnId: prior, sessionId, userText: 'reassign ticket 1 to Hana', ts: 1 } as Event);
    eventLog.append(sessionId, { t: 'step.started', turnId: prior, stepId: 's1', action: 'zz_tickets.reassign_ticket', resolvedParams: [{ id: 't1' }] } as Event);
    eventLog.append(sessionId, { t: 'answer.final', turnId: prior, text: 'Done.' } as Event);
    eventLog.append(sessionId, { t: 'turn.completed', turnId: prior, status: 'done', metrics: { ttfurMs: 1, totalMs: 1, llmCalls: 1, repairs: 0, replans: 0, searchRounds: 0, tokensIn: 1, tokensOut: 1, costUsd: 0, stepsOk: 1, stepsFailed: 0 } } as Event);

    const events = await drive(registry, 'now the oldest one too', [
      toolCallResponse('zz_tickets__reassign_ticket', { id: 't2' }),
      textResponse('Reassigned.'),
    ]);
    expect(completedOf(events).status).toBe('done');
    const started = events.filter((e) => e.t === 'step.started');
    expect(started.some((e) => e.t === 'step.started' && e.action === 'zz_tickets.reassign_ticket')).toBe(true);
  });
});

describe('StuckTracker', () => {
  it('escalates ok -> ok -> hint -> stop for identical action+error+params', () => {
    const tracker = new StuckTracker();
    expect(tracker.record('leads.update', 'VALIDATION', '{"id":"l1"}')).toBe('ok');
    expect(tracker.record('leads.update', 'VALIDATION', '{"id":"l1"}')).toBe('ok');
    expect(tracker.record('leads.update', 'VALIDATION', '{"id":"l1"}')).toBe('hint');
    expect(tracker.record('leads.update', 'VALIDATION', '{"id":"l1"}')).toBe('stop');
  });

  it('different error codes track separately', () => {
    const tracker = new StuckTracker();
    tracker.record('leads.update', 'VALIDATION', '{}');
    tracker.record('leads.update', 'VALIDATION', '{}');
    expect(tracker.record('leads.update', 'NOT_FOUND', '{}')).toBe('ok');
  });

  it('I7: DIFFERENT params on the same action+error are separate attempts, not a stuck loop', () => {
    const tracker = new StuckTracker();
    expect(tracker.record('leads.update', 'VALIDATION', '{"id":"l1"}')).toBe('ok');
    expect(tracker.record('leads.update', 'VALIDATION', '{"id":"l2"}')).toBe('ok');
    expect(tracker.record('leads.update', 'VALIDATION', '{"id":"l3"}')).toBe('ok');
    expect(tracker.record('leads.update', 'VALIDATION', '{"id":"l4"}')).toBe('ok');
  });
});

describe('runLoopTurn — finalize honesty (I1, I2)', () => {
  it('I1: budget exhaustion mid-turn reports progress, never claims nothing was requested', async () => {
    process.env['EVAL_BUDGET_USD'] = '0.000001'; // first metered call trips the cap on the SECOND call
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
    const events = await drive(registry, 'find leads', [
      toolCallResponse('leads__search_leads', { query: 'x' }),
      textResponse('never reached'),
    ]);
    delete process.env['EVAL_BUDGET_USD'];
    expect(completedOf(events).status).toBe('failed');
    const final = finalOf(events);
    expect(final).not.toMatch(/no request was made/i);
    expect(final).toMatch(/1 step|completed .*step|budget/i);
  });

  it('I2: unexpected internal errors never leak raw messages to the user', async () => {
    // a fetch that throws a non-retryable error with internal detail
    const explodingFetch: typeof fetch = (async () => {
      const err = new Error('sqlite I/O catastrophe at /private/db row 42 req_abc123') as Error & { status?: number };
      err.status = 400; // non-retryable
      throw err;
    }) as typeof fetch;
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => ({ items: [], total: 0 }))]], []);
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'find leads',
      sessionDeps: { registry, crm: fakeCrm, refs, eventLog, confirm: approveAll, testFetch: explodingFetch },
      budget: { maxTurns: 2, deadlineMs: 10_000 },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    expect(completedOf(events).status).toBe('failed');
    const final = finalOf(events);
    expect(final).not.toContain('sqlite');
    expect(final).not.toContain('req_abc123');
    expect(final).toMatch(/something went wrong|could not complete/i);
  });
});

describe('runLoopTurn — gate wait excluded from the deadline (round-4)', () => {
  it('a confirmation wait longer than the deadline does not fail the turn', async () => {
    const slowConfirm: ConfirmBroker = { request: () => new Promise((r) => setTimeout(() => r(true), 700)) };
    const registry = buildRegistry([[action('invoices.send_reminders', 'bulk', async () => ({ sent: 2 }))]], []);
    const events = await drive(
      registry,
      'send reminders',
      [toolCallResponse('invoices__send_reminders', { ids: ['a', 'b'] }), textResponse('Sent.')],
      { confirm: slowConfirm },
      { budget: { maxTurns: 4, deadlineMs: 400 } },
    );
    expect(completedOf(events).status).toBe('done');
    expect(finalOf(events)).toBe('Sent.');
  });
});

describe('runLoopTurn — cancellation (I4)', () => {
  it('an aborted cancelSignal stops the loop and finalizes cancelled', async () => {
    const cancel = new AbortController();
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => {
      cancel.abort(); // user cancels while a step is executing
      return { items: [], total: 0 };
    })]], []);
    const events: Event[] = [];
    const input: RunLoopTurnInput = {
      sessionId, turnId: `t_${randomUUID()}`, userText: 'find leads',
      sessionDeps: { registry, crm: fakeCrm, refs, eventLog, confirm: approveAll, testFetch: scriptedFetch([toolCallResponse('leads__search_leads', {}), textResponse('never')]), cancelSignal: cancel.signal },
    };
    for await (const ev of runLoopTurn(input)) events.push(ev);
    expect(completedOf(events).status).toBe('cancelled');
    expect(finalOf(events)).toMatch(/stopped|cancel/i);
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

  it('step cap finalizes failed honestly AND discloses work already done (round-4 billing C3)', async () => {
    let writes = 0;
    const registry = buildRegistry([[action('invoices.send_reminder', 'write', async () => { writes += 1; return { sent: 1 }; })]], []);
    let n = 0;
    const script = () => toolCallResponse('invoices__send_reminder', { id: `inv_${n++}` });
    const events = await drive(
      registry,
      'send them all: inv_0 inv_1 inv_2 inv_3 inv_4',
      Array.from({ length: 5 }, script),
      {},
      { budget: { maxTurns: 3, deadlineMs: 30_000 } },
    );
    expect(completedOf(events).status).toBe('failed');
    const final = finalOf(events);
    expect(final).toMatch(/could not finish|step limit/i);
    // real writes happened before the cap — the user MUST be told
    expect(final).toMatch(new RegExp(String(writes) + '.*(change|write|action|step)', 'i'));
  });

  it('deadline breach between model calls finalizes failed honestly', async () => {
    // New semantics: the deadline is ACTIVE time checked before each model
    // call (per-call hangs are bounded by modelSettings.timeoutMs); a slow
    // first step pushes the SECOND call past the deadline.
    const registry = buildRegistry([[action('leads.search_leads', 'read', async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { items: [], total: 0 };
    })]], []);
    const events = await drive(
      registry,
      'hello',
      [toolCallResponse('leads__search_leads', {}), textResponse('late')],
      {},
      { budget: { maxTurns: 3, deadlineMs: 150 } },
    );
    expect(completedOf(events).status).toBe('failed');
    expect(finalOf(events)).toMatch(/time|deadline/i);
  });
});
