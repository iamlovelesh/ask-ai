# Ask AI Framework — Design Document

**Date:** 2026-11-03 (v2: 2026-11-04) · **Deadline:** 2026-11-08 · **Status:** Draft v2 for approval
**Research base:** `docs/research/2026-11-03-architecture-deep-research.md` and
`docs/research/2026-11-04-oss-agents-full-agent-machinery.md`

## Intent and Why

Build the "Ask AI" hiring assignment: a natural-language agent over a simulated
business platform with **50 modules × 10 actions = 500 executable actions** (catalog fixed by
the assignment's companion PDF, modules M01 Contacts … M50 Reports). Node.js backend,
Vue.js chat frontend. The agent must handle direct, indirect, multi-step, conditional,
follow-up, ambiguous, and unsupported requests; execute real stateful mock handlers; and be
benchmarked on **latency (p50/p95), cost (tokens/$ per successful task), and quality (action
selection, parameter accuracy, end-to-end task success verified against final data state)**
with ≥100 reproducible scenarios and a baseline-vs-optimized comparison.

The user's stated priority: **benchmark rigor** — the differentiator reviewers reward and
where known public attempts at this assignment were weakest.

### Competitive context (informs, must not be copied)

Three public GitHub solutions to this exact assignment exist. All converge on: LLM-as-untrusted-planner
emitting a typed JSON plan in ONE call, deterministic DAG executor, retrieval shortlist
(top 10–22 of 500) instead of full catalog, Zod schemas everywhere, code-enforced confirmation
gates, final-state eval assertions. Their weak spots: multi-turn follow-ups, retrieval misses
on paraphrases, provider latency tails, and (for two of them) missed quality targets or
inability to measure real cost. We adopt the convergent architecture (it is the current
industry best practice, independently validated by research) but implement from scratch and
differentiate on: multi-model benchmark via OpenRouter, stronger follow-up context handling,
cleaner cost accounting (OpenRouter returns per-request cost), and a more rigorous, honest
benchmark report.

## Goals

1. All 500 actions implemented as real stateful handlers over a seeded synthetic store, with
   validation, meaningful outputs, and failure modes (not always-success).
2. Agent correctly handles the 8 request categories: direct, indirect, multi-step, conditional,
   follow-up, ambiguous (clarify), unsupported (honest refusal), and handler-failure recovery.
3. Benchmark suite: ≥110 reproducible scenarios spanning all 50 modules + smoke test of all
   500 handlers; pre-committed targets; baseline vs optimized on identical scenarios; honest
   reporting of misses.
4. Vue chat UI with streaming progress, confirmation cards, clarification prompts, and
   grounded final summaries.
5. README covering architecture + agent design, catalog/action schemas/registration,
   tool selection, context management, **execution strategy**, real-vs-mocked,
   **install/run steps incl. environment variables (.env.example)**, how to run evals and
   reproduce results, latency/cost/quality trade-offs, limitations, scaling beyond 500
   actions; repo pushed to GitHub and verified bootable from a clean clone.
6. 2–5 min demo video covering the brief's SIX mandatory items: (1) direct request
   completed, (2) indirect request interpreted, (3) complex workflow across ≥3 modules,
   (4) follow-up that changes the previous request, (5) ambiguity or tool failure handled,
   (6) latency/cost/quality benchmark results. (Recording is the user's day-5 task.)

## Non-Goals

- Real a commercial CRM API integration (explicitly not required).
- Authentication, multi-tenant. (Sessions ARE durably persisted via node:sqlite — v2.2.)
- Fine-tuning models; local embedding training.
- Production deployment (runs locally; optional: single `docker compose up`).

## Anti-Goals (failure even if it "works")

- Hardcoded mappings from example prompts to plans (explicitly forbidden by the brief).
- Actions that return canned success without touching state.
- Benchmark that only reports wins — missed targets must be reported.
- Architecture that visibly plagiarizes a public solution.
- A planner that silently invents capabilities instead of refusing unsupported asks.

## Constraints

- Backend Node.js (TypeScript), frontend Vue.js — fixed by the brief.
- LLM access via **OpenRouter** (user's key; multiple models available, per-request cost in
  `usage` when `usage: {include: true}` is set).
- 5 calendar days; benchmark rigor prioritized over UI polish.
- Catalog is fixed: exactly the 500 actions from the PDF (ids M01.A01–M50.A10 + slugs).

### Source documents
- Brief: the assignment brief PDF (7 pages: objective, requirements,
  deliverables, evaluation criteria). Catalog companion: `~/Downloads/Next Step AI
  Assignment.pdf` (14 pages: module index M01–M50 and all 500 action names, one-line module
  descriptions, usage guidance). Both get copied into `docs/assignment/` on day 1.
- **The PDF gives action names and module one-liners only — no parameter schemas.** The
  builder therefore designs the shared entity data model (entity types, fields, cross-module
  relationships) and all 500 input/output schemas. This is scheduled explicitly: entity
  data model is the FIRST day-1 deliverable, before any handlers. Transcribing the catalog
  to `catalog.json` is also a day-1 task (names are already extracted from the PDF pages;
  verify count = exactly 500).
- Risk classification (read/write/destructive/bulk/external) is builder judgment, guided by
  the catalog PDF's rule: "Confirm destructive, bulk, and externally visible operations
  before execution."

## Architecture (decided)

Monorepo `ask-ai/`:

```
server/           Node 22.5+ (node:sqlite; engines-pinned + .nvmrc), TypeScript, Fastify, SSE
  src/catalog/    50 module files, each exporting 10 ActionDefs; registry auto-loads
  src/store/      node:sqlite store + seeded fixtures + template-copy reset + virtual clock
  src/agent/      router → retrieval → planner → validator → executor → composer
  src/llm/        Vercel AI SDK as model-call layer ONLY (generateObject+Zod for plans,
                  streamText, OpenRouter provider, usage extraction) wrapped by our own
                  usage/cost/latency logger. Orchestration (retrieval→plan→validate→execute→
                  join→compose) is hand-rolled deterministic code — no agent framework; the
                  AI SDK's native tool loop is reused as the ReAct BASELINE agent.
  src/api/        chat endpoints (SSE), admin (reset/seed), metrics
web/              Vue 3 + Vite chat UI
eval/             scenario specs, runner, baseline agent, benchmark reports
docs/             TARGETS.md (pre-committed), BENCHMARK.md (results), architecture notes
```

### Data layer
- **`node:sqlite` store (v2.3 revision — was in-memory)**: built-in Node 22+ module, zero
  external deps, unified with session storage; indexes on every searchable field;
  deterministic seeded generation; fixed virtual "now". **Two seed profiles**:
  - **`standard` (~50k records)** — evals/CI/smoke. SINGLE reset mechanism (v1.1):
    `POST /admin/reset` = close handle → copy committed template DB → reopen → mark session
    refs stale (<300ms); the template file is committed to the repo so determinism is the
    artifact's, not the generator's. Rollback-based reset deleted (contradicted HTTP-driven
    eval runner).
  - **`scale` — STRETCH GOAL only (v1.1, user-approved)**: 500k–1M profile via one script
    if Nov 8 morning is free; demonstrates agent-latency-flat-vs-data-volume (ref handles)
    and a large bulk-confirmation. The 10M design is documented in the README as built-for
    but not run; it is NOT on the critical path.
  Final-state assertions query through a typed query API either way.
- Handlers validate inputs (Zod), enforce referential integrity, mutate state, return typed
  results, and raise realistic errors (not-found, conflict, validation, simulated transient).

### Action catalog
- Each `ActionDef`: `id` (M01.A01), `slug` (contacts.create_contact), `description`,
  `inputSchema`/`outputSchema` (Zod, strict), `risk` (read | write | destructive | bulk |
  external), `entities`, `searchCard` (enriched text: synonyms, example phrasings, sibling
  disambiguation notes), `handler`.
- Registration: dropping a new module file in `src/catalog/` registers it — no core changes
  (extensibility requirement).
- Catalog scaffolding is code-generated from a `catalog.json` transcription of the PDF, then
  hand-finished per module (schemas and handlers reviewed, not blindly generated).

### Router and direct path (my call)
There is ONE pipeline (context → retrieval → planner → validator → executor → composer) —
no separate code path that could drift. The "router" is a cheap pre-classifier (regex/
heuristics + retrieval-confidence signal, no extra LLM call) that only chooses the planner
MODEL: short single-intent queries with a high-confidence retrieval hit go to
`gemini-2.5-flash-lite`; everything else to `claude-haiku-4.5`. A 1-step plan from a fast
model through the same validator/executor is the "direct path," and the direct p50 TTFUR
< 2s target is measured on it. Misrouting is safe: a complex query routed to the small
model fails validation and is re-planned by the big model (counted in cost).

### Agent pipeline (optimized path)
1. **Context resolve + query rewrite — structured working memory (v2 upgrade).** The session
   keeps a **typed working-state object beside the transcript**, re-injected each turn:
   a small stack of task frames `{intent, status: active|pending|completed, filters,
   result_ref, missing_params}` (topic switches suspend, not clobber), plus entity memory
   with **provenance** — every stored value carries `{value, source: action_slug, step}`.
   **Writes read entity IDs only from working state, never from transcript prose** (the
   hallucination firewall). Large result sets live server-side behind **reference handles**:
   context carries `$ref` + count + first ~20 rows; bulk actions resolve refs server-side
   ("make those 200 due tomorrow" never round-trips 200 records). Old tool results in the
   transcript are **observation-masked** (one-line placeholders; last ~3 turns verbatim) —
   no LLM summarizer (JetBrains Complexity-Trap evidence). Follow-ups are rewritten into
   standalone requests against working state before retrieval ("only Facebook leads" →
   "create follow-up tasks for last week's unreplied leads from the Facebook campaign,
   due tomorrow").
2. **Retrieval — lexical + action-graph, deterministic (v2 change).** BM25 (minisearch)
   over enriched action cards, combined with Aider-repo-map-style graph ranking: an offline
   action graph (shared entity types, output-feeds-input edges, module/sibling links) scored
   by session-usage and module-cohesion boosts (v1.1 review: PPR action graph cut —
   documented in README as evaluated/deferred). minisearch fuzzy matching ON — typos are
   a named brief requirement. Top ~20 cards with module diversification. **No embeddings by
   default** — added only if the recall@20 probe set (~60 paraphrase queries) shows misses
   (goose's deleted embedding routers and Aider's lexical success justify this). Planner may
   call `search_more_actions` (max 2). Cache safety: shortlist rides as text in the user
   message; system prompt + meta-tool defs stay byte-stable (avoids the Manus "dynamic tool
   loading" cache-busting failure). Degradation ladder for card budget: shorten → drop
   descriptions → truncate with warning (OpenClaw pattern).
   **Playbooks (v2 addition):** 5–8 SKILL.md-format playbooks (`lead-follow-up-sweep`,
   `overdue-invoice-reminders`, `pipeline-review`, …) per the Agent Skills spec: name +
   description (~100 tokens total each) always visible to the planner; body (recommended
   action sequence, edge cases, confirmation points) injected only when retrieval or the
   planner matches one. Powers the indirect-request category; mirrors the real product's
   "Skills" feature.
3. **Planner** — ONE LLM call returning a typed JSON **Plan DSL**: steps with action slug,
   params, `$s1.items[*].id` references, `forEach`, `filter`/`exclude` data ops, `condition`
   branches; or `clarify {question}`; or `unsupported {reason}`; or `respond` (chit-chat).
   System prompt is byte-stable (cache-friendly); shortlist cards go in the user message.
4. **Validator** — compile plan against Zod schemas + ref graph; up to 2 repair calls with
   targeted error messages.
5. **Executor** — deterministic DAG runner; independent READ steps run in parallel; WRITE
   steps run single-threaded and sequential through the gate (consensus:
   Cognition/LangChain/τ-bench); each step emits an SSE progress event;
   destructive/bulk/external steps pause for a **confirmation card bound to plan-hash +
   resolved target ids** (code decides, never the model). Step failures: retry transient
   once, else mark failed and continue independent branches; report
   completed/failed/pending. **Stuck detection** (OpenHands pattern): same action+error ×3 →
   inject corrective hint into repair; ×4 → stop and ask the user. Error bodies stay in
   context verbatim (never silently retried away). Budgets: LLD §5.1 is canonical
   (maxRepairs 2, maxReplans 2, maxSearchRounds 2, ≤6 LLM calls/turn).
5b. **Replanning joiner (v2 addition — biggest correctness delta).** After the read phase,
   a code-first check compares actual results against the plan's assumptions (counts,
   emptiness, filter matches). On divergence: patch the plan (repair preferred over full
   replan, max 2 rounds, budgeted in cost metrics) or ask the user. Kills the
   plan-written-before-data-is-seen failure mode (+10.3pts evidence, Plan-and-Act; ReWOO
   unrecoverability; the public repos' admitted weakness).
6. **Composer** — final answer built by code templates from actual execution results
   (grounded; no model hallucination surface), with an optional tiny-model polish pass that
   may only rephrase, not add facts.

### Streaming & observability (v2.1 — first-class requirement)
One append-only event log, four projections: SSE stream (UI), trace store (observability),
metrics aggregator (benchmark), audit feed (product). Single write path.
- **SSE protocol**: `turn.started`, `retrieval.done`, `plan.ready` (step list — streamed as
  the FIRST USEFUL RESPONSE before execution, which is how TTFUR is won; loading indicators
  don't count per the brief), `step.started/finished/failed` (one-line result summaries),
  `confirmation.required`, `replan` (with reason), `answer.delta`, `turn.completed`
  ({latency, tokens, cost}). Vue task tracker renders directly off these.
- **Traces**: every LLM call, retrieval, step, and joiner decision is a span
  `{turnId, spanId, parent, kind, model?, tokensIn/out/cached, costUsd, startMs, endMs,
  status}` persisted to the trace store. Dev-mode trace view in the UI (per-turn waterfall).
  OTel-compatible JSON export = the "execution traces" deliverable. The eval runner computes
  ALL benchmark numbers from these same traces — no gap between demo and report. No external
  APM dependency; graders need zero extra setup.

### Sessions & persistence (v2.2 — ChatGPT-style interface)
- **Durable sessions via `node:sqlite`** (built into Node 22+, zero external deps):
  `sessions` (id, title auto-generated from first message, created/updated, token/cost
  totals) + `events` (session_id, seq, type, payload JSON, ts). Append-only; survives
  restarts. Separate persistence domain from the CRM mock store — resetting CRM data for
  eval runs never touches chat history; eval runner uses ephemeral sessions.
- **UI shell**: sidebar session list (date-grouped, auto-titles), new-chat, open session →
  full end-to-end replay — messages, task trackers in final state, resolved confirmation
  cards, step results, per-turn cost badges. Replay and live rendering are the SAME code
  path (fold(events) → render) — the event-sourcing dividend.
- **Resume**: continuing an old session rebuilds working memory by folding its events.
  Reference handles persist in a session-scoped refs table; a follow-up hitting a ref whose
  underlying CRM state was reset gets a graceful "result set is from an earlier data state —
  re-run the search?" rather than acting on dead IDs.

### Agent infrastructure (v2 additions from OSS research)
- **Event-sourced conversation log**: append-only typed events (user msg, retrieval, plan,
  step start/end, confirmation, replan, response); state = fold(events). Feeds the four
  projections above plus session replay; gives resume support.
- **KV-cache-first prompt assembly**: stable prefix (system prompt, meta-tools), append-only
  messages, deterministic JSON serialization (sorted keys), date/time injected per-turn
  outside the cached prefix. Verified against OpenRouter usage data on day 1.
- **Handler discipline**: semantic IDs (names beside ids in outputs), JIT module guidance
  inside tool results, `concise|detailed` response formats, token-capped outputs with
  spill-to-ref, idempotency keys on all mutating handlers, persist-before-ack, serialized
  turns per session.
- **Research sub-run: README-ONLY (v1.1, user-approved)** — the full design (read-only
  isolated sub-run, structured report contract) is documented in the README's scaling
  section with the 15×-token evidence for why it's not in the core loop. Zero build time.

### Baseline (for the trade-off comparison)
Classic ReAct loop: full 500-action catalog summarized in context, one model call per step,
same handlers, same scenarios. This is the "simple baseline" the brief demands.

Fairness rule (my call): the baseline shares the HARNESS features — conversation transcript
(so multi-turn scenarios are attemptable), code-enforced confirmation gate, and handler
layer — but not the optimized agent's retrieval, plan DSL, or query rewrite. The comparison
then isolates exactly the variables we claim credit for (tool selection + planning strategy),
and no scenario category is auto-failed for the baseline. BENCHMARK.md states this framing
explicitly.

### Benchmark run budget
Full 110-scenario suite × 3 trials runs on the default planner for both baseline and
optimized. The model matrix (2–3 alternative planners) runs on a stratified ~40-scenario
subset, optimized path only. Estimated worst-case spend is dominated by the baseline's full-
catalog prompts (~15–20k tokens/step × ~4 steps × 330 runs ≈ 20–25M input tokens ≈ $5–8 on
Haiku-class pricing, far less with caching); optimized runs are comparatively cheap. A spend
ceiling is enforced in the eval runner (abort + report partial results if exceeded) —
ceiling: **$25 total** (user-set, 2026-11-03).

### Models (via OpenRouter, config-driven)
- Default planner: `anthropic/claude-haiku-4.5` (best small-model function-calling on BFCL).
- Direct-path + composer polish: `google/gemini-2.5-flash-lite` (fast TTFT, cheap).
- Benchmark matrix runs the planner across 2–3 models (e.g. Haiku 4.5, GPT-5-mini at
  minimal reasoning, Gemini 2.5 Flash) — a differentiator no public solution has.
- Gotcha codified in config: GPT-5-family must run with minimal reasoning effort or latency
  explodes.

### Instrumentation (first-class, built day 1 — not bolted on)
Every LLM call logs `{requestId, scenarioId?, stage, model, inputTokens, cachedTokens,
outputTokens, latencyMs, costUsd (from OpenRouter usage accounting), attempt}`. Every chat
request logs TTFUR (first streamed token of useful content — loading indicators excluded per
the brief) and E2E completion. Metrics endpoint aggregates p50/p95 by category.

## Evaluation plan

- **Scenario spec**: `{id, category, seedProfile, turns[], expected: {planAssertions
  (action slugs + param subsets, order-insensitive where valid), stateAssertions (typed
  store queries → expected rows), responseAssertions (must-mention / must-not-claim)}}`.
- ≥110 scenarios: every module covered ≥2×; 8 categories; multi-turn scripts for follow-ups;
  injected handler failures; ambiguous prompts where the ONLY correct behavior is one focused
  clarifying question; unsupported requests where refusal is the pass condition.
- **v2 upgrades (BFCL v3 / τ-bench lessons)**: abstention cases (no matching action among
  500 — declining is the pass), missing-parameter cases (asking is the pass; assuming is the
  fail), distractor stress cases (similar-sounding actions across modules), and **pass^3
  reliability reported alongside pass^1** per category (3 trials already planned — τ-bench
  showed pass^1 61% can hide pass^8 <25%).
- **Smoke test**: auto-enumerated — every one of 500 handlers invoked with minimal valid
  input against seeded store, asserting typed success or expected typed error.
- **Targets pre-committed in docs/TARGETS.md before the benchmark runs** (e.g. direct p50
  TTFUR < 2s, complex E2E p50 < 10s, task success ≥ 85% optimized, cost/successful task
  < $0.01 — final numbers set in TARGETS.md on day 1). Report includes misses, verbatim.
- Runner: `npm run eval` (deterministic, reset per scenario, 3 trials for pass^k honesty),
  `npm run eval:baseline`, `npm run benchmark:report` → markdown report with tables.

## Delivery plan (5 days)

- **Day 1**: repo scaffold, store + fixtures + reset + clock, catalog codegen + first 10
  modules hand-finished, instrumentation layer, TARGETS.md committed.
- **Day 2**: remaining 40 modules finished, smoke test green for 500 handlers; retrieval
  index + quality spot-check (recall@20 ≥ 95% on a 60-query probe set).
- **Day 3**: planner + validator + executor (+ replanning joiner, stuck detection) +
  confirmation + composer; working-memory layer (task frames, refs, masking); SSE; baseline
  agent; playbooks authored.
- **Day 4**: Vue chat UI (streaming, live task tracker, confirm/clarify cards with explicit
  scope, audit feed panel, per-turn cost/latency badge); eval scenarios authored; first full
  benchmark run (sessions UI at FULL scope per user: sidebar, replay, trace view, audit feed).
- **Day 5**: BENCHMARK.md from final overnight run (misses vs TARGETS verbatim), README,
  demo recording against the 6-item checklist, repo push + clean-clone verification, submit.
  Stretch (only if morning free): 500k scale profile + one-paragraph scale result.
  (Canonical day-by-day plan with go/no-go artifacts and ordered cut list: LLD §11.)

## Left to the builder

- Exact SSE payload field details beyond LLD §2.3; Vue component internals.
- Exact Plan DSL field names; repair-prompt wording; retrieval scoring weights.
- Seed data distributions within the ~50k standard profile.
- Whether to add Docker; nice-to-have only.

## Production readiness (honest line, feeds README "real vs mocked" + limitations)

NOT prod-ready, by design: mocked data layer, no auth/multi-tenancy, single process with no
failover/queue/concurrency testing, baseline-only security hardening, no model ops. What IS
production-grade: event-sourced sessions + idempotency + persist-before-ack, code-enforced
plan-hash-bound gates, span-level trace/cost observability, cache-aware prompts, stuck
detection, CI-runnable eval suite (the Sierra/Decagon "regression flywheel" asset).
Path-to-prod (README's scaling story): store→real APIs/Postgres; sessions SQLite→Postgres;
authn + role-scoped action visibility ("deny = schema not sent"); turn queue + stateless
workers folding state from events; cross-provider failover; evals as CI regression gate.
Each is a swap, not a rewrite — that is the claim we defend, never "prod ready."

## Known risks

- **Originality**: public solutions share this architecture; mitigate with scratch
  implementation, distinct DSL/naming, and differentiators above. Never view their code
  while implementing — the research summary is the only artifact consulted.
- **Provider latency tails** via OpenRouter: measure, pin providers per model
  (`provider.order`) if p95 is noisy; report conditions honestly.
- **500 handlers in 2 days**: mitigated by uniform store API + codegen + per-module review
  checklist; smoke test is the safety net.
- **Prompt caching via OpenRouter**: supported for Anthropic (cache_control passthrough) and
  automatic for OpenAI/Gemini; verify cache hits appear in usage data on day 1; if not,
  byte-stable prompts still help and we document observed behavior.
