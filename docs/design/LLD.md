# Ask AI Framework — Low-Level Design (LLD)

**Version:** 1.1 (post staff review, 2026-11-04) · **Companion:** [HLD.md](./HLD.md)
Everything here is the build contract. Field names are normative unless marked (builder).
v1.1 resolves all review blockers: anti-join op, `$item` binding, idempotency key scheme,
`search` plan outcome, unified ref grammar, unified bulk gate, honest sequential reads,
single reset mechanism, baseline definition, runner resilience, restart-safe confirmations.

---

## 1. Repository Layout

```
ask-ai/
├─ server/
│  ├─ src/
│  │  ├─ catalog/            # m01-contacts.ts … m50-reports.ts + registry.ts + types.ts
│  │  ├─ entities/           # entity model (~22-25 merged tables), DDL, seed generators
│  │  ├─ store/              # sqlite access layer, query API, reset, virtual clock
│  │  ├─ agent/
│  │  │  ├─ pipeline.ts      # runTurn() orchestration
│  │  │  ├─ memory.ts        # working memory fold + query rewrite
│  │  │  ├─ retrieval.ts     # bm25 + boosts (fuzzy enabled)
│  │  │  ├─ planner.ts  plan-schema.ts  validator.ts
│  │  │  ├─ executor.ts      # scheduler + gates + stuck detection + resume fold
│  │  │  ├─ joiner.ts  composer.ts
│  │  ├─ playbooks/          # *.skill.md + loader (start with 3)
│  │  ├─ llm/                # AI SDK wrapper, cost logger, model router, backoff, budget
│  │  ├─ events/             # event types, log, projections (sse|trace|metrics|audit)
│  │  ├─ api/                # fastify routes
│  │  └─ baseline/           # ReAct baseline (summarized catalog + call_action tool)
│  └─ test/                  # unit + smoke
├─ web/                      # Vue 3 + Vite + Pinia; components: ChatView, Sidebar,
│                            # TaskTracker, ConfirmCard, TraceView, AuditFeed
├─ eval/
│  ├─ scenarios/  probes/retrieval.yaml  runner.ts  assert.ts  report.ts  smoke.ts
├─ docs/  (TARGETS.md, BENCHMARK.md, design/, research/, assignment/)
└─ scripts/ (seed-standard.ts, seed-scale.ts(500k stretch), transcribe-catalog.ts)
```

**Runtime pin:** `"engines": {"node": ">=22.5"}` + `.nvmrc` + README line 1
(`node:sqlite` requires it — do NOT write "Node 20" anywhere).

## 2. Core Types

### 2.1 ActionDef (catalog/types.ts)

```ts
type Risk = 'read' | 'write' | 'destructive' | 'bulk' | 'external';
// 'bulk'   = action is inherently wide (campaign launch, segment send) → ALWAYS gates (§5.3)
// numeric width of narrow actions is gated dynamically via affectedCount (§5.3)

interface ActionDef<I = unknown, O = unknown> {
  id: string;            // "M01.A01"
  slug: string;          // "contacts.create_contact"
  module: string; name: string; description: string;
  risk: Risk;
  entities: string[];
  inputSchema: z.ZodType<I>;    // strict
  outputSchema: z.ZodType<O>;
  searchCard: { synonyms: string[]; examplePhrasings: string[]; disambiguation?: string };
  jit?: string;          // guidance appended inside successful results (≤120 tokens)
  handler: (input: I, ctx: ActionContext) => Promise<O>;
}

interface ActionContext {
  db: StoreTx;
  clock: VirtualClock;          // handlers NEVER call Date.now()
  idempotencyKey: string;       // `${turnId}:${planRev}:${stepId}:${itemIndex}` (§5.3)
  format: 'concise' | 'detailed';
}
```

**Error taxonomy** (`ActionError.code`): `VALIDATION` · `NOT_FOUND` · `CONFLICT` ·
`TRANSIENT` (executor retries once) · `FORBIDDEN` · `LIMIT_EXCEEDED`. Actionable messages.
**Output discipline:** records include `id` AND display name; list outputs cap at 50 rows
inline — larger sets return `{ref, total, sample: Row[20]}` (§2.5).

### 2.2 Plan DSL (agent/plan-schema.ts)

