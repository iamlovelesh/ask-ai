/**
 * Exponential backoff for LLM calls (LLD §9.2): retries on 429/5xx/network
 * errors, 1s → 16s, max 6 attempts (5 retries) by default. Separate from the
 * executor's per-action TRANSIENT retry (§5.3) — this one wraps the
 * HTTP/model call.
 *
 * Reviewer ruling: the brief's "max 5, 1s→16s" means delays up to 16s must be
 * REACHABLE. With `baseMs*2^(attempt-1)` and 5 total attempts, the last
 * computed delay (before attempt 5) is only 8s — 16s is never hit. 6 attempts
 * (5 retry delays: 1,2,4,8,16s) makes the documented cap reachable.
 */

import { APICallError } from '@ai-sdk/provider';

export interface BackoffOptions {
  maxAttempts?: number;
  baseMs?: number;
  /** Test seam: replace the real timer-based sleep (e.g. to assert delay
   * values without waiting for them). Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface BackoffResult<T> {
  value: T;
  attempts: number;
}

function extractStatus(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    if (typeof record['status'] === 'number') return record['status'];
    if (typeof record['statusCode'] === 'number') return record['statusCode'];
  }
  return undefined;
}

/** 429/5xx/network → retryable. Detects via `APICallError.isRetryable` first
 * (set automatically by the AI SDK for 408/409/429/5xx), falling back to a
 * plain `status`/`statusCode` field, then generic network-failure shapes. */
export function isRetryableError(err: unknown): boolean {
  if (APICallError.isInstance(err)) return err.isRetryable;
  const status = extractStatus(err);
  if (status !== undefined) return status === 429 || status >= 500;
  // fetch() throws a TypeError for DNS/connection failures (network errors).
  if (err instanceof TypeError) return true;
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Calls `fn(attempt)` (1-based), retrying on retryable errors with
 * exponential backoff (`baseMs * 2^(attempt-1)`, capped at 16s). Rethrows the
 * last error once `maxAttempts` is reached or the error is non-retryable.
 */
export async function withBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: BackoffOptions = {},
): Promise<BackoffResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseMs = opts.baseMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === maxAttempts) throw err;
      const delayMs = Math.min(baseMs * 2 ** (attempt - 1), 16_000);
      await sleep(delayMs);
    }
  }
  // Unreachable (loop always returns or throws), but keeps TS happy.
  throw lastError;
}
