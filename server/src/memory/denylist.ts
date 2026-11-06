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
/** Undashed 9-digit SSN, only when an "ssn" keyword is nearby — a bare
 * 9-digit run alone is too ambiguous (ids, counts) to reject. */
const SSN_UNDASHED_RE = /\bssn\b[^0-9]{0,12}\d{9}\b/i;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i;
/** A long unbroken hex/base64-ish run reads as a token/secret. */
const LONG_SECRET_RE = /\b[A-Za-z0-9+/_-]{32,}\b/;
// `\s*` (not `\s+`) so "password: x" / "password=x" (separator attached) are
// caught, not just "password is x".
const PASSWORD_RE = /\b(password|passcode|passphrase|secret)\s*(is|=|:)\s*\S+/i;

const RULES: Rule[] = [
  { reason: 'looks like a payment card number', test: (b) => CARD_RE.test(b) },
  { reason: 'looks like a government id (SSN)', test: (b) => SSN_RE.test(b) || SSN_UNDASHED_RE.test(b) },
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

/**
 * Volatile-aggregate screen (memory hygiene). Query results about live CRM
 * state — record counts, totals/sums, breakdowns, and top-N snapshots of
 * specific records with their current values — are NOT durable facts. They go
 * stale the moment the data changes, and (persona eval) were served back later
 * as if current, producing a confidently wrong "$678K / 30 open" against a real
 * "$19.1M / 712". Keep durable intent (goals, preferences, who-they-are); drop
 * today's numbers. Applied at both write paths, like `screenMemory`.
 */
const CRM_ENTITY = 'leads?|opportunit(?:y|ies)|opps?|deals?|contacts?|invoices?|tickets?|tasks?|accounts?|orders?|quotes?|appointments?|customers?|pipeline';
const VOLATILE_RULES: RegExp[] = [
  // Top-N / snapshot: a record id carrying a current money value ("opp_438 ($50,981.12)").
  /\b[a-z]+_\d+\b[^.]{0,30}\$[\d,]/i,
  // Leading count framing: "Currently has 712…", "Has 14…", "There are 30…".
  /^\W*(?:currently\s+)?(?:has|have|there\s+are)\s+\d/i,
  // Leading bare count of a CRM collection: "712 open opportunities", "30 leads".
  new RegExp(`^\\W*\\d[\\d,]*\\s+(?:open\\s+|new\\s+|active\\s+|closed\\s+|overdue\\s+)?(?:${CRM_ENTITY})\\b`, 'i'),
  // Total / combined / average value with a currency figure nearby.
  /\b(?:total|combined|average|sum)\b[^.]{0,40}\$[\d,]/i,
  // A breakdown/by-group statement.
  /\bbreakdown\b[^.]{0,20}?(?::|\bby\b)/i,
  // Top-N of a CRM collection.
  new RegExp(`\\btop\\s+\\d+\\b[^.]{0,40}(?:${CRM_ENTITY})`, 'i'),
];
export function isVolatileMemory(body: string): boolean {
  return VOLATILE_RULES.some((re) => re.test(body));
}
