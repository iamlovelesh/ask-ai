---
name: Pipeline review
description: Review a sales pipeline's open opportunities and move stale ones forward or flag them with a follow-up task. Use when the user asks to "review the pipeline", "check on open deals", or "clean up stalled opportunities". Triggers: pipeline review, review deals, stale opportunities, check pipeline, clean up pipeline.
---

# Pipeline review

1. List pipelines (to resolve the pipeline the user means, if not already
   named). — slug: pipelines.list_pipelines
2. Search open opportunities in that pipeline. — slug: opportunities.search_opportunities
   `expects: {nonEmpty: true}` — an empty pipeline means there is nothing
   to review; report that instead of continuing.
3. Filter to opportunities whose expected close date has already passed
   (stale) or that have had no recent activity. — slug: core.filter
4. For each stale opportunity, create a follow-up task for its owner. — slug: tasks.create_task
   (forEach — gates once with the aggregate count.)

## Decision points

- If step 2 returns zero open opportunities, stop — the pipeline is
  already clear, nothing to review.
- If step 3 filters everything down to zero from a non-empty step 2
  result, say so explicitly (nothing is actually stale) rather than
  silently creating zero tasks and reporting success with no detail.
- "Moving forward" a stage (`opportunities.move_opportunity_to_stage`) is a
  separate, more invasive action than flagging with a task — only use it
  when the user explicitly asks to advance deals, not just review them.

## Confirmation notes

- Step 4 (`tasks.create_task`) gates once, aggregate scope, when the
  stale-opportunity count exceeds the bulk confirmation threshold.
