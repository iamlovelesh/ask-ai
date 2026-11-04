import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProbes, runProbe, recallOf, RECALL_GATE, type Probe } from '../../scripts/probe';

/**
 * Smoke test for the PROBE RUNNER mechanics (YAML parsing, per-probe
 * scoring, recall aggregation) against a small fixture — NOT a re-run of
 * the full 60-query catalog probe (that's `npm run probe`, documented
 * separately in this task's report with its own recall table). This just
 * proves the harness itself is correct: a probe whose `expect` is
 * satisfied counts as a hit, one that can never be satisfied counts as a
 * miss, and `recallOf`/the 0.95 gate constant compute correctly.
 */
describe('probe runner — small fixture', () => {
  it('loadProbes parses a minimal YAML probe set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-ai-probe-fixture-'));
    const path = join(dir, 'fixture.yaml');
    writeFileSync(
      path,
      [
        '- q: create a contact',
        '  category: direct',
        '  expect: [contacts.create_contact]',
        '- q: creat a contct',
        '  category: typo',
        '  expect: [contacts.create_contact]',
      ].join('\n'),
    );
    try {
      const probes = loadProbes(path);
      expect(probes).toHaveLength(2);
      expect(probes[0]).toEqual({ q: 'create a contact', category: 'direct', expect: ['contacts.create_contact'] });
      expect(probes[1]!.category).toBe('typo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a probe missing a required field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-ai-probe-fixture-'));
    const path = join(dir, 'bad.yaml');
    writeFileSync(path, ['- q: no category here', '  expect: [a.b]'].join('\n'));
    try {
      expect(() => loadProbes(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runProbe hits when an expected slug is in retrieve()’s top 20', () => {
    const probe: Probe = { q: 'create a new contact', category: 'direct', expect: ['contacts.create_contact'] };
    const result = runProbe(probe);
    expect(result.hit).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('runProbe misses when no expected slug could ever match', () => {
    const probe: Probe = { q: 'create a new contact', category: 'direct', expect: ['nonexistent.action_slug'] };
    const result = runProbe(probe);
    expect(result.hit).toBe(false);
  });

  it('recallOf computes hits/total, and the 0.95 gate constant is as documented', () => {
    const fixtureResults = [
      runProbe({ q: 'create a new contact', category: 'direct', expect: ['contacts.create_contact'] }),
      runProbe({ q: 'create a new contact', category: 'direct', expect: ['nonexistent.action_slug'] }),
    ];
    expect(recallOf(fixtureResults)).toBeCloseTo(0.5, 6);
    expect(recallOf([])).toBe(1);
    expect(RECALL_GATE).toBe(0.95);
  });
});
