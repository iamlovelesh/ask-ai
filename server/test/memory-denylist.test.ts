import { describe, it, expect } from 'vitest';
import { screenMemory } from '../src/memory/denylist';

describe('screenMemory — rejects sensitive data', () => {
  const rejected: Array<[string, string]> = [
    ['credit card (spaced)', 'card number 4111 1111 1111 1111'],
    ['credit card (dashed)', 'cc 4111-1111-1111-1111'],
    ['credit card (bare)', 'the card is 4111111111111111'],
    ['SSN', 'his ssn is 123-45-6789'],
    ['openai key', 'the api key is sk-abcdef0123456789abcdef0123456789'],
    ['bearer token', 'Authorization: Bearer abcdef0123456789abcdef0123456789'],
    ['long hex secret', 'token deadbeefdeadbeefdeadbeefdeadbeef12345678'],
    ['password phrase', 'the password is hunter2'],
    ['password colon-attached', 'my password: hunter2'],
    ['password equals', 'password=hunter2'],
    ['undashed SSN', 'his ssn is 123456789'],
  ];
  for (const [label, body] of rejected) {
    it(`rejects ${label}`, () => {
      const r = screenMemory(body);
      expect(r.allowed, `${label} should be rejected`).toBe(false);
      expect(r.reason).toBeTruthy();
    });
  }
});

describe('screenMemory — allows benign facts', () => {
  const allowed = [
    'prefers EU date format',
    'quarterly target is $50,000',
    'works in sales ops and prefers terse answers',
    'recurring goal: weekly pipeline review on Mondays',
  ];
  for (const body of allowed) {
    it(`allows "${body.slice(0, 32)}…"`, () => {
      expect(screenMemory(body).allowed).toBe(true);
    });
  }
});
