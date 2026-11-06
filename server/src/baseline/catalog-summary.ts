/**
 * Baseline catalog summary (LLD §8): a compact, module-grouped text catalog
 * of all 500 registered actions (slug + one-liner) — resent VERBATIM in the
 * baseline ReAct system prompt on EVERY loop step. That repetition is the
 * baseline's defining cost trade-off against the optimized agent's
 * retrieval-shortlisted ~20-card context (LLD §8: "resent per step — that's
 * the point of the baseline").
 *
 * `core.*` built-in data ops (LLD §2.2) are DELIBERATELY excluded here: they
 * are deterministic pseudo-actions that operate on already-resolved `$ref`
 * arrays inside the optimized agent's executor — the baseline's single
 * `call_action{slug,params}` tool has no ref-resolution environment to run
 * them against, and the LLD's "500 actions" scope is exactly the catalog's
 * 500 real `ActionDef`s, not the 6 core ops layered on top for the planner's
 * Plan DSL.
 */

import type { ActionDef } from '../catalog/types.js';
import type { Registry } from '../catalog/registry.js';
import { canUseAction, type Principal } from '../agent/permissions.js';

/**
 * `chars / 4` — the standard rough token-count estimator for English text.
 * No tokenizer dependency; good enough for the ~12k-token BUDGET this
 * module's test asserts against. NOT used for billing — real token/cost
 * accounting always comes from the API's own usage block (`llm/client.ts`).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function titleCaseModule(moduleKey: string): string {
  return moduleKey
    .split('_')
    .map((w) => (w.length > 0 ? `${w[0]!.toUpperCase()}${w.slice(1)}` : w))
    .join(' ');
}

/** Groups by `ActionDef.module`, preserving `registry.all()`'s iteration
 * order (M01…M50, since `RegistryImpl` is backed by insertion-ordered Maps
 * and `module-index.ts` lists modules in that order) — a module's actions
 * never interleave with another's, and modules appear in catalog order. */
function groupByModule(actions: readonly ActionDef[]): Map<string, ActionDef[]> {
  const byModule = new Map<string, ActionDef[]>();
  for (const a of actions) {
    const bucket = byModule.get(a.module);
    if (bucket) bucket.push(a);
    else byModule.set(a.module, [a]);
  }
  return byModule;
}

/**
 * Builds the full catalog summary text: one `## <Module Name>` header per
 * module, followed by one `- <slug>: <description>` line per action.
 * Deterministic for a given `registry` (no randomness, no wall-clock) — safe
 * to snapshot-test byte-for-byte.
 */
export function buildCatalogSummary(registry: Registry, principal?: Principal): string {
  const actions = registry
    .all()
    .filter((a) => !a.slug.startsWith('core.'))
    // Permission pruning (#1): a restricted principal is not told about
    // actions it may not use. Undefined principal = admin = everything.
    .filter((a) => (principal ? canUseAction(principal, a) : true));
  const byModule = groupByModule(actions);

  const lines: string[] = [];
  for (const [moduleKey, defs] of byModule) {
    lines.push(`## ${titleCaseModule(moduleKey)}`);
    for (const def of defs) {
      lines.push(`- ${def.slug}: ${def.description}`);
    }
  }
  return lines.join('\n');
}
