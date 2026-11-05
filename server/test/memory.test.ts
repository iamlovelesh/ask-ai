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

  it('is idempotent: re-applying it to its own output returns the same string', () => {
    const once = rewriteQuery('only the Facebook ones', state);
    const twice = rewriteQuery(once, state);
    expect(twice).toBe(once);
  });

  it('is idempotent even though the rewritten output still contains the anaphora cue', () => {
    const once = rewriteQuery('it is the same one', state);
    // The anaphora signals ("it", "same") are still textually present in
    // the tail of `once` — the guard must still prevent a second prefix.
    expect(once).toMatch(/^follow-up tasks for last week leads/);
    expect(rewriteQuery(once, state)).toBe(once);
  });
});

// --- fix: clarify intent carryover (live-user-confirmed bug, sess_729a1899) -

const llmUsage = { model: 'm', tokensIn: 1, tokensOut: 1, tokensCached: 0, costUsd: 0, latencyMs: 1, attempt: 1 } as const;

function turnCompleted(turnId: string, status: 'done' | 'clarify' | 'refused' | 'failed' | 'cancelled'): Event {
  return {
    t: 'turn.completed',
    turnId,
    status,
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
      stepsOk: 0,
      stepsFailed: 0,
    },
  };
}

describe('foldMemory — a clarify turn does NOT clobber frame.intent/filters', () => {
  it('a prior plan.ready(plan) sets intent; a SUBSEQUENT clarify leaves it untouched, records pendingClarify, and a clarify-ending turn.completed keeps it', () => {
    const events: Event[] = [
      ev({ t: 'memory.snapshot', turnId: '0', state: emptyWorkingState() }),
      ev({ t: 'turn.started', turnId: '3', sessionId: 's', userText: 'Compare leads created Q3 vs Q2', ts: 0 }),
      ev({
        t: 'plan.ready',
        turnId: '3',
        outcome: { kind: 'plan', plan: { goal: 'Compare leads created Q3 vs Q2', steps: [] } },
        planRev: 0,
        planHash: 'h3',
        llm: llmUsage,
      }),
      ev(turnCompleted('3', 'done')),
      ev({ t: 'turn.started', turnId: '4', sessionId: 's', userText: 'In Q1, how many leads were qualified?', ts: 0 }),
      ev({
        t: 'plan.ready',
        turnId: '4',
        outcome: { kind: 'clarify', question: 'Which Q1 do you mean?' },
        planRev: 0,
        planHash: 'h4',
        llm: llmUsage,
      }),
      ev(turnCompleted('4', 'clarify')),
    ];

    const state = foldMemory(events);

    // intent/filters from the PRIOR plan are untouched by the clarify.
    expect(state.frame?.intent).toBe('Compare leads created Q3 vs Q2');
    expect(state.frame?.status).toBe('active');
    // The clarify's OWN turn.completed does not clear what it just set.
    expect(state.frame?.pendingClarify).toEqual({
      question: 'Which Q1 do you mean?',
      request: 'In Q1, how many leads were qualified?',
    });
  });

  it('a clarify as the VERY FIRST turn (no prior frame) still records pendingClarify, surviving its own turn.completed', () => {
    const events: Event[] = [
      ev({ t: 'memory.snapshot', turnId: '0', state: emptyWorkingState() }),
      ev({ t: 'turn.started', turnId: '1', sessionId: 's', userText: 'do the thing', ts: 0 }),
      ev({
        t: 'plan.ready',
        turnId: '1',
        outcome: { kind: 'clarify', question: 'Which thing?' },
        planRev: 0,
        planHash: 'h1',
        llm: llmUsage,
      }),
      ev(turnCompleted('1', 'clarify')),
    ];

    const state = foldMemory(events);

    expect(state.frame?.pendingClarify).toEqual({ question: 'Which thing?', request: 'do the thing' });
    expect(state.frame?.status).toBe('active');
  });

  it('pendingClarify is cleared at the resolving turn\'s turn.completed, for plan/respond/unsupported outcomes', () => {
    const clarifyEvents: Event[] = [
      ev({ t: 'memory.snapshot', turnId: '0', state: emptyWorkingState() }),
      ev({ t: 'turn.started', turnId: '1', sessionId: 's', userText: 'In Q1, how many leads were qualified?', ts: 0 }),
      ev({
        t: 'plan.ready',
        turnId: '1',
        outcome: { kind: 'clarify', question: 'Which Q1?' },
        planRev: 0,
        planHash: 'h1',
        llm: llmUsage,
      }),
      ev(turnCompleted('1', 'clarify')),
    ];

    for (const kind of ['plan', 'respond', 'unsupported'] as const) {
      const outcome =
        kind === 'plan'
          ? ({ kind, plan: { goal: 'g', steps: [] } } as const)
          : kind === 'respond'
            ? ({ kind, text: 'ok' } as const)
            : ({ kind, reason: 'nope' } as const);
      const status = kind === 'plan' ? 'done' : kind === 'respond' ? 'done' : 'refused';
      const events: Event[] = [
        ...clarifyEvents,
        ev({ t: 'turn.started', turnId: '2', sessionId: 's', userText: 'Q1 2026 (Jan–Mar)', ts: 0 }),
        ev({
          t: 'plan.ready',
          turnId: '2',
          outcome,
          planRev: 0,
          planHash: 'h2',
          llm: llmUsage,
        }),
        ev(turnCompleted('2', status)),
      ];
      const state = foldMemory(events);
      expect(state.frame?.pendingClarify).toBeUndefined();
    }
  });

  it('(e) a resolving turn that FAILS outright — repair exhaustion, no plan.ready at all this turn — still clears pendingClarify at turn.completed', () => {
    const events: Event[] = [
      ev({ t: 'memory.snapshot', turnId: '0', state: emptyWorkingState() }),
      ev({ t: 'turn.started', turnId: '1', sessionId: 's', userText: 'ok add a note to the first one saying follow up next week', ts: 0 }),
      ev({
        t: 'plan.ready',
        turnId: '1',
        outcome: { kind: 'clarify', question: 'Should I create a new note or an internal comment?' },
        planRev: 0,
        planHash: 'h1',
        llm: llmUsage,
      }),
      ev(turnCompleted('1', 'clarify')),
      // Turn 2 answers the clarify, but the PLANNING PHASE ITSELF fails
      // (repair exhaustion) — NO plan.ready event is ever emitted for
      // turn 2 at all (mirrors `pipeline.ts`'s `runPlanningPhase` on
      // `{kind:'failed'}`).
      ev({ t: 'turn.started', turnId: '2', sessionId: 's', userText: 'just a regular note, author doesnt matter', ts: 0 }),
      ev(turnCompleted('2', 'failed')),
    ];

    const state = foldMemory(events);

    expect(state.frame?.pendingClarify).toBeUndefined();
  });

  it('(f) the user abandons ("forget it") in a turn that succeeds on something else — pendingClarify is cleared after that turn', () => {
    const events: Event[] = [
      ev({ t: 'memory.snapshot', turnId: '0', state: emptyWorkingState() }),
      ev({ t: 'turn.started', turnId: '1', sessionId: 's', userText: 'ok add a note to the first one saying follow up next week', ts: 0 }),
      ev({
        t: 'plan.ready',
        turnId: '1',
        outcome: { kind: 'clarify', question: 'Should I create a new note or an internal comment?' },
        planRev: 0,
        planHash: 'h1',
        llm: llmUsage,
      }),
      ev(turnCompleted('1', 'clarify')),
      ev({ t: 'turn.started', turnId: '2', sessionId: 's', userText: 'forget the note, whats going on with acme', ts: 0 }),
      ev({
        t: 'plan.ready',
        turnId: '2',
        outcome: { kind: 'respond', text: 'Sure, dropping that. What would you like to know about Acme?' },
        planRev: 0,
        planHash: 'h2',
        llm: llmUsage,
      }),
      ev(turnCompleted('2', 'done')),
    ];

    const state = foldMemory(events);

    expect(state.frame?.pendingClarify).toBeUndefined();
  });

  it('back-to-back clarifies: the SECOND clarify keeps the ORIGINAL request, not the intermediate answer, and survives its own turn.completed', () => {
    const events: Event[] = [
      ev({ t: 'memory.snapshot', turnId: '0', state: emptyWorkingState() }),
      ev({ t: 'turn.started', turnId: '1', sessionId: 's', userText: 'In Q1, how many leads were qualified?', ts: 0 }),
      ev({
        t: 'plan.ready',
        turnId: '1',
        outcome: { kind: 'clarify', question: 'Which Q1?' },
        planRev: 0,
        planHash: 'h1',
        llm: llmUsage,
      }),
      ev(turnCompleted('1', 'clarify')),
      // The user's reply itself triggers a SECOND clarify (e.g. still
      // ambiguous) — its userText is the INTERMEDIATE answer, not the
      // original request.
      ev({ t: 'turn.started', turnId: '2', sessionId: 's', userText: 'the fiscal one', ts: 0 }),
      ev({
        t: 'plan.ready',
        turnId: '2',
        outcome: { kind: 'clarify', question: 'Fiscal Q1 starts in which month for your org?' },
        planRev: 0,
        planHash: 'h2',
        llm: llmUsage,
      }),
      ev(turnCompleted('2', 'clarify')),
    ];

    const state = foldMemory(events);

    expect(state.frame?.pendingClarify?.request).toBe('In Q1, how many leads were qualified?');
    expect(state.frame?.pendingClarify?.question).toBe('Fiscal Q1 starts in which month for your org?');
  });
});

