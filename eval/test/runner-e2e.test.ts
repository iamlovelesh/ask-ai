/**
 * Task 16 — the ONE required full-loop E2E proof (LLD §9.3): spawn a REAL
 * `server/src/index.ts` process, `/admin/reset` a shard-local CRM db
 * copied from the committed template, drive the "direct" seed scenario
 * over the real SSE channel, evaluate `eval/assert.ts`, and produce a
 * JSONL-shaped `ResultRow` — all with `MOCK_LLM_SCRIPT` (server/src/llm/
 * mock-fetch.ts's boot hook) standing in for the real OpenRouter call, so
 * the whole thing runs offline with zero network calls and zero cost.
 *
 * This is deliberately the ONLY test in the suite that spawns a real
 * child process and binds a real TCP port — everything else in
 * `eval/test/` is a pure-function test against fixtures.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReadOnly, type SqlDb } from '../db';
import { runTuple } from '../runner';
import { SERVER_DIR, spawnServer, waitForHealth, type SpawnedServer } from '../runner-process';
import { loadScenarios, planTuples } from '../runner-tuples';

const here = fileURLToPath(new URL('.', import.meta.url));
const EVAL_DIR = resolve(here, '..');
const MOCK_SCRIPT = resolve(EVAL_DIR, 'mock-scripts/direct-search-leads.json');
// Spread the port across the process pid so two `vitest` workers running
// this file concurrently (unlikely — it's one file — but also across an
// accidental re-run) don't collide on the same port.
const PORT = 3800 + (process.pid % 400);
const PROFILE = `e2e-test-${process.pid}`;

describe('runner E2E — direct seed scenario, real spawned server, MockLLM', () => {
  let server: SpawnedServer;
  let db: SqlDb | undefined;

  beforeAll(async () => {
    server = spawnServer({ port: PORT, profile: PROFILE, mockLlmScript: MOCK_SCRIPT });
    await waitForHealth(server.baseUrl, 30_000);
  }, 40_000);

  afterAll(async () => {
    db?.close();
    await server?.stop();
    // `.gitignore` un-ignores `*.template.db` (the committed artifact needs
    // to be trackable) — this test's shard-local copy + working db must
    // not linger as an untracked file some later `git add -A` could sweep
    // up, so delete every file this test's profile created.
    for (const suffix of ['.db', '.db-wal', '.db-shm', '.db-journal', '.template.db']) {
      const path = resolve(SERVER_DIR, `data/crm-${PROFILE}${suffix}`);
      if (existsSync(path)) rmSync(path, { force: true });
    }
  });

  it('spawn -> reset -> SSE -> assert -> JSONL row, fully offline', async () => {
    const scenarios = loadScenarios(resolve(EVAL_DIR, 'scenarios')).filter((s) => s.id === 'direct-search-leads');
    expect(scenarios).toHaveLength(1);

    const tuples = planTuples(scenarios, { agent: 'optimized', trials: 1 });
    expect(tuples).toHaveLength(1);
    const tuple = tuples[0];
    if (!tuple) throw new Error('unreachable: tuples has length 1');

    db = openReadOnly(resolve(SERVER_DIR, `data/crm-${PROFILE}.db`));

    const row = await runTuple({ baseUrl: server.baseUrl, db }, tuple);

    // The full loop actually ran: reset -> session -> SSE turn -> assert.
    expect(row.scenarioId).toBe('direct-search-leads');
    expect(row.category).toBe('direct');
    expect(row.agent).toBe('optimized');
    expect(row.trial).toBe(1);
    expect(row.turns).toHaveLength(1);

    const turn = row.turns[0];
    expect(turn?.status).toBe('done');
    expect(turn?.llmCalls).toBe(1); // exactly the one scripted plan.ready call
    expect(turn?.complex).toBe(false); // single-step plan
    expect(turn?.failures).toEqual([]);
    expect(row.pass).toBe(true);

    // JSONL-shape sanity — this is EXACTLY what eval/runner.ts appends to
    // results/<runid>/results.jsonl per completed tuple.
    const line = JSON.stringify(row);
    expect(JSON.parse(line)).toEqual(row);
  }, 30_000);
});
