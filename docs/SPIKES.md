# Day-1 Spikes — Results (Task 6)

**Run date:** 2026-11-05. **Provider:** OpenRouter, `usage:{include:true}`, real API key
(first money spent on this project). All calls went through `server/src/llm/client.ts`'s
`llmCall` with `stage:'spike'` unless noted otherwise. Scripts: `scripts/spike-schema.ts`,
`scripts/spike-cache.ts`.

## 1. Schema go/no-go spike (`scripts/spike-schema.ts`)

**Setup:** the REAL `planOutcomeSchema` (`server/src/agent/plan-schema.ts`) through
`generateObject`, with the REAL byte-stable planner system prompt
(`buildPlannerPrompt` from `server/src/agent/planner.ts`), against a hand-built context
with 8 real action cards pulled live from the registry (`leads.search_leads`,
`leads.assign_lead_owner`, `leads.update_lead_score`, `appointments.search_appointments`,
`tasks.create_task`, `tasks.assign_task_owner`, `conversations.search_conversations`,
`contacts.search_contacts`) and the LLD §2.2-style conformance request:

> "Find leads created last week who have not replied, exclude anyone with a booked
> appointment, assign them to sales reps and create follow-up tasks"

One attempt + one retry per model (≤6 calls). **All 6 calls failed identically — zero
parses on any model, zero retries recovered it** (the failure is deterministic/schema-shape,
not transient, so the retry reproduced the same error both times for all three models).

| Model | Attempt 1 | Attempt 2 (retry) | kind | steps | tokens in/out | cost | latency |
|---|---|---|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | FAIL (400) | FAIL (400, identical) | — | — | — | — | — |
| `google/gemini-2.5-flash-lite` | FAIL (400) | FAIL (400, identical) | — | — | — | — | — |
| `openai/gpt-5-mini` | FAIL (400) | FAIL (400, identical) | — | — | — | — | — |

The official spike run's own error capture is a generic AI SDK message
(`AI_APICallError: Provider returned error`) with no tokens/cost (OpenRouter returns a
provider-side 400 before any generation happens, so no `usage` object is ever produced —
these calls are effectively free). Per Task 6's requirement to "record NO-GO with the
exact error," 3 cheap, schema-identical diagnostic calls (one per model, same system/prompt,
no retry logic, direct `generateObject` with full error-body capture) were run immediately
after to recover the provider's actual rejection reason. **Root cause is the same defect in
all three, surfaced as three different provider-specific JSON-Schema rules:**

| Model | Exact provider error |
|---|---|
| `anthropic/claude-haiku-4.5` | `output_config.format.schema: Invalid schema: Circular reference detected in schema definitions: __schema0 -> __schema0. Self-referencing or mutually-referencing definitions are not supported.` (Anthropic native; identical error also reported from the Bedrock/Azure/Google fallback routes OpenRouter tried) |
| `google/gemini-2.5-flash-lite` | `ref loops are only supported if they include optional or nullable property values, or a potentially-zero-length array items, but a ref loop of required fields was found at definitions.__schema0.anyOf.5.additionalProperties` (Google AI Studio / Vertex) |
| `openai/gpt-5-mini` | `Invalid schema for response_format 'response': In context=('anyOf', '5'), 'propertyNames' is not permitted.` (OpenAI strict JSON Schema mode; identical error from the Azure fallback route) |

**Root cause (one defect, three symptoms):** `agent/plan-schema.ts`'s `valueSchema` —
the `Value = JSON literal | RefString | Value[] | {[key:string]: Value}` type — is built
with `z.lazy` into a **self-referencing** JSON Schema (`z.record(z.string(), valueSchema)`,
the "record" branch, is `anyOf` index 5 in the compiled schema in all three providers'
error output — same branch, same bug). Every provider's *strict/structured-output* JSON
Schema validator independently rejects this specific shape:
- Anthropic bans self-referencing `$ref`s outright, full stop.
- Google allows ref loops only through `optional`/`nullable` property values — this
  loop runs through a `required` `additionalProperties`, so it's rejected.
