import { describe, it, expect } from 'vitest';
import { falsePromiseNote } from '../src/loop/false-promise';

describe('falsePromiseNote', () => {
  it('flags a deferred follow-up promise when nothing was scheduled', () => {
    const note = falsePromiseNote("Got it — I'll follow up with them next week to check in.", { scheduled: false });
    expect(note).not.toBeNull();
    expect(note).toMatch(/haven't scheduled/i);
  });

  it('flags inherently-deferred phrasing ("I\'ll remind you", "keep you posted")', () => {
    expect(falsePromiseNote("Sure, I'll remind you about the renewal.", { scheduled: false })).not.toBeNull();
    expect(falsePromiseNote("Done — I'll keep you posted on their reply.", { scheduled: false })).not.toBeNull();
    expect(falsePromiseNote("I'll get back to you once they respond.", { scheduled: false })).not.toBeNull();
  });

  it('does NOT flag when a follow-up was actually scheduled this turn', () => {
    expect(falsePromiseNote("I'll follow up with them next week — reminder set.", { scheduled: true })).toBeNull();
  });

  it('does NOT flag immediate, same-turn statements', () => {
    expect(falsePromiseNote('Let me check that for you.', { scheduled: false })).toBeNull();
    expect(falsePromiseNote("I'll show you the results below.", { scheduled: false })).toBeNull();
    expect(falsePromiseNote('Here are the 12 overdue invoices.', { scheduled: false })).toBeNull();
    expect(falsePromiseNote('I archived the 3 contacts you asked for.', { scheduled: false })).toBeNull();
  });

  it('does NOT flag a plain future-time mention without a first-person work promise', () => {
    expect(falsePromiseNote('Their renewal is due next week.', { scheduled: false })).toBeNull();
    expect(falsePromiseNote('The appointment is scheduled for tomorrow at 2pm.', { scheduled: false })).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(falsePromiseNote('', { scheduled: false })).toBeNull();
  });
});
