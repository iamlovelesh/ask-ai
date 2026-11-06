/**
 * Coverage check (improvement: the "checked 9 of 12" class — the model was
 * asked about a set of records and answered from a partial read).
 *
 * Deterministic, high-confidence slice: when the user's message explicitly
 * names two or more record ids ("compare con_1, con_2, con_3"; "what's the
 * latest on these: inv_4 inv_9"), every named id must appear in this turn's
 * tool-output evidence. Any id the agent never actually read is returned so
 * the loop can disclose it — a superlative/aggregate over a set is wrong if
 * part of the set was never looked at. The open-ended case ("these 12
 * contacts" from a prior turn) is left to the prompt rule + router work.
 */

const ID_RE = /\b[a-z][a-z_]*_\d+\b/g;

/** Distinct record ids the USER named in their message. */
export function requestedIds(userText: string): string[] {
  return [...new Set(userText.match(ID_RE) ?? [])];
}

/**
 * Of the record ids the user explicitly named (≥2 → treated as a set), which
 * never appeared in this turn's tool outputs. Empty unless the user named a
 * set AND at least one member went unread.
 */
export function unreadRequestedIds(userText: string, toolOutputs: readonly string[]): string[] {
  const ids = requestedIds(userText);
  if (ids.length < 2) return [];
  const evidence = toolOutputs.join('\n');
  return ids.filter((id) => !evidence.includes(id));
}
