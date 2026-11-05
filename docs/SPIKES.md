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

## 4. Cross-reference: `docs/TARGETS.md`

`docs/TARGETS.md` was already written and committed before this task started (Task 6
Step 3, skipped per instructions — see its own file for the full targets table, TTFUR
definitions, and the budget/measurement conditions referenced in VERDICT (b) above). No
changes made to it by this task.