- OpenAI's strict mode doesn't support the `propertyNames` keyword at all (emitted for
  the `z.record(z.string(), ...)` key-schema), independent of the loop itself.

This is exactly the risk flagged in `plan-schema.ts`'s own header comment and anticipated
by LLD §10 Spike B ("if union shapes fail on Gemini/GPT structured outputs, flatten refs
to plain strings") — except the recursive shape that actually breaks every provider isn't
`RefString` (already flattened to a plain string, per that header) but the untouched
**`Value` type's own self-reference** (nested object/array params). `RefString`-flattening
alone was not sufficient.

### VERDICT (a): Schema GO/NO-GO — **NO-GO for all three models**

Flatten per LLD §10 before Task 9/10 proceed with any real (non-Mock) LLM against this
schema. Two concrete flattening options for whoever picks this up:
1. Keep `params: Record<string, Value>` as the field, but represent a `Value` that would
   otherwise recurse (nested array/object) as an opaque **JSON-encoded string** at the
   schema level (`z.string()`), parsed back to structured data by `agent/validator.ts`
   after `generateObject` returns — breaks the `$ref` cycle entirely since the schema
   itself no longer references itself.
2. Unroll `Value` to a **fixed, finite recursion depth** (e.g. literal | flat array of
   literals | flat object of literals — one level, no further nesting) if real plans
   never need param objects deeper than that in practice (worth checking against the
   LLD's worked examples before committing to this option over #1).

Either way: this is a schema-shape fix, not a prompt fix — no amount of prompt engineering
unblocks this, since the 400 happens before the model ever sees a token (provider-side
schema compilation failure).

## 1a. Fix applied + re-spike (Task 6 follow-up, 2026-11-05)

**Fix (`server/src/agent/plan-schema.ts`):** `stepSchema.params` changed from
`z.record(z.string(), valueSchema)` (the self-referencing `Value` union) to
`z.looseObject({})` — a flat `{"type":"object","properties":{},"additionalProperties":{}}`
JSON Schema with **no `$ref`, no `propertyNames`**. `z.record(z.string(), z.unknown())`
was tried first and rejected as the fix: Zod still compiles ANY `z.record` (even with a
plain `z.string()` key schema) to a `propertyNames` keyword — exactly the second,
independent defect the original spike found on OpenAI's strict mode
(`'propertyNames' is not permitted`). `z.looseObject({})` avoids both the `$ref` cycle
and `propertyNames` while still inferring as an open `{[key: string]: unknown}` record.
`valueSchema`/`Value` are kept in the file (now unreachable from `planOutcomeSchema`) as
documentation + their own unit test. **No other file needed changes**:
`agent/validator.ts` already validates every param as `unknown` against the action's own
`inputSchema` at runtime (never relied on the `Value` zod type), and
`executor.ts`/`joiner.ts`/`memory.ts` already treat `step.params` values as `unknown`.
Verified locally (no API spend) by mirroring `@ai-sdk/provider-utils`' exact zod4
conversion call (`z.toJSONSchema(planOutcomeSchema, {target:'draft-7', io:'input',
reused:'inline'})`) and walking the result for `$ref` cycles and `propertyNames` —
confirmed clean. New regression test: `server/test/plan-schema.test.ts` → "schema
converts to JSON Schema without self-references". Full server suite (299 tests), eval
suite (93 tests), and `npm run smoke` (549/549) all pass unchanged.

**Re-spike (`npx tsx scripts/spike-schema.ts`, live, 5 calls — 2 attempts each for
Haiku/GPT-5-mini since attempt 1 failed, 1 attempt for Gemini which succeeded
immediately):**

| Model | Result after fix |
|---|---|
| `google/gemini-2.5-flash-lite` | **GO** — parsed clean on attempt 1 (`kind:"plan"`, 7 steps, 1,710 in / 766 out tokens, $0.0004774, 2,684 ms). |
| `anthropic/claude-haiku-4.5` | **Still NO-GO** — both attempts failed with a 400, but a **different, previously-masked error** (see below). |
| `openai/gpt-5-mini` | **Still NO-GO** — same new error family as Haiku. |

**New finding — the recursive-`Value` fix was necessary but not sufficient.** A
follow-up diagnostic call per model (2 calls, exact-error capture, bringing this
follow-up's live-call total to 7) recovered the real rejection reason for the two
still-failing providers:

| Model | Exact provider error (post-fix) |
|---|---|
| `anthropic/claude-haiku-4.5` | `output_config.format.schema: Schema type 'oneOf' is not supported` (identical error repeated from the Bedrock/Azure/Google fallback routes OpenRouter tried) |
| `openai/gpt-5-mini` | `Invalid schema for response_format 'response': In context=(), 'oneOf' is not permitted.` (identical from the Azure fallback route) |

**Root cause:** `planOutcomeSchema` is a `z.discriminatedUnion('kind', [...5 variants])`,
which Zod compiles to a **top-level `oneOf`** (`{"oneOf":[{...plan...},{...search...},
...]}` — confirmed in the local JSON Schema dump). Anthropic's and OpenAI's structured
output /strict modes both reject `oneOf` **as the schema root** ("In context=()" is
OpenAI's own way of saying "at the top level") — a union is only acceptable nested
inside an object's property, not as the whole response schema. Gemini does not have
this restriction, which is why it alone now passes. This defect was **present in the
original spike run too**, but was masked: the self-referencing `Value` type's `$ref`
cycle failed validation first (and more loudly) for all three providers, so this
second, independent `oneOf`-at-root defect never surfaced until now.

### VERDICT (a2): Schema GO/NO-GO after the flatten fix — **GO for Gemini only; NO-GO for Anthropic and OpenAI (new defect)**

The recursive-`Value` defect documented above IS fixed and confirmed gone (no more
circular-reference/`propertyNames` errors from any of the three providers). A **second,
independent, pre-existing defect** — `planOutcomeSchema`'s top-level `oneOf` from
`z.discriminatedUnion` — blocks Anthropic and OpenAI structured outputs and must be
fixed before Task 9/10 can use this schema with those two providers. The live-call
budget for this follow-up (7 calls: 5 for the re-spike incl. retries, 2 for exact-error
diagnostics) was fully spent reaching this finding, so **no fix for the `oneOf`-at-root
defect was attempted or verified in this pass** — it needs its own follow-up spike with
fresh budget. Two candidate directions for whoever picks this up (neither validated
against a live API yet):
1. Wrap the union in a named property (`{"type":"object","properties":{"outcome":
   <union>}}`) instead of using it as the schema root — the common workaround for
   OpenAI/Anthropic strict-mode "union not allowed at root" restrictions — then unwrap
   `.outcome` in `llm/client.ts`/`agent/pipeline.ts`.
2. Replace the discriminated union with a single flat object (`kind` plus every
   variant's fields as optional, validated for mutual exclusivity by a `.refine()` or by
   `agent/validator.ts` post-parse) — avoids `oneOf` entirely but is a bigger shape
   change for every consumer of `PlanOutcome`.

## 2. Cache passthrough spike (`scripts/spike-cache.ts`)

**Setup:** two consecutive calls to `anthropic/claude-haiku-4.5` with an **identical**
system prompt (the real planner system prompt — measured **~1,169 tokens** at authoring
time via `buildPlannerPrompt`, not the ~3k tokens Task 6's brief assumed; see note below)
and a different short user suffix (`"... (first call)"` / `"... (second call)"`). Because
the schema bug above makes `generateObject` unusable for this spike (every call would
just fail on the same 400, telling us nothing about caching), **both paths here use
`generateText`/no schema** — this spike is schema-agnostic by design.

| Path | Call | tokens in | tokens out | **tokens cached** | cost | latency |
|---|---|---|---|---|---|---|
| Default (`llmCall`, no explicit `cacheControl`) | 1 | 1,506 | 16 | **0** | $0.001586 | 1,677 ms |
| Default (`llmCall`, no explicit `cacheControl`) | 2 (identical system) | 1,506 | 16 | **0** | $0.001586 | 1,178 ms |
| Explicit `cacheControl: {type:'ephemeral'}` on the system message (bypasses `llmCall`, raw `generateText` + `messages[]`, per the `@openrouter/ai-sdk-provider` README's "Anthropic Prompt Caching" section) | 1 | 1,510 | 16 | **0** | $0.00159 | 1,292 ms |
| Explicit `cacheControl` | 2 (identical system) | 1,510 | 16 | **0** | $0.00159 | 1,973 ms |

**Observation:** zero cached tokens on call 2 in BOTH paths, and — critically — **identical
cost between call 1 and call 2 in both paths**. If caching were active, call 1 (cache
write) and call 2 (cache read) would show different costs (`cachedPerM` pricing is 10×
cheaper than `inPerM` for Haiku per `llm/prices.ts`); identical cost on both calls is
itself evidence no cache write/read ever happened, independent of the `tokensCached` field.

1. **Default path (no explicit `cache_control`): confirmed, by design, that `llmCall`'s
   flat `{system, prompt}` string interface never sets an Anthropic cache breakpoint.**
   `llmCall` only forwards a top-level `providerOptions` (request-level — e.g. the GPT-5
   `reasoning.effort` default); it has no seam for a per-message `providerOptions` (which
   is what `cacheControl` requires — see `SystemModelMessage.providerOptions` in
   `@ai-sdk/provider-utils`). So "does the AI SDK/OpenRouter path set a breakpoint by
   default" — **no**, and it structurally cannot through `llmCall`'s current signature.
2. **Explicit `cacheControl`, bypassing `llmCall`: the passthrough itself works
   mechanically** (OpenRouter accepted the request, no error, `@openrouter/ai-sdk-provider`'s
   documented `providerOptions.openrouter.cacheControl` shape is real and wired through) —
   but it **still produced zero cached tokens.** Most likely cause: **the real planner
   system prompt is only ~1,169 tokens**, and total request size (system + 8-card context +
   request) was **1,506–1,510 tokens** — both under Anthropic's documented **minimum
   cacheable prompt length for Claude Haiku models (2,048 tokens)**. A cache breakpoint on
   a block below that minimum is silently a no-op; Anthropic does not cache it regardless
   of `cache_control` being present. This is a **far more parsimonious explanation** than
   "OpenRouter drops the breakpoint" — the passthrough mechanism is demonstrably present
   (request succeeded, no error, no warning about an unsupported field), it's just that
   the cacheable block is too small to cross Anthropic's own floor.

### VERDICT (b): Cache passthrough — **ABSENT** (in practice, for this prompt size)

The mechanism exists (explicit `cacheControl` is accepted without error by
OpenRouter→Anthropic) but produces no measurable benefit at the planner's actual system
prompt size (~1.17k tokens, well under Haiku's 2,048-token cache-eligibility floor). Note
this is a size problem, not strictly a "does OpenRouter support caching" problem — a
future system prompt that grows past ~2k tokens (e.g. once the core-ops text, more
guidance, or a longer worked example get added) could start benefiting from the same
`cacheControl` wiring demonstrated here to work. For now, treat it as absent.

**Implication (pre-decided fallback, already captured in `docs/TARGETS.md` §4
"Measurement conditions" / "Budget"):** TARGETS.md's committed budget split — optimized
agent gets the full 110-scenario corpus ×3 trials, baseline agent is capped to a
**stratified 40-scenario subset ×1 trial** — was already adopted as the fallback for
exactly this situation ("full-catalog ReAct at ~12k tokens/step cannot fit $10 at 110
scenarios"). This spike's ABSENT finding reinforces that decision from the planner side
too: **no per-call cost projection anywhere in the eval harness should assume a cache
discount on the planner's system prompt** — every cost estimate must use full
(non-cached) input-token pricing until/unless the system prompt grows past Haiku's
cache-eligibility floor and a follow-up spike reconfirms caching actually engages.

### 2a. Big-prompt cache probe — implemented but NOT RUN (2026-11-05 follow-up)

`scripts/spike-cache.ts` was extended with a `--big` mode: pads the real planner system
prompt with the first ~1,500 tokens of `buildCatalogSummary(registry)`
(`server/src/baseline/catalog-summary.ts`) — a real, deterministic text source, not
filler — pushing the padded system prompt to **~2,669 tokens** (measured locally via
the module's own `estimateTokens`, no API call needed), comfortably past both the
>2,600-token target and Anthropic Haiku's ~2,048-token cache-eligibility floor. In
`--big` mode the script skips the default (`llmCall`) path entirely — already
confirmed structurally cache-incapable regardless of prompt size (§2 above: no
per-message `providerOptions` seam) — and spends its whole budget (2 calls) on the
explicit-`cacheControl` path from §2, with the padded system as the identical prefix.

**This mode was written and locally verified (token count only) but never executed
against the live API in this pass.** The live-call budget for this whole follow-up
task was capped at 7 calls total, and the re-spike + exact-error diagnostics in §1a
(5 + 2 calls) consumed all 7 before the schema defect was fully characterized. Running
`--big` would have required 2 more calls, over the cap.

**Verdict: NOT RUN.** `docs/TARGETS.md`'s existing fallback (full non-cached pricing for
every planner-prompt cost estimate, per VERDICT (b) above) stands as-is, unchanged,
since no new evidence was collected either way. Recommended follow-up: run
`npx tsx scripts/spike-cache.ts --big` (2 calls, ~$0.003 at Haiku rates) with a fresh
budget once the `oneOf`-at-root defect in §1a is also resolved, so a single follow-up
pass can close out both open questions together.

## 3. Total spend (this task)

| Call batch | Calls | Measured cost (from `usage.cost`/reported `costUsd`) |
|---|---|---|
| Connectivity sanity check (raw curl, no schema) | 1 | $0.0000014 |
| Schema spike official run (6 calls, all 400 before generation) | 6 | $0 (no `usage` object returned on a pre-generation provider error — not billable) |
| Schema spike diagnostic follow-up (3 calls, exact-error capture, all 400 before generation) | 3 | $0 (same reason) |
| Cache spike, default path | 2 | $0.001586 × 2 = $0.003172 |
| Cache spike, explicit `cacheControl` path | 2 | $0.00159 × 2 = $0.00318 |
| **Total** | **14** | **≈ $0.0064** |

Well under the $0.30 cap for this task (and a rounding error against the $10 total project
credit). The 3 diagnostic follow-up calls were not in the original ≤6-call schema-spike
budget but were added because the official run's generic error message
(`AI_APICallError: Provider returned error`) was not itself an "exact error" — recovering
the real provider `responseBody` was necessary to satisfy Task 6 deliverable #4 ("record
NO-GO with the exact error"). They cost nothing measurable (pre-generation 400s) and are
disclosed here rather than omitted.

### 3a. Total spend (2026-11-05 flatten-fix follow-up)

| Call batch | Calls | Measured cost |
|---|---|---|
| Re-spike, `anthropic/claude-haiku-4.5` (attempt 1 + 1 retry, both 400 pre-generation) | 2 | $0 |
| Re-spike, `google/gemini-2.5-flash-lite` (attempt 1, succeeded) | 1 | $0.0004774 |
| Re-spike, `openai/gpt-5-mini` (attempt 1 + 1 retry, both 400 pre-generation) | 2 | $0 |
| Exact-error diagnostic, Haiku (1 call, 400 pre-generation) | 1 | $0 |
| Exact-error diagnostic, gpt-5-mini (1 call, 400 pre-generation) | 1 | $0 |
| **Total** | **7** | **≈ $0.0004774** |

Exactly at the 7-live-call cap set for this follow-up task; the `--big` cache probe
(§2a) was consequently not run. Well under the $0.20 cost cap.

## 4. Cross-reference: `docs/TARGETS.md`

`docs/TARGETS.md` was already written and committed before this task started (Task 6
Step 3, skipped per instructions — see its own file for the full targets table, TTFUR
definitions, and the budget/measurement conditions referenced in VERDICT (b) above). No
changes made to it by this task.
