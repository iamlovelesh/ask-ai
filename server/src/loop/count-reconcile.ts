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

/** Parse an integer that may carry thousands separators ("1,100" → 1100). */
function parseIntComma(s: string): number {
  return Number(s.replace(/,/g, ''));
}

/** Comparable noun stem: lowercase + naive singularization so "tasks" and
 * "task", "opportunities" and "opportunity" compare equal. */
function nounStem(s: string): string {
  const w = s.toLowerCase();
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2); // addresses -> address
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * The largest quantity the answer CLAIMS to have acted on, 0 if none.
 *
 * Gated on `written` — the set of entity nouns actually written this turn
 * (from `action.entities`). A count only counts when its noun was written, so
 * reported/analytics figures like "1,100 opportunities worth $X" (when only a
 * report *structure* was created) are NOT mistaken for a write overclaim.
 */
function claimedWriteCount(answer: string, written: ReadonlySet<string>): number {
  if (written.size === 0) return 0;
  const writtenStems = new Set([...written].map(nounStem));
  let max = 0;
  // "5 tasks", "1,100 opportunities", "5 follow-up tasks" — only when the
  // noun's stem was actually written this turn.
  for (const m of answer.matchAll(
    new RegExp(String.raw`\b(\d[\d,]*)\s+(?:new |newest |follow-?up )?(${WRITE_NOUN})\b`, 'gi'),
  )) {
    if (writtenStems.has(nounStem(m[2] as string))) max = Math.max(max, parseIntComma(m[1] as string));
  }
  // "for the 5", "for all 5", "for each of 5" — batch phrasing where the count
  // attaches to the target set, not the written noun (e.g. "a task for the 5
  // leads"). Only trust it when the answer also names a written entity, so a
  // stray "for the 5 …" in a report answer doesn't trip it.
  const mentionsWritten = [...writtenStems].some((st) => new RegExp(String.raw`\b${st}s?\b`, 'i').test(answer));
  if (mentionsWritten) {
    for (const m of answer.matchAll(/\bfor (?:the |all |each of )?(\d[\d,]*)\b/gi)) {
      max = Math.max(max, parseIntComma(m[1] as string));
    }
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
 * claims a LARGER acted-on quantity — of an entity that was ACTUALLY WRITTEN
 * this turn — than what landed. `written` is the set of written entity nouns;
 * without it the guard stays silent (fail-safe: no spurious corrections).
 */
export function writeCountReconcileNote(
  answer: string,
  writesLanded: number,
  written: ReadonlySet<string> = new Set(),
): string | null {
  if (writesLanded <= 0) return null;
  const claimed = claimedWriteCount(answer, written);
  if (claimed <= writesLanded) return null;
  // Already honest: the answer states the real accomplished count (e.g.
  // "3 of the 5", "created 3 tasks") — don't pile on a redundant correction
  // that reads as the system doubting its own truthful answer.
  if (new RegExp(String.raw`\b${writesLanded}\b`).test(answer)) return null;
  const remaining = claimed - writesLanded;
  return `⚠ Correction: ${writesLanded} change(s) were actually made this turn — not ${claimed.toLocaleString()}. I was only able to act on ${writesLanded} of them; ask me to finish and I'll complete the remaining ${remaining.toLocaleString()}.`;
}
