/**
 * Test-only failure injection (Task 16 / LLD §9.1 `Scenario.injectFailures`):
 * lets `eval/runner.ts` force a named action to throw a specific
 * `ActionError` for its next N dispatches, so scenarios can exercise the
 * executor's TRANSIENT retry, stuck-detection (×3/×4), and joiner-repair
 * paths deterministically instead of hoping a real handler happens to fail.
 *
 * Wraps `Registry.get`/`all`/`byModule` so EVERY dispatch site — the
 * optimized executor (`agent/executor.ts`'s `registry.get(step.action)`)
 * and the baseline agent (`baseline/agent.ts`'s `registry.get(decision.slug)`)
 * — gets the SAME wrapped `ActionDef` without either module knowing
 * injection exists. The wrap itself is a no-op (zero behavior change) when
 * the injection map is empty, so wiring it unconditionally in `index.ts` is
 * safe; what's actually gated behind `ADMIN_TEST_HOOKS`/`NODE_ENV` is the
 * HTTP endpoint that POPULATES the map (`api/admin.ts`), not this wrapper.
 *
 * State is process-wide (module-level `Map`), matching `llm/client.ts`'s
 * `costMeter` convention — a single eval server process handles one shard's
 * tuples sequentially, so there is no cross-request leakage within a trial;
 * a scenario's `times` count is expected to exactly match the number of
 * calls the plan will make to that action, so the injection naturally
 * exhausts itself by the end of the trial it was registered for.
 */

import type { ActionDef, ActionErrorCode } from './types.js';
import { ActionError } from './types.js';
import type { Registry } from './registry.js';

interface Injection {
  code: ActionErrorCode;
  remaining: number;
}

const injections = new Map<string, Injection>();

/** `POST /admin/inject-failure` handler calls this (api/admin.ts). */
export function registerFailureInjection(action: string, code: ActionErrorCode, times: number): void {
  injections.set(action, { code, remaining: times });
}

/** Test-only: drop every pending injection (e.g. between eval trials that
 * don't want to risk a leftover unconsumed count bleeding into the next
 * scenario). Not wired to any HTTP route today — exported for test/runner use. */
export function clearFailureInjections(): void {
  injections.clear();
}

function wrapAction(def: ActionDef): ActionDef {
  return {
    ...def,
    handler: async (input, ctx) => {
      const injection = injections.get(def.slug);
      if (injection && injection.remaining > 0) {
        injection.remaining -= 1;
        if (injection.remaining <= 0) injections.delete(def.slug);
        throw new ActionError(
          injection.code,
          `[injected failure] '${def.slug}' forced to fail with ${injection.code} (eval/runner.ts injectFailures)`,
        );
      }
      return def.handler(input, ctx);
    },
  };
}

/** Wraps a `Registry` so every `ActionDef` it hands out passes through the
 * injection check above before the real handler ever runs. */
export function withFailureInjection(registry: Registry): Registry {
  return {
    all: () => registry.all().map(wrapAction),
    get: (slug: string) => {
      const def = registry.get(slug);
      return def ? wrapAction(def) : undefined;
    },
    byModule: (module: string) => registry.byModule(module).map(wrapAction),
  };
}
