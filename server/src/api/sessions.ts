/**
 * Session + turn routes (LLD §6): session CRUD/listing, event replay,
 * the live SSE turn channel (`POST .../messages`), confirm, and cancel.
 *
 * `GET .../stream` (the reconnect channel) lives in `stream.ts` — it shares
 * no handler code with `POST .../messages` beyond the `sse.ts` writer,
 * because its replay-then-subscribe sequencing is materially different
 * (see that file's header).
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { openSse } from './sse.js';
import { sessionExists } from './turn-runtime.js';
import { listModels, resolveModelId, defaultModelId } from '../llm/models.js';
import type { AppDeps } from './types.js';

const SESSION_TITLE_MAX_CHARS = 40;

const messageBodySchema = z.object({
  text: z.string().min(1, 'text must not be empty'),
  agent: z.enum(['optimized', 'baseline', 'plandsl']).optional(),
  /** User model-picker: a client model id, validated against the allowlist
   * in `resolveModelId` (an unknown id silently falls back to the default —
   * never trust a raw client model string). */
  model: z.string().optional(),
});

const confirmBodySchema = z.object({
  approved: z.boolean(),
});

interface SessionParams {
  id: string;
}

interface ConfirmParams {
  id: string;
  confirmId: string;
}

function parseLimitCursor(query: Record<string, unknown>): { limit?: number; cursor?: string } {
  const out: { limit?: number; cursor?: string } = {};
  const rawLimit = query['limit'];
  if (typeof rawLimit === 'string' && rawLimit.length > 0) {
    const n = Number(rawLimit);
    if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
  }
  const rawCursor = query['cursor'];
  if (typeof rawCursor === 'string' && rawCursor.length > 0) out.cursor = rawCursor;
  return out;
}

function parseAfterSeq(query: Record<string, unknown>): number {
  const raw = query['afterSeq'];
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 0;
}

export function registerSessionsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { eventLog, sessionsDb, runtime } = deps;

  // --- GET /api/models (model-picker options) ---------------------------

  app.get('/api/models', async (_req, reply) => {
    reply.send({ models: listModels(), default: defaultModelId() });
  });

  // --- POST /api/sessions -----------------------------------------------

  app.post('/api/sessions', async (_req, reply) => {
    const id = eventLog.createSession();
    reply.code(201).send({ id });
  });

  // --- GET /api/sessions?limit&cursor -------------------------------------

  app.get('/api/sessions', async (req, reply) => {
    const { limit, cursor } = parseLimitCursor(req.query as Record<string, unknown>);
    const rows = eventLog.listSessions(limit, cursor);
    reply.send(rows);
  });

  // --- GET /api/sessions/:id/events?afterSeq ------------------------------

  app.get('/api/sessions/:id/events', async (req: FastifyRequest<{ Params: SessionParams }>, reply) => {
    const { id } = req.params;
    if (!sessionExists(sessionsDb, id)) {
      reply.code(404).send({ error: 'session_not_found' });
      return;
    }
    const afterSeq = parseAfterSeq(req.query as Record<string, unknown>);
    reply.send(eventLog.list(id, afterSeq));
  });

  // --- POST /api/sessions/:id/messages (SSE primary live channel) --------

  app.post('/api/sessions/:id/messages', async (req: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply) => {
    const { id: sessionId } = req.params;

    if (!sessionExists(sessionsDb, sessionId)) {
      reply.code(404).send({ error: 'session_not_found' });
      return;
    }

    const parsed = messageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
      return;
    }
    const { text, agent = 'optimized' } = parsed.data;
    const model = resolveModelId(parsed.data.model);

    // LLD §6 "one turn at a time per session" — checked BEFORE opening the
    // SSE stream, so a rejected second POST gets a plain JSON 409, not a
    // half-open stream.
    if (runtime.isRunning(sessionId)) {
      reply.code(409).send({ error: 'turn_in_progress' });
      return;
    }

    // Session titles = first 40 chars of the first message (LLD §6). Only
    // ever set once — a no-op `UPDATE ... WHERE title IS NULL` guard keeps
    // this correct even under the (impossible, given the 409 above, but
    // cheap to guard anyway) race of two first messages.
    const hasAnyTurn = eventLog.list(sessionId).some((se) => se.event.t === 'turn.started');
    if (!hasAnyTurn) {
      sessionsDb.run(`UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL`, [
        text.slice(0, SESSION_TITLE_MAX_CHARS),
        sessionId,
      ]);
    }

    // Subscribe BEFORE starting the turn — `startTurn` synchronously drives
    // the generator up to its first real `await` (an LLM call), which is
    // FAR enough to already emit `turn.started`/`retrieval.done` — so the
    // subscription must exist first or those events would be missed. No
    // `await` happens between `openSse`/`subscribe` and `startTurn` below,
    // so there is no race window for a live event to slip through unseen.
    //
    // `turnId` is assigned only once `startTurn` RETURNS, but the
    // subscriber callback below can fire SYNCHRONOUSLY from inside that
    // very call (the turn's first couple of events happen before the first
    // `await`) — at that instant `turnId` is still `undefined`, so the
    // `=== turnId` check below simply can't match yet. That's harmless: the
    // one event that actually needs to match (`memory.snapshot`, always the
    // LAST event of any turn) can only ever arrive long after `turnId` is
    // assigned.
    let turnId: string | undefined;
    const conn = openSse(reply);

    const unsub = eventLog.subscribe(sessionId, (seqEv) => {
      conn.write(seqEv);
      if (seqEv.event.t === 'memory.snapshot' && seqEv.event.turnId === turnId) {
        unsub();
        conn.close();
      }
    });
    conn.onClientGone(unsub);

    turnId = runtime.startTurn({ sessionId, userText: text, agent, model });
  });

  // --- POST /api/sessions/:id/confirm/:confirmId --------------------------

  app.post('/api/sessions/:id/confirm/:confirmId', async (req: FastifyRequest<{ Params: ConfirmParams }>, reply) => {
    const { id: sessionId, confirmId } = req.params;
    if (!sessionExists(sessionsDb, sessionId)) {
      reply.code(404).send({ error: 'session_not_found' });
      return;
    }

    const parsed = confirmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
      return;
    }

    const resolution = runtime.resolveConfirmation(sessionId, confirmId);
    if (resolution.outcome === 'not_found') {
      reply.code(404).send({ error: 'confirm_not_found' });
      return;
    }
    if (resolution.outcome === 'conflict') {
      reply.code(409).send({ error: 'confirm_not_pending' });
      return;
    }

    resolution.resolve(parsed.data.approved);
    reply.code(204).send();
  });

  // --- POST /api/sessions/:id/cancel --------------------------------------

  app.post('/api/sessions/:id/cancel', async (req: FastifyRequest<{ Params: SessionParams }>, reply) => {
    const { id: sessionId } = req.params;
    if (!sessionExists(sessionsDb, sessionId)) {
      reply.code(404).send({ error: 'session_not_found' });
      return;
    }
    runtime.cancel(sessionId);
    reply.code(204).send();
  });
}
