/**
 * Shared dependency bundle for Task 15's HTTP layer (LLD §6). Every
 * `register*Routes(app, deps)` function in `server/src/api/*.ts` takes the
 * SAME `AppDeps` shape and destructures only what it needs — `index.ts`
 * builds exactly one of these at boot.
 */

import type { Registry } from '../catalog/registry.js';
import type { EventLog } from '../events/log.js';
import type { SessionsDb } from '../store/sessions-db.js';
import type { Spans } from '../events/trace.js';
import type { SessionRuntime } from './turn-runtime.js';

export interface AppDeps {
  registry: Registry;
  eventLog: EventLog;
  /** Raw handle onto the SAME sqlite file `eventLog` persists to (LLD §3.1)
   * — used for the few operations `EventLog`'s interface deliberately
   * doesn't expose: session-title updates (LLD §6 "first 40 chars of first
   * message") and the admin-reset "mark EVERY session's refs stale" sweep
   * (`RefStore.markAllStale` only ever targets one session at a time). */
  sessionsDb: SessionsDb;
  spans: Spans;
  runtime: SessionRuntime;
  /** The CRM profile this server instance runs against (`PROFILE` env, LLD
   * §10) — `/admin/reset` resets exactly this profile. */
  profile: string;
}
