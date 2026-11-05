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

/** Renders completed turns oldest→newest: last `keepLastN` in full detail,
 * older ones collapsed to one line. Empty string when nothing completed. */
export function renderRecentTurns(events: readonly Event[], keepLastN = DEFAULT_KEEP_LAST_N): string {
  const turns = fold(events);
  if (turns.length === 0) return '';
  const cutoff = Math.max(0, turns.length - keepLastN);
  const lines: string[] = [];
  turns.forEach((turn, i) => {
    if (i < cutoff) {
      lines.push(`[earlier] user: ${turn.userText} → assistant: ${turn.answer}`);
      return;
    }
    lines.push(`user: ${turn.userText}`);
    for (const s of turn.steps) lines.push(s);
    lines.push(`assistant: ${turn.answer}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}
