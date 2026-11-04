#!/usr/bin/env node
/**
 * Post-build asset copy: `tsc` only emits compiled `.js` from `.ts` sources
 * — it never touches the `*.skill.md` playbook files that live alongside
 * `src/playbooks/loader.ts`. Without this step, `dist/playbooks/` has no
 * markdown files at all, and `loadPlaybooks()` (whose default directory
 * resolves relative to the RUNNING module, i.e. `dist/playbooks` in
 * production) would otherwise silently see an empty directory. Plain
 * Node/fs so this runs identically on every platform `npm run build` does
 * (no shell-specific `cp`).
 */
import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url))); // server/
const srcDir = join(serverRoot, 'src', 'playbooks');
const distDir = join(serverRoot, 'dist', 'playbooks');

mkdirSync(distDir, { recursive: true });
const files = readdirSync(srcDir).filter((f) => f.endsWith('.skill.md'));
for (const file of files) {
  copyFileSync(join(srcDir, file), join(distDir, file));
}

console.log(`copy-playbooks: copied ${files.length} playbook file(s) into ${distDir}`);
