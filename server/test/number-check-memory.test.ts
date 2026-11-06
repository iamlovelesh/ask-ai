import { describe, it, expect } from 'vitest';
import { numberCheck } from '../src/loop/number-check';

describe('numberCheck — recalled memory as extra evidence', () => {
  it('treats a figure present only in extraEvidence as supported', () => {
    const draft = 'Your quarterly target is $50,000.';
    // not in tool outputs nor user text
    expect(numberCheck(draft, [], '').ok).toBe(false);
    // present in recalled memory (extraEvidence) → supported
    expect(numberCheck(draft, [], '', ['- [goal] quarterly target is $50,000']).ok).toBe(true);
  });

  it('treats a date present only in extraEvidence as supported', () => {
    const draft = 'We agreed to review on Mar 3.';
    expect(numberCheck(draft, [], '').ok).toBe(false);
    expect(numberCheck(draft, [], '', ['review date 2026-03-03']).ok).toBe(true);
  });

  it('does NOT let two unrelated memory figures arithmetically "support" a fabricated sum (exact-match only)', () => {
    // §4.6.1 intends exact restatement, not cross-memory derivation.
    const draft = 'Your projected revenue is $80,000.';
    const memory = ['- [goal] target is $50,000', '- [goal] quota is $30,000'];
    const r = numberCheck(draft, [], '', memory);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain('$80,000');
  });

  it('still flags a figure absent from outputs, userText, and extraEvidence', () => {
    const draft = 'The total is $777,777.';
    const r = numberCheck(draft, ['some tool output 100'], 'user asked', ['- [goal] target is $50,000']);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain('$777,777');
  });
});
