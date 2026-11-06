import { describe, it, expect } from 'vitest';
import { generateTitle, cleanTitle, TITLE_MAX_CHARS } from '../src/api/title';

describe('cleanTitle', () => {
  it('strips surrounding quotes, trailing punctuation and collapses whitespace', () => {
    expect(cleanTitle('"Overdue invoices this month."')).toBe('Overdue invoices this month');
    expect(cleanTitle('  show   my\nleads  ')).toBe('show my leads');
  });

  it('caps length at a word boundary within the limit', () => {
    const long = 'show me every single overdue invoice across all regions for the last fiscal year and more';
    const out = cleanTitle(long);
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(out.endsWith(' ')).toBe(false);
  });
});

describe('generateTitle', () => {
  const ok = (t: string) => ({ complete: async () => t });

  it('uses the model title, cleaned', async () => {
    expect(await generateTitle('can you show me my overdue invoices?', ok('"Overdue Invoices".'))).toBe('Overdue Invoices');
  });

  it('falls back to the cleaned first message when the model returns empty', async () => {
    expect(await generateTitle('show my open leads', ok('   '))).toBe('show my open leads');
  });

  it('falls back to the cleaned first message when the model throws', async () => {
    const deps = { complete: async () => { throw new Error('model down'); } };
    expect(await generateTitle('how many deals closed in Q3?', deps)).toBe('how many deals closed in Q3?');
  });

  it('never exceeds the length limit', async () => {
    const out = await generateTitle('x', ok('y'.repeat(200)));
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });
});
