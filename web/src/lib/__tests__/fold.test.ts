import { describe, expect, it } from 'vitest';
import { applyEvent, emptyChatState } from '../fold.js';
import type { AppEvent } from '../events.js';

const metrics = {
  ttfurMs: 1,
  totalMs: 2,
  llmCalls: 0,
  repairs: 0,
  replans: 0,
  searchRounds: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  stepsOk: 0,
  stepsFailed: 0,
};

describe('fold activeTurnId lifecycle (aria-live scoping)', () => {
  it('is null on an empty chat', () => {
    expect(emptyChatState().activeTurnId).toBeNull();
  });

  it('is set on turn.started and cleared on turn.completed', () => {
    const chat = emptyChatState();
    applyEvent(chat, { t: 'turn.started', seq: 1, turnId: 't1', sessionId: 's', userText: 'hi', ts: 1 });
    expect(chat.activeTurnId).toBe('t1');
    applyEvent(chat, { t: 'turn.completed', seq: 2, turnId: 't1', status: 'done', metrics });
    expect(chat.activeTurnId).toBeNull();
  });

  it('is null after a fully-replayed historical session (nothing left in flight)', () => {
    const chat = emptyChatState();
    const events: AppEvent[] = [
      { t: 'turn.started', seq: 1, turnId: 't1', sessionId: 's', userText: 'a', ts: 1 },
      { t: 'turn.completed', seq: 2, turnId: 't1', status: 'done', metrics },
      { t: 'turn.started', seq: 3, turnId: 't2', sessionId: 's', userText: 'b', ts: 2 },
      { t: 'turn.completed', seq: 4, turnId: 't2', status: 'done', metrics },
    ];
    for (const ev of events) applyEvent(chat, ev);
    expect(chat.activeTurnId).toBeNull();
    expect(chat.running).toBe(false);
  });

  it('stays set when a session was left mid-turn (turn.started with no matching turn.completed)', () => {
    const chat = emptyChatState();
    applyEvent(chat, { t: 'turn.started', seq: 1, turnId: 't1', sessionId: 's', userText: 'a', ts: 1 });
    applyEvent(chat, { t: 'turn.completed', seq: 2, turnId: 't1', status: 'done', metrics });
    applyEvent(chat, { t: 'turn.started', seq: 3, turnId: 't2', sessionId: 's', userText: 'b', ts: 2 });
    expect(chat.activeTurnId).toBe('t2'); // t2 still in flight
    expect(chat.running).toBe(true);
  });
});
