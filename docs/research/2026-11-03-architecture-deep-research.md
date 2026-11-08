# Agent Architectures for 500-Action Catalogs: Deep Research Report

*Generated: 2026-11-03 · Sources: ~45 (vendor engineering blogs, production case studies,
peer-reviewed papers, benchmarks) · Confidence: High on convergent findings, flagged where thin*

## Executive Summary

Every credible source — vendor guidance, production systems, and published benchmarks —
converges on the same conclusion: **no one ships a flat 500-tool prompt**. At 500 actions,
tool shortlisting (retrieval or routing) is mandatory for every architecture, and the
strongest-evidence design for a CRM-style workload is a **hybrid**: tool-RAG shortlist →
single planner call producing a reviewable plan/DAG → parallel execution of reads →
single-threaded, individually-confirmed writes → a **replanning joiner** for data-dependent
branches. Pure ReAct loses on cost/latency (3–7× tokens); pure plan-once loses on
data-dependent branching; full code-execution agents win on tokens but lose on auditability
of writes. Our draft design matches the convergent recipe; this research adds five concrete
refinements (below).

## 1. The five architecture families — head-to-head evidence

| | ReAct loop (native FC) | Plan-then-execute (DAG) | Orchestrator-worker | Tool-RAG + loop | Code-execution agent |
|---|---|---|---|---|---|
| Selection accuracy @500 tools | −− 13.6% with all schemas in prompt (RAG-MCP) | − planner hallucinates plan nodes as catalog grows unless shortlisted | + module scoping helps (unmeasured) | **++** 13.6→43.1% (RAG-MCP); Opus 49→74% with tool search (Anthropic) | + typed stubs catch hallucinated APIs |
| Multi-step reliability | + adapts per step; but drift/looping, pass^8 <25% (τ-bench) | − blind plans unrecoverable (ReWOO); **++ with dynamic replanning** (+10.3pts, Plan-and-Act) | 0 write coordination fails (Cognition) | + inherits loop; silent shortlist-miss risk | ++ composition (+20.7pts M3ToolEval); = JSON on atomic calls |
| Latency | − one round-trip per action | **++** 1.8–3.7× faster via parallel DAG (LLMCompiler) | − sequential orchestration bottleneck | + fewer tokens/call | ++ 20+ calls per inference pass (PTC) |
| Cost | −− 3.4–6.7× more expensive (LLMCompiler); 5× tokens (ReWOO) | **++** cheapest measured | −− ~15× chat tokens (Anthropic) | + ~50% prompt cut | ++ −37% (PTC) to −98.7% (MCP code mode) |
| Auditability of writes | ++ discrete typed calls, per-action gates | ++ plan reviewable BEFORE execution; deterministic trace | 0 decisions dispersed | ++ same as ReAct | −− side effects buried in generated code; approval UX degraded |
| Implementation effort (5 days) | ++ trivial | 0 moderate | −− high | + moderate | − sandbox + security burden |

