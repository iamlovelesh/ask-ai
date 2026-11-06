/**
 * Memory management routes (memory-layer design §4.8): list / edit / delete a
 * user's durable memories, the global on/off switch, and per-session incognito.
 * Mirrors `sessions.ts` style (zod body validation, status-code conventions).
 *
 * Single-tenant: the acting user is `DEMO_USER_ID` (default `user_1`). Edit and
 * delete enforce ownership against that id so a memory belonging to another
 * user can never be read, changed, or removed (Review Focus: cross-user).
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createMemoryStore } from '../memory/store.js';
import type { MemoryPatch } from '../memory/types.js';
import { sessionExists } from './turn-runtime.js';
import type { AppDeps } from './types.js';

const patchBodySchema = z.object({
  body: z.string().min(1).optional(),
  category: z.enum(['preference', 'fact', 'goal', 'context']).optional(),
});
const settingsBodySchema = z.object({ enabled: z.boolean() });
const incognitoBodySchema = z.object({ incognito: z.boolean() });

interface IdParams { id: string }

function actingUserId(): string {
  return process.env['DEMO_USER_ID'] || 'user_1';
}

export function registerMemoryRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { sessionsDb } = deps;
  const memory = createMemoryStore(sessionsDb);

  // --- GET /api/memories -------------------------------------------------
  app.get('/api/memories', async (_req, reply) => {
    reply.send({ memories: memory.listLive(actingUserId()) });
  });

  // --- GET/PUT /api/memories/settings (global on/off) --------------------
  app.get('/api/memories/settings', async (_req, reply) => {
    reply.send({ enabled: memory.isEnabled(actingUserId()) });
  });

  app.put('/api/memories/settings', async (req, reply) => {
    const parsed = settingsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
      return;
    }
    memory.setEnabled(actingUserId(), parsed.data.enabled);
    reply.code(204).send();
  });

  // --- PATCH /api/memories/:id (edit) ------------------------------------
  app.patch('/api/memories/:id', async (req: FastifyRequest<{ Params: IdParams }>, reply) => {
    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
      return;
    }
    const existing = memory.get(req.params.id);
    if (!existing || existing.userId !== actingUserId()) {
      reply.code(404).send({ error: 'memory_not_found' });
      return;
    }
    // Build the patch dropping absent keys — MemoryPatch's optionals are exact
    // (no `| undefined`) under exactOptionalPropertyTypes.
    const patch: MemoryPatch = {};
    if (parsed.data.body !== undefined) patch.body = parsed.data.body;
    if (parsed.data.category !== undefined) patch.category = parsed.data.category;
    const updated = memory.update(req.params.id, patch);
    reply.send(updated);
  });

  // --- DELETE /api/memories/:id (hard delete) ----------------------------
  app.delete('/api/memories/:id', async (req: FastifyRequest<{ Params: IdParams }>, reply) => {
    const existing = memory.get(req.params.id);
    if (!existing || existing.userId !== actingUserId()) {
      reply.code(404).send({ error: 'memory_not_found' });
      return;
    }
    memory.remove(req.params.id);
    reply.code(204).send();
  });

  // --- PUT /api/sessions/:id/incognito (per-session write suppression) ---
  app.put('/api/sessions/:id/incognito', async (req: FastifyRequest<{ Params: IdParams }>, reply) => {
    if (!sessionExists(sessionsDb, req.params.id)) {
      reply.code(404).send({ error: 'session_not_found' });
      return;
    }
    const parsed = incognitoBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
      return;
    }
    memory.setIncognito(req.params.id, parsed.data.incognito);
    reply.code(204).send();
  });
}
