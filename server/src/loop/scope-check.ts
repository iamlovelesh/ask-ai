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
export function unsanctionedFilters(
  draft: string,
  userText: string,
  filters: readonly AppliedFilter[],
): AppliedFilter[] {
  if (filters.length === 0 || !TOTALITY_RE.test(draft)) return [];
  const hay = userText.toLowerCase();
  const seen = new Set<string>();
  const out: AppliedFilter[] = [];
  for (const f of filters) {
    const value = f.value.toLowerCase();
    const keyStems = f.key.toLowerCase().split('_').filter((s) => s.length > 2);
    const sanctioned =
      (value.length >= 3 && hay.includes(value)) || keyStems.some((s) => hay.includes(s));
    const dedupeKey = `${f.key}=${value}`;
    if (!sanctioned && !seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      out.push(f);
    }
  }
  return out;
}
