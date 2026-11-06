import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { coerceDateParams, buildDateAnchors, widenDateFields } from '../src/loop/date-rail';

// Pinned eval clock: 2026-11-04T10:00:00Z (Wednesday).
const NOW = 1793786400000;

describe('coerceDateParams', () => {
  it('coerces ISO-8601 strings in date-shaped keys to epoch ms', () => {
    const { params } = coerceDateParams({ valid_until: '2026-11-30T23:59:59.999Z' }, NOW);
    expect(params['valid_until']).toBe(Date.parse('2026-11-30T23:59:59.999Z'));
  });

  it('resolves @-relative expressions against pinned now', () => {
    const { params } = coerceDateParams({ created_after: '@today', start_before: '@now-7d' }, NOW);
    expect(params['created_after']).toBe(Date.parse('2026-11-04T00:00:00.000Z'));
    expect(params['start_before']).toBe(NOW - 7 * 24 * 3600 * 1000);
  });

  it('passes numeric date values through untouched', () => {
    const { params, resolved } = coerceDateParams({ start_after: NOW }, NOW);
    expect(params['start_after']).toBe(NOW);
    expect(resolved).toEqual([]);
  });

  it('leaves non-date keys untouched even when they look like dates', () => {
    const { params } = coerceDateParams({ name: '2026-11-30', note: '@today' }, NOW);
    expect(params['name']).toBe('2026-11-30');
    expect(params['note']).toBe('@today');
  });

  it('I5: coerces string ELEMENTS of arrays under date-shaped keys', () => {
    const { params } = coerceDateParams({ reminder_at: ['2026-11-04T00:00:00Z', '@today'] }, NOW);
    expect(params['reminder_at']).toEqual([Date.parse('2026-11-04T00:00:00Z'), Date.parse('2026-11-04T00:00:00.000Z')]);
  });

  it('walks nested objects and arrays', () => {
    const { params } = coerceDateParams({ filter: { due_date: '@today' }, items: [{ expires_at: '2026-12-01T00:00:00Z' }] }, NOW);
    expect((params['filter'] as Record<string, unknown>)['due_date']).toBe(Date.parse('2026-11-04T00:00:00.000Z'));
    expect(((params['items'] as unknown[])[0] as Record<string, unknown>)['expires_at']).toBe(Date.parse('2026-12-01T00:00:00Z'));
  });

  it('does not mutate the input object', () => {
    const input = { valid_until: '2026-11-30T00:00:00Z', filter: { due_date: '@today' } };
    coerceDateParams(input, NOW);
    expect(input.valid_until).toBe('2026-11-30T00:00:00Z');
    expect(input.filter.due_date).toBe('@today');
  });

  it('emits a human-readable resolved echo line per coercion', () => {
    const { resolved } = coerceDateParams({ created_after: '@today' }, NOW);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toContain('created_after');
    expect(resolved[0]).toContain('@today');
    expect(resolved[0]).toContain('2026-11-04T00:00:00.000Z');
  });

  it('leaves unparseable strings in date keys untouched (schema will reject)', () => {
    const { params, resolved } = coerceDateParams({ created_after: 'next blursday' }, NOW);
    expect(params['created_after']).toBe('next blursday');
    expect(resolved).toEqual([]);
  });
});

describe('buildDateAnchors', () => {
  const anchors = buildDateAnchors(NOW);

  it('includes now with weekday', () => {
    expect(anchors).toContain('2026-11-04T10:00:00.000Z');
    expect(anchors).toContain('Wednesday');
  });

  it('includes tomorrow and today bounds', () => {
    expect(anchors).toContain('tomorrow = 2026-11-05');
    expect(anchors).toContain('2026-11-04T00:00:00.000Z');
    expect(anchors).toContain('2026-11-04T23:59:59.999Z');
  });

  it('includes upcoming weekday anchors (round-5: "due friday" was written as Sunday)', () => {
    expect(anchors).toMatch(/next friday = 2026-11-06/i);
    expect(anchors).toMatch(/next monday = 2026-11-09/i);
  });

  it('includes month bounds and 7 days ago', () => {
    expect(anchors).toContain('2026-11-01T00:00:00.000Z');
    expect(anchors).toContain('2026-11-30T23:59:59.999Z');
    expect(anchors).toContain('2026-10-28');
  });
});

describe('widenDateFields', () => {
  const schema = z.object({
    query: z.string().optional(),
    created_after: z.number().optional(),
    limit: z.number().optional(),
  });

  it('date fields accept strings ONLY — model-written epoch numbers are rejected at the schema', () => {
    // Live evidence 2026-11-06: the model sent start_after=1730688000000
    // (epoch for 2024) straight past the string-coercion rail. Policy
    // matches the plan-DSL validator: the MODEL never writes epoch numbers.
    const wide = widenDateFields(schema);
    expect(wide.safeParse({ created_after: '2026-11-04T10:00:00Z' }).success).toBe(true);
    expect(wide.safeParse({ created_after: '@today' }).success).toBe(true);
    expect(wide.safeParse({ created_after: NOW }).success).toBe(false);
  });

  it('leaves non-date fields untouched', () => {
    const wide = widenDateFields(schema);
    expect(wide.safeParse({ limit: 'not-a-number' }).success).toBe(false);
    expect(wide.safeParse({ query: 'acme', limit: 5 }).success).toBe(true);
  });

  it('I5: widens date fields NESTED in objects and arrays of objects', () => {
    const nested = z.object({
      filter: z.object({ due_date: z.number() }).optional(),
      windows: z.array(z.object({ start_at: z.number() })).optional(),
    });
    const wide = widenDateFields(nested);
    expect(wide.safeParse({ filter: { due_date: '2026-11-04T00:00:00Z' } }).success).toBe(true);
    expect(wide.safeParse({ windows: [{ start_at: '@today' }] }).success).toBe(true);
    // strings-only policy applies at every depth
    expect(wide.safeParse({ filter: { due_date: 1793786400000 } }).success).toBe(false);
  });
});
