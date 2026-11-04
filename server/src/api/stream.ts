/**
 * Reconnect SSE channel (LLD §6): `GET /api/sessions/:id/stream?afterSeq`
 * (or a `Last-Event-ID` header, same meaning) — replays every PERSISTED
 * event after `afterSeq` from `EventLog.list`, then live-subscribes for
 * anything further. This is the channel Review Focus 1 exercises: a client
 * that dropped `POST .../messages` mid-turn reconnects here and must see
 * the `confirmation.required` it missed, because `runTurn`/`runBaselineTurn`
 * already persisted it via `eventLog.append` regardless of who (if anyone)
 * was listening at the time.
 *
 * Deliberately simpler lifecycle than `sessions.ts`'s live channel: this
 * endpoint doesn't know (or care) which turnId the caller is interested in
 * — it closes the connection the first time ANY `memory.snapshot` passes
 * through (replayed or live), on the theory that "a turn just ended" is a
 * sensible place for even a generic reconnect to stop and let the client
 * decide whether to reconnect again with a fresher `afterSeq`. One
 * documented consequence: reconnecting from `afterSeq=0` against a session
 * with several already-completed turns in its history replays only up to
 * the FIRST one's `memory.snapshot`, not the whole history — a client that
 * wants full replay should use `GET .../events` (no SSE, no closing
 * behavior) instead.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { openSse } from './sse.js';
import { sessionExists } from './turn-runtime.js';
import type { AppDeps } from './types.js';

interface SessionParams {
  id: string;
}

function parseAfterSeq(query: Record<string, unknown>, headers: Record<string, unknown>): number {
  const rawQuery = query['afterSeq'];
  if (typeof rawQuery === 'string' && rawQuery.length > 0) {
    const n = Number(rawQuery);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const lastEventId = headers['last-event-id'];
  const raw = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 0;
}

export function registerStreamRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { eventLog, sessionsDb } = deps;

  app.get('/api/sessions/:id/stream', async (req: FastifyRequest<{ Params: SessionParams }>, reply) => {
    const { id: sessionId } = req.params;
    if (!sessionExists(sessionsDb, sessionId)) {
      reply.code(404).send({ error: 'session_not_found' });
      return;
    }

    const afterSeq = parseAfterSeq(
      req.query as Record<string, unknown>,
      req.headers as Record<string, unknown>,
    );

    const conn = openSse(reply);

    // Replay backlog first. No `await` between this loop and the
    // `subscribe` call below — both run inside the same synchronous tick —
    // so there is no window in which a live event could be appended and
    // missed (EventLog.append fans out to subscribers synchronously).
    for (const seqEv of eventLog.list(sessionId, afterSeq)) {
      conn.write(seqEv);
      if (seqEv.event.t === 'memory.snapshot') {
        conn.close();
        return;
      }
    }
    if (conn.isClosed()) return; // client disconnected mid-replay

    const unsub = eventLog.subscribe(sessionId, (seqEv) => {
      conn.write(seqEv);
      if (seqEv.event.t === 'memory.snapshot') {
        unsub();
        conn.close();
      }
    });
    conn.onClientGone(unsub);
  });
}
