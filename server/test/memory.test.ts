import { describe, it, expect } from 'vitest';
import {
  foldMemory,
  renderWorkingState,
  maskTurns,
  rewriteQuery,
  emptyWorkingState,
  type WorkingState,
  type RefHandle,
  type TurnTranscript,
} from '../src/agent/memory';
import type { Event } from '../src/events/types';

function ev(e: Event): Event {
  return e;
}

function handle(overrides: Partial<RefHandle> & { ref: string }): RefHandle {
  return {
    action: 'leads.search_leads',
    turnId: '1',
    entityType: 'leads',
    total: 1,
    idList: [],
    sample: [],
    ...overrides,
  };
}

describe('foldMemory — starts from the latest memory.snapshot', () => {
  it('rebuilds frame + handles from events AFTER the snapshot, ignoring events before it', () => {
    const snapshotState: WorkingState = {
      frame: { intent: 'old intent', status: 'active', filters: {}, missingParams: [] },
      entities: {},
      handles: [handle({ ref: 'r_t1_s1', total: 99 })],
    };

    const events: Event[] = [
      // Before the snapshot — must be ignored entirely.
      ev({ t: 'turn.started', turnId: '1', sessionId: 'sess_1', userText: 'old stuff', ts: 0 }),
      ev({ t: 'memory.snapshot', turnId: '1', state: snapshotState }),
      // After the snapshot.
      ev({
        t: 'plan.ready',
        turnId: '2',
        outcome: { kind: 'plan', plan: { goal: 'follow up on overdue invoices', steps: [] } },
        planRev: 0,
        planHash: 'hash_2',
        llm: { model: 'm', tokensIn: 1, tokensOut: 1, tokensCached: 0, costUsd: 0, latencyMs: 1, attempt: 1 },
      }),
      ev({ t: 'step.started', turnId: '2', stepId: 's1', action: 'invoices.list_overdue_invoices' }),
      ev({
        t: 'step.finished',
        turnId: '2',
        stepId: 's1',
        summary: 'invoices.list_overdue_invoices: 42 invoices',
        resultRef: 'r_t2_s1',
        ms: 5,
      }),
    ];

    const state = foldMemory(events);

    expect(state.frame?.intent).toBe('follow up on overdue invoices');
    expect(state.frame?.status).toBe('active');
    // The snapshot's old handle is carried forward (newest-first ordering
    // puts the NEW handle in front), and the new handle's action/entityType
    // were recovered from the matching step.started, total from the summary.
    expect(state.handles[0]?.ref).toBe('r_t2_s1');
    expect(state.handles[0]?.action).toBe('invoices.list_overdue_invoices');
    expect(state.handles[0]?.entityType).toBe('invoices');
    expect(state.handles[0]?.total).toBe(42);
    expect(state.handles[1]?.ref).toBe('r_t1_s1');
  });

  it('caps handles at 6, newest-first, even with 8 post-snapshot handle-producing steps', () => {
    const events: Event[] = [ev({ t: 'memory.snapshot', turnId: '0', state: emptyWorkingState() })];
    for (let i = 1; i <= 8; i += 1) {
      events.push(ev({ t: 'step.started', turnId: '1', stepId: `s${i}`, action: 'leads.search_leads' }));
      events.push(
        ev({
          t: 'step.finished',
          turnId: '1',
          stepId: `s${i}`,
          summary: `leads.search_leads: ${i} leads`,
          resultRef: `r_t1_s${i}`,
          ms: 1,
        }),
      );
    }

    const state = foldMemory(events);

    expect(state.handles).toHaveLength(6);
    // Newest-first: the LAST handle added (s8) is at index 0.
    expect(state.handles[0]?.ref).toBe('r_t1_s8');
    expect(state.handles[5]?.ref).toBe('r_t1_s3');
  });

  it('marks the frame completed on turn.completed status "done", carries entities forward unchanged', () => {
    const snapshotState: WorkingState = {
      frame: { intent: 'do the thing', status: 'active', filters: { source: null }, missingParams: [] },
      entities: { 'the facebook campaign': { id: 'camp_1', type: 'campaign', name: 'Facebook Q4', source: 'turn 1', turn: '1' } },
      handles: [],
    };
    const events: Event[] = [
      ev({ t: 'memory.snapshot', turnId: '1', state: snapshotState }),
      ev({
        t: 'turn.completed',
        turnId: '2',
        status: 'done',
        metrics: {
          ttfurMs: 1,
          totalMs: 1,
          llmCalls: 1,
          repairs: 0,
          replans: 0,
          searchRounds: 0,
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          stepsOk: 1,
          stepsFailed: 0,
        },
      }),
    ];

    const state = foldMemory(events);

    expect(state.frame?.status).toBe('completed');
    expect(state.entities['the facebook campaign']?.id).toBe('camp_1');
  });

  it('with no memory.snapshot in the list at all, folds from an empty state', () => {
    const events: Event[] = [
      ev({ t: 'turn.started', turnId: '1', sessionId: 'sess_1', userText: 'hi', ts: 0 }),
    ];
    expect(foldMemory(events)).toEqual(emptyWorkingState());
  });

  it('accepts SeqEvent[] (the EventLog.list shape) transparently', () => {
    const seqEvents = [
      { seq: 1, event: ev({ t: 'memory.snapshot', turnId: '0', state: emptyWorkingState() }) },
      {
        seq: 2,
        event: ev({
          t: 'plan.ready',
          turnId: '1',
          outcome: { kind: 'plan', plan: { goal: 'do X', steps: [] } },
          planRev: 0,
          planHash: 'h',
          llm: { model: 'm', tokensIn: 1, tokensOut: 1, tokensCached: 0, costUsd: 0, latencyMs: 1, attempt: 1 },
        }),
      },
    ];
    const state = foldMemory(seqEvents);
    expect(state.frame?.intent).toBe('do X');
  });
});

