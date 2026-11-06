import { describe, it, expect } from 'vitest';
import { looksLikeClarify } from '../src/loop/agent';

describe('looksLikeClarify — plain-text clarify backstop', () => {
  const clarifying: string[] = [
    // The missed case: questions mid-text, ends on a statement.
    "I need more information to update the deal. Could you please clarify: 1. Which deal do you mean? 2. What do you want to change? Once you tell me, I'll make the update right away.",
    'Which contact do you mean?',
    'Could you specify the amount you want to set?',
    'Can you tell me which opportunity this is for?',
    'I need some details first: what value should I set on the deal?',
    'Please confirm which invoice you want to send.',
    'What would you like to change?',
  ];
  for (const t of clarifying) {
    it(`true: "${t.slice(0, 40)}…"`, () => {
      expect(looksLikeClarify(t)).toBe(true);
    });
  }

  const notClarifying: string[] = [
    'You have 1,362 leads with status New. Here is a sample.',
    'Done — I created 3 follow-up tasks.',
    'The total value of all open opportunities is $19,098,279.08 across 712 deals.',
    'I could not do that — deleting all records is destructive.',
  ];
  for (const t of notClarifying) {
    it(`false: "${t.slice(0, 40)}…"`, () => {
      expect(looksLikeClarify(t)).toBe(false);
    });
  }
});
