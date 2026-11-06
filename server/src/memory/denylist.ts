/**
 * Sensitive-data denylist (design §4.7). A deterministic pre-write filter
 * applied at BOTH write paths (the `memory__save` tool and the background
 * extractor) before anything is persisted. Never store government IDs,
 * financial account / card / credential data, or anything that looks like a
 * secret or token.
 *
 * Conservative by design: it would rather drop a borderline memory than
 * persist a credential. First matching rule wins.
 */

export interface DenylistResult {
  allowed: boolean;
  reason?: string;
}

interface Rule {
  reason: string;
  test: (body: string) => boolean;
}

/** 13–16 digits, optionally grouped by spaces or dashes (card-shaped). */
const CARD_RE = /\b(?:\d[ -]?){13,16}\b/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i;
/** A long unbroken hex/base64-ish run reads as a token/secret. */
const LONG_SECRET_RE = /\b[A-Za-z0-9+/_-]{32,}\b/;
const PASSWORD_RE = /\b(password|passcode|passphrase|secret)\s+(is|=|:)\s*\S+/i;

const RULES: Rule[] = [
  { reason: 'looks like a payment card number', test: (b) => CARD_RE.test(b) },
  { reason: 'looks like a government id (SSN)', test: (b) => SSN_RE.test(b) },
  { reason: 'looks like an API key', test: (b) => OPENAI_KEY_RE.test(b) },
  { reason: 'looks like a bearer token', test: (b) => BEARER_RE.test(b) },
  { reason: 'contains a credential phrase', test: (b) => PASSWORD_RE.test(b) },
  { reason: 'looks like a secret/token', test: (b) => LONG_SECRET_RE.test(b) },
];

export function screenMemory(body: string): DenylistResult {
  for (const rule of RULES) {
    if (rule.test(body)) return { allowed: false, reason: rule.reason };
  }
  return { allowed: true };
}