describe('renderWorkingState — token-budget sanity', () => {
  it('renders a full state (frame + several entities + 6 handles) under 800 tokens (~4 chars/token)', () => {
    const state: WorkingState = {
      frame: {
        intent: 'assign and follow up on unreplied unbooked leads from last week',
        status: 'active',
        filters: { source: 'facebook', created_after: '2026-10-26' },
        missingParams: [],
      },
      entities: {
        'the facebook campaign': { id: 'camp_1', type: 'campaign', name: 'Facebook Q4', source: 'turn 1', turn: '1' },
        'jane doe': { id: 'contact_42', type: 'contact', name: 'Jane Doe', source: 'turn 2', turn: '2' },
      },
      handles: Array.from({ length: 6 }, (_, i) =>
        handle({ ref: `r_t3_s${i + 1}`, total: 100 + i, entityType: 'leads', action: 'leads.search_leads', turnId: '3' }),
      ),
    };

    const text = renderWorkingState(state);
    const approxTokens = text.length / 4;

    expect(approxTokens).toBeLessThan(800);
    expect(text).toContain('WORKING_STATE:');
    expect(text).toContain('frame:');
    expect(text).toContain('jane doe');
    expect(text).toContain('$r_t3_s1');
  });

  it('renders an empty state compactly with explicit "(none)" markers', () => {
    const text = renderWorkingState(emptyWorkingState());
    expect(text).toContain('frame: (none)');
    expect(text).toContain('entities: (none)');
    expect(text).toContain('handles: (none)');
  });
});

describe('maskTurns — older tool results collapse, recent turns stay verbatim', () => {
  const turns: TurnTranscript[] = [
    { turnId: '1', userText: 'find overdue invoices', steps: [{ summary: 'invoices.list_overdue_invoices: 42 invoices' }] },
    { turnId: '2', userText: 'send reminders', steps: [{ summary: 'invoices.send_invoice_reminder: 42 record(s)' }] },
    { turnId: '3', userText: 'now show me leads', steps: [{ summary: 'leads.search_leads: 5 leads' }] },
    { turnId: '4', userText: 'assign them to reps', steps: [{ summary: 'leads.assign_lead_owner: 5 record(s)' }] },
  ];

  it('masks turns older than keepLastN to one one-liner each, keeps the last N verbatim', () => {
    const text = maskTurns(turns, 2);

    expect(text).toContain('TURN 1 (result): 1 step(s) — invoices.list_overdue_invoices: 42 invoices');
    expect(text).toContain('TURN 2 (result): 1 step(s) —');
    // Recent turns (3, 4) use the verbatim "(step)" rendering, not "(result)".
    expect(text).toContain('TURN 3 (step): leads.search_leads: 5 leads');
    expect(text).toContain('TURN 4 (step): leads.assign_lead_owner: 5 record(s)');
    expect(text).not.toContain('TURN 3 (result)');
  });
});

describe('rewriteQuery — deterministic anaphora rewriting (no LLM)', () => {
  const frame: WorkingState['frame'] = {
    intent: 'follow-up tasks for last week leads',
    status: 'active',
    filters: { source: null },
    missingParams: [],
  };
  const state: WorkingState = { frame, entities: {}, handles: [handle({ ref: 'r_t3_s1', total: 42 })] };

  it('prefixes with the frame intent when the message carries an anaphora signal', () => {
    const rewritten = rewriteQuery('only the Facebook ones', state);
    expect(rewritten).toContain('follow-up tasks for last week leads');
    expect(rewritten).toContain('only the Facebook ones');
  });

  it('is a pure passthrough when there is no anaphora signal', () => {
    expect(rewriteQuery('create a new contact named Jane Doe', state)).toBe('create a new contact named Jane Doe');
  });

  it('is a passthrough when there is an anaphora signal but no active frame', () => {
    expect(rewriteQuery('only the Facebook ones', emptyWorkingState())).toBe('only the Facebook ones');
  });

  it('is a passthrough when the frame exists but is completed, not active', () => {
    const completedState: WorkingState = { ...state, frame: { ...frame, status: 'completed' } };
    expect(rewriteQuery('only the Facebook ones', completedState)).toBe('only the Facebook ones');
  });
});
