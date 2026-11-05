/**
 * Extracts enumerated options from a `kind:'clarify'` question, when it
 * reads as a clean comma/'or'-separated list of ≤4 short alternatives —
 * e.g. "Which contact did you mean: Jane Smith, John Doe, or Jane Doe?" →
 * `['Jane Smith', 'John Doe', 'Jane Doe']`. `ClarifyCard` renders these as
 * reply chips that fill the composer and send immediately.
 *
 * Deliberately conservative. With no colon/dash/'between'/'among' lead-in,
 * a bare comma list NEVER qualifies on its own — a comma with no 'or' is
 * almost always a compound question ("Which contact, and what date?", which
 * would otherwise emit garbage chips that SEND the wrong text), and a bare
 * "X or Y?" with no comma is too easily ordinary prose ("did you want me to
 * search leads or contacts for this?"). So without a lead-in we require BOTH
 * a comma AND an explicit 'or'; a lead-in marker is itself sufficient. False
 * negatives (no chips offered) are harmless; false positives would offer a
 * chip that sends garbage.
 */

const MAX_OPTIONS = 4;
const MAX_OPTION_LENGTH = 40;

/** A clause that opens with an interrogative ("Are you asking about…",
 * "Should I…", "Which…") still carries the question STEM before its first
 * comma — with no lead-in marker to strip it, the first "option" would be
 * the stem itself ("Are you asking about overdue invoices"), a chip that
 * SENDS garbage. Only lead-in-marked questions ("Which X: A, B, or C") get
 * the stem removed, so a bare interrogative enumeration is not chip-able. */
const INTERROGATIVE_LEAD_RE =
  /^(?:are|is|was|were|do|does|did|should|shall|can|could|would|will|which|what|whom|who|where|when|how|may|might|has|have|had)\b/i;

export function parseClarifyOptions(question: string): string[] | null {
  const trimmed = question.trim().replace(/[?!.]+$/, '');
  if (!trimmed) return null;

  // Clarify questions are usually framed as "Which X — A, B, or C?" or
  // "...between A, B, or C"; prefer the clause after that lead-in when one
  // is present.
  const leadInMatch = trimmed.match(/(?:[:—–]|\bbetween\b|\bamong\b)\s*(.+)$/i);
  const clause = (leadInMatch ? leadInMatch[1] : trimmed).trim();

  const hasComma = clause.includes(',');
  const hasOr = /\bor\b/i.test(clause);
  if (leadInMatch) {
    // A lead-in marker (colon/dash/between/among) is itself the enumeration
    // signal; we still need a comma or an 'or' to split into ≥2 options.
    if (!hasComma && !hasOr) return null;
  } else {
    // No lead-in marker: a bare comma list alone NEVER qualifies — a comma
    // with no 'or' is almost always a compound question ("Which contact,
    // and what date?"), and a bare "X or Y?" with no comma is ambiguous
    // prose. Require BOTH a comma AND an explicit 'or' to treat it as a
    // genuine choice list ("Acme Corp, Acme Inc, or Acme LLC?").
    if (!hasComma || !hasOr) return null;
    // ...and that list must not open with a question stem, or the first
    // chip would send the stem rather than a clean option.
    if (INTERROGATIVE_LEAD_RE.test(clause)) return null;
  }

  const parts = clause
    .split(/,\s*(?:or\s+)?|\s+or\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length < 2 || parts.length > MAX_OPTIONS) return null;
  if (parts.some((p) => p.length === 0 || p.length > MAX_OPTION_LENGTH)) return null;
  return parts;
}
