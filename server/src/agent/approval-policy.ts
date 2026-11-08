/**
 * Value-based approval policies (#7): gate a write on
 * WHAT it does, not just its risk class or record count. A $9,000 order edit or
 * a 75%-off discount is a single-record `write` that `shouldGate` would wave
 * through on count alone — these policies catch it by inspecting the arguments.
 *
 * Deliberately conservative and unit-aware: monetary fields in this CRM are
 * stored in CENTS, so the amount gate compares against cents; discount fields
 * may be a percent (60) or a fraction (0.75) and both are handled.
 */

export interface ApprovalPolicyHit {
  /** Stable policy id (for logging/telemetry). */
  policy: 'financial-action' | 'high-amount' | 'high-discount';
  /** Human-readable reason appended to the confirm card. */
  reason: string;
}

/** $5,000, in cents — the default high-value threshold. */
export const AMOUNT_GATE_CENTS = 500_000;
const DISCOUNT_GATE_PCT = 50;

const FINANCIAL_ACTION_RE = /(refund|payout|charge|credit_note|void_payment|wire_transfer)/i;
const AMOUNT_KEY_RE = /(amount|total|price|value|refund|credit|payout|balance)/i;
const DISCOUNT_KEY_RE = /(discount|percent|pct)/i;

function numericValues(v: unknown): number[] {
  if (typeof v === 'number' && Number.isFinite(v)) return [v];
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return [Number(v)];
  if (Array.isArray(v)) return v.flatMap(numericValues);
  return [];
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US')}`;
}

/** Returns a policy hit when the action/args require approval on value grounds,
 * else null. Called ALONGSIDE `shouldGate` — either one firing gates the write. */
export function approvalPolicy(slug: string, params: Record<string, unknown>): ApprovalPolicyHit | null {
  if (FINANCIAL_ACTION_RE.test(slug)) {
    return { policy: 'financial-action', reason: 'financial operation' };
  }
  for (const [key, raw] of Object.entries(params)) {
    for (const n of numericValues(raw)) {
      if (AMOUNT_KEY_RE.test(key) && n >= AMOUNT_GATE_CENTS) {
        return { policy: 'high-amount', reason: `amount ≥ ${dollars(AMOUNT_GATE_CENTS)}` };
      }
      if (DISCOUNT_KEY_RE.test(key) && (n > DISCOUNT_GATE_PCT || (n > 0.5 && n <= 1))) {
        return { policy: 'high-discount', reason: `discount over ${DISCOUNT_GATE_PCT}%` };
      }
    }
  }
  return null;
}
