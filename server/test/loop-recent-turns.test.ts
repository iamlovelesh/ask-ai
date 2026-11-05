import { describe, it, expect } from 'vitest';
import type { Event, TurnMetrics } from '../src/events/types';
import { renderRecentTurns } from '../src/loop/recent-turns';

const METRICS: TurnMetrics = {
  ttfurMs: 1, totalMs: 2, llmCalls: 1, repairs: 0, replans: 0, searchRounds: 0,
  tokensIn: 1, tokensOut: 1, costUsd: 0, stepsOk: 1, stepsFailed: 0,
};

function turnEvents(n: number, userText: string, answer: string, extra: Event[] = []): Event[] {
  const turnId = `t_${n}`;
  return [
    { t: 'turn.started', turnId, sessionId: 's_1', userText, ts: n } as Event,
    ...extra.map((e) => ({ ...e, turnId }) as Event),
    { t: 'answer.final', turnId, text: answer } as Event,
    { t: 'turn.completed', turnId, status: 'done', metrics: METRICS } as Event,
  ];
}

describe('renderRecentTurns', () => {
  const history: Event[] = [
    ...turnEvents(1, 'hello there', 'Hi! How can I help?'),
    ...turnEvents(2, 'show open tickets assigned to user_38', 'You have 4 open tickets: ...', [
      {
        t: 'step.started', turnId: 't_2', stepId: 's1', action: 'support_tickets.search_tickets',
        resolvedParams: [{ assignee_id: 'user_38', status: 'open' }],
      } as Event,
      { t: 'step.finished', turnId: 't_2', stepId: 's1', summary: 'search tickets: 4 tickets [ref r_t2_s1]', ms: 5 } as Event,
    ]),
    ...turnEvents(3, 'what about invoices', 'There are 165 overdue invoices.', [
      { t: 'step.started', turnId: 't_3', stepId: 's1', action: 'invoices.search_invoices', resolvedParams: [{ status: 'issued' }] } as Event,
      { t: 'step.failed', turnId: 't_3', stepId: 's1', error: { code: 'VALIDATION', message: 'bad' }, ms: 3 } as Event,
    ]),
  ];

  it('renders user text, scope filters, step summaries and answers for recent turns', () => {
    const out = renderRecentTurns(history, 3);
    expect(out).toContain('show open tickets assigned to user_38');
    expect(out).toContain('assignee_id');
    expect(out).toContain('user_38');
    expect(out).toContain('4 tickets [ref r_t2_s1]');
    expect(out).toContain('You have 4 open tickets');
  });

  it('orders turns oldest to newest', () => {
    const out = renderRecentTurns(history, 3);
    expect(out.indexOf('hello there')).toBeLessThan(out.indexOf('show open tickets'));
    expect(out.indexOf('show open tickets')).toBeLessThan(out.indexOf('what about invoices'));
  });

  it('includes failed step codes', () => {
    const out = renderRecentTurns(history, 3);
    expect(out).toContain('VALIDATION');
  });

  it('collapses turns older than keepLastN to a single user->answer line', () => {
    const out = renderRecentTurns(history, 2);
    expect(out).toContain('hello there');
    expect(out).toContain('Hi! How can I help?');
    // collapsed turn keeps no step detail
    const firstSection = out.slice(0, out.indexOf('show open tickets'));
    expect(firstSection).not.toContain('step');
    // recent turns keep detail
    expect(out).toContain('assignee_id');
  });

  it('excludes an in-flight turn with no final answer', () => {
    const inFlight: Event[] = [
      ...history,
      { t: 'turn.started', turnId: 't_4', sessionId: 's_1', userText: 'current question', ts: 4 } as Event,
    ];
    const out = renderRecentTurns(inFlight, 3);
    expect(out).not.toContain('current question');
  });

  it('returns empty string for no completed turns', () => {
    expect(renderRecentTurns([], 3)).toBe('');
  });
});