```ts
type PlanOutcome =
  | { kind: 'plan'; plan: Plan }
  | { kind: 'search'; queries: string[] }      // retrieval escape hatch: pipeline runs
                                               // search → re-plan; max 2 rounds, counted
                                               // in maxLlmCallsPerTurn
  | { kind: 'clarify'; question: string }      // exactly one focused question; MUST NOT
                                               // ask for info present in working state
  | { kind: 'unsupported'; reason: string }
  | { kind: 'respond'; text: string };

interface Plan { goal: string; steps: Step[] }

interface Step {
  id: string;                     // "s1"
  action: string;                 // slug from shortlist (or prior search round)
  params: Record<string, Value>;  // Value = JSON literal | RefString
  dependsOn: string[];
  forEach?: RefString;            // fan-out over a list; inside this step, $item is bound
  when?: { ref: RefString; op: 'eq'|'gt'|'lt'|'nonempty'|'empty'; value?: unknown };
  expects?: { nonEmpty?: boolean; maxCount?: number; minCount?: number };
}
```

**Ref grammar (the ONLY forms; validator enforces):**

```
$s<N>[.path]        intra-plan step result        e.g. $s1.items[*].id
$r_t<T>_s<N>[.path] cross-turn handle from WorkingState (serialized there verbatim)
$item[.path]        current element — legal ONLY inside a step that has forEach
path := field | field.path | items[*] (pluck over array)
```

`"$turnN.sM"` syntax does NOT exist. WorkingState serializes handles as
`$r_t3_s1 (200 leads — leads.search_leads, turn 3)` so the planner emits exactly what it sees.

**Built-in data ops** (deterministic pseudo-actions, zero LLM, risk='read'):

```
core.filter     {in: Ref, field, op: eq|neq|gt|lt|contains, value}        → {items}
core.exclude_by {in: Ref, field, op, value}       // scalar predicate     → {items}
core.anti_join  {in: Ref, key, exclude: Ref, excludeKey}  // set difference → {items}
core.join       {in: Ref, key, with: Ref, withKey, as}    // enrich        → {items}
core.pluck      {in: Ref, field}                                          → {items}
core.distribute {items: Ref, across: Ref, strategy: 'round_robin'}
                → {items: Array<{item, assignee}>}        // shape is normative
```

