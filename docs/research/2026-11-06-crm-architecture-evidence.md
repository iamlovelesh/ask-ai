# Plan-First vs Iterative-Loop for a 500-Action CRM Agent: Evidence Review

Research agent report, 2026-11-06. **[O]** = directly observed in source; **[I]** = inference.

---

## 1. What production CRM/business agents actually do

**Headline [I]: no major production system ships our architecture** — a per-request LLM-emitted multi-step plan frozen into a DAG and executed deterministically with a templated composer. The dominant pattern is an iterative tool-calling loop, scoped per-turn, with determinism added as *design-time rails* (human-authored scripts/procedures), not as per-request compiled plans. Final answers are model-written everywhere, usually with a separate validation pass.

| System | Execution engine | Final answer | Multi-turn scope | Stated rationale/guardrails |
|---|---|---|---|---|
| Salesforce Agentforce (Atlas) | ReAct loop — "a loop of reason, act, and observe until a user goal is fulfilled"; ReAct "yielded much better results compared to the CoT technique" [O] ([Atlas page](https://www.salesforce.com/ap/agentforce/what-is-a-reasoning-engine/atlas/)) | Model-written from conversation history [O] | Per-turn routing to topics/subagents bundling instructions+actions [O] | 2025–26: added **Agent Graph/Agent Script** — "orchestration as design-time configuration, not runtime improvisation" [O] ([eng blog](https://engineering.salesforce.com/agentforces-agent-graph-toward-guided-determinism-with-hybrid-reasoning/), [hybrid reasoning guide](https://architect.salesforce.com/docs/architect/fundamentals/guide/hybrid-reasoning-agentforce-builder-agent-script)) — motivated by goal drift, "drop-off" on tangents, zero auditability of giant prompts [O] |
| Shopify Sidekick | Single-agent tool loop; explicitly: "Avoid multi-agent architectures early" [O] ([shopify.engineering](https://shopify.engineering/building-production-ready-agentic-systems)) | Model-written in-loop [O/I] | **Just-in-time instructions** returned alongside tool data; lean core prompt; preserves prompt caches [O] | Simplicity/debuggability beat planner complexity; >~50 tools made the system "difficult to reason about" — fixed via JIT instructions, not a planner [O] |
| Intercom Fin | Staged pipeline for Q&A; **Fin Procedures** executed step-wise by the LLM: "evaluates the next best step in real time, can jump sections, revisit earlier steps" vs deterministic Workflows as a separate product [O] ([Procedures doc](https://www.intercom.com/help/en/articles/14077835-procedures-vs-tasks-vs-workflows), [fin.ai/ai-engine](https://fin.ai/ai-engine)) | Model-written, then a validation stage checks accuracy/safety [O] | Procedures read/update attributes across turns; approval pauses before writes [O] ([Tasks doc](https://www.intercom.com/help/en/articles/10257113-how-to-set-up-fin-tasks)) | Generate-then-validate; honest escalation |
| Decagon | **AOPs**: natural-language SOPs "compile into structured logic"; LLM interprets input turn-by-turn, "code-based logic ensures critical actions execute correctly" [O] ([AOP post](https://decagon.ai/blog/from-sops-to-agent-operating-procedures)) | Model-written within guardrails [I] | Not publicly documented | Identity/payment under "strict validation protocols" in code; test-driven simulation ([blog](https://decagon.ai/blog/the-future-of-ai-agents-is-test-driven)) |
| Sierra | Loop with graded agency; "15+ models", supervisors "enforce guardrails, policies, and quality checks" [O] ([constellation post](https://sierra.ai/blog/constellation-of-models)); their own τ-bench models agents as tool-calling loops ([benchmarking post](https://sierra.ai/blog/benchmarking-ai-agents)) [I: runtime is loop-based] | Model-written; tone is a modular capability [O] | Dedicated "context layer" [O]; mechanics undocumented | Declarative SDK + hard deterministic guardrails ("orders returned only within 30 days") ([ADLC post](https://sierra.ai/blog/agent-development-life-cycle)) |
| Zendesk | "Adaptive reasoning… without fixed scripts"; agent "plans a course of action and presents a preview of its proposed steps" — plan-as-*preview for humans*, adaptive execution [O] ([Relate 2025](https://www.zendesk.com/newsroom/articles/relate-2025-resolution-platform/)) | Model-written [I] | Not documented | Chain-of-thought audit controls [O] |
| HubSpot Breeze / ClickUp / Monday | Breeze: tool call → "based on the output, the agent reasons further" (loop) [O] ([community thread](https://community.hubspot.com/t/building-custom-agent-tools-for-breeze-what-the-architecture-actually-looks-like-and-where-it-break/155506)); ClickUp: sub-agent architecture + per-job model routing ([clickup.com/brain/agents](https://clickup.com/brain/agents)); internals not publicly documented | — | — | — |

**Key pattern [I]:** where the industry wants determinism (Salesforce Agent Script, Decagon AOPs, Sierra guardrails), it is *authored by humans at design time* and the LLM iterates inside it — the inverse of our system, where the LLM authors the deterministic artifact per request.

---

## 2. Plan-first vs loop: the benchmark evidence and its direction of error

| Paper | What won | Task type | Key numbers | Transfers to 500-action CRM writes? |
|---|---|---|---|---|
| [Plan-and-Act (2503.09572)](https://arxiv.org/abs/2503.09572), ICML 2025 | Planner **only with dynamic replanning** | Web navigation (WebArena-Lite), fine-tuned Llama-3.3-70B | Executor-only 36.97% → naive planner **14.21%** → trained static plan 43.63% → **+ replanning 53.94% (+10.31)** [O, Table 1] | Strongest datapoint against frozen plans: untuned planner is −22.8 pts vs no planner; the winning variant replans after each observation, i.e., converges to a loop [I] |
| [ReWOO (2305.18323)](https://arxiv.org/abs/2305.18323) | Plan-ahead on **cost** | Read-only multi-hop QA, gpt-3.5 | −64% tokens, +4.4% acc vs ReAct [O]; authors concede plan-ahead "becomes impractical" without prior environment knowledge [O, §Limitations] | No — CRM lookups (IDs, duplicates, empty results) are exactly the unforeseeable-state case [I] |
| [LLMCompiler (2312.04511)](https://arxiv.org/abs/2312.04511) | DAG-plan on **latency** | Parallelizable read QA (HotpotQA, ParallelQA, Movie Rec) | Up to 3.7× speedup, 6.7× cost cut, accuracy ~flat [O] | Only the parallel-*read* fan-out transfers; sequenced confirmation-gated writes are serial, erasing the motivation [I]. Even LLMCompiler replans on intermediate results [O] |
| [τ-bench (2406.12045)](https://arxiv.org/abs/2406.12045) / [τ²-bench (2506.07982)](https://arxiv.org/abs/2506.07982) | **Native function-calling loop** beats ReAct text format and Act-only [O]; no plan-first arm exists | Transactional retail/airline/telecom with simulated users | gpt-4o retail 61.2% pass^1 but **pass^8 <25%** [O]; τ²: dual-control costs GPT-4.1 ~18 pts; telecom pass^1 34% [O] | Loop weakness is *variance and rule adherence*, arguing for deterministic gates around a loop, not plan freezing [I] |
| [WorkBench (2405.00823)](https://arxiv.org/abs/2405.00823) | n/a — all 5 ReAct agents weak | Side-effecting workplace tasks, outcome-checked DB state | Best (GPT-4) 43%; errors include "email sent to the wrong person" [O] | Justifies confirmation gates regardless of architecture [I] |
| [CRMArena (2411.02305)](https://arxiv.org/abs/2411.02305) / [CRMArena-Pro (2505.18878)](https://arxiv.org/abs/2505.18878) | FC loop beats ReAct by ~15 pts (<55% vs <40%) [O]; Pro tested **ReAct only** — no plan-first arm | CRM on live Salesforce schemas; Pro adds multi-turn, confidentiality | **~58% single-turn → ~35% multi-turn** [O]; multi-turn failures: in 9/20 queries the agent "did not acquire all necessary information" [O]; policy compliance 41–42%; near-zero confidentiality awareness [O] | Our domain. Multi-turn collapse happens *inside a loop* — iteration isn't sufficient — but a plan frozen before turn 2 can't absorb later information by construction [I] |
| [ToolSandbox (2408.04682)](https://arxiv.org/abs/2408.04682), Apple | n/a | Stateful multi-turn tool use | State Dependency, Canonicalization, Insufficient Information hardest for SOTA models [O] | State-dependency errors must be *observed* and reacted to; frozen plans cannot discover them [I] |

**Direction-of-error summary [I]:** every published plan-first win is on read-only, parallelizable QA and is a cost/latency win, not accuracy. The one accuracy win for planning (Plan-and-Act) required per-observation replanning and heavy planner fine-tuning. There is **no** published head-to-head where one-shot-plan + deterministic execution beats an FC loop on stateful writes — partly because no benchmark even includes that arm.

---

## 3. Why plan-first works when it works

- **Dropbox Dash** [O] ([dropbox.tech](https://dropbox.tech/machine-learning/building-dash-rag-multi-step-ai-agents-business-users)): planner emits code in a minimal Python-like DSL run on a from-scratch interpreter; viability comes from **pre-execution static analysis**, a **second LLM repair pass**, and step-level diagnostics/type checks. Reported failure modes: invalid generated code, per-step logic failures, type mismatches. Crucially: Dash is *read/search-oriented RAG*, not confirmation-gated CRM writes [I].
- **Salesforce Agent Script** [O] ([eng blog](https://engineering.salesforce.com/agentforces-agentscript-building-deterministic-control-for-enterprise-ai-workflows/)): deterministic layer = verification gates, permissions, sequencing, critical branches — "execute as code with no LLM involvement"; LLM layer = NLU and reasoning inside allowed slots. Human-authored, design-time determinism.
- **LLMCompiler in production:** no named deployments found; [LangChain's planning-agents retrospective](https://www.langchain.com/blog/planning-agents) notes all plan-and-execute variants "require re-evaluation when initial plans prove insufficient" [O].
- **Vendor guidance:** Anthropic's [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) — for agents "it's crucial... to gain 'ground truth' from the environment at each step" [O]. OpenAI's [agents guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf): use deterministic solutions where they suffice; layered guardrails otherwise [O].

**Common enablers [I]:** constrained grammar + tiny runtime surface; static validation *before* execution; determinism only at business-critical gates; read-heavy domains. Our 500-action catalog, bespoke ref-grammar with 42% repair-error share, and write-heavy tasks lack most of these preconditions.

---

## 4. Our four failure classes in the literature

**(a) LLM date/epoch arithmetic.** Temporal *arithmetic* is a distinct, weak LLM skill ([Test of Time, 2406.09170](https://arxiv.org/abs/2406.09170)); digit tokenization measurably degrades long-number arithmetic ([2402.14903](https://www.arxiv.org/pdf/2402.14903)) — a 13-digit epoch-ms literal is a worst case [I]. Standard mitigation [O]: the model emits a *relative expression* resolved by a deterministic date tool/library; never an LLM-computed literal. **Architecture-independent** [I].

**(b) Multi-turn filter continuity.** [LLMs Get Lost in Multi-Turn Conversation (2505.06120)](https://arxiv.org/abs/2505.06120): ~39% average drop from single-turn to sharded multi-turn (~15% aptitude loss + ~112% unreliability increase); models latch onto early assumptions [O]. CRMArena-Pro's 58→35% and τ²-bench corroborate [O]. Architectural implication [I]: degradation mechanism is *lossy carry-over of constraints*; a loop keeping full conversation + raw tool history preserves prior filters structurally; a per-turn replanner fed summarized state re-creates exactly the sharding the paper measures.

**(c) Final-answer faithfulness.** [Fabrication After Tool Failure (2609.14758)](https://arxiv.org/html/2609.14758v1): forcing explicit `retrieval_status: OK|FAILED` cut dishonesty 14.10% → 0.87% [O]. Consensus mitigation [O]: the component writing the final answer must see raw tool outputs; success/failure status derived from tool results, not prose. A *deterministic* status banner derived from executor state is the strongest fix; model-written answer grounded in raw results second; a template decoupled from executor outcomes worst [I].

**(d) Counts over paginated results.** No benchmark isolates this, but tool-design guidance is unanimous [O]: return `total_count`/`has_more`/`truncated` fields ([Anthropic tool-writing](https://www.anthropic.com/engineering/writing-tools-for-agents)). Counts must come from a server-side aggregate field, never the model counting page 1 [I]. Architecture-independent.

---

## 5. Model tier: can Haiku-4.5-class drive the loop?

| Benchmark | Haiku 4.5 | Sonnet 4.5 | Source |
|---|---|---|---|
| SWE-bench Verified | 73.3% | 77.2% | [Haiku 4.5](https://www.anthropic.com/news/claude-haiku-4-5), [Sonnet 4.5](https://www.anthropic.com/news/claude-sonnet-4-5) [O] |
| τ²-bench (Anthropic harness) | Retail 83.2 / Airline 63.6 / Telecom 83.0 | Retail 86.2 / Airline 70.0 / Telecom 98.0 | announcement footnotes [O] |
| τ²-bench (third-party harness, pass^1) | 53.4 avg (telecom 37.2) | 73.3 (telecom 76.0) | [llm-stats](https://llm-stats.com/benchmarks/tau2-telecom) [O; harness differs] |
| Terminal-Bench | ~41% | ~50% | Anthropic footnotes via mirrors [O] |

**Realistic expectation [I]:** Haiku 4.5 *can* run a 3–8-step loop, plausibly 60–80% pass^1 on a well-built harness — but the Haiku↔Sonnet gap widens non-linearly with policy/action-space complexity, and pass^k will be materially worse than pass^1. Evidence-supported mitigations: per-turn retrieval of a small action subset; deterministic helpers; stronger model for planning/ambiguity.

---

## What this evidence actually licenses us to conclude

**Reasonably well-supported:**
1. No published benchmark or production system demonstrates one-shot-plan + deterministic execution outperforming an iterative FC loop on stateful, multi-turn write tasks; the best planning result needed per-observation replanning; an untuned planner measurably *hurts* (−22.8 pts).
2. Production CRM-adjacent vendors run iterative loops with model-written answers; determinism is human-authored at design time.
3. Frozen plans can't absorb mid-conversation information (b); answer-writers that don't see raw execution results fabricate success (c); LLM epoch arithmetic is known-bad with a standard deterministic fix (a).
4. Date math (a) and truncated counts (d) are tool-contract problems to fix in *either* architecture; pivoting alone won't fix them.

**Thin or conflicting:**
- CRMArena-Pro: loops only reach ~35% multi-turn with 2025 frontier models — a pivot is not a reliability guarantee; "loop beats plan-first on CRM" is an argument from absence plus adjacent-domain ablations.
- No published study isolates template-composer vs model-written answer faithfulness.
- Haiku-4.5-on-500-actions has no public datapoint; harness variance up to 45 points on telecom.
- Dropbox Dash is the existence proof for hardened plan-first — in a read-heavy product with static analysis, preconditions our system doesn't meet.
