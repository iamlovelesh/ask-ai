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

/** Record nouns a write answer typically quantifies ("created 5 tasks",
 * "for the 5 leads"). Used to read a CLAIMED acted-on count from prose while
 * ignoring bare years/ids. */
const WRITE_NOUN =
  'tasks?|records?|leads?|contacts?|reminders?|appointments?|invoices?|deals?|opportunities?|notes?|messages?|updates?|follow-?ups?|items?|rows?|people|accounts?|events?|quotes?|orders?';

/** The largest quantity the answer CLAIMS to have acted on, or 0 if none. */
function claimedWriteCount(answer: string): number {
  let max = 0;
  // "5 tasks", "5 follow-up tasks", "5 newest leads"
  for (const m of answer.matchAll(new RegExp(String.raw`\b(\d+)\s+(?:new |newest |follow-?up )?(?:${WRITE_NOUN})\b`, 'gi'))) {
    max = Math.max(max, Number(m[1]));
  }
  // "for the 5", "for all 5", "for each of 5"
  for (const m of answer.matchAll(/\bfor (?:the |all |each of )?(\d+)\b/gi)) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Batch-overclaim guard. Persona eval: asked to "create a follow-up task for
 * each of the 5 newest leads", the model batched only 3 records but narrated
 * all 5 (and listed 5 chips) — an answer that claimed more writes than landed.
 * The deterministic "Changes this turn: N" footer was right; the prose lied.
 *
 * Fires ONLY when a write actually landed (writesLanded > 0) and the answer
 * claims a LARGER acted-on quantity than what was written. Returns an honest
 * correction naming both numbers and offering to finish the rest.
 */
export function writeCountReconcileNote(answer: string, writesLanded: number): string | null {
  if (writesLanded <= 0) return null;
  const claimed = claimedWriteCount(answer);
  if (claimed <= writesLanded) return null;
  // Already honest: the answer states the real accomplished count (e.g.
  // "3 of the 5", "created 3 tasks") — don't pile on a redundant correction
  // that reads as the system doubting its own truthful answer.
  if (new RegExp(String.raw`\b${writesLanded}\b`).test(answer)) return null;
  const remaining = claimed - writesLanded;
  return `⚠ Correction: ${writesLanded} change(s) were actually made this turn — not ${claimed}. I was only able to act on ${writesLanded} of them; ask me to finish and I'll complete the remaining ${remaining}.`;
}
