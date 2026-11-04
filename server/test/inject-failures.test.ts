/**
 * Task 16 — `catalog/inject-failures.ts`: the test-only failure-injection
 * wrapper `eval/runner.ts`'s `injectFailures` scenario field drives via
 * `POST /admin/inject-failure`. Unit-level only (no HTTP) — registers an
 * injection, confirms the wrapped handler throws the SAME `ActionError`
 * code for exactly `times` calls, then falls back to the real handler.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import { clearFailureInjections, registerFailureInjection, withFailureInjection } from '../src/catalog/inject-failures';
import { buildRegistry } from '../src/catalog/registry';
import { coreOps } from '../src/catalog/core-ops';
import { ActionError, type ActionDef, type ActionContext } from '../src/catalog/types';
import type { StoreTx } from '../src/store/db';
import { VirtualClock } from '../src/store/clock';

function action(slug: string, handler: ActionDef['handler']): ActionDef {
  return {
    id: slug,
    slug,
    module: slug.split('.')[0] as string,
    name: slug,
    description: slug,
    risk: 'read',
    entities: [slug.split('.')[0] as string],
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.any(),
    searchCard: { synonyms: [], examplePhrasings: [] },
    handler,
  };
}

const noopTx: StoreTx = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const ctx: ActionContext = { db: noopTx, clock: new VirtualClock(), idempotencyKey: 'test:0:s1:0', format: 'concise' };

beforeEach(() => {
  clearFailureInjections();
});

describe('withFailureInjection', () => {
  it('is a no-op pass-through when nothing has been injected', async () => {
    const registry = buildRegistry([[action('m.ok', async () => ({ ok: true }))]], coreOps);
    const wrapped = withFailureInjection(registry);
    const result = await wrapped.get('m.ok')?.handler({}, ctx);
    expect(result).toEqual({ ok: true });
  });

  it('forces the named action to throw the injected ActionError for exactly `times` calls', async () => {
    let realCalls = 0;
    const registry = buildRegistry(
      [[action('m.flaky', async () => {
        realCalls += 1;
        return { ok: true };
      })]],
      coreOps,
    );
    registerFailureInjection('m.flaky', 'TRANSIENT', 2);
    const wrapped = withFailureInjection(registry);
    const def = wrapped.get('m.flaky');
    if (!def) throw new Error('unreachable');

    await expect(def.handler({}, ctx)).rejects.toThrow(ActionError);
    await expect(def.handler({}, ctx)).rejects.toMatchObject({ code: 'TRANSIENT' });
    // Third call: injection exhausted — falls through to the real handler.
    const result = await def.handler({}, ctx);
    expect(result).toEqual({ ok: true });
    expect(realCalls).toBe(1);
  });

  it('wraps every action returned by all()/byModule() the same way', async () => {
    const registry = buildRegistry([[action('m.a', async () => ({ v: 1 })), action('m.b', async () => ({ v: 2 }))]], coreOps);
    registerFailureInjection('m.a', 'FORBIDDEN', 1);
    const wrapped = withFailureInjection(registry);

    const fromAll = wrapped.all().find((d) => d.slug === 'm.a');
    await expect(fromAll?.handler({}, ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const fromModule = wrapped.byModule('m').find((d) => d.slug === 'm.b');
    expect(await fromModule?.handler({}, ctx)).toEqual({ v: 2 });
  });

  it('getting an unknown slug stays undefined', () => {
    const registry = buildRegistry([[action('m.a', async () => ({}))]], coreOps);
    expect(withFailureInjection(registry).get('m.nope')).toBeUndefined();
  });
});