**DSL conformance example (the brief's flagship — MUST be expressible; lives as a unit test):**
"Find leads created last week who have not replied, exclude anyone with a booked
appointment, assign the remaining leads to available sales reps, and create follow-up tasks."

```jsonc
{ "goal": "Assign & create follow-up tasks for last week's unreplied, unbooked leads",
  "steps": [
  {"id":"s1","action":"leads.search_leads","params":{"created_after":"2026-10-26","created_before":"2026-11-02"},"dependsOn":[],"expects":{"nonEmpty":true}},
  {"id":"s2","action":"conversations.search_conversations","params":{"contact_ids":"$s1.items[*].contact_id","has_inbound_reply":true},"dependsOn":["s1"]},
  {"id":"s3","action":"core.anti_join","params":{"in":"$s1.items","key":"contact_id","exclude":"$s2.items","excludeKey":"contact_id"},"dependsOn":["s1","s2"]},
  {"id":"s4","action":"appointments.search_appointments","params":{"contact_ids":"$s3.items[*].contact_id","status":"booked"},"dependsOn":["s3"]},
  {"id":"s5","action":"core.anti_join","params":{"in":"$s3.items","key":"contact_id","exclude":"$s4.items","excludeKey":"contact_id"},"dependsOn":["s3","s4"]},
  {"id":"s6","action":"users.list_users","params":{"role":"sales_rep","active":true},"dependsOn":[],"expects":{"nonEmpty":true}},
  {"id":"s7","action":"core.distribute","params":{"items":"$s5.items","across":"$s6.items[*].id","strategy":"round_robin"},"dependsOn":["s5","s6"]},
  {"id":"s8","action":"leads.assign_lead_owner","params":{"lead_id":"$item.item.id","owner_id":"$item.assignee"},"forEach":"$s7.items","dependsOn":["s7"]},
  {"id":"s9","action":"tasks.create_task","params":{"title":"Follow up with $item.item.name","contact_id":"$item.item.contact_id","owner_id":"$item.assignee","due_date":"2026-11-05"},"forEach":"$s7.items","dependsOn":["s7"]}
]}
```

### 2.3 Events (events/types.ts)

```ts
type Event =
  | { t:'turn.started'; turnId; sessionId; userText; ts }
  | { t:'retrieval.done'; turnId; candidates: string[]; playbook?; ms }
  | { t:'plan.ready'; turnId; outcome: PlanOutcome; planRev: number; planHash; llm: LlmUsage }
      // fires AFTER validation; repair latency is inside TTFUR for plan-led turns
  | { t:'repair'|'replan'|'search'; turnId; round; reason; llm: LlmUsage }
  | { t:'step.started'; turnId; stepId; action; itemCount? }
  | { t:'step.finished'; turnId; stepId; summary; resultRef?: string;
      inlineResult?: unknown /* ≤2KB, else ref */; ms }
  | { t:'step.failed'; turnId; stepId; error:{code;message}; ms }
  | { t:'confirmation.required'; turnId; confirmId; planRev; planHash; stepId;
      scope: { actions: string[]; affectedCount: number; targetSample: string[];
               description: string } }
  | { t:'confirmation.resolved'; turnId; confirmId; approved }
  | { t:'answer.delta'; turnId; text }            // SSE-only, NOT persisted
  | { t:'answer.final'; turnId; text }            // persisted (replay reads this)
  | { t:'turn.completed'; turnId; status:'done'|'clarify'|'refused'|'failed'|'cancelled';
      metrics: TurnMetrics }
  | { t:'memory.snapshot'; turnId; state: WorkingState };  // fold checkpoint, every turn end
```

`fold` starts from the latest `memory.snapshot`, not from event zero (bounds rebuild cost).
Projections: SSE forwards all; persistence skips `answer.delta`; traces derive spans;
metrics aggregates `turn.completed`; audit filters write/confirm events.

### 2.4 Spans — unchanged from v1.0 (llm|retrieval|step|joiner|compose; tokens, cost, ms).

### 2.5 Working Memory (agent/memory.ts)

```ts
interface WorkingState {
  frame: TaskFrame | null;             // SINGLE active frame (v1.1: stack cut per review —
                                       // suspend/resume undemonstrable; completed frames
                                       // summarized one-line into entities provenance)
  entities: Record<string, EntityRef>; // "the Facebook campaign" → {id,type,name,source,turn}
  handles: RefHandle[];                // last ≤6 result handles, newest first
}
interface TaskFrame { intent; status:'active'|'completed'; filters: Record<string,unknown>;
                      missingParams: string[]; planHash? }
interface RefHandle {
  ref: string;            // "r_t3_s1" (serialized to planner as "$r_t3_s1 (…)")
  action: string; turnId: string; entityType: string; total: number;
  idList: string[];       // ≤10k ids; larger sets store the query descriptor instead
  query?: object;         // normalized params that produced the set
  sample: unknown[];      // 20 rows for display/planning
}
```

**Resolution semantics (normative):** a cross-turn ref resolves by **re-checking existence
of idList against the store at use time** (or re-running `query` when idList was elided).
Drift is reported, not hidden: "14 of 200 no longer match — proceeding with 186" goes into
the confirmation scope / step summary; drift >25% on a gated step forces re-confirmation.
`stale: true` only after `/admin/reset` (all handles marked). No frozen-snapshot writes.

**Writer rule (hard invariant):** executor resolves `$ref`s/entity IDs exclusively through
handles/step results server-side — never from model-emitted literal ID lists when a ref
exists. Transcript to planner: last 6 turns, older tool results masked to one-liners,
WorkingState block at the END of the user message.

## 3. Storage Schemas (node:sqlite)

### 3.1 Session domain (durable, `sessions.db`) — as v1.0, with:
`refs` stores `id_list TEXT, query TEXT, sample TEXT` (NOT full row payloads — full-row
storage contradicted the data-volume-independence claim). `events` excludes `answer.delta`.

### 3.2 CRM domain (resettable, `crm-{profile}.db`)
**~22–25 merged tables** (v1.1: merged from ~35 — one `messages` (channel col: sms|email),
one `line_items` (parent_type: quote|invoice|order), one `content_items`
(kind: website_page|landing_page|blog_post), one `participations`
(kind: event_registration|enrollment|membership|community_member)). Conventions unchanged:
TEXT ids `{prefix}_{n}`, virtual-clock epochs, `archived` soft-delete, indexes on every
searchable field. Entity model remains the FIRST day-1 deliverable.

**Profiles:** `standard` ~50k rows (committed as `crm-standard.template.db` in-repo —
byte-determinism across machines guaranteed by the artifact, not the generator);
`scale` = **stretch goal only** (500k–1M via seed-scale.ts; 10M design documented, not run).

**Reset (SINGLE mechanism — rollback path deleted):** `POST /admin/reset` →
close sqlite handle → copy template file → reopen → mark ALL session `refs` stale →
respond `{ms}` (budget <300ms). Virtual clock pinned to `2026-11-04T10:00:00Z` default
(`VIRTUAL_NOW` env), hardcoded in scenarios — never "today".

## 4. Retrieval (agent/retrieval.ts)

```
score(a) = 0.70·bm25(q′, card(a)) + 0.20·sessionBoost(a) + 0.10·moduleCohesion(a)
```

v1.1: **PPR action graph cut** (review: intellectual appeal, not rubric; README documents it
as "evaluated, deferred — probe set showed lexical sufficiency"). minisearch configured with
**`fuzzy: 0.2` + prefix matching — typos are a named brief requirement**. Probe set
(`eval/probes/retrieval.yaml`, 60 queries) now includes ≥12 typo and ≥20 paraphrase queries;
gate recall@20 ≥ 0.95; contingency unchanged (bge-small reranker behind a stubbed interface).
Diversification (≤4/module), card rendering, meta-actions in user message: as v1.0.

## 5. Agent Pipeline

### 5.1 Turn budgets (canonical — the spec defers to these)

```
maxLlmCallsPerTurn: 6      maxRepairs: 2      maxReplans: 2      maxSearchRounds: 2
turnTimeoutMs: 120_000     confirmTargetThreshold: 50
forEachHardCap: 500        // fan-out >500 → step REFUSED with "narrow the selection or use
                           // a bulk action"; never silently chunked
planRev: increments on every repair/replan/search re-plan (feeds idempotency keys)
```

### 5.2 Planner prompt layout — as v1.0 (cache-stable SYSTEM; context/playbook/actions/request
in USER; date in context; sorted-keys JSON). SYSTEM teaches the §2.2 grammar INCLUDING
`$item`, `$r_t*`, core.* signatures, and the search/clarify/unsupported outcomes.

