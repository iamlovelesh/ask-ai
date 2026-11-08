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
| Complex TTFUR latency, p50 | **< 4s** | Time from `turn.started` to TTFUR (first useful response, see §3) on complex turns — production loop agent. (The metric was originally defined against the retired plan-DSL's `plan.ready` event; it carries over to the loop as the TTFUR of a multi-action turn.) |
| Complex end-to-end (E2E) latency, p50 | **< 12s** | Time from `turn.started` to `turn.completed` (`metrics.totalMs`), complex turns only |
| Complex end-to-end (E2E) latency, p95 | **< 25s** | Same as above, p95 |

"Direct" vs "complex" bucketing (normative — used identically by `eval/report.ts`):
for the production loop agent a turn is **complex** iff it dispatched more than one action
(`dispatchedActions().length > 1`); every other turn (a single action, or a
`respond`/`clarify`/`unsupported` with none) is **direct**. (For the retired plan-DSL
comparator the equivalent signal was a `plan.ready` carrying `outcome.kind==='plan'` with
`steps.length > 1`.) This is a property of the *turn's actual work*, not of the scenario's
`category` label — a `multistep`-category scenario the agent resolved in one action still
buckets as direct for latency purposes, and the report calls out any such mismatch as a note.

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
a multi-action turn and a one-line clarifying question (LLD §9.2: "so the definition can be
defended or re-sliced"). The rule applied per outcome:

| Outcome (production loop agent) | TTFUR measured at |
|---|---|
| `respond` / `clarify` / `unsupported` (refusal) | the first `answer.delta` chunk |
| First useful act is a destructive/bulk/external confirmation | the `confirmation.required` event |
| Any other turn (incl. multi-action) | the first `answer.delta` chunk (the loop marks TTFUR at the first useful output via `markTtfur`) |
| Baseline comparator (any outcome) | the first assistant-visible token OR the first tool-intent event (`confirmation.required` if the first dispatched call gates, else `step.started`) — whichever comes first |
| Retired plan-DSL comparator (plan-led turn) | the `plan.ready` event (repair latency included — it fires AFTER validation) |

`turn.completed.metrics.ttfurMs` is the field the production loop computes and the one these
targets are graded against; it already applies the correct rule per outcome.

## 4. Measurement conditions (must hold for every number in BENCHMARK.md)

- **Provider:** OpenRouter, `usage:{include:true}`. `PROVIDER_ORDER` is **reserved — not yet
  wired** (no code reads it today); the intent is to pin the upstream provider per model so a
  flaky/variable-priced fallback provider never silently skews one run's cost or latency
  relative to another's. Until it is wired, a run that could not hold a single provider for a
  model in the matrix discloses this explicitly rather than reporting mixed-provider numbers
  as if they were comparable.
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
- **Budget:** `EVAL_BUDGET_USD=8.50` as a hard process-wide ceiling (revised 2026-11-05,
  pre-benchmark: total available API credit is $10; ceiling leaves headroom). Consequences,
  decided before any run: optimized = full corpus ×3 trials; baseline = full corpus ×1 trial
  (full-catalog ReAct at ~12k tokens/step, so the baseline is held to a single trial rather
  than the optimized agent's 3 — disclosed in BENCHMARK.md); model matrix reduced to a ≤10-scenario spot
  check only if residual budget permits; a run that aborts on budget
  reports a partial table, not a padded/extrapolated one.
