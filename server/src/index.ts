import './env.js';
import Fastify from 'fastify';
import { createRegistry } from './catalog/registry.js';
import { withFailureInjection } from './catalog/inject-failures.js';
import { getCrm } from './store/db.js';
import { wallClockNow } from './store/clock.js';
import { openEventLog } from './events/log.js';
import { openSessions, sessionsDbPath } from './store/sessions-db.js';
import { openSpans } from './events/trace.js';
import { loadPlaybooks } from './playbooks/loader.js';
import { installMockLlmFromEnv } from './llm/mock-fetch.js';
import { SessionRuntime } from './api/turn-runtime.js';
import { registerSessionsRoutes } from './api/sessions.js';
import { registerStreamRoutes } from './api/stream.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerMetricsRoutes } from './api/metrics.js';
import { registerMemoryRoutes } from './api/memory.js';
import { registerRecordRoutes } from './api/records.js';
import type { AppDeps } from './api/types.js';

const PORT = Number(process.env['PORT'] ?? 3000);
const PROFILE = process.env['PROFILE'] ?? 'standard';

function currentNow(): string {
  return process.env['VIRTUAL_NOW'] ?? new Date().toISOString();
}

const app = Fastify({
  logger: true,
});

app.get('/api/health', async () => {
  return { ok: true, now: currentNow() };
});

async function start(): Promise<void> {
  try {
    // Task 16 (eval/runner.ts) offline E2E hook: MOCK_LLM_SCRIPT + non-prod
    // NODE_ENV wires a scripted fetch into every llmCall for this process's
    // lifetime. No-op when unset — see llm/mock-fetch.ts's header.
    installMockLlmFromEnv();

    // --- boot wiring (LLD §6/§11): open stores, load playbooks, build
    // deps, register routes.
    //
    // `withFailureInjection` wraps the registry unconditionally (Task 16):
    // it is a no-op pass-through when nothing has been injected, and what's
    // actually gated behind NODE_ENV/ADMIN_TEST_HOOKS is the HTTP endpoint
    // that populates the injection map (api/admin.ts), not this wrap.
    const registry = withFailureInjection(createRegistry());
    const playbooks = loadPlaybooks(registry);
    const eventLog = openEventLog();
    const sessionsDb = openSessions(sessionsDbPath());
    const spans = openSpans();
    getCrm(PROFILE); // ensure the configured CRM profile is open at boot.

    const runtime = new SessionRuntime(sessionsDb, eventLog, registry, playbooks, () => getCrm(PROFILE));

    const deps: AppDeps = {
      registry,
      eventLog,
      sessionsDb,
      spans,
      runtime,
      profile: PROFILE,
    };

    registerSessionsRoutes(app, deps);
    registerStreamRoutes(app, deps);
    registerAdminRoutes(app, deps);
    registerMetricsRoutes(app, deps);
    registerMemoryRoutes(app, deps);
    registerRecordRoutes(app, deps);

    // Auto-resume poller for durable scheduled follow-ups (#8): fires due
    // tasks as system-initiated turns. Disabled with SCHEDULER_POLL_MS=0.
    const pollMs = Number(process.env['SCHEDULER_POLL_MS'] ?? 30_000);
    const pollTimer =
      pollMs > 0
        ? setInterval(() => {
            try {
              runtime.fireDueScheduledTasks(wallClockNow());
            } catch (err) {
              app.log.error(err, 'scheduled-task poll failed');
            }
          }, pollMs)
        : undefined;
    pollTimer?.unref(); // never keep the process alive on the timer alone

    app.addHook('onClose', async () => {
      if (pollTimer) clearInterval(pollTimer);
      eventLog.close();
      sessionsDb.close();
      spans.close();
    });

    await app.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

async function shutdown(): Promise<void> {
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});

start();
