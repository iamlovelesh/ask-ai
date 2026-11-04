/**
 * Action registry (LLD §2.1 / task-7 brief). Combines every `m*.ts` module's
 * `ActionDef[]` (via `module-index.ts`) with the built-in `coreOps`
 * (`core-ops.ts`) into one lookup surface: `all()` / `get(slug)` /
 * `byModule(module)`.
 *
 * Loading strategy: static index, not filesystem/dynamic-import scanning.
 * `module-index.ts` is the single file a new module needs to touch (one
 * import + one array entry) — `registry.ts` itself never changes when a
 * module is added.
 */

import type { ActionDef } from './types.js';
import { coreOps } from './core-ops.js';
import { MODULE_ACTION_ARRAYS } from './module-index.js';

export interface Registry {
  all(): ActionDef[];
  get(slug: string): ActionDef | undefined;
  byModule(module: string): ActionDef[];
}

class RegistryImpl implements Registry {
  private readonly bySlug = new Map<string, ActionDef>();
  private readonly byModuleKey = new Map<string, ActionDef[]>();

  constructor(moduleActionArrays: readonly ActionDef[][], builtins: readonly ActionDef[]) {
    const allDefs = [...moduleActionArrays.flat(), ...builtins];
    for (const def of allDefs) {
      const existing = this.bySlug.get(def.slug);
      if (existing) {
        throw new Error(
          `Duplicate action slug '${def.slug}' (ids '${existing.id}' and '${def.id}')`,
        );
      }
      this.bySlug.set(def.slug, def);
      const bucket = this.byModuleKey.get(def.module);
      if (bucket) {
        bucket.push(def);
      } else {
        this.byModuleKey.set(def.module, [def]);
      }
    }
  }

  all(): ActionDef[] {
    return [...this.bySlug.values()];
  }

  get(slug: string): ActionDef | undefined {
    return this.bySlug.get(slug);
  }

  byModule(module: string): ActionDef[] {
    return [...(this.byModuleKey.get(module) ?? [])];
  }
}

/**
 * Build a registry from explicit inputs. Exported (in addition to
 * `createRegistry`) so tests can exercise duplicate-slug rejection without
 * mutating the real static module index.
 */
export function buildRegistry(
  moduleActionArrays: readonly ActionDef[][],
  builtins: readonly ActionDef[] = coreOps,
): Registry {
  return new RegistryImpl(moduleActionArrays, builtins);
}

/** Build a fresh registry from the static module index + core ops. */
export function createRegistry(): Registry {
  return buildRegistry(MODULE_ACTION_ARRAYS, coreOps);
}

/** Process-wide default registry instance. */
export const registry: Registry = createRegistry();
