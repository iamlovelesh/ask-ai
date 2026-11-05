/**
 * Step summary humanization (Feature B.2). The server emits a step summary
 * shaped `"<slug>: <count> <noun><drift?> [ref <r_...>]"` (see
 * server/src/agent/executor.ts `summarize`). The human-facing primary line
 * should read as the plain count — "123 invoices" — with the technical
 * artifacts (the leading slug, the `[ref r_...]` fragment) peeled off into
 * the expanded detail. This pure parser does that split; it keeps the human
 * count/drift note intact and never invents text.
 */

export interface ParsedStepSummary {
  /** The human-readable remainder: count + noun + any drift note, e.g.
   * `"123 invoices (120 of 123 still match)"`. */
  primary: string;
  /** The leading action slug, if the summary carried one (mono detail). */
  slug?: string;
  /** The spilled result ref from a `[ref r_...]` fragment, if present. */
  ref?: string;
}

/** A dotted lower-snake action slug, e.g. `invoices.search_invoices`. */
const SLUG_PREFIX_RE = /^([a-z0-9]+(?:[._][a-z0-9]+)+):\s+/i;
/** Trailing ` [ref r_xxx]` fragment the executor appends on a result spill. */
const REF_SUFFIX_RE = /\s*\[ref\s+([^\]]+)\]\s*$/i;

export function parseStepSummary(summary: string | undefined): ParsedStepSummary {
  if (!summary) return { primary: '' };
  let s = summary;
  const parsed: ParsedStepSummary = { primary: s };

  const refMatch = s.match(REF_SUFFIX_RE);
  if (refMatch) {
    parsed.ref = refMatch[1]?.trim();
    s = s.replace(REF_SUFFIX_RE, '').trimEnd();
  }

  const slugMatch = s.match(SLUG_PREFIX_RE);
  if (slugMatch) {
    parsed.slug = slugMatch[1];
    s = s.slice(slugMatch[0].length);
  }

  parsed.primary = s.trim();
  return parsed;
}
