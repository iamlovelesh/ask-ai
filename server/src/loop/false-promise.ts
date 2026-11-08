/**
 * False-promise rail (backlog #8, source: Chatwoot `assistant_false_promise`).
 *
 * The agent cannot act on its own after a turn ends — it has no background
 * worker. The ONE exception is a durable scheduled follow-up/briefing
 * (`session__schedule_follow_up` / `session__schedule_briefing`). So an answer
 * that promises FUTURE autonomous work ("I'll follow up tomorrow", "I'll remind
 * you next week", "I'll keep you posted") is a trust failure UNLESS the turn
 * actually scheduled something — a promise no deterministic rail otherwise
 * catches.
 *
 * This is a DETERMINISTIC check (no extra LLM call — the brief weights cost):
 * high precision, deliberately modest recall. It fires only on clear
 * first-person future-autonomous-work phrasing, so it won't flag immediate
 * same-turn statements like "let me check that" or "I'll show you the results".
 */

/** Phrases that inherently imply deferred autonomous work — "later" is baked
 * into their meaning, so they need no accompanying time word. */
const INHERENT_DEFER_RE =
  /\b(i['’]?ll\s+(remind|get back to|circle back|check back (in|on|with)|follow up with|be in touch)|remind you|get back to you|circle back|check back (with|in|on) you|keep you (posted|updated|in the loop)|touch base|i['’]?ll be in touch|i['’]?ll let you know (later|tomorrow|next|soon|once|when))\b/i;

/** First-person future intent ("I'll", "I will", "I'm going to", "I plan to"). */
const FIRST_PERSON_FUTURE_RE = /\b(i['’]?ll|i\s+will|i['’]?m\s+going\s+to|i\s+plan\s+to|i['’]?ll\s+go\s+ahead\s+and)\b/i;

/** Future-time expressions that turn a first-person-future statement into a
 * promise about work that happens AFTER this turn. */
const FUTURE_TIME_RE =
  /\b(tomorrow|tonight|later(\s+(today|this\s+week|on))?|soon|shortly|next\s+(week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|quarter)|this\s+(afternoon|evening)|by\s+(eod|end\s+of\s+(the\s+)?day|end\s+of\s+week|tomorrow|friday|monday|next\s+week)|first\s+thing|in\s+(a|an|\d+)\s+(minute|hour|day|week|month)s?)\b/i;

/** Autonomous-work verbs that, combined with a first-person-future + a future
 * time, read as "I will do this for you later". */
const FUTURE_WORK_RE =
  /\b(follow\s*up|remind|check\s+back|reach\s+out|send|email|call|notify|update\s+you|ping|message|review|prepare|compile|put\s+together|take\s+care\s+of|handle|sort\s+(this|that|it)\s+out)\b/i;

/**
 * Returns a correction note to append to the answer when it promises future
 * autonomous work that nothing in the turn backs, or `null` otherwise.
 *
 * @param finalText the draft final answer
 * @param opts.scheduled whether a durable follow-up/briefing was actually
 *   scheduled this turn (that makes the promise TRUE — no flag)
 */
export function falsePromiseNote(finalText: string, opts: { scheduled: boolean }): string | null {
  if (opts.scheduled) return null; // a real schedule backs the promise
  if (!finalText) return null;

  const inherent = INHERENT_DEFER_RE.test(finalText);
  const futurePromise =
    FIRST_PERSON_FUTURE_RE.test(finalText) && FUTURE_TIME_RE.test(finalText) && FUTURE_WORK_RE.test(finalText);

  if (!inherent && !futurePromise) return null;

  return (
    '⚠ Note: I can\'t act on my own after this reply — I haven\'t scheduled anything. ' +
    'If you want me to follow up at a specific time, ask me to schedule a reminder and I will.'
  );
}
