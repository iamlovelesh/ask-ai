import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Deterministic CI/eval runs: `llm/client.ts`'s test seams
    // (`__setTestFetch`/`__setTestSpans`/`__setTestBackoffOptions`,
    // `costMeter`) are module-level mutable state, and running test FILES
    // across multiple workers lets one file's seam override race another's
    // mid-turn, producing intermittent MockLLM-queue-count mismatches in
    // unrelated test files (confirmed on `main` before Task 15, via
    // `git stash`). Disabling file parallelism is the correct scope for
    // this fix — the root cause (module-scoped, not per-run-scoped, seams
    // in `llm/client.ts`) is deferred; this just makes the authoritative
    // test command (`npm -w server run test`, run with cwd=`server/`)
    // reliable for CI/eval today.
    //
    // NOTE: the repo-root `vitest.config.ts` is NOT loaded for this
    // invocation — vitest resolves its config relative to cwd, and `npm -w
    // server run test` runs `vitest run` with cwd=`server/`, which never
    // climbs to the parent directory looking for a config file. This file
    // is the one that actually governs `npm -w server run test`.
    fileParallelism: false,
  },
});
