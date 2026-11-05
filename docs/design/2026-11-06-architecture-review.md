# Architecture Review — why the agent keeps failing, and the path out

Date: 2026-11-06 · Status: DECISION PENDING · Inputs: 3 rounds of persona-based human testing (sessions DB-verified), planner-utilization audit (quantified from live spans/events), 5 fix waves, quick-eval history, Sonnet-planner experiment.

## 1. Verdict summary

Round-3 human testing: **4/4 personas NO-SHIP.** Blockers: model-computed dates landing in 2023/2024 (two personas), a rejected bulk action reported as "successful," follow-ups dropping the prior turn's filters (wrong-ticket write), false counts ("3" vs true 30), one duplicate bulk write (165 sends ×2 — idempotency regression), one indefinite hang.

What IS solid (DB-verified across all rounds): the catalog (500 actions, zod schemas), confirmation gates (no unapproved write ever landed), event-sourced sessions + SSE + UI, retrieval (recall@20 = 1.000), the eval harness.

## 2. Root cause — the architecture fights the model

The optimized agent is **plan-then-execute**: one LLM call emits a complete multi-step DAG in a bespoke JSON DSL (custom ref grammar, params-as-JSON-string, outcome kinds), validated/repaired via error messages, executed deterministically, then a template composer reconstructs a user answer from result shapes.

Chosen for latency/cost (1–3 LLM calls/turn). Three test rounds show the price:

| # | Structural cause | Quantified evidence |
|---|---|---|
| 1 | **Blind planning** — all semantic decisions (filters, refs, ordinals, date windows, which-of-12-Liams) committed before seeing any data | 178 handles store real sample rows (avg 5.3KB); the planner is never shown one. All 8 stable quick-set failures are wrong guesses about data one read-step away |
| 2 | **Private languages** — ref grammar, params-as-string, @-dates; models are RL-trained on standard tool calling, not our DSL | REF_* = 42% of repair-error instances, 62% of stuck repairs; our deterministic ref auto-fixer fired **0 times** in live traffic; 401 plans failed schema parse outright |
| 3 | **One-shot burden → rule pile-up** — each failure class patched with a prompt rule; rules now interact | ~30 rules, 3.1k tokens, ≥2 direct contradictions; the round-3 date regression was our own card label (`date-ms`) defeating our own prompt rule (write ISO) |
| 4 | **Composer re-guesses intent from shapes** | "successful" on a rejected action; average rendered as total; invented narrative ("maintenance date") |
| 5 | **Hand-rolled conversation state** (frames/pendingClarify/filters) | filter-drop on follow-ups (202 vs 8; wrong-ticket write); stale-intent class; clarify lifecycle bugs — each a missed transition in our own state machine |
| 6 | **Weakest model on most turns** | flash-lite routed 64% of live turns; 19.2% vs 13.0% failure vs haiku; both prompt-wave regressions and the "qualified→created" misplan were flash-lite turns |

Fix-wave dynamics confirm the treadmill: each wave killed its target class and exposed/created another (5 waves; round-3 found 2 regressions of previously-FIXED bugs caused by fix-vs-fix conflicts). Hardening has flat-lined at quick-eval 7/20 across 6 consecutive runs while live trust bugs keep moving around.

## 3. Options

**A. Keep hardening plan-then-execute.** Implement audit top-3 (reasoning field, deterministic dates, show-rows + drop flash-lite) + round-3 criticals (reject-copy lie, filter-drop, double-write, hang). Cost: ~1 day + ~$1 testing. Risk: the last 5 waves' pattern — each wave shifts failures rather than ending them; the one-shot semantic burden (cause #1/#2/#3) remains.

**B. RECOMMENDED — pivot execution to the standard tool-calling loop on the proven substrate.** Replace the planner-DSL/orchestration/composer trio with the Vercel AI SDK's native multi-step tool loop (generateText + tools + stopWhen): the model calls real tools one (or a few) at a time, SEES each result, decides the next step with data in hand, and writes the final answer itself — grounded because it watched the data arrive. Everything proven stays:
- catalog actions become per-turn tools directly (zod schemas already exist; retrieval still picks the ≤24 exposed per turn)
- gates become tool-middleware (confirmation before destructive/bulk/external — same rules, same UI events)
- deterministic rails stay where they're deterministic: @-date resolution, ISO coercion, full-set hydration, idempotency keys, budgets/timeouts
- event log/SSE/traces: each tool call emits the same step events; UI unchanged
- memory: recent-turns verbatim + handles (drop the lossy frame compression)
Latency/cost estimate: 3–6 small haiku calls/turn vs today's 1–3 planned + 2–6 repair calls on failures; repair-heavy turns today already cost MORE (6 calls, 15–20s, $0.03–0.05) than a clean tool-loop turn. Eliminates by construction: the ref grammar (42% of repairs), params-as-string parse failures (401), blind-data guessing (cause #1), composer re-derivation (cause #4).
Evidence gate: the benchmark baseline agent IS this loop — quick-20 result pending (running now). If baseline ≈/≥ optimized's 7/20 without ANY of the five fix waves' polish, the pivot is de-risked: it's "productionize the baseline," not a rewrite.
Effort: ~1 focused day (the trio is ~2k LOC of a ~15k codebase; 80%+ reuses as-is). Then one human-test round + trimmed benchmark (~$2.5 within remaining budget).

**C. Stepwise plan execution (checkpoint the model after each read stratum).** Middle path; keeps the DSL (cause #2 stays) while adding calls — worst of both. Not recommended.

## 4. Decision needed
Option B vs A, gated on the baseline quick-20 number. Deadline 2026-11-08; remaining budget ≈$3.90. Either option ships with: quickwins wave already in flight (deterministic dates, reasoning field, haiku-only planning — all valid under both), harness-fairness fix, and the benchmark story reframed honestly: "we measured plan-then-execute vs the native loop and shipped the one the data supported — with the deterministic safety rails as the differentiator."
