/**
 * Single reset mechanism (LLD §3.2, §5): close the live sqlite handle, copy the
 * committed template file over the profile DB, reopen. Returns elapsed ms
 * (budget <300ms; template-copy approach makes this O(file size), not O(rows)).
 *
 * Callers are responsible for marking session `refs` stale afterwards (that
 * lives in the session store, a different task).
 */

import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { openCrm, crmDbPath, closeRegistered } from './db.js';

/**
 * Restore `crm-{profile}.db` from `templatePath`.
 *
 * close → copy → reopen. The reopened handle is registered as the live
 * connection for the profile; callers that held a prior `Crm` must re-`openCrm`.
 */
export async function resetCrm(
  profile: string,
  templatePath: string,
): Promise<{ ms: number }> {
  if (!existsSync(templatePath)) {
    throw new Error(`reset template not found: ${templatePath}`);
  }
  const start = performance.now();

  // 1. Close the live handle (checkpoints + releases file locks).
  closeRegistered(profile);

  // 2. Clear any leftover WAL/SHM sidecars so the copy is the only on-disk state.
  const dbPath = crmDbPath(profile);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = dbPath + suffix;
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }

  // 3. Copy template bytes over the profile DB.
  copyFileSync(templatePath, dbPath);

  // 4. Reopen (registers the fresh handle; idempotent pragmas/DDL only).
  openCrm(profile);

  return { ms: performance.now() - start };
}
