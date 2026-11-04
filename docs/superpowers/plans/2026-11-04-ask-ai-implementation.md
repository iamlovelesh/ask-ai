# Ask AI Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Ask AI assignment end-to-end: 500-action catalog, plan-then-execute agent, Vue chat UI, eval/benchmark harness — per the approved v1.1 design.

**Architecture:** LLM-as-untrusted-planner emits a validated Plan DSL; deterministic executor runs it with gated writes and a replanning joiner; one append-only event log feeds SSE/traces/metrics/audit; everything measured.

**Tech Stack:** Node ≥22.5 (`node:sqlite`), TypeScript strict, Fastify, Zod v3, minisearch, `ai` (Vercel AI SDK v5) + `@openrouter/ai-sdk-provider`, Vitest, Vue 3 + Vite + Pinia, npm workspaces.

**Spec:** `docs/design/LLD.md` (v1.1 build contract — **canonical for every field name, budget, and grammar**), `docs/design/HLD.md`, `docs/superpowers/specs/2026-11-03-ask-ai-framework-design.md`. Where this plan and the LLD disagree, the LLD wins.

## Global Constraints

- `"engines": {"node": ">=22.5"}` + `.nvmrc` (22.x); `node:sqlite` only — no better-sqlite3.
- All LLM traffic through `server/src/llm/client.ts`; every call produces a Span (LLD §2.4) and respects `EVAL_BUDGET_USD`.
- Handlers never call `Date.now()` — `VirtualClock` only (default `2026-11-04T10:00:00Z`).
- JSON serialized with sorted keys everywhere a prompt or hash is built.
- Budgets/thresholds verbatim from LLD §5.1; ref grammar verbatim from LLD §2.2.
- Events are the only write path for conversation state; `answer.delta` is never persisted.
- Commit after every task (conventional commits; repo is `ask-ai/`, init in Task 1).
- Secrets only via env; `.env` gitignored; `.env.example` committed.

## Review Focus

1. **SSE drop mid-turn** → client reconnects via `GET /sessions/:id/stream?afterSeq` and misses nothing (incl. a pending `confirmation.required`). Test pinned to Task 15.
2. **User DENIES a confirmation** → step cancelled, dependents skipped, `turn.completed{status:'cancelled'}`, zero writes. Test pinned to Task 11.
3. **Planner emits an action slug not in catalog/shortlist** → validator repair (not crash, not execution). Test pinned to Task 10.
4. **Cross-turn ref drift**: 30 of 200 referenced leads deleted between turns → executor reports "170 of 200 still match", drift >25% on gated step forces re-confirmation. Test pinned to Task 11.
5. **OpenRouter response missing `usage`/cost fields** → price-table fallback, never NaN in spans or metrics. Test pinned to Task 5.

---

## Phase 0 — Scaffold

### Task 1: Repo + workspaces scaffold

**Files:** Create `package.json` (workspaces: `server`, `web`, `eval`), `server/package.json`, `server/tsconfig.json` (strict), `.nvmrc`, `.gitignore`, `.env.example` (keys per LLD §10), `vitest.config.ts`, `server/src/index.ts` (Fastify boot), `web/` via `npm create vite@latest web -- --template vue-ts`, `web/vite.config.ts` (proxy `/api→http://localhost:3000`), root npm scripts (`dev`, `seed`, `smoke`, `probe`, `eval`, `eval:quick`, `eval:baseline`, `benchmark:report`).

- [ ] Step 1: `git init` in `ask-ai/`; commit existing `docs/`.
- [ ] Step 2: Scaffold the files above; `GET /api/health` returns `{ok:true, now:<virtual clock placeholder>}`.
- [ ] Step 3: Verify: `npm install && npm run dev` boots server on :3000; `curl /api/health` → 200; `npm -w web run dev` serves Vite.
- [ ] Step 4: Copy both assignment PDFs into `docs/assignment/`. Commit `chore: scaffold workspaces`.

### Task 2: Virtual clock, ids, deterministic PRNG

