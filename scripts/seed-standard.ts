#!/usr/bin/env tsx
/**
 * Builds the committed standard template DB from scratch:
 *   delete existing file → fresh DDL → seedStandard(42) → close (checkpoints
 *   WAL) → hash the resulting bytes.
 *
 * The file is hashed AFTER `close()` because `close()` runs
 * `PRAGMA wal_checkpoint(TRUNCATE)` — hashing before that would capture a
 * main-file-plus-WAL state that does not match what `resetCrm`'s byte-copy
 * produces later, breaking the determinism guarantee this script exists to
 * prove (see task-4-report.md / task-3 carry-forward note).
 *
 * Usage: `npm run seed` (wired in package.json).
 */

import { existsSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openCrm, crmDbPath } from '../server/src/store/db.js';
import { seedStandard } from '../server/src/entities/seed.js';

const PROFILE = 'standard.template';

function main(): void {
  const dbPath = crmDbPath(PROFILE);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = dbPath + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }

  const crm = openCrm(PROFILE);
  const summary = seedStandard(crm, 42);
  crm.close();

  const bytes = readFileSync(dbPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const tableNames = Object.keys(summary).sort();
  const totalRows = tableNames.reduce((sum, t) => sum + (summary[t] ?? 0), 0);
  const width = Math.max(...tableNames.map((t) => t.length));

  console.log(`Seeded template: ${dbPath}`);
  console.log('');
  console.log('table'.padEnd(width) + '  rows');
  console.log('-'.repeat(width + 8));
  for (const t of tableNames) {
    console.log(`${t.padEnd(width)}  ${String(summary[t]).padStart(6)}`);
  }
  console.log('-'.repeat(width + 8));
  console.log(`${'TOTAL'.padEnd(width)}  ${String(totalRows).padStart(6)}`);
  console.log('');
  console.log(`bytes:  ${bytes.length}`);
  console.log(`sha256: ${sha256}`);
}

main();
