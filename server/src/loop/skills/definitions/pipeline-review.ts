import type { Skill } from '../types.js';

export const pipelineReview: Skill = {
  name: 'pipeline-review',
  label: 'Pipeline / deal review',
  description:
    'Use when the user asks how the pipeline or deals are doing, or what deals are at risk.',
  content: `# Pipeline / deal review
Assess open opportunities and surface what is at risk, with the reason.

## Gather
- Search open opportunities; keep the [ref]. Filter by owner/stage/close
  window if the user scoped it. Use data__group_by_ref for shape questions
  (count/sum by stage or owner) — never bucket rows yourself.

## Signals (evaluate each; each becomes one output line)
- Momentum: time in current stage vs the rest (group_by stage).
- Contact: days since the last SENT message or meeting (drafts don't count).
- Threading: how many distinct contacts are engaged.
- Hygiene: missing or implausible close date / amount.
- Commitments: open or overdue tasks on the deal.

## Produce
- At-risk deals FIRST, one line each, sorted by risk (not size). Name the
  signal that makes each one at-risk. Cite every deal as a [[record:...]] chip.
- Use data__aggregate_ref for any total; present cents as dollars.

## Rules
- Read-only. Explicitly name any signal you could NOT evaluate and why
  (e.g. "no meeting data available") — a review that hides its gaps is worse
  than a short one.`,
};
