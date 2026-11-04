# Ask AI — Benchmark Targets

**Status: COMMITTED 2026-11-05, before any benchmark run (quick or full) was executed
against the real matrix.** These numbers are pre-registered pass/fail bars, not numbers
backed into after seeing results. `eval/report.ts` renders a table of these
EXACT values next to what the final run actually measured, with a MET/MISSED column —
whatever that table says, this file is never edited retroactively to make a miss look
like a hit. Any change to a number below after a benchmark run has started must be
called out explicitly in `docs/BENCHMARK.md`'s own notes, with a reason.

**Changelog (both entries predate any benchmark run — legitimate pre-benchmark
clarifications, not post-hoc adjustments):**
- 2026-11-05: Task 16 review (I1) tightened §2's cost-per-successful-task wording to the
  STRICT reading of "including retries" — a failed trial's cost is now explicitly part of
  the numerator for EVERY successful trial in the same agent/run, not excluded from the
  ratio entirely. `eval/report.ts`'s BENCHMARK.md output also reports the looser
  "cost among successful runs only" figure as a clearly labeled secondary line.

Source: LLD §9.2 ("Runner") and the Task 16 brief. Field names match
`eval/types.ts`'s `Scenario.expect` / `eval/runner.ts`'s result rows so the report's
comparison table can be generated mechanically.

## 1. Latency

| Metric | Target | Definition |
|---|---|---|
| Direct TTFUR, p50 | **< 2s** | See §3 "direct" row |
| Direct TTFUR, p95 | **< 4s** | See §3 "direct" row |
| Complex `plan.ready` latency, p50 | **< 4s** | Time from `turn.started` to the `plan.ready` event that carries a validated multi-step plan (`outcome.kind==='plan'`, `plan.steps.length > 1`) |
| Complex end-to-end (E2E) latency, p50 | **< 12s** | Time from `turn.started` to `turn.completed` (`metrics.totalMs`), complex turns only |
| Complex end-to-end (E2E) latency, p95 | **< 25s** | Same as above, p95 |

"Direct" vs "complex" bucketing (normative — used identically by `eval/report.ts`):
a turn is **complex** iff its `plan.ready` event carries `outcome.kind==='plan'` AND
`outcome.plan.steps.length > 1`. Every other outcome (`respond`, `clarify`,
`unsupported`, or a single-step `plan`) is **direct**. This is a property of the
*turn's actual outcome*, not of the scenario's `category` label — a `multistep`-category
scenario whose planner chose a 1-step plan still buckets as direct for latency purposes,
and the report calls out any such mismatch as a note.

## 2. Quality / Cost

| Metric | Target |
|---|---|
| Task success rate, optimized agent | **≥ 85%** (pass^1, across the full scenario corpus, optimized agent) |
| Optimized vs baseline success delta | **optimized ≥ baseline + 15 points** (percentage points of pass^1) |
| Cost per **successful** task, optimized agent | **< $0.01** — STRICT definition: `sum(cost of EVERY recorded trial — passing AND failing) / count(passing trials)`. "Including retries" (the brief's own wording) means a failed attempt's real spend counts toward the eventual success it took to get there — it is NOT excluded from the ratio just because that particular attempt didn't pan out. `eval/report.ts` also reports a secondary, clearly-labeled "cost among successful runs only" figure (`sum(cost of ONLY passing trials) / count(passing trials)`) for reference — that looser figure is NOT what this target is graded against. |
| Repair-rate assumption, complex scenarios | **< 35%** of complex-category turns trigger at least one `repair`/`replan`/`search` round (an ASSUMPTION pre-registered for sanity-checking the planner/validator loop's stability, not a hard pass/fail gate the way the above rows are) |

## 3. TTFUR definitions, per outcome (normative — LLD §9.2)

TTFUR ("time to first useful response") is measured differently depending on how a turn
resolves — there is no single universal "first byte" definition that is meaningful across
a plan-led multi-step turn and a one-line clarifying question. Every turn records BOTH
`plan.ready`'s timestamp and the first `answer.delta`'s timestamp regardless of which
definition below applies to it (LLD §9.2: "so the definition can be defended or
re-sliced"), and `turn.completed.metrics.ttfurMs` (the field the optimized pipeline
itself computes and the one these targets are graded against) already applies the
correct rule per outcome:

| Outcome | TTFUR measured at |
|---|---|
| Plan-led turn (`plan.ready` with `outcome.kind==='plan'`) | the `plan.ready` event (repair latency included — it fires AFTER validation) |
| `respond` / `clarify` outcome | the first `answer.delta` chunk |
| Destructive/bulk/external action taken directly (no multi-step plan) | the `confirmation.required` event |
| `unsupported` / refused outcome | the first `answer.delta` chunk (the refusal message) |
| Baseline agent (any outcome) | the first assistant-visible token OR the first tool-intent event (`confirmation.required` if the first dispatched call gates, else `step.started`) — whichever comes first |

"Direct" scenarios in §1 are turns whose TTFUR definition above is `answer.delta` or
`confirmation.required` (no multi-step plan involved); "complex" scenarios use the
`plan.ready` definition.

## 4. Measurement conditions (must hold for every number in BENCHMARK.md)

- **Provider:** OpenRouter, `usage:{include:true}`. `PROVIDER_ORDER` (if set) pins the
  upstream provider per model so a flaky/variable-priced fallback provider never silently
  skews one run's cost or latency relative to another's — a run that could not get a
  pinned provider for a model in the matrix discloses this explicitly rather than
  reporting mixed-provider numbers as if they were comparable.
- **Clock:** `VIRTUAL_NOW` pinned to `2026-11-04T10:00:00Z` for every run (never real
  wall-clock "today" — scenarios hardcode dates, never relative ones).
- **Profile:** `standard` (~50k rows, the committed `crm-standard.template.db`). The
  `scale` profile (500k–1M, stretch goal) is never used for these targets.
- **MockLLM runs are EXCLUDED** from every number in this file and from BENCHMARK.md's
  tables — `MOCK_LLM_SCRIPT`-driven turns exist solely to prove the harness machinery
  works offline (`eval/test/runner-e2e.test.ts`); they carry no real latency or cost
  signal and must never be averaged into a benchmark table.
- **Trials:** optimized agent ×3 trials per scenario (pass^1 and pass^3 are both
  reported); baseline agent ×1 trial per scenario (LLD §8: "baseline runs 1 trial — pass^k
  is measured on the optimized agent only, disclosed").
- **Budget:** `EVAL_BUDGET_USD=25` per run as a hard ceiling; a run that aborts on budget
  reports a partial table, not a padded/extrapolated one.
