import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openEventLog, type EventLog, type SeqEvent } from '../src/events/log';
import { openSpans, type Spans } from '../src/events/trace';
import type { Event } from '../src/events/types';

function tmpDbPath(name: string): string {
  return join(tmpdir(), `ask-ai-events-${name}-${randomUUID()}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = path + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

const openPaths: string[] = [];
function freshLog(): EventLog {
  const path = tmpDbPath('log');
  openPaths.push(path);
  return openEventLog(path);
}

afterEach(() => {
  while (openPaths.length) cleanup(openPaths.pop()!);
});

function turnStarted(turnId: string, sessionId: string, userText: string, ts: number): Event {
  return { t: 'turn.started', turnId, sessionId, userText, ts };
}

describe('EventLog.append / list', () => {
  it('assigns monotonically increasing seq numbers and preserves order', () => {
    const log = freshLog();
    const sessionId = 'sess_a';
    const seq1 = log.append(sessionId, turnStarted('t1', sessionId, 'hello', 1000));
    const seq2 = log.append(sessionId, { t: 'answer.final', turnId: 't1', text: 'hi there' });
    const seq3 = log.append(sessionId, {
      t: 'turn.completed',
      turnId: 't1',
      status: 'done',
      metrics: {
        ttfurMs: 10,
        totalMs: 20,
        llmCalls: 1,
        repairs: 0,
        replans: 0,
        searchRounds: 0,
        tokensIn: 5,
        tokensOut: 5,
        costUsd: 0.001,
        stepsOk: 0,
        stepsFailed: 0,
      },
    });

    expect(seq1).toBeLessThan(seq2);
    expect(seq2).toBeLessThan(seq3);

    const all = log.list(sessionId);
    expect(all.map((e: SeqEvent) => e.event.t)).toEqual([
      'turn.started',
      'answer.final',
      'turn.completed',
    ]);
    expect(all.map((e: SeqEvent) => e.seq)).toEqual([seq1, seq2, seq3]);
    log.close();
  });

  it('afterSeq returns only events strictly after the given seq', () => {
    const log = freshLog();
    const sessionId = 'sess_b';
    const seq1 = log.append(sessionId, turnStarted('t1', sessionId, 'a', 1));
    const seq2 = log.append(sessionId, { t: 'answer.final', turnId: 't1', text: 'x' });
    log.append(sessionId, turnStarted('t2', sessionId, 'b', 2));

    const afterFirst = log.list(sessionId, seq1);
    expect(afterFirst.map((e) => e.seq)).toEqual([seq2, seq2 + 1]);

    const afterAll = log.list(sessionId, seq2 + 1);
    expect(afterAll).toEqual([]);
    log.close();
  });

  it('keeps seq sequences independent per session', () => {
    const log = freshLog();
    log.append('sess_x', turnStarted('t1', 'sess_x', 'a', 1));
    log.append('sess_x', turnStarted('t1', 'sess_x', 'a', 2));
    const seqY = log.append('sess_y', turnStarted('t1', 'sess_y', 'a', 3));

    expect(seqY).toBe(1);
    expect(log.list('sess_x').length).toBe(2);
    expect(log.list('sess_y').length).toBe(1);
    log.close();
  });
});

describe('EventLog answer.delta', () => {
  it('is NOT persisted but IS delivered to live subscribers', () => {
    const log = freshLog();
    const sessionId = 'sess_delta';
    const received: SeqEvent[] = [];
    const unsubscribe = log.subscribe(sessionId, (seqEv) => received.push(seqEv));

    log.append(sessionId, turnStarted('t1', sessionId, 'hello', 1));
    log.append(sessionId, { t: 'answer.delta', turnId: 't1', text: 'partial chunk' });
    log.append(sessionId, { t: 'answer.final', turnId: 't1', text: 'partial chunk done' });

    // Subscriber sees ALL three, including the delta.
    expect(received.map((e) => e.event.t)).toEqual([
      'turn.started',
      'answer.delta',
      'answer.final',
    ]);

    // Persisted log skips the delta.
    const persisted = log.list(sessionId);
    expect(persisted.map((e) => e.event.t)).toEqual(['turn.started', 'answer.final']);

    unsubscribe();
    log.append(sessionId, { t: 'answer.delta', turnId: 't1', text: 'after unsubscribe' });
    expect(received.length).toBe(3); // unsubscribed — no further deliveries.
    log.close();
  });

  it('supports multiple independent subscribers', () => {
    const log = freshLog();
    const sessionId = 'sess_multi';
    const a: SeqEvent[] = [];
    const b: SeqEvent[] = [];
    log.subscribe(sessionId, (e) => a.push(e));
    const unsubB = log.subscribe(sessionId, (e) => b.push(e));

    log.append(sessionId, { t: 'answer.delta', turnId: 't1', text: 'x' });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);

    unsubB();
    log.append(sessionId, { t: 'answer.delta', turnId: 't1', text: 'y' });
    expect(a.length).toBe(2);
    expect(b.length).toBe(1);
    log.close();
  });
});

describe('EventLog session rows', () => {
  it('createSession + listSessions round-trip, newest first', () => {
    const log = freshLog();
    const id1 = log.createSession('First');
    const id2 = log.createSession('Second');
    expect(id1).not.toBe(id2);

    log.touchSession(id1, { turns: 1, tokens: 100, costUsd: 0.01 });

    const rows = log.listSessions();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);

    const row1 = rows.find((r) => r.id === id1)!;
    expect(row1.title).toBe('First');
    expect(row1.turns).toBe(1);
    expect(row1.cost_usd).toBeCloseTo(0.01);
    log.close();
  });

  it('touchSession accumulates deltas across multiple calls', () => {
    const log = freshLog();
    const id = log.createSession();
    log.touchSession(id, { turns: 1, costUsd: 0.5 });
    log.touchSession(id, { turns: 2, costUsd: 0.25 });

    const row = log.listSessions().find((r) => r.id === id)!;
    expect(row.turns).toBe(3);
    expect(row.cost_usd).toBeCloseTo(0.75);
    log.close();
  });

  it('respects limit', () => {
    const log = freshLog();
    log.createSession('a');
    log.createSession('b');
    log.createSession('c');
    expect(log.listSessions(2).length).toBe(2);
    log.close();
  });
});

describe('Spans', () => {
  function freshSpans(): Spans {
    const path = tmpDbPath('spans');
    openPaths.push(path);
    return openSpans(path);
  }

  it('records a span per start/end and retrieves it by turnId', () => {
    const spans = freshSpans();
    const handle = spans.start({ turnId: 'turn_1', kind: 'llm', name: 'plan' });
    spans.end(handle, { tokensIn: 10, tokensOut: 4, costUsd: 0.002, meta: { stage: 'plan' } });

    const forTurn = spans.forTurn('turn_1');
    expect(forTurn.length).toBe(1);
    expect(forTurn[0]!.kind).toBe('llm');
    expect(forTurn[0]!.tokensIn).toBe(10);
    expect(forTurn[0]!.tokensOut).toBe(4);
    expect(forTurn[0]!.costUsd).toBeCloseTo(0.002);
    expect(forTurn[0]!.ms).toBeGreaterThanOrEqual(0);
    spans.close();
  });

  it('keeps spans scoped per turnId and orders them by start time', () => {
    const spans = freshSpans();
    const h1 = spans.start({ turnId: 'turn_a', kind: 'retrieval' });
    spans.end(h1);
    const h2 = spans.start({ turnId: 'turn_a', kind: 'llm' });
    spans.end(h2);
    spans.start({ turnId: 'turn_b', kind: 'step' });

    const a = spans.forTurn('turn_a');
    expect(a.map((s) => s.kind)).toEqual(['retrieval', 'llm']);
    expect(spans.forTurn('turn_b').length).toBe(1);
    spans.close();
  });
});
