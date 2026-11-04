import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualClock } from '../src/store/clock';
import { Prng } from '../src/util/prng';
import { makeId } from '../src/util/ids';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

describe('VirtualClock', () => {
  it('should default to 2026-11-04T10:00:00.000Z', () => {
    const clock = new VirtualClock();
    expect(clock.iso()).toBe('2026-11-04T10:00:00.000Z');
  });

  it('should return milliseconds since epoch from now()', () => {
    const clock = new VirtualClock();
    const nowMs = clock.now();
    const expectedMs = new Date('2026-11-04T10:00:00Z').getTime();
    expect(nowMs).toBe(expectedMs);
  });

  it('should calculate daysAgo(7) correctly', () => {
    const clock = new VirtualClock();
    const sevenDaysAgoMs = clock.daysAgo(7);
    const expectedMs = new Date('2026-10-28T10:00:00Z').getTime();
    expect(sevenDaysAgoMs).toBe(expectedMs);
  });

  it('should return startOfWeek for current week', () => {
    const clock = new VirtualClock();
    // Wednesday 2026-11-04, so week started Monday 2026-11-02
    const startOfWeekMs = clock.startOfWeek(0);
    const expectedMs = new Date('2026-11-02T00:00:00Z').getTime();
    expect(startOfWeekMs).toBe(expectedMs);
  });

  it('should return startOfWeek for previous week', () => {
    const clock = new VirtualClock();
    // Previous week started Monday 2026-10-26
    const startOfPrevWeekMs = clock.startOfWeek(-1);
    const expectedMs = new Date('2026-10-26T00:00:00Z').getTime();
    expect(startOfPrevWeekMs).toBe(expectedMs);
  });
});

describe('makeId', () => {
  it('should create IDs with prefix and number', () => {
    const id = makeId('c', 1042);
    expect(id).toBe('c_1042');
  });

  it('should work with different prefixes', () => {
    const id1 = makeId('user', 100);
    expect(id1).toBe('user_100');

    const id2 = makeId('x', 0);
    expect(id2).toBe('x_0');
  });
});

describe('Prng', () => {
  it('should generate identical sequence with same seed', () => {
    const prng1 = new Prng(12345);
    const prng2 = new Prng(12345);

    const seq1: number[] = [];
    const seq2: number[] = [];

    for (let i = 0; i < 100; i++) {
      seq1.push(prng1.int(1000));
      seq2.push(prng2.int(1000));
    }

    expect(seq1).toEqual(seq2);
  });

  it('should generate different sequences with different seeds', () => {
    const prng1 = new Prng(12345);
    const prng2 = new Prng(54321);

    const seq1: number[] = [];
    const seq2: number[] = [];

    for (let i = 0; i < 100; i++) {
      seq1.push(prng1.int(1000));
      seq2.push(prng2.int(1000));
    }

    // Very unlikely to be equal
    expect(seq1).not.toEqual(seq2);
  });

  it('should pick uniformly from array', () => {
    const prng = new Prng(42);
    const arr = ['a', 'b', 'c'];
    const picked = prng.pick(arr);
    expect(arr).toContain(picked);
  });

  it('should return chance results as boolean', () => {
    const prng = new Prng(42);
    const result = prng.chance(0.5);
    expect(typeof result).toBe('boolean');
  });

  it('.int(max) should return values in range [0, max)', () => {
    const prng = new Prng(999);
    const max = 100;
    for (let i = 0; i < 1000; i++) {
      const val = prng.int(max);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(max);
    }
  });
});

describe('grep guard tests', () => {
  it('should not use Date.now( or Math.random( outside clock.ts and prng.ts', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const srcDir = join(__dirname, '../src');

    function getAllTypeScriptFiles(dir: string): string[] {
      const files: string[] = [];

      function walk(currentDir: string) {
        const entries = readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(currentDir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.name.endsWith('.ts')) {
            files.push(fullPath);
          }
        }
      }

      walk(dir);
      return files;
    }

    const files = getAllTypeScriptFiles(srcDir);
    const violations: string[] = [];

    for (const file of files) {
      const basename = file.split('/').pop() || '';
      const isAllowed = basename === 'clock.ts' || basename === 'prng.ts';

      const content = readFileSync(file, 'utf-8');

      if (!isAllowed) {
        if (content.includes('Date.now(')) {
          violations.push(`${file} contains Date.now(`);
        }
        if (content.includes('Math.random(')) {
          violations.push(`${file} contains Math.random(`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
