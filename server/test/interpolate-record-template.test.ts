import { describe, it, expect } from 'vitest';
import { interpolateRecordTemplate } from '../src/loop/tools';

describe('interpolateRecordTemplate (per-record outreach templating)', () => {
  const row = { first_name: 'Ada', company: 'Acme', last_name: 'Lovelace', amount_cents: 5000 };

  it('fills {{field}} and {{record.field}} tokens from the record', () => {
    const out = interpolateRecordTemplate(
      { body: 'Hi {{first_name}}, following up on {{record.company}}.', title: 'Follow up' },
      row,
    );
    expect(out['body']).toBe('Hi Ada, following up on Acme.');
    expect(out['title']).toBe('Follow up'); // no tokens → unchanged
  });

  it('substitutes an empty string for an unknown field', () => {
    expect(interpolateRecordTemplate({ body: 'Hi {{middle_name}}!' }, row)['body']).toBe('Hi !');
  });

  it('leaves non-string params untouched and stringifies numeric field values', () => {
    const out = interpolateRecordTemplate({ flag: true, note: 'owed {{amount_cents}}', n: 3 }, row);
    expect(out['flag']).toBe(true);
    expect(out['n']).toBe(3);
    expect(out['note']).toBe('owed 5000');
  });

  it('is a no-op when there are no tokens', () => {
    expect(interpolateRecordTemplate({ a: 'plain', b: 'no braces here' }, row)).toEqual({ a: 'plain', b: 'no braces here' });
  });
});
