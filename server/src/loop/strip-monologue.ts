/**
 * Strip internal monologue from a final answer (improvement Tier-2 #5).
 *
 * Smaller models leak process narration into the answer — "Perfect! I can now
 * see…", "Let me create a summary table:", "Now I have all the data I need." —
 * which reads as leaked scratch state. We remove leading interjections and
 * leading/standalone process-narration sentences, HIGH-PRECISION: we never
 * touch real content ("Based on the data, 1,362 leads"), a trailing offer
 * ("Let me know if…"), and never strip the answer to empty.
 */

/** Leading interjection: "Perfect!", "Great,", "Okay —", … */
const INTERJECTION = /^\s*(perfect|great|okay|ok|alright|sure|got it|excellent|awesome|here we go)\b[\s!.,:—-]+/i;

/** Process verbs that mark a sentence as scratch narration, not answer. */
const PROC = 'create|compile|summarize|verify|check|calculate|compute|gather|look|search|retrieve|find|get|run|pull|analyze|review|put together|see';

/** A leading/standalone monologue sentence:
 *  - "Let me <proc> …"  (but NOT "Let me know …")
 *  - "Now I have/can/'ll/will …", "Now let me <proc> …"
 *  - "I'll now …", "I'm going to <proc> …", "I can now <proc/see> …"
 *  - "Let's <proc> …"
 * up to the first sentence end (. : !) or newline. */
const SCAFFOLD = new RegExp(
  '^\\s*(?:' +
    `let me (?:${PROC})` +
    '|now i (?:have|can|will|\\u2019ll|\'ll)' +
    `|now let me (?:${PROC})` +
    '|i\\u2019ll now|i\'ll now' +
    `|i(?:\\u2019m| am) going to (?:${PROC})` +
    `|i can now (?:${PROC})` +
    `|let(?:\\u2019s| us) (?:${PROC})` +
    ')\\b[^.:!\\n]*[.:!]?\\s*',
  'i',
);

function stripLeading(text: string): string {
  let t = text;
  let prev = '';
  while (t !== prev) {
    prev = t;
    t = t.replace(INTERJECTION, '');
    t = t.replace(SCAFFOLD, '');
  }
  return t;
}

export function stripMonologue(text: string): string {
  const stripped = stripLeading(text).trimStart();
  // Never strip the whole answer away.
  return stripped.length > 0 ? stripped : text.trimStart();
}