### 5.3 Executor (agent/executor.ts)

```
stratum := next frontier of steps whose deps are satisfied
loop until all terminal or timeout:
  JOINER CHECKPOINT: if this stratum contains any write-bearing step, first check
    `expects` of ALL completed upstream reads (§5.4); diverged → joiner path
  reads in stratum  → execute SEQUENTIALLY (v1.1: node:sqlite is synchronous — parallel
    claims deleted; speed comes from indexed queries. Worker-thread pool = documented
    future option, not built)
  writes in stratum → strictly sequential; per write step:
    1. resolve params ($refs via server-side results/handles; literals via inputSchema)
    2. GATE (unified rule): fire confirmation iff
         risk ∈ {destructive, bulk, external}  OR  affectedCount > confirmTargetThreshold
       where affectedCount = resolved target count (updates/deletes/sends)
                           | forEach fan-out size (creates)
       forEach steps gate ONCE with aggregate scope (never per item)
       → emit confirmation.required{confirmId, planRev, planHash, stepId, scope}; PAUSE
       → resume only on confirmation.resolved(approved) matching SAME planHash+planRev
    3. execute; idempotencyKey = turnId:planRev:stepId:itemIndex (itemIndex=0 if no forEach)
       TRANSIENT → one retry (250ms backoff), same key (safe: keys are per-item)
  step.failed → dependents marked skipped; independent branches continue
  stuck: identical (action,args,errorCode) ×3 → hint into repair context; ×4 → halt turn
```