**Files:** Create `server/src/store/clock.ts`, `server/src/util/ids.ts`, `server/src/util/prng.ts`. Test: `server/test/clock.test.ts`.

**Interfaces — Produces:** `VirtualClock{now():number; iso():string; startOfWeek(offsetWeeks?):number; daysAgo(n):number}` built from `VIRTUAL_NOW`; `makeId(prefix:string,n:number):string` → `"c_1042"`; `Prng(seed:number)` with `.int(max)`, `.pick(arr)`, `.chance(p)` (mulberry32 — no `Math.random` anywhere in server/).

- [ ] Step 1: Failing tests: clock pinned to `2026-11-04T10:00:00Z` default; `daysAgo(7)` exact; same seed → identical 100-draw sequence; different seed differs.
- [ ] Step 2: Run (fail) → implement → run (pass).
- [ ] Step 3: Add ESLint/grep guard test: no `Date.now(`/`Math.random(` under `server/src` outside `clock.ts`/`prng.ts`. Commit.

### Task 3: Entity model, DDL, store, reset

**Files:** Create `server/src/entities/model.ts` (the ~22–25 merged tables per LLD §3.2 — full column lists decided HERE, one object per table: `{name, columns, indexes}`), `server/src/store/db.ts`, `server/src/store/reset.ts`. Test: `server/test/store.test.ts`.

**Interfaces — Produces:** `openCrm(profile:'standard'):Crm` where `Crm{tx<T>(fn:(db:StoreTx)=>T):T; close():void}`; `StoreTx{all(sql,params):Row[]; get(sql,params):Row|undefined; run(sql,params):{changes:number}}`; `resetCrm(profile,templatePath):Promise<{ms:number}>` implementing close→copy→reopen (LLD §3.2); `ddl():string[]`.

- [ ] Step 1: Failing tests: `ddl()` creates all tables; every searchable column in `model.ts` marked `indexed` yields an index; insert+query round-trip on `contacts`; `resetCrm` restores a mutated DB to template bytes and returns ms<1000.
- [ ] Step 2: Run (fail) → implement with `node:sqlite` `DatabaseSync` → run (pass). Merged-table rules from LLD §3.2 (messages/line_items/content_items/participations).
- [ ] Step 3: Commit `feat: entity model + sqlite store + template reset`.

### Task 4: Seed generator + committed template

**Files:** Create `server/src/entities/seed.ts`, `scripts/seed-standard.ts`. Test: `server/test/seed.test.ts`. Artifact: `server/data/crm-standard.template.db` (committed).

