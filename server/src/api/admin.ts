/**
 * Admin routes (LLD §6): `POST /admin/reset?profile&seed` (CRM
 * template-restore + session-wide ref staleness) and `GET /admin/catalog`
 * (module/action listing). Also (Task 16, TEST-ONLY): `POST
 * /admin/inject-failure` — see the route below for the guard.
 */

import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { crmDbPath } from '../store/db.js';
import { resetCrm } from '../store/reset.js';
import { clearFailureInjections, registerFailureInjection } from '../catalog/inject-failures.js';
import type { ActionErrorCode } from '../catalog/types.js';
import type { AppDeps } from './types.js';

const ACTION_ERROR_CODES: readonly ActionErrorCode[] = [
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'TRANSIENT',
  'FORBIDDEN',
  'LIMIT_EXCEEDED',
];

/** `eval/runner.ts`'s `injectFailures` scenario field (LLD §9.1 / Task 16)
 * needs a way to force a named action to fail deterministically — a real
 * production deployment must NEVER expose this (it lets any caller make
 * arbitrary actions throw). Mirrors the brief's own guard wording: enabled
 * when either NODE_ENV isn't 'production', or the operator opted in
 * explicitly via ADMIN_TEST_HOOKS=1 (e.g. a prod-like staging box running
 * the eval matrix). */
function adminTestHooksEnabled(): boolean {
  return process.env['NODE_ENV'] !== 'production' || process.env['ADMIN_TEST_HOOKS'] === '1';
}

const injectFailureBodySchema = z.object({
  action: z.string().min(1),
  code: z.enum(ACTION_ERROR_CODES as [ActionErrorCode, ...ActionErrorCode[]]),
  times: z.number().int().positive(),
});

const resetQuerySchema = z.object({
  profile: z.string().min(1).optional(),
  // Accepted for forward-compat with LLD §6's `?profile&seed` signature —
  // NOT used: `resetCrm` is a close→copy-template→reopen restore (Task 3),
  // not a re-seed-with-arbitrary-seed operation. The committed template
  // (`crm-standard.template.db`) is fixed at seed 42 (Task 4). A future
  // re-seed-on-demand feature would consume this; today it's a documented
  // no-op so the query param doesn't 400.
  seed: z.coerce.number().optional(),
});

/** `server/data/crm-{profile}.template.db` — sibling of `crmDbPath`'s own
 * `crm-{profile}.db` convention (Task 3/4), derived without needing a
 * second exported constant from `store/db.ts`. */
function templatePathFor(profile: string): string {
  return join(dirname(crmDbPath(profile)), `crm-${profile}.template.db`);
}

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { sessionsDb, registry, profile: defaultProfile } = deps;

  app.post('/admin/reset', async (req, reply) => {
    const parsed = resetQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_query', details: parsed.error.issues });
      return;
    }
    const profile = parsed.data.profile ?? defaultProfile;

    const startedAtMs = performance.now();
    try {
      await resetCrm(profile, templatePathFor(profile));
    } catch (err) {
      // `resetCrm` throws exactly one message shape for "the template file
      // doesn't exist" (`store/reset.ts`: `reset template not found: ...`)
      // — that's the only case that's really a 404 (bad `?profile`). Any
      // OTHER failure (copy/close/reopen I/O error, corrupted template,
      // permissions) is a server-side problem, not a client-input one, and
      // blanket-404ing it would misreport a real failure as "just pick a
      // different profile".
      const message = err instanceof Error ? err.message : String(err);
      const templateMissing = message.includes('reset template not found');
      reply
        .code(templateMissing ? 404 : 500)
        .send({ error: templateMissing ? 'template_not_found' : 'reset_failed', message });
      return;
    }

    // Mark EVERY session's refs stale (LLD §3.2/§5) — not just one session,
    // so this goes straight at the shared `sessions.db` `refs` table rather
    // than through `RefStore.markAllStale(sessionId)`, which only ever
    // targets a single session.
    sessionsDb.run(`UPDATE refs SET stale = 1`);

    // C1 (Task 16 review, CRITICAL): clear every pending test-only failure
    // injection on every reset. Without this, an UNDER-consumed injection
    // (e.g. `times:2` registered but the scenario's plan only dispatched
    // the action once before the turn ended) silently carries into the
    // NEXT tuple's run — which resets the CRM data but, before this fix,
    // left the injection map untouched — making a later scenario's
    // completely unrelated call to the same action slug fail for a reason
    // that has nothing to do with that scenario. `/admin/reset` already is
    // "start this tuple over from a known-clean state" for the CRM; the
    // injection map is exactly the same kind of per-tuple state and must
    // be reset alongside it.
    clearFailureInjections();

    const ms = performance.now() - startedAtMs;
    reply.send({ ms });
  });

  app.get('/admin/catalog', async (_req, reply) => {
    const byModule = new Map<string, { id: string; slug: string; name: string; description: string; risk: string; entities: string[] }[]>();
    for (const action of registry.all()) {
      const bucket = byModule.get(action.module);
      const row = {
        id: action.id,
        slug: action.slug,
        name: action.name,
        description: action.description,
        risk: action.risk,
        entities: action.entities,
      };
      if (bucket) {
        bucket.push(row);
      } else {
        byModule.set(action.module, [row]);
      }
    }
    const modules = [...byModule.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([module, actions]) => ({ module, actions: actions.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)) }));
    reply.send({ modules });
  });

  // --- POST /admin/inject-failure (TEST-ONLY — see adminTestHooksEnabled) ---

  if (adminTestHooksEnabled()) {
    app.post('/admin/inject-failure', async (req, reply) => {
      const parsed = injectFailureBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
        return;
      }
      if (!registry.get(parsed.data.action)) {
        reply.code(404).send({ error: 'action_not_found', action: parsed.data.action });
        return;
      }
      registerFailureInjection(parsed.data.action, parsed.data.code, parsed.data.times);
      reply.code(204).send();
    });
  }
}
