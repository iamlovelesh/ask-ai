/**
 * Auto-titled chat threads (a common pattern): instead of the first 40
 * characters of the first message, generate a short, specific title with a
 * fast model. Always degrades to a cleaned first message — a title is cosmetic
 * and must never block or fail a turn.
 */

export const TITLE_MAX_CHARS = 60;

/** Normalize a raw title: strip wrapping quotes, collapse whitespace, drop
 * trailing punctuation, and cap at `TITLE_MAX_CHARS` on a word boundary. */
export function cleanTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  // Strip wrapping quotes and trailing sentence punctuation together (a model
  // may emit `"Title".` — quote then period), but keep a trailing '?'.
  t = t.replace(/^["'`\s]+/, '').replace(/["'`.。\s]+$/, '').trim();
  if (t.length <= TITLE_MAX_CHARS) return t;
  const slice = t.slice(0, TITLE_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 20 ? slice.slice(0, lastSpace) : slice).trim();
}

export interface TitleDeps {
  /** Returns the model's raw title text for the given first message. */
  complete: (firstMessage: string) => Promise<string>;
}

/** Produce a chat title from the first user message. Never throws: a model
 * error or empty output falls back to the cleaned first message. */
export async function generateTitle(firstMessage: string, deps: TitleDeps): Promise<string> {
  const fallback = cleanTitle(firstMessage) || firstMessage.slice(0, TITLE_MAX_CHARS);
  try {
    const raw = await deps.complete(firstMessage);
    const cleaned = cleanTitle(raw);
    return cleaned.length > 0 ? cleaned : fallback;
  } catch {
    return fallback;
  }
}
