/**
 * Verbatim recent-turn memory for the tool loop (plan rev 3, Task 3).
 *
 * Research basis (docs/research/2026-11-06-subproblem-mechanisms.md):
 * "lost filter scope" is a STATE problem — follow-ups like "reassign the
 * oldest one" must resolve against a durable artifact, not the model's
 * memory of a pruned page. So the last N completed turns are rendered
 * VERBATIM (user text + each step's resolved filter params + result
 * summary incl. [ref …] handle + final answer), and older turns are
 * observation-masked down to one `user → answer` line (the only
 * net-positive condensation strategy in the 2026 evidence; LLM
 * summarization is deliberately absent).
 */

import type { Event } from '../events/types.js';

const DEFAULT_KEEP_LAST_N = 3;

// Context compaction (a common pattern: prune history at a fraction of the
// window). The last `keepLastN` turns are full-detail CANDIDATES, but the
// full-detail section is also bounded by a character budget: walking
// newest→oldest, a candidate that would push the section past the budget is
// demoted to a collapsed one-liner instead. The newest turn is always kept in
// full (floor of 1) even if it alone exceeds the budget. ~6000 chars ≈ 1500
// tokens, well under the model's window with room for the catalog + prompt.
const DEFAULT_MAX_CHARS = 6000;

function fullLines(turn: TurnView): string[] {
  return [`user: ${turn.userText}`, ...turn.steps, `assistant: ${turn.answer}`, ''];
}

interface TurnView {
  userText: string;
  steps: string[];
  answer: string;
  completed: boolean;
}

function fold(events: readonly Event[]): TurnView[] {
  const byTurn = new Map<string, TurnView>();
  for (const e of events) {
    if (e.t === 'turn.started') {
      byTurn.set(e.turnId, { userText: e.userText, steps: [], answer: '', completed: false });
      continue;
    }
    const turn = byTurn.get(e.turnId);
    if (!turn) continue;
    if (e.t === 'step.started') {
      const scope = e.resolvedParams && e.resolvedParams.length > 0 ? ` with ${JSON.stringify(e.resolvedParams[0])}` : '';
      turn.steps.push(`- ran ${e.action}${scope}`);
    } else if (e.t === 'step.finished') {
      turn.steps.push(`  result: ${e.summary}`);
    } else if (e.t === 'step.failed') {
      turn.steps.push(`  failed: ${e.error.code}`);
    } else if (e.t === 'answer.final') {
      turn.answer = e.text;
    } else if (e.t === 'turn.completed') {
      turn.completed = true;
    }
  }
  // Map preserves insertion order = chronological (events are appended).
  return [...byTurn.values()].filter((t) => t.completed && t.answer !== '');
}

/** Renders completed turns oldest→newest: the newest turns in full detail
 * (bounded by `keepLastN` AND the `maxChars` budget), older ones collapsed to
 * one line. Empty string when nothing completed. */
export function renderRecentTurns(
  events: readonly Event[],
  keepLastN = DEFAULT_KEEP_LAST_N,
  maxChars = DEFAULT_MAX_CHARS,
): string {
  const turns = fold(events);
  if (turns.length === 0) return '';
  const windowStart = Math.max(0, turns.length - keepLastN);
  // Walk the full-detail candidates newest→oldest, keeping each in full while
  // the section stays within budget; demote the rest. Newest is always full.
  const full = new Set<number>();
  let budget = maxChars;
  for (let i = turns.length - 1; i >= windowStart; i -= 1) {
    const cost = fullLines(turns[i] as TurnView).join('\n').length;
    if (full.size === 0 || cost <= budget) {
      full.add(i);
      budget -= cost;
    } else {
      break; // older candidates can't fit either (sections only grow)
    }
  }
  const lines: string[] = [];
  turns.forEach((turn, i) => {
    if (full.has(i)) {
      lines.push(...fullLines(turn));
    } else {
      lines.push(`[earlier] user: ${turn.userText} → assistant: ${turn.answer}`);
    }
  });
  return lines.join('\n').trimEnd();
}
