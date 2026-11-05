/**
 * Task 19 deliverable 1: proves "opening an old session renders identically
 * to live" is actually true, not just asserted in a comment. Both paths run
 * the SAME `applyEvent` fold (`lib/fold.ts`) over the SAME recorded fixture
 * event list — one via `store.openSession()` (bulk `GET .../events`, as a
 * reload of an old session would see), the other via a bare
 * `emptyChatState()` + a manual per-event loop (simulating exactly how the
 * live SSE channels feed `applyEvent` one frame at a time). If the two
 * folded states ever diverge, this test fails — a stronger, mechanical
 * check than "same renderer" by inspection.
 *
 * No browser/DOM is needed: the folded `SessionChatState` IS the complete
 * input to every template in `ChatView`/`TaskTracker`/etc. (they only ever
 * read from it, never from raw events — see `fold.ts`'s header), so a
 * deep-equal over that state is equivalent to a DOM diff of what those
 * templates would render from it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../session.js';
import { applyEvent, emptyChatState } from '../../lib/fold.js';
import type { AppEvent } from '../../lib/events.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(encoder.encode(frames[i]));
        i += 1;
        return;
      }
      controller.close();
    },
  });
}

/** A full turn: plan with a gated step, confirmation approved, two steps
 * (one `forEach`-shaped via itemCount), a final answer, and completion —
 * exercises every branch `applyEvent` has, not just the happy path. */
const FIXTURE_EVENTS: AppEvent[] = [
  { t: 'turn.started', seq: 1, turnId: 't1', sessionId: 'sess_x', userText: 'Archive two contacts', ts: 1000 },
  { t: 'retrieval.done', seq: 2, turnId: 't1', candidates: ['contacts.archive_contact'], ms: 5 },
  {
    t: 'plan.ready',
    seq: 3,
    turnId: 't1',
    outcome: {
      kind: 'plan',
      plan: {
        goal: 'Archive two contacts',
        steps: [
          { id: 's1', action: 'contacts.archive_contact', params: {}, dependsOn: [] },
          { id: 's2', action: 'contacts.archive_contact', params: {}, dependsOn: ['s1'] },
        ],
      },
    },
    planRev: 1,
    planHash: 'h1',
    llm: { model: 'test-model', tokensIn: 10, tokensOut: 5, tokensCached: 0, costUsd: 0.001, latencyMs: 100, attempt: 1 },
  },
  { t: 'step.started', seq: 4, turnId: 't1', stepId: 's1', action: 'contacts.archive_contact', itemCount: 1 },
  {
    t: 'confirmation.required',
    seq: 5,
    turnId: 't1',
    confirmId: 'c1',
    planRev: 1,
    planHash: 'h1',
    stepId: 's1',
    scope: {
      actions: ['contacts.archive_contact'],
      affectedCount: 2,
      targetSample: ['Dante Lindqvist', 'Freya Volkov'],
      description: 'Archive 2 contacts',
    },
  },
  { t: 'confirmation.resolved', seq: 6, turnId: 't1', confirmId: 'c1', approved: true },
  { t: 'step.finished', seq: 7, turnId: 't1', stepId: 's1', summary: 'Archived Dante Lindqvist', ms: 50 },
  { t: 'step.started', seq: 8, turnId: 't1', stepId: 's2', action: 'contacts.archive_contact', itemCount: 1 },
  { t: 'step.finished', seq: 9, turnId: 't1', stepId: 's2', summary: 'Archived Freya Volkov', ms: 40 },
  { t: 'answer.delta', seq: 10, turnId: 't1', text: 'Archived 2 ' },
  { t: 'answer.delta', seq: 11, turnId: 't1', text: 'contacts.' },
  { t: 'answer.final', seq: 12, turnId: 't1', text: 'Archived 2 contacts.' },
  {
    t: 'turn.completed',
    seq: 13,
    turnId: 't1',
    status: 'done',
    metrics: {
      ttfurMs: 120,
      totalMs: 300,
      llmCalls: 1,
      repairs: 0,
      replans: 0,
      searchRounds: 0,
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.001,
      stepsOk: 2,
      stepsFailed: 0,
    },
  },
  { t: 'memory.snapshot', seq: 14, turnId: 't1', state: {} },
];

describe('replay correctness (Task 19)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('openSession() folds a recorded event history to the EXACT SAME state as applying the same events live, one at a time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/events')) return jsonResponse(200, FIXTURE_EVENTS);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const store = useSessionStore();
    await store.openSession('sess_x');
    const viaReplay = store.chats['sess_x'];

    const viaLive = emptyChatState();
    for (const ev of FIXTURE_EVENTS) applyEvent(viaLive, ev);
    viaLive.loaded = true; // openSession() sets this after the fold; live channels never touch it

    // Deep-equal the ENTIRE folded state — turns, steps, pendingConfirm,
    // deltaText/finalText, metrics, lastSeq, running — everything every
    // template in ChatView/TaskTracker/ConfirmCard/CostBadge reads from.
    expect(viaReplay).toEqual(viaLive);

    // Spot-check the parts a DOM diff would actually render, so a future
    // regression in `toEqual`'s proxy handling can't silently pass:
    expect(viaReplay.turns).toHaveLength(1);
    expect(viaReplay.turns[0].finalText).toBe('Archived 2 contacts.');
    expect(viaReplay.turns[0].status).toBe('done');
    expect(viaReplay.turns[0].pendingConfirm).toMatchObject({ resolved: true, approved: true });
    expect(viaReplay.turns[0].steps['s1']).toMatchObject({ status: 'done', summary: 'Archived Dante Lindqvist' });
    expect(viaReplay.turns[0].steps['s2']).toMatchObject({ status: 'done', summary: 'Archived Freya Volkov' });
    expect(viaReplay.running).toBe(false);
  });

  it('continuing an old session (send() after openSession()) starts a new turn correctly', async () => {
    const continuationFrame =
      'id: 15\nevent: turn.started\ndata: {"seq":15,"t":"turn.started","turnId":"t2","sessionId":"sess_x","userText":"now do another one","ts":2000}\n\n' +
      'id: 16\nevent: answer.final\ndata: {"seq":16,"t":"answer.final","turnId":"t2","text":"Done."}\n\n' +
      'id: 17\nevent: turn.completed\ndata: {"seq":17,"t":"turn.completed","turnId":"t2","status":"done","metrics":{"ttfurMs":1,"totalMs":2,"llmCalls":0,"repairs":0,"replans":0,"searchRounds":0,"tokensIn":0,"tokensOut":0,"costUsd":0,"stepsOk":0,"stepsFailed":0}}\n\n';

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/events')) return jsonResponse(200, FIXTURE_EVENTS);
      if (u.includes('/messages')) return { ok: true, body: sseBody([continuationFrame]) };
      if (u === '/api/sessions') return jsonResponse(200, []); // refreshSessionMeta after send()
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = useSessionStore();
    await store.openSession('sess_x');
    expect(store.chats['sess_x'].turns).toHaveLength(1);
    expect(store.chats['sess_x'].running).toBe(false);

    await store.send('now do another one');

    const chat = store.chats['sess_x'];
    expect(chat.turns).toHaveLength(2); // the old turn is untouched, a new one was appended
    expect(chat.turns[0].turnId).toBe('t1');
    expect(chat.turns[1]).toMatchObject({ turnId: 't2', finalText: 'Done.', status: 'done' });
    expect(chat.running).toBe(false);
    expect(chat.lastSeq).toBe(17);
  });
});
