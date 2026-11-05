# Synthesis: Should the agent be a tool-calling loop? (adjudication research)

Date: 2026-11-06 · Method: 3 parallel source-level research agents (OSS framework internals; production CRM agents + benchmark literature; four sub-problem mechanisms). Full reports:
- `2026-11-06-oss-loop-internals.md`
- `2026-11-06-crm-architecture-evidence.md`
- `2026-11-06-subproblem-mechanisms.md`

Trigger: 3 rounds of NO-SHIP human testing on the plan-then-execute agent; proposed pivot to a tool loop questioned ("I don't think this approach would work as well — research properly, reference well-known OSS projects").

## Verdict

**The iterative tool-calling loop is the right architecture family — the evidence is one-directional — but the pivot plan as first drafted had one significant error (the single `call_action`/`paramsJson` dispatch tool) and several evidence-backed refinements. Revised plan: native per-tool function calling over a retrieved shortlist.**

## 1. Loop vs plan-first: what the evidence licenses

- **No production CRM/business agent ships per-request LLM-compiled plans.** Salesforce Atlas is explicitly a ReAct loop ("yielded much better results compared to CoT"); Shopify Sidekick is a single-agent loop that *retreated from* architectural complexity; Intercom Fin Procedures are executed step-wise by the LLM; Sierra, Decagon, Zendesk — all loops. Where these vendors add determinism it is **human-authored at design time** (Agent Script, AOPs, guardrails-as-code) — the inverse of our system, where the LLM authors a deterministic artifact per request.
- **Plan-first benchmark wins are cost/latency wins on read-only QA** (ReWOO −64% tokens; LLMCompiler 3.7× faster on parallelizable reads). The one accuracy win for planning, Plan-and-Act (ICML 2025), required replanning after every observation — it converges to a loop — and its **untuned planner scored 22.8 points WORSE than no planner** (36.97% → 14.21% on WebArena-Lite). That result is a published replica of our situation: 5 fix waves flat-lined at 7/20 while an unpolished loop baseline existed.
- **No published head-to-head shows one-shot-plan + deterministic execution beating a function-calling loop on stateful multi-turn writes.** No benchmark even includes that arm.
- **Honest caveat:** CRMArena-Pro shows plain loops with 2025 frontier models reach only ~35% on multi-turn CRM tasks (58% single-turn). The loop is the better family, not a guarantee; harness quality (retrieval, rails, gates) is where the remaining reliability comes from.

## 2. The correction: native tool schemas, not a dispatch meta-tool

Our prototype (and first plan draft) had the model emit `{"kind":"call_action","slug":…,"paramsJson":"{…}"}` as a JSON blob. **No surveyed framework uses this as the model-facing interface** (OpenAI Agents SDK, Vercel AI SDK, LangGraph, smolagents, Claude Agent SDK, goose, OpenHands — all native function calling; goose and OpenHands treat text-parsed calls as an explicit degraded mode for weak local models; OpenHands moved TO native FC because it "got the agent stuck in loops less often").

- Where dispatch meta-tools exist at scale (Uber's Omni gateway over 5,000 tools; MCP gateways), the per-action schema is retrieved **into context before invocation** — discover, then call natively.
- Anthropic's measured version: Tool Search Tool + deferred schemas took Opus 4 from 49% → 74% tool-selection accuracy at −85% context. The gain came from shrinking the visible catalog **while keeping native typed calls**.
- JSON-in-string params sit on a documented live failure class (double-encoding/escaping bugs across vLLM, opencode, goose, Vercel AI SDK issues) and forfeit provider-side schema validation and framework repair loops (`repairToolCall`, LangGraph validation-error feedback).
- Caveat recorded: BFCL shows prompt-mode parsing is not uniformly worse for every model; the exact `call_action(paramsJson)` vs native comparison is unmeasured. Direction is still one-way.

**Decision: per turn, bind the retrieved shortlist (~20 actions) as real tools with their existing zod schemas via the AI SDK's native tool-calling (`generateText` + `tools` + `stopWhen`), plus a stable `search_actions` retrieval tool (langgraph-bigtool / Tool Search pattern). Toolset stays stable within a turn (Manus: mask, don't remove mid-loop).** Our `llm/client.ts` is already the Vercel AI SDK over OpenRouter, so this is incremental, not a rewrite.

