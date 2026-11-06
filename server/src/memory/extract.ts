/**
 * Async memory extractor + consolidator (design §4.4). Runs AFTER a turn's
 * answer is sent — fire-and-forget, never on the hot path — on a cheap model,
 * under the existing cost guard. Two LLM calls per salient candidate:
 *
 *   1. extract:    turn (user + answer) → candidate durable facts (salience-gated)
 *   2. consolidate: candidate + matching existing memories → ADD/UPDATE/DELETE/NOOP
 *
 * BEST-EFFORT: the whole pipeline is wrapped so it can never throw into the
 * turn. A budget-exhausted or failed call logs and leaves memory unchanged;
 * the next turn re-reads fresh material.
 */

import { z } from 'zod';
import { llmCall } from '../llm/client.js';
import { screenMemory, isVolatileMemory } from './denylist.js';
import type { MemoryStore } from './store.js';
import type { Memory, MemoryCategory, MemoryKind } from './types.js';
import type { Event } from '../events/types.js';

export interface MemoryExtractionInput {
  memory: MemoryStore;
  userId: string;
  sessionId: string;
  turnId: string;
  userText: string;
  answerText: string;
  model: string;
  /** Records each applied memory operation into the turn's trace (design
   * extension): the caller appends these to the event log so the UI can show
   * which message produced which ADD/UPDATE/DELETE. Best-effort, like the rest
   * of extraction. */
  emit?: (ev: Event) => void;
}

const CATEGORIES = ['preference', 'fact', 'goal', 'context'] as const;

const EXTRACT_SCHEMA = z.object({
  candidates: z.array(
    z.object({
      category: z.enum(CATEGORIES),
      kind: z.enum(['profile', 'collection']),
      key: z.string().optional(),
      body: z.string(),
      salient: z.boolean(),
    }),
  ),
});
type Candidate = z.infer<typeof EXTRACT_SCHEMA>['candidates'][number];

const CONSOLIDATE_SCHEMA = z.object({
  op: z.enum(['ADD', 'UPDATE', 'DELETE', 'NOOP']),
  targetId: z.string().optional(),
});
type Decision = z.infer<typeof CONSOLIDATE_SCHEMA>;

const EXTRACT_SYSTEM = `You maintain durable, long-term memory about a CRM user across conversations.
Read one turn (the user's message and the assistant's answer) and extract ONLY durable facts
worth remembering next time: stable preferences, standing goals, and lasting context about who
the user is and how they work. Mark salient=true only for things that will still matter in a
future conversation; set salient=false for one-off, ephemeral, or purely transactional details.
Use kind="profile" with a short stable key for a single-valued preference/fact (e.g. key
"date-format"); use kind="collection" (no key) for standalone notes. NEVER extract secrets,
passwords, card numbers, government ids, or anything sensitive.
NEVER store volatile query results — record counts, totals, sums, averages, breakdowns, or lists
of specific records with their current values (e.g. "712 open opportunities", "total pipeline is
$19M", "top 5 deals: opp_438 …"). Those change constantly and are wrong the next day; the user's
live data is always re-read fresh. Store the durable INTENT behind a request (a standing goal or
preference), never today's numbers. Return an empty list when nothing durable was stated.`;

const CONSOLIDATE_SYSTEM = `You reconcile one new candidate memory against the user's existing
memories. Choose exactly one operation: ADD (genuinely new), UPDATE (supersedes a specific
existing memory — give its targetId), DELETE (the candidate says an existing memory is now wrong —
give its targetId), or NOOP (already known / not worth storing). Only use a targetId drawn from
the provided existing memories.`;

function buildExtractPrompt(userText: string, answerText: string, existing: readonly Memory[]): string {
  const index = existing.length === 0 ? '(none)' : existing.map((m) => `- [${m.category}] ${m.key ? `${m.key}: ` : ''}${m.body}`).join('\n');
  return [
    '<existing_memories>',
    index,
    '</existing_memories>',
    '',
    '<turn>',
    `user: ${userText}`,
    `assistant: ${answerText}`,
    '</turn>',
  ].join('\n');
}

function buildConsolidatePrompt(candidate: Candidate, matches: readonly Memory[]): string {
  const ms = matches.length === 0 ? '(none)' : matches.map((m) => `- id=${m.id} [${m.category}] ${m.key ? `${m.key}: ` : ''}${m.body}`).join('\n');
  return [
    '<candidate>',
    `[${candidate.category}/${candidate.kind}] ${candidate.key ? `${candidate.key}: ` : ''}${candidate.body}`,
    '</candidate>',
    '',
    '<existing_matches>',
    ms,
    '</existing_matches>',
  ].join('\n');
}

