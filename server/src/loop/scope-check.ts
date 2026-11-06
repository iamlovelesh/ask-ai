/**
 * Scope-claim check (support round-7b N1): the model hallucinated a
 * priority:"high" filter on "how many open tickets in total?" (23 vs the
 * true 76) and the audit follow-up re-ran the same filtered query while
 * asserting "across all priorities". The turn KNOWS what filters it passed,
 * so totality claims are deterministically checkable: any string filter the
 * user's own words never sanctioned gets an explicit disclosure appended.
 */

export interface AppliedFilter {
  action: string;
  key: string;
  value: string;
}

const TOTALITY_RE =
  /\b(in total|across all|altogether|overall|every single|all of (?:them|our)|total across)\b/i;

/** Filters to disclose: present in a read this turn, not traceable to the
 * user's words (neither a key stem nor the value appears in userText), on a
 * draft that claims totality. Deduped by key=value. */
/** Punctuation/case-insensitive token set: "closed-won", "Closed Won", and
 * "closed_won" all normalize to {closed, won} so ordinary paraphrase of a
 * user-sanctioned filter is NOT falsely flagged (review HIGH-2). */
function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((t) => t.length >= 2));
}

export function unsanctionedFilters(
  draft: string,
  userText: string,
  filters: readonly AppliedFilter[],
): AppliedFilter[] {
  if (filters.length === 0 || !TOTALITY_RE.test(draft)) return [];
  const hay = tokenize(userText);
  const seen = new Set<string>();
  const out: AppliedFilter[] = [];
  for (const f of filters) {
    const valueTokens = [...tokenize(f.value)];
    const keyStems = f.key.toLowerCase().split('_').filter((s) => s.length > 2);
    // Sanctioned when EVERY value token appears in the user's words (so a
    // reformatted enum like "Closed Won" ↔ "closed-won" matches), or any
    // key stem does. Err toward sanctioned: a missed disclosure is far
    // less harmful than contradicting a correct, user-requested answer.
    const sanctioned =
      (valueTokens.length > 0 && valueTokens.every((t) => hay.has(t))) ||
      keyStems.some((s) => hay.has(s));
    const dedupeKey = `${f.key}=${f.value.toLowerCase()}`;
    if (!sanctioned && !seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      out.push(f);
    }
  }
  return out;
}