**Interfaces — Produces:** `seedStandard(db, seed=42):SeedSummary` (~50k rows, weighted; relational integrity by generation order; all timestamps via VirtualClock; distributions guarantee scenario raw material: ≥200 leads created "last week", ≥40 invoices overdue >15d, ≥25 unreplied conversations, ≥8 active sales-rep users, every module's tables non-empty).

- [ ] Step 1: Failing tests: row-count ranges per table; the four scenario-material guarantees above as SQL count assertions; run-twice-same-seed → identical SHA-256 of DB file.
- [ ] Step 2: Implement; `npm run seed` writes the template; commit template + `chore: committed standard template db`.

### Task 5: Event log, spans, LLM client + cost logger

**Files:** Create `server/src/events/types.ts` (verbatim LLD §2.3), `server/src/events/log.ts`, `server/src/events/trace.ts`, `server/src/llm/client.ts`, `server/src/llm/prices.ts`, `server/src/llm/backoff.ts`. Test: `server/test/events.test.ts`, `server/test/llm-client.test.ts`.

**Interfaces — Produces:** `EventLog{append(sessionId,ev:Event):seq; list(sessionId,afterSeq?):Event[]; subscribe(sessionId,cb):unsub}` (sqlite-backed, `answer.delta` filtered from persistence, in-memory fan-out for SSE); `llmCall<T>(opts:{stage:'plan'|'repair'|'replan'|'compose'|'baseline'; model:string; schema?:ZodType<T>; system:string; prompt:string; turnId:string}):Promise<{value:T|string; usage:LlmUsage; spanId}>` wrapping `generateObject`/`generateText`, with exponential backoff on 429/5xx (max 5, 1s→16s), span recording, cost = OpenRouter native cost else `prices.ts` table, budget-guard throw past `EVAL_BUDGET_USD`.

- [ ] Step 1: Failing tests: append/list ordering + afterSeq; `answer.delta` not persisted but delivered to subscriber; span written per call (mock fetch); **missing-usage response → cost from price table, finite number** (Review Focus 5); 429 twice then 200 → succeeds with 3 attempts recorded; budget exceeded → typed `BudgetExceededError`.
- [ ] Step 2: Implement (AI SDK with `openrouter` provider; `usage:{include:true}`). Run (pass). Commit.

### Task 6: Day-1 spikes (go/no-go) + TARGETS.md

**Files:** Create `scripts/spike-cache.ts`, `scripts/spike-schema.ts`, `docs/SPIKES.md`, `docs/TARGETS.md`.

- [ ] Step 1: `spike-schema`: send the REAL `PlanOutcome` Zod schema (Task 9's `plan-schema.ts` stub version — write the schema file now, it has no deps) through `generateObject` on `anthropic/claude-haiku-4.5`, `google/gemini-2.5-flash-lite`, `openai/gpt-5-mini` with the LLD §2.2 conformance prompt. Record per-model pass/fail in SPIKES.md. **Fail ⇒ flatten per LLD §10 before Task 9 proceeds.**
- [ ] Step 2: `spike-cache`: two identical-prefix Haiku calls; record whether cached tokens appear in usage. **Fail ⇒ activate pre-decided fallback (baseline on 40-scenario subset) — note in SPIKES.md + TARGETS.md.**
- [ ] Step 3: Write `TARGETS.md` (pre-committed, per LLD §9.2 TTFUR definitions): direct p50 TTFUR <2s / p95 <4s; complex p50 plan.ready <4s, E2E <12s / p95 <25s; task success ≥85% optimized, ≥ baseline+15pts; cost/successful task <$0.01 optimized; repair-rate assumption <35% on complex. Commit all.

## Phase 1 — Catalog (the 500)

### Task 7: Catalog types, transcription, registry

**Files:** Create `server/src/catalog/types.ts` (verbatim LLD §2.1), `scripts/transcribe-catalog.ts`, `server/src/catalog/catalog.json`, `server/src/catalog/registry.ts`. Test: `server/test/registry.test.ts`.

**Interfaces — Produces:** `catalog.json`: `[{id:"M01.A01", module:"contacts", name:"Create contact"}…]` transcribed from `docs/assignment/` PDF (names already known); `Registry{all():ActionDef[]; get(slug):ActionDef|undefined; byModule(m):ActionDef[]}` auto-loading `m*.ts` files; `coreOps` registered as pseudo-ActionDefs (`core.filter`, `core.exclude_by`, `core.anti_join`, `core.join`, `core.pluck`, `core.distribute` — pure functions per LLD §2.2 signatures, risk `read`).

- [ ] Step 1: Failing tests: catalog.json has exactly 500 entries, 50 modules × 10, unique ids/slugs; registry loads a sample module file and exposes it; `core.anti_join({in:[{id:1},{id:2}],key:'id',exclude:[{cid:2}],excludeKey:'cid'})` → `{items:[{id:1}]}`; `core.distribute` round-robin shape `{items:[{item,assignee}]}` exact.
- [ ] Step 2: Transcribe (source: the action names in `docs/assignment/` PDF — verify count); implement registry + core ops. Run (pass). Commit.

### Task 8: Exemplar module (M01 Contacts) + smoke harness

**Files:** Create `server/src/catalog/m01-contacts.ts`, `eval/smoke.ts`, `server/src/catalog/testing.ts` (minimal-valid-input synthesizer from Zod + known-good seeded ids). Test: `server/test/m01.test.ts`, run `npm run smoke -- --module m01`.

**Interfaces — Produces:** the handler conventions every other module copies: Zod strict schemas; outputs `{id,name,…}`; lists cap 50 + `{ref,total,sample}` spill signal (`SPILL` marker object the executor converts to a RefHandle); errors via `ActionError(code,message)`; `jit` strings; idempotent writes keyed on `ctx.idempotencyKey` (an `idempotency` table: key→result snapshot, replay returns snapshot). Smoke harness: for every registered ActionDef, synthesize input, run in a tx, assert typed success or expected `ActionError`; **writes assert a state delta; Tier-A reads get a filter-discrimination check** (two contrasting values → different counts) per LLD §9.3.

- [ ] Step 1: Failing tests for all 10 M01 actions incl.: `search_contacts` filter-discrimination; `create_contact` twice with same idempotency key → one row; `archive_contact` on missing id → `NOT_FOUND`; `merge_duplicate_contacts` moves relations.
- [ ] Step 2: Implement M01 + smoke harness. `npm run smoke -- --module m01` green. Commit.

### Task 9: Remaining 49 modules (parallelizable fan-out)

**Files:** Create `server/src/catalog/m02-….ts` … `m50-reports.ts`. Verification: `npm run smoke` (all 500).

**Interfaces — Consumes:** Task 8 conventions exactly. **Per-module checklist (from LLD §9.3) applies to every file:** correct tables, `archived` respected, every input param applied, schema↔DDL names match, NOT_FOUND/VALIDATION paths, risk class sane (delete→destructive; send/publish→external; campaign-launch/segment-wide→bulk), clock only, id+name outputs, spill honored.

- [ ] Step 1: Generate stubs for m02–m50 from catalog.json (naive-but-real: touch state, typed errors — never canned success).
- [ ] Step 2: Hand-finish in five batches of ~10 modules (batch order: CRM core m02–m10 → messaging m11–m17 → scheduling m18–m24 → commerce m25–m34 → content/ops m35–m50). After each batch: `npm run smoke -- --modules <batch>` green, commit `feat: modules mXX-mYY`.
- [ ] Step 3: Full `npm run smoke` green (500/500, Tier-A checks on scenario-exercised + destructive/bulk/external set). Commit.

## Phase 2 — Agent

### Task 10: Plan schema, retrieval, planner, validator

**Files:** Create `server/src/agent/plan-schema.ts` (verbatim LLD §2.2 incl. `search` outcome), `server/src/agent/retrieval.ts`, `server/src/agent/planner.ts`, `server/src/agent/validator.ts`, `eval/probes/retrieval.yaml` (60 queries: ≥20 paraphrase, ≥12 typo), `scripts/probe.ts`. Tests: `server/test/plan-schema.test.ts`, `retrieval.test.ts`, `validator.test.ts`.

**Interfaces — Produces:** `retrieve(q:string, session:SessionCtx):{cards:Card[], playbook?:Playbook}` (minisearch `fuzzy:0.2, prefix:true`; score weights LLD §4; top 20, ≤4/module); `buildPlannerPrompt(ctx):{system:string; prompt:string}` (layout LLD §5.2 — system byte-stable: snapshot test); `validate(outcome:PlanOutcome, shortlist:Set<string>, handles:RefHandle[]):{ok:true, plan:Plan, planHash:string}|{ok:false, errors:ValidationError[]}` checking: known slugs (catalog, not just shortlist), Zod param compile per action, ref grammar (`$sN`/`$r_tT_sN`/`$item`-only-under-forEach), dependency acyclicity, `when`/`expects` shapes; `repair(plan, errors)` → `llmCall` with targeted messages, ≤`maxRepairs`.

- [ ] Step 1: Failing tests: conformance example (LLD §2.2 flagship JSON) parses + validates OK and hash is stable across key order; **unknown slug → repairable error, never throws** (Review Focus 3); `$item` outside forEach → error; cycle → error; probe runner computes recall@20.
- [ ] Step 2: Implement. `npm run probe` ≥0.95 recall@20 (else enable bge-small reranker contingency per LLD §4 and re-run). Snapshot-test the system prompt. Commit.

### Task 11: Executor + gates + resume

**Files:** Create `server/src/agent/executor.ts`, `server/src/agent/refs.ts` (RefHandle store + resolution per LLD §2.5). Test: `server/test/executor.test.ts` (fake registry with scripted handlers; no LLM).

**Interfaces — Produces:** `execute(plan, ctx):AsyncGenerator<Event>` implementing LLD §5.3 verbatim: strata, sequential reads, gate rule (`risk∈{destructive,bulk,external} OR affectedCount>50`; forEach gates once aggregate), pause via yielded `confirmation.required` + `awaitConfirmation(confirmId)`, idempotency keys `turnId:planRev:stepId:itemIndex`, TRANSIENT single retry, stuck ×3 hint/×4 halt, `forEachHardCap:500` refusal; `foldExecutor(events):ExecutorState` for resume; ref resolution with existence re-check + drift report, >25% drift on gated step → re-confirm.

- [ ] Step 1: Failing tests: conformance plan executes against scripted results (s8/s9 fan-out counts = distribute size, per-item keys distinct); **deny confirmation → step cancelled, dependents skipped, status 'cancelled', zero handler calls after deny** (Review Focus 2); bulk risk with 3 targets still gates; 51 targets gates; forEach create of 120 gates once with `affectedCount:120`; 501 fan-out → refused; TRANSIENT then success → one result, same key; stuck ×4 halts; **drift: handle with 200 ids, 30 missing → summary "170 of 200", gated step re-confirms** (Review Focus 4); `foldExecutor` over a paused turn's events reproduces frontier + pending confirmId.
- [ ] Step 2: Implement. Run (pass). Commit.

### Task 12: Joiner, working memory, composer, playbooks

**Files:** Create `server/src/agent/joiner.ts`, `server/src/agent/memory.ts`, `server/src/agent/composer.ts`, `server/src/playbooks/loader.ts` + 3 playbook files (LLD §7). Tests: `joiner.test.ts`, `memory.test.ts`, `composer.test.ts`.

**Interfaces — Produces:** `checkStratum(plan, completed):JoinerVerdict` (`proceed` | `violation{stepId, expect, actual}`); `joinerRepair(…)` → patch bumping planRev (≤`maxReplans`); `foldMemory(events):WorkingState` (single frame, entities, ≤6 handles, starts from last `memory.snapshot`); `renderContext(state, lastTurns):string` (masking: tool results older than 3 turns → one-liners; WorkingState block last); `rewriteQuery(userText, state):string`; `compose(plan, results, status):string` (pure templates — counts, names, failures, pending; NO model call); playbook loader validates slugs at boot (bad slug → startup throw).

- [ ] Step 1: Failing tests: nonEmpty violation detected; pass-case costs zero LLM calls; memory fold rebuilds frame+handles from events incl. post-snapshot only; rewrite "only the Facebook ones" + state(frame filters + handle) → standalone query containing source:facebook + original intent; compose covers done/partial/cancelled with exact counts; playbook with unknown slug fails boot.
- [ ] Step 2: Implement. Run (pass). Commit.

### Task 13: Pipeline + model router

**Files:** Create `server/src/agent/pipeline.ts`, `server/src/llm/router.ts`. Test: `server/test/pipeline.test.ts` (MockLLM scripted per test).

**Interfaces — Produces:** `runTurn(sessionId, userText):AsyncGenerator<Event>` wiring LLD §5 end-to-end: fold → rewrite → retrieve → plan (router picks model per LLD §5.5) → validate/repair ≤2 → execute (with joiner checkpoints, replan ≤2, search outcome loops ≤2) → compose → `answer.delta`s + `answer.final` + `turn.completed{metrics}` + `memory.snapshot`. Enforces `maxLlmCallsPerTurn:6`, `turnTimeoutMs`. `clarify`/`unsupported`/`respond` short-circuit paths.

- [ ] Step 1: Failing tests (MockLLM): direct 1-step plan → exactly 1 LLM call, correct event sequence incl. plan.ready AFTER validation; `search` outcome → retrieval re-run → plan → 2 calls total; clarify path emits no handler calls; llm-call budget 6 enforced (7th scripted call → turn fails honestly); metrics fields all finite.
- [ ] Step 2: Implement. Run (pass). Commit.

### Task 14: Baseline agent

**Files:** Create `server/src/baseline/agent.ts`, `server/src/baseline/catalog-summary.ts`. Test: `server/test/baseline.test.ts`.

**Interfaces — Produces:** `runBaselineTurn(sessionId,userText):AsyncGenerator<Event>` per LLD §8: full summarized catalog (~12k tokens, generated once from registry, snapshot-tested), single `call_action{slug,params}` tool, AI SDK loop `stopWhen: stepCountIs(12)`, same gate + events; TTFUR event = first visible token/tool-intent.

- [ ] Step 1: Failing tests (MockLLM): dispatches via registry with validation; gate fires for destructive; events render in same UI schema; catalog summary contains all 500 slugs.
- [ ] Step 2: Implement. Run (pass). Commit.

### Task 15: HTTP API + SSE + sessions

**Files:** Create `server/src/api/sessions.ts`, `server/src/api/stream.ts`, `server/src/api/admin.ts`, `server/src/api/metrics.ts`. Test: `server/test/api.test.ts` (fastify inject + real EventLog + MockLLM pipeline).

**Interfaces — Produces:** the full LLD §6 contract verbatim (POST messages = SSE response; GET `/stream?afterSeq` resumable with `Last-Event-ID`; confirm/cancel; events paging; traces; metrics; admin reset marks refs stale; catalog listing). Session titles = first 40 chars of first message.

- [ ] Step 1: Failing tests: full turn over inject → SSE frames parse to the Task 13 event sequence; **drop stream after `confirmation.required`, reconnect `GET /stream?afterSeq=n` → receive the pending confirmation event and complete the turn via POST confirm** (Review Focus 1); replay endpoint returns `answer.final` not deltas; reset → handles stale + CRM template-fresh; one-turn-at-a-time per session (second POST during run → 409).
- [ ] Step 2: Implement. Run (pass). Commit `feat: api + sse + sessions`.

## Phase 3 — Eval harness

### Task 16: Scenario format, assertion engine, runner

**Files:** Create `eval/types.ts`, `eval/assert.ts`, `eval/runner.ts`, `eval/report.ts`, 6 seed scenarios (one per: direct, multistep-conformance-flagship, followup, ambiguous+mustNotAsk, unsupported, typo). Test: `eval/test/assert.test.ts`, `eval/test/runner.test.ts`.

**Interfaces — Produces:** scenario YAML schema per LLD §9.1 (incl. `countDelta`, `mustNotAsk`, `injectFailures`); runner per LLD §9.2: drives real HTTP, auto-approve-iff-expected, per-tuple incremental JSONL, `--resume`, `--quick` (stratified 20×1), `--shard k/m` (own port+template copy per shard), budget-guard abort→partial report; `report.ts` → `BENCHMARK.md` tables: pass^1/pass^3 per category, TTFUR+E2E p50/p95 split direct/complex (per-outcome TTFUR defs from TARGETS.md), tokens+cost per request & per successful task, baseline deltas, **misses vs TARGETS verbatim**.

- [ ] Step 1: Failing tests: assertion engine on fixture transcripts (planActions orderFree, paramChecks, state via SQL, countDelta, behavior flags, mustNotAsk); runner resumes skipping completed tuples (kill-and-rerun fixture); report math (p50/p95, pass^3 = all-3-trials) on synthetic rows.
- [ ] Step 2: Implement; run the 6 seed scenarios live against MockLLM pipeline (deterministic). Commit.

### Task 17: Scenario corpus (continuous; quota-gated)

**Files:** Create `eval/scenarios/*.yaml` (≥110), `eval/lint.ts` (coverage: every module ≥2; every category + subtype ≥2; VIRTUAL_NOW-relative dates only).

- [ ] Step 1: Build `eval/lint.ts` + failing lint. Author batch A (~40: all direct + unsupported + ambiguous + typo + abstention) — cheap categories, delta assertions preferred.
- [ ] Step 2: Batch B (~40 multistep/conditional, incl. the brief's four worked examples). Batch C (~30 followup/failure-injection/distractor/no-repeat). `npm run eval -- --lint` green after each batch; human-verify each batch against the seeded DB before commit (expected numbers derived by SQL, not by eye). Commit per batch.
- [ ] Step 3: `npm run eval:quick` with live planner (Haiku) green-or-triaged; fix scenario bugs vs agent bugs explicitly. Commit.

## Phase 4 — Web UI

### Task 18: Chat core (graded half)

**Files:** Create `web/src/stores/session.ts` (Pinia), `web/src/lib/sse.ts` (fetch-stream parser — NOT EventSource for POST), `web/src/components/{ChatView,TaskTracker,ConfirmCard,ClarifyCard,CostBadge,Sidebar}.vue`, error states per LLD §6.

- [ ] Step 1: `sse.ts` unit test (vitest + mock ReadableStream): parses event frames, resumes via `afterSeq`.
- [ ] Step 2: Build components against the event schema (tracker: pending/running/done/failed per step; confirm card shows scope description + affectedCount + approve/deny; cost badge from turn.completed). Sidebar: list + new + open (flat, date-grouped).
- [ ] Step 3: Verify manually against live server (script: direct request, confirm flow, SSE-drop reconnect via DevTools offline toggle). Commit.

### Task 19: Full-scope session UX (user-kept scope)

**Files:** Create `web/src/components/{TraceView,AuditFeed,ReplayView}.vue`.

- [ ] Step 1: Replay: open old session renders identical UI from `GET events` (same renderer as live — assert by rendering a recorded fixture both ways and diffing DOM). Continue-conversation works (new turn in old session).
- [ ] Step 2: TraceView: per-turn span waterfall from `GET /api/traces/:turnId`. AuditFeed: filtered write/confirm events. Commit.

## Phase 5 — Benchmark + ship

### Task 20: Benchmark execution + report

- [ ] Step 1: Night of Nov 6: `npm run eval -- --shard` full run (optimized ×3) + `eval:baseline` (×1). Morning triage: classify failures scenario-bug vs agent-bug in a `TRIAGE.md`; fix; `--quick` verify.
- [ ] Step 2: Alt-model spot check (1 model × 20) if budget allows. Night of Nov 7: final full run.
- [ ] Step 3: `npm run benchmark:report` → `docs/BENCHMARK.md`; verify every TARGETS.md line has a verdict (met/missed, number shown). Commit.

### Task 21: README, demo, submission

**Files:** Create `README.md`, `docs/DEMO-SCRIPT.md`.

- [ ] Step 1: README per spec Goals §5 (architecture+agent design, catalog/schemas/registration, tool selection, context management, execution strategy, real-vs-mocked, install/run/env from a clean clone, eval reproduction, trade-offs, limitations, scaling beyond 500: deferred PPR/sub-run/10M designs with evidence).
- [ ] Step 2: DEMO-SCRIPT.md: the 6 mandatory items (spec Goals §6) with exact prompts to type and expected screen states.
- [ ] Step 3: Clean-clone verification on a second checkout: `nvm use && npm i && npm run seed && npm run dev` + one chat turn + `npm run smoke`. Push to GitHub. Tag `v1.0`.

---

## Self-review notes (performed)

- **Spec coverage:** every LLD section maps to a task (§1→T1, §2.1→T7-8, §2.2→T10, §2.3/2.4→T5, §2.5→T11-12, §3→T3-4, §4→T10, §5→T11-13, §6→T15, §7→T12, §8→T14, §9→T16-17+T8 smoke, §10→T5-6, §11→phase order). Gap found and fixed: idempotency snapshot table added to T8 (LLD implies, never names it).
- **Type consistency:** `RefHandle`, `Event`, `PlanOutcome`, `StoreTx` names used across T5/T10/T11/T12/T15 all match LLD §2.
- **Review Focus:** all 5 pinned to owning tasks (T15, T11, T10, T11, T5).
- **Proportion:** plan ≈ LLD length; bodies omitted except normative shapes already in the LLD.