describe('rewriteQuery — clarify-answer composition (fix: clarify intent carryover)', () => {
  it('composes the ORIGINAL request with the (typically anaphora-free) answer, ignoring the stale frame.intent path', () => {
    const state: WorkingState = {
      frame: {
        intent: 'Compare leads created Q3 vs Q2', // stale — must NOT leak in
        status: 'active',
        filters: { created_after: 123 },
        missingParams: [],
        pendingClarify: { question: 'Which Q1?', request: 'In Q1, how many leads were qualified?' },
      },
      entities: {},
      handles: [],
    };

    const rewritten = rewriteQuery('Q1 2026 (Jan–Mar)', state);

    expect(rewritten).toContain('In Q1, how many leads were qualified?');
    expect(rewritten).toContain('Q1 2026 (Jan–Mar)');
    expect(rewritten).not.toContain('Compare leads created Q3 vs Q2');
  });

  it('is idempotent: re-applying it to its own output returns the same string', () => {
    const state: WorkingState = {
      frame: {
        intent: 'g',
        status: 'active',
        filters: {},
        missingParams: [],
        pendingClarify: { question: 'Which Q1?', request: 'In Q1, how many leads were qualified?' },
      },
      entities: {},
      handles: [],
    };
    const once = rewriteQuery('Q1 2026 (Jan–Mar)', state);
    expect(rewriteQuery(once, state)).toBe(once);
  });

  it('takes priority over the anaphora-signal path even when the answer carries no anaphora cue', () => {
    const state: WorkingState = {
      frame: {
        intent: 'Compare leads created Q3 vs Q2',
        status: 'active',
        filters: {},
        missingParams: [],
        pendingClarify: { question: 'Which Q1?', request: 'In Q1, how many leads were qualified?' },
      },
      entities: {},
      handles: [],
    };
    // No anaphora signal word present at all — the OLD code path would
    // have returned this unchanged; the fix still composes it.
    expect(rewriteQuery('Q1 2026', state)).toBe(
      'In Q1, how many leads were qualified? — clarification answered: Q1 2026',
    );
  });
});

describe('renderWorkingState — surfaces a pending clarify', () => {
  it('includes an awaiting-clarification line with the question and original request', () => {
    const state: WorkingState = {
      frame: {
        intent: 'g',
        status: 'active',
        filters: {},
        missingParams: [],
        pendingClarify: { question: 'Which Q1?', request: 'In Q1, how many leads were qualified?' },
      },
      entities: {},
      handles: [],
    };
    const text = renderWorkingState(state);
    expect(text).toContain('awaiting-clarification: Which Q1? (for: In Q1, how many leads were qualified?)');
  });
});
