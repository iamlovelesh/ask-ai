/**
 * Spawns/manages a REAL `server/src/index.ts` process for `eval/runner.ts`
 * (Task 16, LLD §9.2: "drives the REAL HTTP server (spawn `tsx
 * server/src/index.ts` on a per-shard port ... or accept --server-url)").
 *
 * Shard-local template handling (binding, from the brief): `/admin/reset`
 * (server/src/api/admin.ts) restores a profile's CRM db from
 * `server/data/crm-{profile}.template.db`. This module NEVER opens the
 * COMMITTED `crm-standard.template.db` for writing — it copies it ONCE,
 * at spawn time, to a shard-local template path keyed by that shard's own
 * profile name, so every `/admin/reset` call during the run restores from
 * the shard-local copy, never the committed artifact.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..');
export const SERVER_DIR = resolve(REPO_ROOT, 'server');
export const COMMITTED_TEMPLATE = resolve(SERVER_DIR, 'data/crm-standard.template.db');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

export interface SpawnedServer {
  baseUrl: string;
  profile: string;
  stop(): Promise<void>;
}

export interface SpawnServerOptions {
  port: number;
  /** Shard-local CRM profile name (e.g. `evalrun-<runId>-s1`) — NEVER
   * `'standard'` for a real run, so the committed template/db are never
   * touched. */
  profile: string;
  /** Set only for the offline MockLLM E2E proof (`eval/test/runner-
   * e2e.test.ts`) — wires `server/src/llm/mock-fetch.ts`'s boot hook. */
  mockLlmScript?: string;
  extraEnv?: Record<string, string>;
}

/** Copies the COMMITTED template to a shard-local template path matching
 * `profile` (`server/src/api/admin.ts`'s `templatePathFor` convention:
 * `server/data/crm-{profile}.template.db`). Returns the copy's path. */
export function prepareShardTemplate(profile: string): string {
  const dest = resolve(SERVER_DIR, `data/crm-${profile}.template.db`);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(COMMITTED_TEMPLATE, dest);
  return dest;
}

/** Every shard/eval-local profile this module ever generates matches this
 * prefix (`shardProfileName` in `eval/runner.ts`, and this module's own
 * test-only callers). Anything NOT matching it — most importantly the
 * real `'standard'` profile — is a benchmark-destroying foot-gun to ever
 * delete files for, so `cleanupShardFiles` refuses outright rather than
 * trying to special-case `'standard'` alone (stricter is safer: an
 * unanticipated future profile name is ALSO rejected, not just the one
 * name anyone thought to block). */
const SHARD_PROFILE_RE = /^evalrun-/;

/**
 * I4 (Task 16 review) + follow-up review (shard-cleanup guard): deletes
 * every shard-local CRM file this module ever creates for `profile` —
 * `.db`, its WAL/SHM/journal sidecars, AND the shard-local `.template.db`
 * copy (`prepareShardTemplate`). Safe to call even if some/none of these
 * exist. `.gitignore` un-ignores `*.template.db` (so the COMMITTED
 * artifact stays trackable) — which means a shard-local template copy
 * left on disk after a run would show up as an untracked file a broad
 * `git add -A` could sweep in; this is what keeps a real eval run from
 * leaking those into the working tree.
 *
 * THROWS if `profile` doesn't match `/^evalrun-/` — in particular, this
 * means a call with `profile: 'standard'` throws rather than deleting
 * `server/data/crm-standard.db` AND the COMMITTED
 * `crm-standard.template.db` fixture. An explicit `--profile standard`
 * CLI invocation (no `--server-url`) is exactly the scenario this guards
 * against; `eval/runner.ts`'s `parseArgs` additionally refuses that
 * combination outright before a server is even spawned (belt and
 * suspenders — this function's own guard is what actually protects any
 * OTHER caller, present or future, that might pass a profile through
 * without going via `parseArgs` at all).
 */
export function cleanupShardFiles(profile: string): void {
  if (!SHARD_PROFILE_RE.test(profile)) {
    throw new Error(
      `cleanupShardFiles refuses to touch profile '${profile}' — it must match /^evalrun-/. ` +
        "Deleting files for 'standard' (or any other non-shard profile) would destroy the " +
        'committed crm-standard.template.db fixture and/or the live crm-standard.db.',
    );
  }
  const base = resolve(SERVER_DIR, `data/crm-${profile}`);
  for (const suffix of ['.db', '.db-wal', '.db-shm', '.db-journal', '.template.db']) {
    const path = `${base}${suffix}`;
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

export async function waitForHealth(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // Not accepting connections yet — retry until the deadline.
    }
    if (Date.now() >= deadline) {
      throw new Error(`eval server at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Spawns `tsx server/src/index.ts` with the given port/profile/env and
 * returns a handle once the process has been started (NOT once it's
 * healthy — call `waitForHealth(baseUrl)` separately so callers can decide
 * their own timeout/retry policy). */
export function spawnServer(opts: SpawnServerOptions): SpawnedServer {
  prepareShardTemplate(opts.profile);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(opts.port),
    PROFILE: opts.profile,
    VIRTUAL_NOW: process.env['VIRTUAL_NOW'] ?? '2026-11-04T10:00:00Z',
    // Never 'production' — this is what keeps the `/admin/inject-failure`
    // test-only route and the `MOCK_LLM_SCRIPT` boot hook reachable.
    NODE_ENV: process.env['NODE_ENV'] === 'production' ? 'development' : (process.env['NODE_ENV'] ?? 'development'),
    ADMIN_TEST_HOOKS: '1',
    ...opts.extraEnv,
  };
  // Conversational-reply polish (Feature C) is a UX-only, cost-adding extra
  // LLM call that must NEVER run under the benchmark — it would skew every
  // metric and perturb answer text the eval asserts on. The eval runner can
  // inherit `COMPOSER_POLISH=1` from the operator's shell (`set -a; source
  // .env`), so strip it explicitly from every spawned eval server's env,
  // regardless of how it got into `process.env`/`extraEnv`.
  delete env['COMPOSER_POLISH'];
  if (opts.mockLlmScript) env['MOCK_LLM_SCRIPT'] = opts.mockLlmScript;

  const child: ChildProcess = spawn(TSX_BIN, ['src/index.ts'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });

  let stopped = false;
  child.on('exit', (code) => {
    if (!stopped && code !== 0) {
      process.stderr.write(
        `\n[eval] server process for profile '${opts.profile}' exited early (code ${code}):\n${stderrTail}\n`,
      );
    }
  });

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    child.kill('SIGTERM');
    await new Promise<void>((res) => {
      const timer = setTimeout(() => res(), 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        res();
      });
    });
    // I4 (Task 16 review): clean up this shard's CRM file + its
    // shard-local template copy now that the server holding the sqlite
    // handle has actually exited (deleting while it's still open risks a
    // race on some platforms; waiting for 'exit' above already blocks
    // until the process is gone, or the 5s grace timer fires).
    cleanupShardFiles(opts.profile);
  }

  return { baseUrl: `http://127.0.0.1:${opts.port}`, profile: opts.profile, stop };
}
