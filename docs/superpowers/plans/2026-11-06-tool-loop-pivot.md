# Tool-Loop Pivot Implementation Plan (rev 3 — OpenAI Agents SDK)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production agent's plan-then-execute path (planner DSL → validator/repair → executor → composer) with a **native tool-calling loop on the OpenAI Agents SDK**: per turn, the retrieved shortlist of catalog actions is bound as real tools (existing zod-4 schemas), the model sees every result before deciding the next step, and writes the final answer itself.

**Architecture:** The loop engine is `@openai/agents` (user decision 2026-11-06, superseding rev 2's `generateText` wrapper) driving models through OpenRouter via `OpenAIProvider({ useResponses: false })`. Deterministic rails stay server-side and OURS: ISO-only date coercion, pre-execution confirmation gates via the existing broker (inside tool `execute()` — no double-execution by construction; rationale recorded below), spill-handle tools for full-set sort/aggregate, idempotency keys, step/deadline budgets, StuckDetector-lite. A decorator `Model` intercepts every model call for cost-meter/span accounting. The old pipeline stays in-tree as the `'plandsl'` benchmark comparator; `'optimized'` becomes the loop. Event vocabulary, gates, refs, SSE/UI unchanged.

**Tech Stack:** TypeScript, zod ^4.6.7, `@openai/agents` **pinned exact at 0.21.0** (0.x churn — 4 minor releases in 6 weeks) + `openai ^7.2`, OpenRouter, vitest, better-sqlite3.

**Spec:** `docs/research/2026-11-06-SYNTHESIS-loop-vs-plan.md` (adjudication research) + the OpenAI Agents SDK fact sheet findings recorded in that doc's decision log, implementing `docs/design/2026-11-06-architecture-review.md` §3 Option B. Failure evidence: `.superpowers/sdd/2026-11-04-ask-ai-implementation/humantest-round3-*-findings.md`.

## Global Constraints

- **Native per-tool schemas, always:** every action the model can call is an Agents SDK `tool({...})` whose `parameters` is a zod-4 schema (SDK validates locally before `execute`, strict mode auto). No JSON-encoded-string params anywhere model-facing. Tool names: slug with `.` → `__` (provider function-name charset).
- **Schema fallback (spike-verified, docs/SPIKES.md 2026-11-06):** 24/508 catalog schemas use `z.record(...)` and fail strict conversion — for those, `toolParameters(action)` emits `strict: false` + `JSON.parse(JSON.stringify(z.toJSONSchema(schema, {io:'input', target:'draft-7'})))` (the stringify strip removes zod's hidden `~standard` marker, which otherwise makes the SDK demand strict mode). Coerced params are ALWAYS re-validated against the original zod schema in `execute` regardless of path.
- **Runner isolation (spike-verified):** always explicit `new Runner({ modelProvider: new OpenAIProvider({ openAIClient, useResponses: false }), tracingDisabled: true })` — never `setDefaultOpenAIClient` (sticky global). `errorHandlers` and `signal` are RUN options, not Runner-constructor options.
- **Toolset is stable WITHIN a turn**; it changes only between turns via retrieval (Manus "mask, don't remove").
- **Tracing egress OFF at startup:** `setTracingDisabled(true)` before any run (default exporter ships run data incl. LLM inputs/outputs to OpenAI's trace backend). If a trace processor is ever added, use `setTraceProcessors()` (replace), never `addTraceProcessor()` (additive).
- **Model always set explicitly** on the Agent (unset falls back to an OpenAI default slug that is invalid on OpenRouter). Model: `plannerModel()` (haiku-class) only; no flash-lite.
- **Serial execution:** `modelSettings.parallelToolCalls: false` AND `toolExecution.maxFunctionToolConcurrency: 1` — writes must be sequential through the gate; our event stream assumes serial steps.
- The model NEVER computes epoch-ms timestamps: date-like params accept ISO-8601 or `@`-relative strings, coerced server-side; the tool result echoes the resolved absolute range back.
- **Gate pattern (decision):** pre-execution broker await INSIDE tool `execute()` (not `needsApproval` interruptions). Rationale: SDK docs confirm approval-resume does "not guarantee exactly-once tool side effects" (app's job); our broker gate never invokes the handler on deny, preserving no-double-execution by construction, and keeps `SessionRuntime`/cancel semantics unchanged. Blocking in `execute()` is mechanically supported (no default tool timeout); acceptable for our single-process runs where the suspended turn already lives in memory. The serialized-`RunState` interruption flow is the documented future path if cross-process resume is ever needed. A denial returns the tool result "DENIED by the user — this action was NOT executed" so it is in-trace.
- Idempotency keys `${turnId}:0:s${n}:0` on every write dispatch (belt-and-braces).
- No internal vocabulary in user-facing text: no dotted slugs, no `r_tNN_sN` handles, no "truncated"/"sample" jargon.
- Every turn emits exactly one `turn.completed` and one `memory.snapshot`.
- Loop budgets: `maxTurns: 12` with `errorHandlers.maxTurns` producing an honest final output WITHOUT another model call; wall-clock deadline via `AbortSignal.timeout(90_000)` passed to `run()` → abort finalizes `status:'failed'` honestly; `modelSettings.timeoutMs` 60s per model call.
- **No `outputType`/structured final output** — the final answer is prose (`answer.final`); this sidesteps the fact sheet's top OpenRouter risk (json_schema support varies per upstream provider).
- StuckDetector-lite: 3× semantically-identical action+error → corrective hint in the tool result; 4× → finalize `'failed'`.
- Old pipeline modules are NOT deleted — they remain the `'plandsl'` comparator.

## Review Focus

Model *behavior* can't be pinned by scripted-mock tests; these five land in Task 8's human round:

1. **Count honesty on spilled results** — totals from result metadata ("30 total, here are 3"), never counting the sample (round-3 F20).
2. **Denied-gate narration** — answer states nothing executed (F2). Denial-as-tool-result pinned in Task 5; narration in Task 8.
3. **Specific refusals** — `session__refuse` reason reaches `answer.final` verbatim (R3-4/F8).
4. **Follow-up filter continuity** — "reassign the oldest one" stays scoped (R3-1). Scope artifact pinned in Task 3; behavior in Task 8.
5. **Choosing the handle tools** — does haiku call `data__sort_ref`/`data__aggregate_ref` when a result shows `total` > sample? Prompt hints in Task 1; replayed in Task 8 ("biggest value", "oldest overdue", "average owed"). Also watch: multi-turn tool-call round-trips on reasoning-capable OpenRouter slugs (open SDK issue #2110 — OpenRouter's `reasoning` key is handled, but verify on our slugs).

---

### Task 1: Loop prompts

**Files:**
- Create: `server/src/loop/prompts.ts`
- Test: `server/test/loop-prompts.test.ts`

**Interfaces:**
- Produces: `buildLoopSystemPrompt(): string` (static, byte-stable — role, honesty rules, tool-use guidance), `buildLoopUserPrompt(input: { userText: string; nowIso: string; dateAnchors: string; recentTurns: string }): string`.

- [ ] **Step 1: Write failing tests** — system prompt contains rules: dates as ISO-8601 strings or `@`-relative, never epoch numbers; "state totals from result metadata; list at most 3 as examples of the total"; "if a result's `total` exceeds the rows shown, use `data__sort_ref`/`data__aggregate_ref` with the result's ref — never guess from the sample"; "if an action was denied it was NOT executed — say so plainly"; "use `session__ask_user` when you need a decision from the user, `session__refuse` (with the specific reason) when the request cannot be done"; no internal ids/jargon in answers. User prompt embeds all four inputs.
- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run test/loop-prompts.test.ts`.
- [ ] **Step 3: Implement** (system prompt free of per-turn content; per-turn material in the user message).
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `feat(loop): system/user prompts for agents-sdk tool loop`

### Task 2: Deterministic date rail

**Files:**
- Create: `server/src/loop/date-rail.ts`
- Test: `server/test/loop-date-rail.test.ts`

**Interfaces:**
- Consumes: `DATE_FIELD_RE`, `resolveRelativeDate(expr, nowMs)` from `agent/date-expr.ts`.
- Produces: `coerceDateParams(params: Record<string, unknown>, nowMs: number): { params: Record<string, unknown>; resolved: string[] }` (new object; deep-walk; ISO/`@`-relative strings under `DATE_FIELD_RE` keys → epoch ms; `resolved` = human-readable echo lines); `buildDateAnchors(nowMs: number): string` (now ISO + weekday, today 00:00/23:59 UTC, tomorrow, start/end of month, 7 days ago); `widenDateFields(schema: ZodObject): ZodObject` — returns a copy of an action's input schema whose `DATE_FIELD_RE`-matching numeric fields also accept strings (this widened schema is what the model sees; the ORIGINAL schema re-validates after coercion, Task 5).

- [ ] **Step 1: Write failing tests** — pinned now `1793786400000` (2026-11-04T10:00Z): `{valid_until:'2026-11-30T23:59:59.999Z'}` → `1796083199999`; `@`-exprs resolve; numbers pass through; non-date keys untouched; nested walk; no mutation; `resolved` echo lines; anchors contain `tomorrow = 2026-11-05` + correct weekday; `widenDateFields` output parses both `1793786400000` and `'2026-11-04T10:00:00Z'` for `created_after`, rejects `{name: 123}` changes (non-date fields untouched).
- [ ] **Step 2: Run, verify FAIL.**  **Step 3: Implement.**  **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `feat(loop): deterministic date coercion, anchors, schema widening, resolved-range echo`

### Task 3: Verbatim recent-turn memory with scope artifacts

**Files:**
- Create: `server/src/loop/recent-turns.ts`
- Test: `server/test/loop-recent-turns.test.ts`

**Interfaces:**
- Consumes: `Event` from `events/types.ts`.
- Produces: `renderRecentTurns(events: readonly Event[], keepLastN?: number): string` — groups by turnId; last N completed turns render: user text, each `step.finished` summary **plus its resolved filter params and `[ref …]` handle** (durable scope artifact), each `step.failed` code, `answer.final`. Older turns collapse to one `user → answer` line (observation-masking).

- [ ] **Step 1: Write failing tests** — synthetic 3-turn history: turn 1 `"show open tickets assigned to user_38"` with `resolvedParams [{assignee_id:'user_38', status:'open'}]` + summary naming 4 tickets → rendering contains user text, the **assignee_id filter**, and the ticket summary; ordering oldest→newest; in-flight turn excluded; N-trimming; older-turn collapse keeps user text + answer only.
- [ ] **Step 2: Run, verify FAIL.**  **Step 3: Implement.**  **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `feat(loop): verbatim recent-turn memory with durable scope artifacts`

### Task 4: Agents SDK runner integration (model accounting, mocking, budgets)

**Files:**
- Create: `server/src/llm/agents-runtime.ts`
- Modify: `server/package.json` (add `@openai/agents` pinned `0.21.0`, `openai ^7.2`)
- Test: `server/test/agents-runtime.test.ts`

**Interfaces:**
- Consumes: `costMeter`/price table from `llm/client.ts`+`llm/prices.ts`, span sink (`events/trace.ts`), the fetch-level test seam convention.
- Produces:
  - `createLoopRunner(opts: { testFetch?: typeof fetch }): Runner` — a `Runner` with `modelProvider` = our provider wrapping `OpenAIProvider({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', useResponses: false })` (the inner `OpenAI` client gets `fetch: testFetch` when provided); calls `setTracingDisabled(true)` once at module init.
  - `MeteredModel implements Model` — decorator over the provider's model: `getResponse(request)` delegates, then records tokens via the SDK response `usage` (+ `modelSettings.preserveRawUsage` and OpenRouter `usage: {include: true}` via `providerData` for cached-token detail), prices via `priceFor`, adds to `costMeter`, emits one `kind:'llm'` span per call, throws `BudgetExceededError` when `costMeter.total() >= budgetUsd()` BEFORE delegating.
  - `runLoopOnce(opts: { runner: Runner; agent: Agent; input: string | RunState; maxTurns: number; deadlineMs: number }): Promise<RunResult>` — wires `signal: AbortSignal.timeout(deadlineMs)`, `maxTurns`, `errorHandlers: { maxTurns }` (honest final output, no extra model call), and maps abort → a typed `LoopDeadlineError`.

- [ ] **Step 1: Write failing tests** (fetch-level mocks replaying OpenRouter chat-completions tool-call responses): a 2-step run (tool call → execute invoked with validated args → final text) returns final text, `costMeter` increased, 2 llm spans; budget already exhausted → `BudgetExceededError` before any fetch; `maxTurns: 1` with a tool-calling script → `errorHandlers.maxTurns` final output, no extra fetch; `deadlineMs: 1` → `LoopDeadlineError` without a second fetch; tracing: no request ever leaves to any host but the OpenRouter baseURL (assert on mock fetch's seen URLs).
- [ ] **Step 2: Run, verify FAIL.**  **Step 3: Implement.**  **Step 4: Run full suite, verify PASS** (`llm/client.ts` untouched).
- [ ] **Step 5: Commit** — `feat(llm): agents-sdk runner with metered model, budget/deadline rails, tracing off`

### Task 5: The loop agent — `runLoopTurn`

**Files:**
- Create: `server/src/loop/agent.ts`
- Create: `server/src/loop/tools.ts`
- Test: `server/test/loop-agent.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `retrieve`/`renderCards` from `agent/retrieval.ts`; `shouldGate`, `ConfirmBroker` from `agent/executor.ts`; `RefStore` (incl. `hydrate`); `emptyWorkingState`; `getDefaultSpans`; `plannerModel()`; `baseline/agent.ts` as structural reference for finalize/metrics/ttfur/event emission.
- Produces:
  - `tools.ts`: `buildTurnTools(input: { registry: Registry; cards: readonly Card[]; crm: Crm; refs: RefStore; confirm: ConfirmBroker; clock: VirtualClock; turnId: string; emit: (e: Event) => void; sessionCtx: SessionCtx; exits: LoopExits; stuck: StuckTracker }): Tool[]` — one Agents SDK `tool()` per retrieved action: `name` = slug `.`→`__`; `parameters` = `widenDateFields(action.inputSchema)` (zod-4, SDK-validated, strict); `execute` = coerceDateParams → re-validate against the ORIGINAL `action.inputSchema` → gate-if-write (broker await; deny → return DENIED result, handler never invoked) → `crm.tx(handler)` with idempotency key → spill-to-ref → emit `step.started`/`step.finished`/`step.failed` → return observation (incl. `total`, resolved-date echo, `[ref …]`); failures return error observations (never throw out of the loop) and feed `stuck`. Plus five standing tools: `catalog__search_actions {query}`; `data__sort_ref {ref, field, direction, limit?}` and `data__aggregate_ref {ref, field, op}` (via `refs.hydrate`; `!complete` → honest "set incomplete"); `session__ask_user {question}` and `session__refuse {reason}` (set `exits` and end the run — tool returns a sentinel; the agent instructions say stop after calling them, and `runLoopTurn` treats a set exit as terminal regardless of remaining model text).
  - `agent.ts`: `runLoopTurn(input: RunLoopTurnInput): AsyncGenerator<Event, TurnResult>` — `interface RunLoopTurnInput { sessionId: string; turnId: string; userText: string; sessionDeps: LoopSessionDeps }`; `interface LoopSessionDeps { registry: Registry; crm: Crm; refs: RefStore; eventLog: EventLog; confirm: ConfirmBroker; testFetch?: typeof fetch }`. Builds `SessionCtx` from prior `step.started` actions; retrieval on `userText`; constructs `new Agent({ name:'ask-ai', model: plannerModel(), instructions: buildLoopSystemPrompt(), tools, modelSettings: { parallelToolCalls: false, timeoutMs: 60_000 }, toolExecution: { maxFunctionToolConcurrency: 1 } })`; runs via `runLoopOnce`; StuckTracker (3× identical action+error → hint appended to the tool result; 4× → finalize `'failed'`); finalizes with status from exits (`'clarify'`/`'refused'`) else `'done'`; model final text → `answer.delta`/`answer.final`; gate description pluralizes only when the noun doesn't already end in `s`.

- [ ] **Step 1: Write failing tests** (fetch-level tool-call scripts; in-memory crm/eventLog/refs copied from the baseline test harness):
  - read turn → events `turn.started, step.started(resolvedParams), step.finished, answer.delta…, answer.final, turn.completed{status:'done'}, memory.snapshot`.
  - date rail end-to-end: tool call with `{created_after:'2026-11-04T00:00:00Z'}` → `resolvedParams[0].created_after` is epoch; tool result contains the resolved-range echo; an invalid non-date type still rejected by the ORIGINAL schema re-validation.
  - gated write approved: `confirmation.required` → broker approve → handler invoked EXACTLY once (spy) → `confirmation.resolved`, write lands.
  - gated write denied: handler NEVER invoked; tool result contains `DENIED` and `NOT executed`; zero writes.
  - clarify: `session__ask_user {question:'Which Lucia Kim…'}` → `turn.completed{status:'clarify'}`, `answer.final === 'Which Lucia Kim…'`; refuse → `status:'refused'`, reason verbatim.
  - sort_ref over a seeded >50-row spill with `limit:1` → true max row; incomplete handle → honest "incomplete", no rows.
  - aggregate_ref `{op:'avg'}` → arithmetic mean, not the sum.
  - search_actions → no registry dispatch, rendered cards in tool result.
  - StuckDetector-lite: 3 identical failing calls → hint in 3rd result; 4th → `status:'failed'`.
  - maxTurns and deadline → `status:'failed'`, honest messages, no extra model call; gate noun `tasks` renders "4 tasks" not "4 taskss".
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `tools.ts` then `agent.ts` (copy `runBaselineTurn`'s finalize/buffer/metrics skeleton).
- [ ] **Step 4: Run full server suite, verify PASS.**
- [ ] **Step 5: Commit** — `feat(loop): agents-sdk tool-loop agent (retrieval-scoped tools, broker gates, handle ops, honest exits)`

### Task 6: Wire the loop in as the production agent

**Files:**
- Modify: `server/src/api/turn-runtime.ts` (`AgentKind`, `drive()`) · Modify: `server/src/api/sessions.ts` · Test: `server/test/turn-runtime.test.ts` (extend)

**Interfaces:**
- Produces: `export type AgentKind = 'optimized' | 'baseline' | 'plandsl'` — `'optimized'` drives `runLoopTurn`, `'plandsl'` the old `runTurn`, `'baseline'` unchanged.

- [ ] **Step 1: Write failing test** — `agent:'optimized'` turn produces loop-shaped events (no `plan.ready`); `'plandsl'` still emits `plan.ready`; cancel-during-gate finalizes `'cancelled'` for the loop (broker deny path shared).
- [ ] **Step 2: Run, verify FAIL.**  **Step 3: Implement.**  **Step 4: Full suite PASS.**
- [ ] **Step 5: Commit** — `feat(api): route optimized agent to the agents-sdk loop; keep plan-DSL as 'plandsl' comparator`

### Task 7: Eval-harness fairness for plan-less agents

**Files:**
- Modify: `eval/assert.ts` · Test: `eval/test/assert.test.ts` (extend)

- [ ] **Step 1: Write failing test** — a plan-less transcript with `step.started{action, resolvedParams}` passes `planActions`/`paramChecks` expecting that action+param; fails when absent. (Keeps the uncommitted `resolvedParams` fairness work.)
- [ ] **Step 2: Run, verify FAIL.**  **Step 3: Implement fallback.**  **Step 4: PASS.**
- [ ] **Step 5: Commit** — `fix(eval): plan-less transcript fairness + scenario corrections` (folds in staged scenario corrections)

### Task 8: Quick-20 sanity run, then human-test round 4 (the ship bar)

**Files:**
- Create: `.superpowers/sdd/2026-11-04-ask-ai-implementation/humantest-round4-addendum.md`

- [ ] **Step 1: Quick-20 for `optimized` (now the loop)**; expected ≥ the plan-DSL 7/20 plateau. First live-model run also validates the OpenRouter/Agents-SDK wire path on our actual slugs (tool-call round-trips, usage fields) — skim for harness bugs/crashes only, no fix wave.
- [ ] **Step 2: Write the round-4 addendum** replaying every round-3 critical verbatim: "leads created today"/"tomorrow" dates; coupon/webinar relative-date writes; count honesty ("my open opportunities" → 30); denied-gate narration; "reassign the oldest one" filter continuity; approve-once→write-once (DB-verify exactly 165); tag-leads specific refusal, no hang; ordinals + "average owed"; month-over-month attempt; jargon/leak sweep (no `r_t*`, "truncated", "taskss").
- [ ] **Step 3: Dispatch 4 persona testers; triage.** SHIP bar: ≥3/4 personas SHIP with zero CRITICALs → benchmark phase. Otherwise findings are the next small fix list.
