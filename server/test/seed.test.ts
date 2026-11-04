import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ENTITY_MODEL, STRUCTURE_KINDS, RECORD_KINDS } from '../src/entities/model';
import { seedStandard } from '../src/entities/seed';
import type { SeedSummary } from '../src/entities/seed-types';
import { openCrm, crmDbPath, closeRegistered, type Crm } from '../src/store/db';
import { VirtualClock } from '../src/store/clock';

const PROFILE = 'test-seed';

function cleanup(profile: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = crmDbPath(profile) + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

describe('seedStandard', () => {
  let crm: Crm;
  let summary: SeedSummary;
  const clock = new VirtualClock();
  const weekStart = clock.startOfWeek(-1);
  const weekEnd = clock.startOfWeek(0);

  beforeAll(() => {
    cleanup(PROFILE);
    crm = openCrm(PROFILE);
    summary = seedStandard(crm, 42);
  });

  afterAll(() => {
    closeRegistered(PROFILE);
    cleanup(PROFILE);
  });

  it('returns a summary with every ENTITY_MODEL table represented and non-empty', () => {
    for (const t of ENTITY_MODEL) {
      expect(summary[t.name], `${t.name} should be seeded`).toBeGreaterThan(0);
    }
  });

  it('seeds ~50k rows total, weighted per the brief (contacts/messages/leads)', () => {
    const total = Object.values(summary).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(35_000);
    expect(total).toBeLessThan(70_000);
    expect(summary['contacts']).toBeGreaterThanOrEqual(10_000);
    expect(summary['messages']).toBeGreaterThanOrEqual(10_000);
    expect(summary['leads']).toBeGreaterThanOrEqual(4_000);
  });

  it('row counts land within expected per-table ranges', () => {
    const ranges: Record<string, [number, number]> = {
      teams: [5, 10],
      users: [30, 50],
      companies: [800, 2000],
      contacts: [10_000, 14_000],
      structures: [300, 500],
      leads: [4_000, 6_000],
      opportunities: [800, 1_500],
      tasks: [1_000, 2_000],
      notes: [800, 1_500],
      conversations: [1_000, 2_000],
      messages: [10_000, 20_000],
      appointments: [500, 1_000],
      events: [30, 80],
      products: [100, 250],
      quotes: [300, 600],
      invoices: [600, 1_000],
      orders: [600, 1_000],
      line_items: [1_500, 8_000],
      payments: [700, 1_100],
      subscriptions: [150, 350],
      content_items: [100, 250],
      courses: [30, 80],
      participations: [700, 1_100],
      reviews: [250, 500],
      support_tickets: [250, 500],
      records: [700, 1_100],
    };
    for (const [table, [min, max]] of Object.entries(ranges)) {
      expect(summary[table], `${table} >= ${min}`).toBeGreaterThanOrEqual(min);
      expect(summary[table], `${table} <= ${max}`).toBeLessThanOrEqual(max);
    }
  });

  it('every STRUCTURE_KINDS kind has at least one row', () => {
    for (const kind of STRUCTURE_KINDS) {
      const row = crm.tx((db) => db.get('SELECT COUNT(*) as c FROM structures WHERE kind = ?', [kind]));
      expect(Number(row?.['c']), kind).toBeGreaterThan(0);
    }
  });

  it('every RECORD_KINDS kind has at least one row', () => {
    for (const kind of RECORD_KINDS) {
      const row = crm.tx((db) => db.get('SELECT COUNT(*) as c FROM records WHERE kind = ?', [kind]));
      expect(Number(row?.['c']), kind).toBeGreaterThan(0);
    }
  });

  it('guarantees >= 200 leads created within the previous calendar week', () => {
    const row = crm.tx((db) =>
      db.get('SELECT COUNT(*) as c FROM leads WHERE created_at >= ? AND created_at < ?', [weekStart, weekEnd]),
    );
    expect(Number(row?.['c'])).toBeGreaterThanOrEqual(200);
  });

  it('last-week leads have a realistic source/owner spread, not a single dummy value', () => {
    const rows = crm.tx((db) =>
      db.all('SELECT source, owner_id, created_at FROM leads WHERE created_at >= ? AND created_at < ?', [
        weekStart,
        weekEnd,
      ]),
    );
    const sources = new Set(rows.map((r) => r['source']));
    const owners = new Set(rows.map((r) => r['owner_id']));
    const createdTimes = new Set(rows.map((r) => r['created_at']));
    const requiredSources = ['facebook', 'google', 'referral', 'website'];
    const present = requiredSources.filter((s) => sources.has(s));
    expect(present.length, `expected most of ${requiredSources.join(',')} to appear`).toBeGreaterThanOrEqual(3);
    expect(owners.size, 'owners should be mixed').toBeGreaterThanOrEqual(3);
    expect(createdTimes.size, 'timestamps should be spread, not identical').toBeGreaterThan(50);
  });

  it('guarantees >= 40 invoices overdue by more than 15 days', () => {
    const cutoff = clock.now() - 15 * 24 * 60 * 60 * 1000;
    const row = crm.tx((db) =>
      db.get("SELECT COUNT(*) as c FROM invoices WHERE status = 'issued' AND due_date < ?", [cutoff]),
    );
    expect(Number(row?.['c'])).toBeGreaterThanOrEqual(40);
  });

  it('guarantees >= 25 unreplied open conversations', () => {
    const row = crm.tx((db) =>
      db.get(
        "SELECT COUNT(*) as c FROM conversations WHERE status = 'open' AND (last_outbound_at IS NULL OR last_inbound_at > last_outbound_at)",
      ),
    );
    expect(Number(row?.['c'])).toBeGreaterThanOrEqual(25);
  });

  it('guarantees >= 8 active sales-rep users', () => {
    const row = crm.tx((db) => db.get("SELECT COUNT(*) as c FROM users WHERE role = 'sales_rep' AND active = 1"));
    expect(Number(row?.['c'])).toBeGreaterThanOrEqual(8);
  });

  it('is deterministic in-process: same seed on a fresh db yields identical SeedSummary', () => {
    cleanup('test-seed-repeat');
    const crm2 = openCrm('test-seed-repeat');
    try {
      const summary2 = seedStandard(crm2, 42);
      expect(summary2).toEqual(summary);
    } finally {
      crm2.close();
      cleanup('test-seed-repeat');
    }
  });
});

// --- real `npm run seed` path: byte-identical template across two runs ---
//
// Carry-forward from Task 3 review: the committed template MUST be produced
// via the store's own close() path (WAL checkpoint TRUNCATE), snapshotted
// only after close. This test exercises the REAL `scripts/seed-standard.ts`
// entry point (not a shortcut) so a regression there is caught, not just a
// regression in `seedStandard` itself.
describe('scripts/seed-standard.ts (real path)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = resolve(__dirname, '../..');
  const SCRIPT = resolve(REPO_ROOT, 'scripts/seed-standard.ts');
  const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');
  const TEMPLATE_PATH = resolve(REPO_ROOT, 'server/data/crm-standard.template.db');

  function runSeedScript(): string {
    execFileSync(TSX_BIN, [SCRIPT], { cwd: REPO_ROOT, stdio: 'ignore' });
    const bytes = readFileSync(TEMPLATE_PATH);
    return createHash('sha256').update(bytes).digest('hex');
  }

  it(
    'produces a byte-identical crm-standard.template.db across two full runs',
    () => {
      const hash1 = runSeedScript();
      const hash2 = runSeedScript();
      expect(hash1).toBe(hash2);
    },
    60_000,
  );
});
