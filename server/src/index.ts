import Fastify from 'fastify';
import { createRegistry } from './catalog/registry.js';
import { getCrm } from './store/db.js';
import { openEventLog } from './events/log.js';
import { openSessions, sessionsDbPath } from './store/sessions-db.js';
import { openSpans } from './events/trace.js';
import { loadPlaybooks } from './playbooks/loader.js';
import { SessionRuntime } from './api/turn-runtime.js';
import { registerSessionsRoutes } from './api/sessions.js';
import { registerStreamRoutes } from './api/stream.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerMetricsRoutes } from './api/metrics.js';
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
    // --- boot wiring (LLD §6/§11): open stores, load playbooks, build
    // deps, register routes.
    const registry = createRegistry();
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

    app.addHook('onClose', async () => {
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