/** Candidate ↔ existing-memory matches to show the consolidator. Profile:
 * the same key. Collection: shares a content word (cheap lexical overlap). */
function findMatches(candidate: Candidate, existing: readonly Memory[]): Memory[] {
  if (candidate.kind === 'profile') {
    return existing.filter((m) => m.kind === 'profile' && m.category === candidate.category && m.key === candidate.key);
  }
  const terms = new Set(candidate.body.toLowerCase().split(/\s+/).filter((t) => t.length > 3));
  return existing
    .filter((m) => m.kind === 'collection')
    .filter((m) => {
      const words = m.body.toLowerCase().split(/\s+/);
      return words.some((w) => terms.has(w));
    })
    .slice(0, 5);
}

function applyDecision(
  input: MemoryExtractionInput,
  candidate: Candidate,
  decision: Decision,
): void {
  const base = {
    userId: input.userId,
    category: candidate.category as MemoryCategory,
    kind: candidate.kind as MemoryKind,
    ...(candidate.key ? { key: candidate.key } : {}),
    body: candidate.body,
    source: 'extract' as const,
    sourceSession: input.sessionId,
  };
  if (decision.op === 'ADD') {
    const created = input.memory.add(base);
    emitOp(input, 'ADD', { category: base.category, key: base.key, body: base.body, memoryId: created.id });
    return;
  }
  if (decision.op === 'UPDATE' || decision.op === 'DELETE') {
    const id = decision.targetId;
    if (!id) return;
    const target = input.memory.get(id);
    // No-op on a stale/foreign/already-invalid target (Review Focus).
    if (!target || target.userId !== input.userId || target.invalidAt !== undefined) return;
    if (decision.op === 'UPDATE') {
      const created = input.memory.supersede(id, base);
      emitOp(input, 'UPDATE', { category: base.category, key: base.key, body: base.body, memoryId: created.id, targetId: id });
    } else {
      input.memory.invalidate(id);
      // DELETE describes the memory being removed (its own body/category).
      emitOp(input, 'DELETE', { category: target.category, key: target.key, body: target.body, targetId: id });
    }
  }
  // NOOP: nothing.
}

function emitOp(
  input: MemoryExtractionInput,
  op: 'ADD' | 'UPDATE' | 'DELETE',
  fields: { category: string; key?: string | undefined; body: string; memoryId?: string | undefined; targetId?: string | undefined },
): void {
  if (!input.emit) return;
  const ev: Event = {
    t: 'memory.op',
    turnId: input.turnId,
    op,
    category: fields.category,
    body: fields.body,
    ...(fields.key !== undefined ? { key: fields.key } : {}),
    ...(fields.memoryId !== undefined ? { memoryId: fields.memoryId } : {}),
    ...(fields.targetId !== undefined ? { targetId: fields.targetId } : {}),
  };
  input.emit(ev);
}

export async function runMemoryExtraction(input: MemoryExtractionInput): Promise<void> {
  try {
    const existing = input.memory.listLive(input.userId);
    const { value } = await llmCall({
      stage: 'extract',
      model: input.model,
      schema: EXTRACT_SCHEMA,
      system: EXTRACT_SYSTEM,
      prompt: buildExtractPrompt(input.userText, input.answerText, existing),
      turnId: input.turnId,
    });
    const extracted = value as z.infer<typeof EXTRACT_SCHEMA>;
    const kept = extracted.candidates.filter(
      (c) => c.salient && screenMemory(c.body).allowed && !isVolatileMemory(c.body),
    );

    for (const candidate of kept) {
      const matches = findMatches(candidate, existing);
      const { value: decValue } = await llmCall({
        stage: 'extract',
        model: input.model,
        schema: CONSOLIDATE_SCHEMA,
        system: CONSOLIDATE_SYSTEM,
        prompt: buildConsolidatePrompt(candidate, matches),
        turnId: input.turnId,
      });
      applyDecision(input, candidate, decValue as Decision);
    }
  } catch (err) {
    // Best-effort: extraction failure (budget, provider, schema) must never
    // surface into the turn. Log server-side and move on.
    console.error('[memory] extraction failed', err);
  }
}
