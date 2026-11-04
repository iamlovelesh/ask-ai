/**
 * Catalog core types (LLD §2.1). Field names are verbatim from the LLD —
 * `registry.ts` and every `m*.ts` module file depend on this exact shape.
 */

import type { z } from 'zod';
import type { StoreTx } from '../store/db.js';
import type { VirtualClock } from '../store/clock.js';

/**
 * 'bulk'  = action is inherently wide (campaign launch, segment send) →
 *           ALWAYS gates (LLD §5.3).
 * numeric width of narrow actions is gated dynamically via affectedCount
 * (LLD §5.3) — that gating does not change an action's declared `risk`.
 */
export type Risk = 'read' | 'write' | 'destructive' | 'bulk' | 'external';

export interface SearchCard {
  synonyms: string[];
  examplePhrasings: string[];
  disambiguation?: string;
}

export interface ActionDef<I = unknown, O = unknown> {
  id: string; // "M01.A01"
  slug: string; // "contacts.create_contact"
  module: string;
  name: string;
  description: string;
  risk: Risk;
  entities: string[];
  inputSchema: z.ZodType<I>; // strict
  outputSchema: z.ZodType<O>;
  searchCard: SearchCard;
  /** Guidance appended inside successful results (≤120 tokens). */
  jit?: string;
  handler: (input: I, ctx: ActionContext) => Promise<O>;
}

export interface ActionContext {
  db: StoreTx;
  clock: VirtualClock; // handlers NEVER read wall-clock time directly
  idempotencyKey: string; // `${turnId}:${planRev}:${stepId}:${itemIndex}` (LLD §5.3)
  format: 'concise' | 'detailed';
}

/** Error taxonomy (LLD §2.1). `TRANSIENT` is retried once by the executor. */
export type ActionErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TRANSIENT'
  | 'FORBIDDEN'
  | 'LIMIT_EXCEEDED';

/** Thrown by handlers. Messages MUST be actionable (LLD §2.1). */
export class ActionError extends Error {
  readonly code: ActionErrorCode;

  constructor(code: ActionErrorCode, message: string) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
  }
}