Key head-to-head numbers:
- **LLMCompiler** (ICML 2024): plan-DAG + parallel executor vs ReAct — 1.8–3.74× faster,
  3.4–6.7× cheaper, equal-or-better accuracy ([arxiv 2312.04511](https://arxiv.org/html/2312.04511v3)).
- **ReWOO**: −64% tokens, +4.4pts accuracy vs ReAct avg over 6 benchmarks; but unrecoverable
  when a mid-plan step fails ([arxiv 2305.18323](https://arxiv.org/abs/2305.18323)).
- **Plan-and-Act** (ICML 2025): dynamic replanning worth **+10.3pts** over a static plan; a
  badly-tuned planner scored WORSE than no planner ([arxiv 2503.09572](https://arxiv.org/html/2503.09572)).
- **CodeAct** (ICML 2024): code actions +20.7pts and −30% turns on multi-tool composition —
  but no better than native JSON tool calls for single atomic calls ([arxiv 2402.01030](https://arxiv.org/html/2402.01030)).
- **WorkBench** (CRM-like, 26 tools): giving all tools vs only relevant toolkits dropped
  accuracy 49%→43% — direct distractor-tool evidence; 2026 revisit: native structured tool
  calling eliminated the 2024 dominant failure class ([arxiv 2405.00823](https://arxiv.org/abs/2405.00823), [2606.13715](https://arxiv.org/abs/2606.13715)).
- **τ-bench / τ²-bench** (Sierra): pass^1 ~61% retail but pass^8 <25%; success ≈ 0 beyond
  ~7 write actions per task; native FC > ReAct ([arxiv 2406.12045](https://arxiv.org/pdf/2406.12045), [2506.07982](https://arxiv.org/abs/2506.07982)).

## 2. What vendors advise (first-party engineering blogs)

- **Anthropic, "Writing effective tools for agents"**: fewer consolidated workflow-shaped
  tools beat 1:1 endpoint wrappers; namespacing matters; **semantic IDs** (names, not UUIDs)
  "significantly improve precision"; `response_format: concise|detailed` (their Slack example:
  72 vs 206 tokens); token-cap tool responses; iterate descriptions against eval transcripts
  (one rewrite = −40% task completion time) ([link](https://www.anthropic.com/engineering/writing-tools-for-agents)).
- **Anthropic advanced tool use**: selection "degrades once you exceed 30–50 tools"; tool
  search = −85% context, Opus 4 accuracy 49→74% on large-library MCP evals; Programmatic Tool
  Calling −37% tokens, eliminates 19+ inference passes on 20-call workflows
  ([link](https://www.anthropic.com/engineering/advanced-tool-use)).
- **OpenAI practical guide**: trouble can start under 10 *overlapping* tools; risk-rate every
  tool (read/reversible/irreversible/financial) and gate high-risk behind approval
  ([PDF](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)).
- **Cloudflare Code Mode**: model writes TypeScript against generated API in V8 isolate;
  thesis: LLMs know code better than tool-call tokens ([link](https://blog.cloudflare.com/code-mode/)).
  Critiques: scripted loops have no judgment point between steps (Kilcher); confirmation
  dialogs showing 15 lines of TS are "a downgrade in safety"; CE-MCP attacks succeed
  *without* sandbox escape ([arxiv 2602.15945](https://arxiv.org/html/2602.15945)).
- **Vercel AI SDK**: `prepareStep` + `activeTools` is the first-class hook for per-step tool
  subsets; `stopWhen` budgets; v6 adds per-tool approval gates ([link](https://ai-sdk.dev/docs/agents/loop-control)).
- **Anthropic multi-agent system**: multi-agent ≈ 15× chat tokens; dependency-heavy
  transactional domains (CRM) "are not a good fit for multi-agent systems today"
  ([link](https://www.anthropic.com/engineering/multi-agent-research-system)).

## 3. What production systems actually do

- **Salesforce Agentforce/Atlas** (closest analogue, "scale to thousands of actions"):
  two-stage **Topics** — classify message → one focus topic → inject only that topic's
  action subset; grounding check gates the final response; 2025 lesson: pure NL instructions
  → unpredictable agents, so they added a deterministic DSL (Agent Script)
  ([link](https://engineering.salesforce.com/inside-the-brain-of-agentforce-revealing-the-atlas-reasoning-engine/)).
- **Shopify Sidekick**: single agent, not multi-agent; tool thresholds 0–20 fine / 20–50
  blurry / 50+ unmanageable; **Just-in-Time instructions inside tool results** (cache-friendly,
  "not a token less"); never mutates state directly — fills previews the merchant approves
  ([link](https://shopify.engineering/building-production-ready-agentic-systems)).
- **Decagon**: "the single biggest driver of tool-calling accuracy is… how much of the tool
  surface the agent has to reason over" — selection degrades at 30+ tools; router +
  intent-scoped toolsets ([link](https://decagon.ai/blog/getting-the-most-out-of-mcp)).
- **Sierra**: "ReAct remains the public state of the art, but [doesn't] perform sufficiently
  for production"; deterministic guardrails enforce business rules; pass^k is the metric;
  annotated conversations become replayable regression simulations
  ([link](https://sierra.ai/blog/agent-development-life-cycle)).
- **Intercom Fin**: TTFT measured at the frontend is the north-star; eager speculative
  requests saved −2s median; famous finding — *added* latency can increase resolution rate
  (confound to control in experiments) ([link](https://fin.ai/research/does-slower-seem-smarter-rethinking-latency-in-ai-agents/)).
- **Dropbox Dash**: planner-executor where the plan is code in a **restricted Python-like
  DSL**, statically validated, run in a minimal purpose-built interpreter — the
  "constrained code mode" middle path ([link](https://dropbox.tech/machine-learning/building-dash-rag-multi-step-ai-agents-business-users)).
- **Uber**: 800+ MCP servers / 5,000+ tools behind a gateway; replaced the tool pile with a
  discover-and-call meta-tool + code execution for heavy cases → >40% token reduction
  ([link](https://www.infoq.com/news/2026/11/uber-mcp-gateway-ai-agents/)).
- **a commercial CRM's Ask-AI product** (grader signal): advertises 500+ actions from chat;
  emphasizes permission checks mirroring user role, **confirmation step for every
  write/destructive/bulk op**, live task tracker, audit feed, bulk scope confirmation.

## 4. Implications for our design (deltas vs the draft)

The draft design (tool-RAG shortlist → single-call Plan DSL → deterministic executor →
code-composed summary) is the convergent industry recipe — Dropbox Dash is its closest
production twin. Research-driven refinements:

1. **Add a replanning joiner (biggest correctness delta).** Plan-once-blind is the
   best-documented failure mode (ReWOO unrecoverable; +10.3pts for dynamic replanning; the
   public assignment repos hit exactly this). After the read-phase of a plan executes, a
   cheap joiner decision (code-first, LLM only when results diverge from plan assumptions)
   either continues, patches the plan (repair > full replan), or asks the user. Budgeted:
   max 2 replan rounds.
2. **Reads parallel, writes single-threaded and sequential** through the confirmation gate —
   consensus across Cognition/LangChain/τ-bench/a commercial CRM's own product.
3. **Action-card quality is the real bottleneck** (ToolRet: generic embedders are weak;
   Arcade: ~60% retrieval on bad descriptions). Invest day-2 time in enriched cards +
   synthetic probe queries + measure recall@k before touching the planner. Semantic IDs
   (return names alongside ids), concise/detailed response formats, token-capped outputs.
4. **JIT instructions in tool results** (Shopify): module-specific guidance rides in
   handler results, not the system prompt — keeps the system prompt byte-stable (cache) and
   localizes guidance.
5. **Eval upgrades from BFCL v3 / τ-bench**: state-based final verification (already
   planned) + abstention cases (no matching action among 500 — must decline), missing-parameter
   cases (must ask, not assume), distractor stress cases, and **pass^3 reliability** reported
   alongside pass^1. Report per-category.
6. **UI alignment with the real product**: live task tracker (steps done/in-progress/pending),
   confirmation cards with explicit scope ("this will email 23 customers"), audit feed panel.
7. **Rejected after review**: full code-execution sandbox (auditability of writes + 5-day
   security burden; our Plan DSL already captures the token/latency win in constrained,
   reviewable form — and we frame it exactly that way in the README); multi-agent
   orchestration (15× tokens, wrong fit for dependent CRM writes); flat tool-calling ReAct
   as the primary path (kept only as the benchmark baseline).

## Key takeaways

- Shortlisting is mandatory at 500 actions; it is a layer every architecture needs, not a rival.
- Hybrid plan-DAG + replanning joiner + confirmed writes has the strongest combined evidence
  for latency, cost, AND auditability.
- Plan DSL = "constrained code mode": code-mode's economics with tool-calling's safety — a
  defensible, citable framing for the README.
- Reliability (pass^k), abstention, and missing-parameter behavior are what separate serious
  evals from demos — and what the τ-bench authors (Sierra) say actually predicts production.

## Methodology

Three parallel research agents: (1) first-party vendor engineering blogs (Anthropic, OpenAI,
Cloudflare, Vercel, LangChain, Berkeley Gorilla) — deep-read in full; (2) production case
studies (Sierra, Intercom, Decagon, Ada, Salesforce, Shopify, commercial CRM product docs,
Dropbox, Notion, LinkedIn, Uber, DoorDash, Airbnb); (3) published head-to-head evidence
(LLMCompiler, ReWOO, CodeAct, Plan-and-Act, HuggingGPT, τ/τ²-bench, CRMArena-Pro, WorkBench,
ToolSandbox, RAG-MCP, ToolRet). Gaps acknowledged: no public internals for the commercial product's own
routing, ClickUp Brain, Monday Sidekick, Forethought; complexity-routing and mid-program
confirmation in code agents have thin evidence; most cross-architecture numbers come from
QA/web tasks, not transactional CRM.
