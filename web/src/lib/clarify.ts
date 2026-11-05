/**
 * Extracts enumerated options from a `kind:'clarify'` question, when it
 * reads as a clean comma/'or'-separated list of ≤4 short alternatives —
 * e.g. "Which contact did you mean: Jane Smith, John Doe, or Jane Doe?" →
 * `['Jane Smith', 'John Doe', 'Jane Doe']`. `ClarifyCard` renders these as
 * reply chips that fill the composer and send immediately.
 *
 * Deliberately conservative: a question with no colon/dash/'between'/'among'
 * lead-in AND no comma (a bare "X or Y?") is NOT parsed, even though it has
 * an "or" — too easily confused with ordinary prose ("did you want me to
 * search leads or contacts for this?"). False negatives (no chips offered)
 * are harmless; false positives would offer a chip that sends garbage.
 */

const MAX_OPTIONS = 4;
const MAX_OPTION_LENGTH = 40;

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
  if (!hasComma && !hasOr) return null;
  if (!leadInMatch && !hasComma) return null; // see header: bare "X or Y?" is too ambiguous

  const parts = clause
    .split(/,\s*(?:or\s+)?|\s+or\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length < 2 || parts.length > MAX_OPTIONS) return null;
  if (parts.some((p) => p.length === 0 || p.length > MAX_OPTION_LENGTH)) return null;
  return parts;
}
