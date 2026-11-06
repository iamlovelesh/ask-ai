/**
 * Count-reconciliation guard (#1, the equivalent of "report the DB
 * totalCount, not the page"). Persona eval: a follow-up narrowed by attribute
 * made the model sort to a top-N ref and report that small count (5) as THE
 * count, when the ref-tool knew the full matching set was far larger (119).
 *
 * Deterministic, low-cry-wolf: fires ONLY when a ref-tool this turn reported a
 * set total >= THRESHOLD, the answer states a SMALLER count as if it were the
 * whole, AND the answer never mentions the real total. In every other case it
 * returns null (the answer already surfaced the total, the set is small, or
 * there is no count claim).
 */

const MIN_TOTAL = 10;

function numsIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\b(\d[\d,]{0,11})\b/g)) {
    const n = Number((m[1] as string).replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

/** The largest "full set" size a ref-tool reported this turn: the N in
 * "Sorted N records" (sort_ref) or the M in "…: M matched" (filter/search_ref). */
function largestReportedTotal(toolOutputs: readonly string[]): number {
  let max = 0;
  for (const o of toolOutputs) {
    for (const m of o.matchAll(/\bSorted\s+([\d,]+)\s+records\b/gi)) max = Math.max(max, Number((m[1] as string).replace(/,/g, '')));
    for (const m of o.matchAll(/:\s*([\d,]+)\s+matched\b/gi)) max = Math.max(max, Number((m[1] as string).replace(/,/g, '')));
  }
  return max;
}

/** An honest reconciliation note to append, or null when nothing is amiss. */
export function countReconciliationNote(answer: string, toolOutputs: readonly string[]): string | null {
  const total = largestReportedTotal(toolOutputs);
  if (total < MIN_TOTAL) return null;
  // The answer already surfaced the real total → nothing to add.
  if (numsIn(answer).has(total)) return null;
  // Does the answer assert a SMALLER count as if it were the whole set?
  const claim = /\b(?:you have|there are|i found|found|showing|here are|that'?s)\s+\**(\d[\d,]*)\b/i.exec(answer);
  if (!claim) return null;
  const stated = Number((claim[1] as string).replace(/,/g, ''));
  if (!Number.isFinite(stated) || stated >= total) return null;
  return `⚠ ${total.toLocaleString()} records match in total — the ${stated.toLocaleString()} above are only the top/sample rows shown, not the full count. For an exact breakdown or total over the whole set, ask and I'll compute it with the ref-tools.`;
}