**Restart-safe resume (kept at user direction, now actually designed):**
`foldExecutor(turnEvents) → ExecutorState`: validated plan from `plan.ready` payload
(+ highest planRev from repair/replan events) · completed step results from
`step.finished.inlineResult|resultRef` · pending gate from last unresolved
`confirmation.required` (which carries `stepId`). On server boot: turns with a pending
confirmation are resumable (approval re-executes from the paused step; per-item idempotency
keys make partial fan-out re-runs safe); crashed turns WITHOUT a pending confirmation are
marked `turn.completed{status:'failed'}` with partial results reported. The 120s turn timer
restarts from resume, not from original start (documented in BENCHMARK.md if it fires).

### 5.4 Joiner — checkpoint model (v1.1)
Runs at every write-bearing stratum boundary (not "after last read"): checks `expects` of
completed upstream reads + forEach-source emptiness + filter-to-zero-from-nonzero. All pass
→ proceed (no LLM — common case free). Violation → one repair-style call (original plan +
violated expectation + actual summaries) → `patch (bumps planRev) | proceed | clarify |
abort`. Max 2 rounds, then honest partial report. Validator additionally warns (not
forbids) reads depending on writes; such reads get no expects-protection and the README
documents the limitation.

### 5.5 Model routing — as v1.0 (flash-lite simple / Haiku default / env override;
misroute escalates via validator failure; GPT-5 family always minimal reasoning effort).

## 6. API Contract

```
POST /api/sessions                      → {id}
GET  /api/sessions?limit&cursor         → [{id,title,updated_at,turns,cost_usd}]
GET  /api/sessions/:id/events?afterSeq  → Event[]                 (replay, paged)
POST /api/sessions/:id/messages         → SSE stream (primary live channel)
GET  /api/sessions/:id/stream?afterSeq  → SSE (v1.1: RECONNECT channel — resumable via
                                          Last-Event-ID=seq; fixes dropped-connection-
                                          during-confirmation dead end)
POST /api/sessions/:id/confirm/:confirmId {approved} → 204
POST /api/sessions/:id/cancel           → 204
GET  /api/traces/:turnId                → {spans}   (OTel-compatible JSON)
GET  /api/metrics?window                → aggregates
POST /admin/reset?profile&seed          → {ms}
GET  /admin/catalog                     → module/action listing
```

Client note (write it down so nobody builds `EventSource` against a POST): the live stream
is fetch-streaming on the POST response; `EventSource` is only valid on GET `/stream`.
Vite dev proxy `/api → :3000` configured day 1 (SSE breaks cross-origin otherwise).
UI error states (normative): SSE drop → banner + auto-reconnect via `/stream`; turn
`failed` → red step card + partial-results text; server unreachable → retry screen.

## 7. Playbooks — as v1.0, but START WITH 3 (`lead-follow-up-sweep`,
`overdue-invoice-reminders`, `pipeline-review`); grow only if days 3–4 hold.

## 8. Baseline Agent (v1.1 — single definition, runnable on every matrix model)