## 3. Sub-problem mechanisms (evidence → design)

| Sub-problem | Evidence | Decision |
|---|---|---|
| Dates | LLM date/epoch arithmetic is a documented weak skill (PRIMETIME; Test of Time; digit tokenization). Universal mitigation: inject ISO "now" + derived anchors; ISO-8601-only date params; server resolves relatives; **echo the resolved absolute range back in the tool result** | Keep plan Task 2, add the echo-back. Architecture-independent fix — required either way |
| Aggregates/ordinals over big sets | Dominant 2026 pattern: result handle + sandboxed code execution for reads (Anthropic PTC, Cloudflare Code Mode, Uber, smolagents). Runner-up and "ship first" for a 500-action SQLite catalog: small deterministic server-side transforms over handles (MCP ResourceLink dual-response pattern) | Keep `data.sort_ref`/`data.aggregate_ref` handle tools; document code-exec as the scaling path, not v1 |
| Multi-turn scope | "LLMs Get Lost in Multi-Turn Conversation": degradation = lossy constraint carry-over. 2026 condensation study: observation-masking the only net-positive; LLM summarization adds 24–94% overhead, no quality gain. CLIs keep user/assistant turns verbatim far longer than tool outputs | Verbatim recent turns + mask old tool outputs + make scope durable: each search observation carries its resolved filters + handle, so follow-ups resolve against an artifact |
| Answer faithfulness | Fabrication-after-tool-failure: explicit status fields cut dishonesty 14.1% → 0.87%. Claude Code injects denials AS tool results. Salesforce Atlas runs a pre-response grounding check | Model writes the answer with raw results + explicit per-step status in context; denials injected as tool results; deterministic ledger line (writes executed/denied/failed) available at answer time |
| Gates/idempotency | Pre-execution pause (Claude SDK, goose, OpenHands) avoids double-execution by construction; suspend-and-replay designs (LangGraph interrupt re-runs the node; OpenAI SDK docs: approval "does not guarantee exactly-once") push idempotency to the app | Our pre-execution broker gate is the validated pattern — keep. Idempotency keys stay as belt-and-braces |
| Loop safety | Field floor = step budget + errors-fed-back. Only OpenHands ships stuck detection: 4 repeated action-observation pairs / 3 action-error repeats over last 20 events, semantic compare ignoring IDs | Step cap 12 + 90s deadline + StuckDetector-lite (3× identical action+error → corrective hint; 4× → honest fail) |
| Model tier | Haiku 4.5 runs τ²-bench loops credibly (retail 83 vendor-harness) but the small↔large gap widens non-linearly with policy complexity (telecom 37 vs 76 third-party). Anthropic guidance: strong model orchestrates/escalates | Haiku default; document sonnet-class escalation for ambiguity-heavy turns as a flag (budget-gated) |

## 4. What this changes in the implementation plan

1. **Tasks 1/4 rewritten:** native AI SDK tool loop (`generateText` + per-turn `tools` from retrieved cards' zod schemas + `stopWhen`), not the hand-rolled JSON-blob protocol. Clarify/refuse become explicit tools (`session.ask_user`, `session.refuse` — Claude SDK AskUserQuestion pattern) so TurnStatus stays honest.
2. **New client path** `llm/tool-loop.ts` wrapping `generateText` with tools (usage/cost/span accounting per step; fetch-level mock seam unchanged).
3. **Task 2 (dates):** unchanged + resolved-range echo in tool results.
4. **Task 3 (memory):** unchanged + scope artifact (filters + handle) in each search observation.
5. **Task 4 additions:** StuckDetector-lite; execution-ledger status visible at answer time.
6. Everything else (gates, refs, events, eval fairness, quick-20 sanity, human round-4 as ship bar) stands.

## 5. What would change this verdict

- Evidence that a hardened plan-first arm (static validation + replanning joiner, Dash-style) beats a native loop on stateful CRM writes — none published today.
- The quick-20/human round showing the haiku-driven native loop below the plan-DSL agent's 7/20 plateau — would trigger model-tier escalation before any architecture re-litigation.
