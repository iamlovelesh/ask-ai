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

## 1b. Round-2 fix: flat-root object + sentinel values (2026-11-05, same day)

**Fix applied** (direction #2 above, chosen for maximum provider safety): `agent/
plan-schema.ts` gained `flatPlanOutcomeSchema` — a single flat root object, every field
always present/required, NO union anywhere:

```
{kind: enum[5], plan: Plan, queries: string[], question: string|null, reason: string|null, text: string|null}
```

`planner.ts`'s `plan()` and `pipeline.ts`'s repair call site (the ONLY two places that
ever ask a provider for a `PlanOutcome` directly — `joiner.ts`'s `joinerDecisionSchema`
is a THIRD, separate `z.discriminatedUnion` with the identical root-`oneOf` defect,
confirmed present but **out of this round's scope and NOT fixed** — flagged for a
follow-up) now request `flatPlanOutcomeSchema` instead of `planOutcomeSchema`. A new
pure function, `toPlanOutcome`, narrows the flat shape back to the existing
discriminated `PlanOutcome` union every downstream consumer
(validator/executor/joiner/events) already expects; an invalid combination (the
active-kind field left at its default) throws `FlatOutcomeShapeError`, which
`planner.ts`'s `narrowFlatOutcome` re-throws as the AI SDK's own
`NoObjectGeneratedError` — reusing `pipeline.ts`'s EXISTING escalate-then-fail handling
for that error type with **zero new pipeline control-flow**.

**Mid-fix discovery — one fix was not enough, twice:** the FIRST attempt used
`.nullable()` for all four kind-specific fields (`plan`/`queries` included) — fixing
the root `oneOf` but leaving Anthropic/OpenAI still failing (confirmed live). A local
`z.toJSONSchema` check proved why: Zod has no public way to compile a nullable
OBJECT/ARRAY to the type-array form (`{"type":["object","null"]}`) — `.nullable()`,
`z.union([X, z.null()])`, and `.or(z.null())` ALL compile to `{"anyOf":[{X},{"type":
"null"}]}` for complex types (primitives like `z.string().nullable()` DO get the clean
type-array form, no `anyOf` — this asymmetry is why `question`/`reason`/`text` stay
`.nullable()` below but `plan`/`queries` do not). Since `anyOf` was the only
union-shaped keyword left anywhere in the schema after the root fix, and every
provider rejection in this whole investigation (round 1 and round 2) has been about a
union keyword specifically, `plan`/`queries` were changed to **sentinel values**
instead of nullable: `plan` defaults to the empty plan `{goal:"",steps:[]}`, `queries`
defaults to `[]`. This eliminates `anyOf` from the compiled schema ENTIRELY — confirmed
locally: zero occurrences of `oneOf`/`anyOf`/`$ref`/`propertyNames` anywhere in the
tree (not just the root), per the strengthened `plan-schema.test.ts` regression test.

**Status: NOT yet live-verified.** The budget for this round (≤8 live calls) was spent
reconfirming (wastefully, on an early mistake — see below) that the root-`oneOf` fix
alone doesn't unblock Anthropic/OpenAI, before the sentinel-value redesign above could
be tried. The sentinel-value schema is implemented, locally verified (see the "no
union ANYWHERE" test), and all local suites pass, but **has not been re-spiked against
a live provider** — that is the single most important next step for whoever picks this
up, and should cost exactly 3 calls (1 attempt per model, no retry needed if this is
the fix) at near-zero spend.

**How the budget was actually spent (full disclosure):**
1. Re-ran `scripts/spike-schema.ts` first WITHOUT updating it to import
   `flatPlanOutcomeSchema` — it was still importing the OLD `planOutcomeSchema` from a
   prior edit of `plan-schema.ts`'s exports. This wasted **5 calls** (2 Haiku + 1 Gemini
   + 2 GPT-5-mini) reconfirming the ALREADY-KNOWN round-1 `oneOf`-at-root failure, not
   testing the actual fix. Caught and fixed immediately after, but the calls were
   already spent.
2. Fixed the script, re-ran with `MAX_ATTEMPTS` temporarily reduced to 1 (budget was
   down to 3 of 8) — **3 calls** (1 each). Gemini: GO (clean parse). Anthropic/GPT-5-mini:
   STILL FAIL, generic `AI_APICallError: Provider returned error` with no captured
   `responseBody` (the script's `describeError` only reads `.message`, not the full
   provider error body an earlier diagnostic script captured in round 1) — exact text
   not recovered this round.
3. At the 8-call cap with no budget left for either (a) a diagnostic call to recover
   the exact error text, or (b) a live re-verification of the sentinel-value redesign
   devised in response to (2)'s failure, work stopped here per the explicit budget
   instruction. `MAX_ATTEMPTS` was reverted to `2` in the committed script (the
   intended retry policy for future runs — the `1` was a one-off, budget-driven choice
   for this invocation only, not a permanent change).

**Known, NOT-yet-addressed second hypothesis:** `stepSchema` (nested under `plan`)
still has THREE genuinely-optional (not nullable, not sentinel) fields — `forEach`,
`when`, `expects` — i.e. absent from that level's `required` array. `.optional()`
(unlike `.nullable()`) does NOT introduce `anyOf`/`oneOf` — it's a plain omission from
`required` — so it's a structurally different construct than everything fixed so far,
and was never isolated/tested on its own in any round. If the sentinel-value fix above
is re-spiked and STILL fails on Anthropic/OpenAI, this is the next thing to try:
convert those three to the same required+nullable-or-sentinel pattern used everywhere
else in this schema (`forEach: string|null`, `when`/`expects` similarly) — but that
requires `executor.ts`/`validator.ts`/`joiner.ts` to treat `null` the same as
`undefined` for these three fields (a wider, currently out-of-scope change versus
everything else in this round, which touched only `plan-schema.ts`/`planner.ts`/one
`pipeline.ts` call site).

### VERDICT (a3): Schema GO/NO-GO after the round-2 fix — **GO for Gemini only (unchanged); Anthropic/OpenAI UNRESOLVED, next fix implemented but unverified**

No regression: all local suites (server 304 tests, eval 93 tests, both typechecks
sans the pre-existing unrelated `eval/test/scenario.test.ts` failure, `npm run smoke`
549/549) pass with the sentinel-value schema in place. Do NOT mark this GO for
Anthropic/OpenAI until the 3-call re-verification above actually runs and passes.

## 1c. Round-3 fix: params-as-string + uniform required fields (2026-11-05, same day) — **RESOLVED, GO ×3**

**Mandatory call order this round** (per explicit instruction): spend exactly 2 live
calls FIRST (one per still-failing provider, against the round-2 sentinel schema,
unchanged) to capture the exact error text, then STOP and diagnose locally before any
further spend. That is exactly what happened.

**The 2 diagnostic calls' exact errors:**

| Model | Exact provider error (against the round-2 schema) |
|---|---|
| `anthropic/claude-haiku-4.5` | `output_config.format.schema: Empty schema ({}) that accepts any JSON value is not supported. Please specify a concrete type.` |
| `openai/gpt-5-mini` | `Invalid schema for response_format 'response': In context=('properties','plan','properties','steps','items','properties','params','additionalProperties'), schema must have a 'type' key.` |

**Root cause, found by local diagnosis (zero further spend) before any more live
calls:** both errors point at the exact same place — `stepSchema.params`'s
`z.looseObject({})` compiles to `"params":{"type":"object","properties":{},
"additionalProperties":{}}`. The `additionalProperties` value is `{}` — an EMPTY,
type-less nested schema. Anthropic rejects it outright; OpenAI's strict mode
specifically requires every schema object to carry a `"type"` key, which `{}` lacks.
This is a THIRD, independent defect from rounds 1 (recursive `$ref`) and 2 (root/
nested `oneOf`/`anyOf`) — masked in both those rounds because validation apparently
stops at the first offending construct it reaches, and `params` sits deep enough in
the tree that it was never reached until the root-level union was fixed.

A local `z.toJSONSchema` dump of the round-2 schema (zero API cost) additionally
found, UNEXERCISED by either error (validation stopped at `params` first) but
structurally present and certain to surface next if left alone:
- `whenSchema.value` (`z.unknown()`) has the IDENTICAL empty/type-less `{}` shape as
  `params`.
- `stepSchema`'s `forEach`/`when`/`expects` are genuinely `.optional()` — omitted from
  that level's `required` array — the long-flagged-but-never-confirmed hypothesis from
  round 2 (§1b), now confirmed by direct inspection (not by a live failure).
- `whenSchema.value` and `expectsSchema`'s 3 fields are likewise omitted from their
  objects' `required` arrays.

**Fix applied uniformly (not one-at-a-time, to avoid a round 4 chasing a fourth masked
defect) — the SAME pattern at BOTH remaining `generateObject` call sites
(`agent/plan-schema.ts`'s `flatPlanOutcomeSchema`, `agent/joiner.ts`'s new
`wireJoinerDecisionSchema`):**

1. **`params`** — no longer an object schema at all. `z.string()`, a JSON-ENCODED
   blob of the real `Record<string, unknown>` (LLD §10 Spike B's original option 1,
   floated all the way back in the very first SPIKES.md §1 entry and finally needed).
   A plain string has a trivially concrete `type`; this can never hit the "empty
   schema" rejection again no matter how deeply nested or heterogeneous real param
   values get. The new `toStep` adapter (`plan-schema.ts`) does `JSON.parse` to
   reconstruct the real params object for `agent/validator.ts`/`agent/executor.ts`
   (unchanged — they still receive exactly the `Record<string, unknown>` they always
   did).
2. **`forEach`/`when`/`expects`** — ALWAYS present (never `.optional()`), with
   sentinel/nullable semantics the adapter strips back to `undefined`:
   `forEach: z.string()` (`""` = absent); `when` is always an object with
   `ref: z.string()` (`""` = absent, then `op`/`value` are ignored), `op` staying the
   REAL 5-value enum (never nulled — see point 4), and `value` per point 3; `expects`
   is always an object with `nonEmpty`/`maxCount`/`minCount` each `.nullable()`
   (`null` = that field unset — primitive `.nullable()` collapses to a `type` ARRAY,
   e.g. `{"type":["number","null"]}`, confirmed locally to NOT be `anyOf`, unlike
   round 2's object/array-nullable finding).
3. **`when.value`** — `z.union([z.string(), z.number(), z.boolean(), z.null()])`. A
   union of BARE PRIMITIVES (no enum, no object, no array) collapses cleanly to
   `{"type":["string","number","boolean","null"]}`, confirmed locally — the one place
   in this whole investigation a JSON Schema union is actually safe. Every other union
   tried across all 3 rounds failed because it also contained an enum/object/array
   branch forcing `anyOf`.
4. **Why `when.op` stays a real enum instead of also being nulled**: local testing
   (`z.toJSONSchema`) found `z.enum([...]).nullable()` does NOT collapse to a type
   array the way plain primitives do — it compiles to `anyOf` (the `enum` keyword
   can't be folded into a bare `type` array the way a plain `type` can). So `op`
   itself never goes nullable; `ref===""` carries the "this when clause is unused"
   signal instead, and `op` is simply ignored by the adapter in that case.
5. **`joinerDecisionSchema`** (`agent/joiner.ts`) — flagged in round 2 (§1b) as a
   third `z.discriminatedUnion` with the identical root-`oneOf` defect, never fixed
   until now. Replaced with `wireJoinerDecisionSchema` (same flat-root + sentinel
   pattern: `decision` enum, `patchedSteps` sentinel `[]`, `question` nullable),
   reusing `plan-schema.ts`'s `wireStepSchema`/`toStep` for `patchedSteps` rather than
   duplicating the step-wire logic. A new `toJoinerDecision` adapter narrows back to
   the existing `JoinerDecision` shape; `joinerRepair`'s existing `NoObjectGeneratedError`
   re-throw pattern (mirroring `planner.ts`'s `narrowFlatOutcome`) covers the
   cross-field-mismatch case with zero new pipeline logic, identically to the planner
   path.

All of this was implemented and committed LOCALLY (schema + adapters + test suite
green) BEFORE any further live spend, per this round's explicit sequencing.

### Live re-spike (6 calls — planner ×3 models + joiner ×1 model, on top of the 2 diagnostic calls = 8 of the 10-call budget)

| Call | Model | Result |
|---|---|---|
| Planner re-spike | `anthropic/claude-haiku-4.5` | **GO** — `kind:"clarify"` (a legitimate choice, not a plan, but a clean structured-output parse), 3,217 in / 71 out tokens, $0.003572, 9,070 ms |
| Planner re-spike | `google/gemini-2.5-flash-lite` | **GO** — `kind:"plan"`, 8 steps, 2,133 in / 1,336 out tokens, $0.0007477, 3,613 ms |
| Planner re-spike | `openai/gpt-5-mini` | **GO** — `kind:"plan"`, 10 steps, 2,229 in / 1,405 out tokens, $0.00336725, 19,162 ms |
| Joiner-schema spike | `anthropic/claude-haiku-4.5` | **GO** — `decision:"clarify"` with a real question, 936 in / 70 out tokens, $0.001286, 7,794 ms |

All 4 calls succeeded on attempt 1 — zero retries needed, consistent with this being a
genuine schema-shape fix rather than a flaky/prompt issue. The joiner-schema call used
Anthropic only ("cheapest sufficient signal" per instruction) — Gemini/OpenAI were
already proven safe against union/empty-schema/optional-field defects by the planner
re-spike using the identical `wireStepSchema` building block, so a full 3-model joiner
re-spike would have been redundant spend.

### VERDICT (a4): Schema GO/NO-GO after the round-3 fix — **GO for all 3 models, planner AND joiner schemas**

`anthropic/claude-haiku-4.5`: **GO**. `google/gemini-2.5-flash-lite`: **GO**.
`openai/gpt-5-mini`: **GO**. `joiner.ts`'s `wireJoinerDecisionSchema`: **GO**
(Anthropic-verified; Gemini/OpenAI not independently re-spiked but share every
provider-sensitive construct with the already-3-model-verified planner schema). This
closes out the schema-shape blocker from docs/SPIKES.md §1/§1a/§1b — Task 9/10 may
proceed with real (non-Mock) LLM traffic against the planner AND joiner schemas on all
3 target models.

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

### 2a. Big-prompt cache probe — RUN in round 3 (2026-11-05, same day) — **CONFIRMED ABSENT, now at a size past the floor**

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
against the live API in this pass.** The live-call budget for that follow-up task was
capped at 7 calls total, and the re-spike + exact-error diagnostics in §1a (5 + 2
calls) consumed all 7 before the schema defect was fully characterized. Running
`--big` would have required 2 more calls, over the cap.

**Round-2 update (2026-11-05, same day): still NOT RUN — same reason, repeated.** This
round's explicit instruction was to run `--big` BEFORE any diagnostics, but the
schema-fix verification itself (§1b) consumed the ENTIRE round-2 budget (8 of 8 calls)
before the flat-root fix could even be confirmed working — 5 of those 8 calls were
wasted re-confirming the round-1 failure against a spike script that hadn't been
updated to the new schema yet (an avoidable mistake, disclosed in §1b), leaving no
room for `--big` even with the "run it first" instruction. `--big` mode itself is
unchanged and still ready to run.

**Round 3: finally run, per the explicit "cache probe runs next, before anything
else, non-negotiable" instruction** — executed immediately after the schema fix was
confirmed GO ×3 (§1c), BEFORE any optional diagnostics, exactly as instructed. 2
calls, `anthropic/claude-haiku-4.5`, explicit `cacheControl:{type:'ephemeral'}`,
identical system prefix:

| Call | tokens in | tokens out | **tokens cached** | cost | latency |
|---|---|---|---|---|---|
| 1 | 3,608 | 16 | **0** | $0.003688 | 1,899 ms |
| 2 (identical system) | 3,608 | 16 | **0** | $0.003688 | 1,362 ms |

Padded system measured at **~3,160 tokens** (`estimateTokens`, verified before any
API call) — comfortably past BOTH the >2,600-token target AND, critically, Anthropic
Haiku's documented ~2,048-token cache-eligibility floor that made round 1's result
inconclusive ("too small to tell"). This time the prompt is unambiguously large
enough. Result: **zero cached tokens on call 2, and identical cost between call 1 and
call 2** ($0.003688 both times) — the same "no cost difference" signal round 1 used to
argue caching never engaged, but now at a size where the floor-based explanation no
longer applies.

### VERDICT (b2): Cache passthrough — **CONFIRMED ABSENT** (not just "too small to tell" anymore)

Round 1's VERDICT (b) left open the possibility that the explicit-`cacheControl`
passthrough mechanism was real but simply never got a large-enough prompt to engage.
This round closes that gap: at ~3,160 system-prompt tokens (>1.5× Haiku's own stated
floor), two identical-prefix calls through the documented
`providerOptions.openrouter.cacheControl` passthrough STILL show zero cached tokens
and identical cost. The mechanism either doesn't actually reach Anthropic's cache
layer through OpenRouter for this request shape, or some other factor (the
`<catalog-summary-pad>`-wrapped padding, the `messages[]`-array bypass path itself,
OpenRouter's current cache-breakpoint support for this model route) prevents it —
further isolating WHICH is beyond this task's scope, but the practical answer for
cost planning is now a confirmed **NO**, not a "maybe, retry bigger."

**Baseline-economics implication:** `docs/TARGETS.md`'s existing non-cached-pricing
assumption for every planner-prompt cost estimate is now CONFIRMED correct (not just
assumed) — no change needed to the committed budget split (optimized agent: full
110-scenario corpus ×3 trials; baseline agent: stratified 40-scenario subset ×1
trial). This closes out the cache-passthrough question for the planner's real system
prompt size range; no further cache spikes are needed unless the system prompt
architecture changes significantly (e.g. a shared-prefix multi-turn caching scheme,
which is a different mechanism than the single-request breakpoint tested here).

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

### 3b. Total spend (2026-11-05 round-2: flat-root + sentinel fix)

| Call batch | Calls | Measured cost |
|---|---|---|
| Wasted re-spike (stale `planOutcomeSchema` import not yet updated) — Haiku, 2 attempts | 2 | $0 |
| Wasted re-spike — Gemini, 1 attempt (succeeded, but against the stale schema) | 1 | $0.0004737 |
| Wasted re-spike — GPT-5-mini, 2 attempts | 2 | $0 |
| Flat-schema re-spike (`MAX_ATTEMPTS` reduced to 1 to stay in budget) — Haiku | 1 | $0 |
| Flat-schema re-spike — Gemini (succeeded) | 1 | $0.0004433 |
| Flat-schema re-spike — GPT-5-mini | 1 | $0 |
| **Total** | **8** | **≈ $0.0009170** |

Exactly at the 8-live-call cap set for this round; well under the $0.25 cost cap. 5 of
the 8 calls (62.5%) were spent re-confirming an ALREADY-KNOWN failure because the spike
script wasn't updated before the first re-run — disclosed in full in §1b rather than
omitted. No budget remained for the exact-error diagnostic that would explain why
Anthropic/OpenAI still fail with the (merely) root-fixed schema, nor for live-verifying
the sentinel-value redesign devised in response, nor for the `--big` cache probe §2a
asked for this round.

### 3c. Total spend (2026-11-05 round-3: params-as-string uniform fix + cache probe) — ALL GREEN

| Call batch | Calls | Measured cost |
|---|---|---|
| Diagnostic (mandatory first step), `anthropic/claude-haiku-4.5` against round-2 schema | 1 | $0 (400 pre-generation) |
| Diagnostic (mandatory first step), `openai/gpt-5-mini` against round-2 schema | 1 | $0 (400 pre-generation) |
| Planner re-spike, `anthropic/claude-haiku-4.5` (attempt 1, succeeded) | 1 | $0.003572 |
| Planner re-spike, `google/gemini-2.5-flash-lite` (attempt 1, succeeded) | 1 | $0.0007477 |
| Planner re-spike, `openai/gpt-5-mini` (attempt 1, succeeded) | 1 | $0.00336725 |
| Joiner-schema spike, `anthropic/claude-haiku-4.5` (attempt 1, succeeded) | 1 | $0.001286 |
| Big-prompt cache probe, call 1 | 1 | $0.003688 |
| Big-prompt cache probe, call 2 | 1 | $0.003688 |
| **Total** | **8** | **≈ $0.0163489** |

8 of the 10-call budget used, 2 calls to spare; well under the $0.30 cost cap. Unlike
rounds 1 and 2, EVERY live call this round produced new, used signal — no wasted
calls, and the mandated ordering (diagnose-first, cache-probe-before-anything-else)
was followed exactly as instructed. This round closes out BOTH the schema GO/NO-GO
question (§1c, GO ×3 + joiner GO) and the cache-passthrough question (§2a, CONFIRMED
ABSENT) in a single pass.

## 4. Cross-reference: `docs/TARGETS.md`

`docs/TARGETS.md` was already written and committed before this task started (Task 6
Step 3, skipped per instructions — see its own file for the full targets table, TTFUR
definitions, and the budget/measurement conditions referenced in VERDICT (b) above). No
changes made to it by this task.