**Summarized-catalog + dispatch-tool ReAct** (resolves the tool-defs-vs-summary
contradiction; avoids OpenAI's 128-tool cap): context carries a compact text catalog of all
500 actions (slug + one-liner, ~12k tokens, resent per step — that's the point of the
baseline); ONE tool `call_action{slug, params}` validated against the registry at dispatch;
AI SDK loop `stopWhen: stepCountIs(12)`; same handlers, confirm gate, transcript. Baseline
TTFUR := first assistant-visible token or tool-intent event (disclosed in BENCHMARK.md).
**Baseline runs 1 trial** (pass^k is measured on the optimized agent only — disclosed).

## 9. Eval Harness

### 9.1 Scenario format — as v1.0 plus (v1.1):
- subtypes: `typo` (misspelled prompts; pass = correct action anyway), `no-repeat`
  (clarify turns carry `mustNotAsk: [field]` — fails if the question re-asks known info)
- **prefer delta assertions** (`countDelta: +9`) over absolute counts — absolute counts
  couple scenarios to the seed and one generator tweak invalidates dozens
- coverage lint unchanged (every module ≥2; all categories + subtypes ≥2 each)

### 9.2 Runner (v1.1 — resilience is non-negotiable)
- LLM-level **exponential backoff on 429/5xx/timeout** (separate from handler TRANSIENT)
- **incremental JSONL** result writes per (scenario, trial, agent) tuple
- **`--resume`** skips completed tuples; **`--quick`** = stratified 20 × 1 trial (the inner
  debug loop); **`--shard N/M`** across 2–4 server instances, each with its own copied
  template DB + port (cuts the 9–14h full run 3–4×)
- full matrix: optimized ×3 trials, baseline ×1, alt-model spot check (1 model × 20) —
  budget recomputed: ≈$12–18 worst case under ceiling; **pre-decided fallback** if day-1
  cache spike fails: baseline on 40-scenario stratified subset (disclosed)
- overnight cadence: first full run night of Nov 6, final night of Nov 7
- TTFUR definitions (TARGETS.md, per outcome): direct read → first `answer.delta`;
  destructive direct → `confirmation.required`; multi-step → post-validation `plan.ready`;
  baseline → first visible token. BOTH `plan.ready` and first `answer.delta` timestamps
  recorded for every turn so the definition can be defended or re-sliced.

### 9.3 Smoke (v1.1 — tiered to match review finding on silent codegen bugs)
All 500: minimal-valid-input invocation + typed success/error + **state delta asserted for
writes**. Tier A (~120 scenario-exercised + all destructive/bulk/external actions) adds:
**filter-discrimination check** (two contrasting filter values must yield different counts —
catches accepted-but-ignored params, the #1 codegen bug) + round-trip (write visible via
sibling read). Tier B = smoke-level, disclosed in README as "smoke-verified".
Handler review checklist (per module): correct tables + `archived` respected · every
input param applied · schema↔DDL name drift · NOT_FOUND/VALIDATION paths · risk class
sane · virtual clock only · id+name in outputs · list cap/ref spill honored.

## 10. Instrumentation & Config — as v1.0 plus:
`.env.example` committed (OPENROUTER_API_KEY, PLANNER_MODEL, FAST_MODEL, PROFILE,
VIRTUAL_NOW, EVAL_BUDGET_USD=25, PORT, PROVIDER_ORDER). npm scripts (normative):
`dev · seed · smoke · probe · eval · eval:quick · eval:baseline · benchmark:report`.
**Day-1 go/no-go spikes:** (A) OpenRouter cache-hit verification per provider (decides
baseline budget fallback); (B) real `PlanOutcome` Zod schema through `generateObject` on
Haiku 4.5 + flash-lite + one matrix model — if union shapes fail on Gemini/GPT structured
outputs, flatten refs to plain strings (already strings) and lift unions to a
`kind`-discriminated flat object BEFORE building the planner.

## 11. Build Order (revised plan — reviewer version adopted)

**D1 (Nov 4):** entity model (merged) + DDL + seed + template commit + store + reset +
clock · catalog transcription (assert 500) + codegen all 500 naive-but-real stubs ·
LLM client + spans + Spikes A/B · TARGETS.md, .env.example, scripts, engines pin, Vite
proxy · evening: Tier-A handler finishing begins; first 30 cheap scenarios drafted.
**D2 (Nov 5):** tiered handler review done; smoke green (incl. Tier-A discrimination) ·
BM25 retrieval + probe gate · Plan DSL + planner + validator + repair · executor started ·
baseline built · 60 scenarios verified.
**D3 (Nov 6):** executor (gates, resume fold) + joiner + composer (templates only) +
working memory + SSE + sessions · 3 playbooks · runner (backoff/JSONL/--resume/--quick/
shard) · --quick loop until stable · 100+ scenarios · **overnight: full run** (opt ×3,
base ×1).
**D4 (Nov 7):** triage overnight fallout (expect scenario-bug majority) · Vue UI (chat,
tracker, confirm/clarify, cost badge, sidebar+replay, trace view, audit feed — full scope
per user) · alt-model spot check · **overnight: final run**.
**D5 (Nov 8):** BENCHMARK.md from final traces (misses verbatim) · README (incl. install/
run/env, execution strategy, real-vs-mocked, deferred designs: PPR/sub-run/10M) · **demo
recording against the 6-item checklist** (direct · indirect · complex ≥3 modules ·
request-changing follow-up · ambiguity/failure handling · benchmark results) · push repo,
verify clean-clone boot · submit by evening. No code after noon except showstoppers.

**Daily go/no-go artifacts:** D1 spikes answered · D2 smoke green · D3 full run launched ·
D4 final run launched. A day ending without its artifact executes the next cut:
matrix spot-check → playbooks 3→2 → trace/audit panels → scenario 110→100.
```
