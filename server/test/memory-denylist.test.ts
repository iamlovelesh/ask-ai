import { describe, it, expect } from 'vitest';
import { screenMemory, isVolatileMemory } from '../src/memory/denylist';

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

describe('isVolatileMemory — rejects stale CRM aggregates/snapshots', () => {
  const volatile: Array<[string, string]> = [
    ['total value', 'Total value of open opportunities is $19,098,279.08'],
    ['count "currently has"', 'Currently has 712 open opportunities'],
    ['count "has N"', 'Has 14 open opportunities over $20,000'],
    ['leading count', '712 open opportunities in the pipeline right now'],
    ['status breakdown', 'Lead status breakdown: new (1,362), contacted (1,252), qualified (1,183)'],
    ['combined value', 'Has 12 opportunities in negotiation stage with combined value of $289,288.53'],
    ['top-N snapshot', 'Top 5 highest-value negotiation opportunities: opp_438 ($50,981.12), opp_612 ($50,788.16)'],
    ['filtered total', 'Total value of open opportunities over $20,000 is $466,747.33'],
  ];
  for (const [label, body] of volatile) {
    it(`rejects ${label}`, () => {
      expect(isVolatileMemory(body)).toBe(true);
    });
  }

  const durable: string[] = [
    'prefers EU date format',
    'quarterly target is $50,000',
    'SMB Sales team with 8 members, managed by Mateo Osei',
    'Prefers to send automated payment reminders first, then follow up by phone',
    'Always sort ticket lists by priority, highest first',
    'Reduce overdue invoices and improve payment collection rate',
  ];
  for (const body of durable) {
    it(`keeps durable "${body.slice(0, 32)}…"`, () => {
      expect(isVolatileMemory(body)).toBe(false);
    });
  }
});
