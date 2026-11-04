# Full-Agent Machinery in OSS Agents: Skills, Tools, Context, Subagents, Memory

*Generated: 2026-11-04 · Sources: ~40 (repo source reads, official docs, engineering blogs,
papers) · Round 3 of research for the Ask AI assignment*

## Executive Summary

We studied how OpenClaw, Claude Code, goose, OpenHands, smolagents, Aider, Manus, Cline/Roo,
Letta/MemGPT, Mem0, Zep/Graphiti, Agent Zero, and AutoGen implement skills, tool registries,
context management, subagents, and memory. Three findings change or sharpen our design:
(1) **per-turn LLM/vector tool-routing died in production** (goose built it twice, deleted it
twice) — but our design avoids the failure modes because retrieval is synchronous and local,
and the shortlist is injected as text, not swapped native schemas; (2) the follow-up problem
is a **structured working-memory problem** with a well-documented solution (typed task
frames + provenance-carrying result refs), not a vector-memory problem; (3) **skills as
SKILL.md playbooks** (~24–100 tokens each, progressive disclosure) are the standard pattern
for procedural knowledge — and a commercial CRM's Ask-AI product ships "Skills," making them a
high-value, low-cost differentiator for us.

## 1. Tool selection at 500 actions — reconciling four camps

| Camp | Mechanism | Verdict for us |
|---|---|---|
| Manus | "Mask, don't remove": ~20 stable meta-tools + logit masking; they tried RAG-style dynamic tool loading and **rejected it** (cache busting, hallucinated removed tools) | Their failure mode doesn't apply to us: we never swap native tool schemas. System prompt + tool defs stay byte-stable; the shortlist rides as *text cards in the user message*. Their cache rules (append-only, sorted JSON keys, no timestamps in prefix) we adopt wholesale. |
| goose | Built vector router (May 2025), deleted (Aug 2025); built LLM router, deleted (Dec 2025) — "painfully slow"; guidance: <25 active tools | The deleted versions were an **extra LLM hop** or buggy embedding index. Even goose's own post-mortem endorses "cheap synchronous lexical+embedding filter feeding a deferred-schema catalog" — which is exactly our design. |
| Claude Code / Anthropic / OpenAI | Deferred schemas + ToolSearch meta-tool; names-only in context (~24 tokens/tool), full schema on demand | Matches our `search_more_actions` escape hatch. Adopt the degradation ladder (shorten → drop descriptions → truncate with warning). |
| Aider repo-map | Deterministic graph ranking: tree-sitter tags + personalized PageRank seeded by chat mentions, **no embeddings, no LLM call**, binary-search to token budget | Strong inspiration: add graph signals to our retrieval — boost actions used this session (×50-style weight), sibling/module expansion, entity-type links. 500 nodes = sub-ms PageRank. Lexical-first; embeddings as a measured add-on, not a default assumption. |

**Resolved design**: stable system prompt + stable meta-tool definitions (cache-safe);
synchronous local retrieval (BM25 + action-graph ranking, embeddings only if probe-set recall
demands it) → top ~20 action cards as text in the planner message → planner may call
`search_more_actions` (max 2). This position is defensible against every documented failure.

## 2. Working memory for follow-ups (the biggest design upgrade)

Convergent published pattern (IDSS arxiv 2608.15755, structured-scratchpad, Waxell ref-handles,
Letta blocks):

- **Typed working-state object beside the transcript**, re-injected each turn: task frames
  `{intent, status: active|pending|completed, filters, result_ref, missing_params}` — a small
  stack, so topic switches suspend rather than clobber ("go back to those leads from before").
- **Provenance rule**: every stored value carries `{value, source: action_slug, step}`;
  **writes read entity IDs only from this state, never from transcript prose** — the
  hallucination firewall for 500 actions.
- **Reference handles**: full result sets cached server-side keyed by step; context carries
  `$ref` + count + first ~20 rows. "Make those 200 due tomorrow" never round-trips 200 records
  through the model. (Extends our Plan DSL's `$s1.x` refs across turns.)
- **Observation masking** beats LLM summarization in controlled tests (JetBrains "Complexity
  Trap": masking matched/beat summaries in 4/5 configs at −50% cost; OpenHands full-run:
  condenser cost MORE overall due to cache misses). For our session lengths: mask old tool
  results with one-line placeholders, keep last ~3 turns verbatim, no LLM summarizer needed.
- Memory-vendor accuracy claims (Mem0 vs Zep vs Letta) are mutually unreproducible — Letta's
  file-plus-grep agent beat Mem0's graph variant on Mem0's own benchmark. Build nothing on
  those numbers; eval follow-ups ourselves (we already planned multi-turn scenarios).

## 3. Skills → Playbooks (new scope item)

- Agent Skills spec: SKILL.md, frontmatter name (≤64 chars) + description (≤1024), three
  disclosure levels (~100 tokens always-loaded → <5k-token body on activation → unbounded files).
- OpenClaw: ~24 tokens/skill in prompt, 150-skill/18k-char budget with graceful degradation;
  lexical FTS search beyond budget. Claude Code: same shape; skills ARE slash commands.
- **the commercial product has "Skills"** (user-defined markdown instruction sets, invoked
  by matching or /name, plus Triggers). Grader-visible feature.
- For us: 5–8 playbooks (e.g. `lead-follow-up-sweep`, `overdue-invoice-reminders`,
  `pipeline-review`) with name+description always in the planner context; body (recommended
  action sequence, edge cases, confirmation points) loaded when retrieval or the planner
  matches one. Directly powers the *indirect* request category ("help me stay on top of
  leads" → matches the playbook, plan follows its procedure). Cheap (~½ day), visibly "full
  agent," and grounded in the open spec.

## 4. Subagents — honest scoping

- Evidence against default multi-agent: ~15× tokens (Anthropic), goose deleted lead/worker,
  Cognition "don't build multi-agents," Manus fresh-context subagents only for parallel
  *read* fan-out; OpenClaw/Claude Code both restrict children (no messaging, report-only
  return, injection-scanned).
- Where they help us: nothing in the 8 graded categories needs one; latency/cost grading
  punishes them. **Scope**: implement the *pattern* in its minimal useful form — a read-only
  "research" sub-run with isolated context and structured report (smolagents contract:
  short outcome / detailed outcome / context-even-on-failure) usable by the planner for heavy
  analytical asks; document the full design as the scaling path in the README. Do last; cut
  first if time slips.

## 5. Context/infrastructure patterns adopted (from the ranked lists)

1. KV-cache-first prompt assembly: stable prefix, append-only, sorted JSON keys,
   date/time outside the system prompt (OpenClaw measured; Manus: 10× price lever).
2. Event-sourced conversation log: append-only typed events (user msg, plan, step start/end,
   confirmation, replan), state = fold(events) — gives resume, audit feed, and the
   **execution traces the assignment explicitly requires as a deliverable** (OpenHands).
3. Stuck detection, nudge-then-stop: same action+error ×3 → corrective hint; ×4 → stop and
   ask; window resets per user message (OpenHands, ~150 lines).
4. Keep errors in context + max 3 repair reflections (Manus/Aider/smolagents).
5. Idempotency keys on all mutating handlers; persist-before-ack; serialized turns per
   session (OpenClaw gateway).
6. Spill-to-ref for oversized results, 25k-token handler output cap (Claude Code/Anthropic).
7. Plan recitation kept compact — Manus found full todo rewrites wasted ~30% of tokens; our
   task-tracker SSE events give the UX benefit without re-prompting cost.
8. Guardrails are code, not prompts: per-risk-class gates; "deny = schema not sent";
   confirmation bound to plan hash (already in design; now with three independent
   corroborations — Claude Code hooks, goose modes, OpenClaw tool policy).

## 6. What we're explicitly NOT adopting (and can defend in the README)

- Per-turn LLM routing call (goose's double deletion is the definitive evidence).
- LLM summarization condenser (masking wins at our horizon; cache-miss cost).
- Full code-execution sandbox (CodeAct's +20pts is for composition — our Plan DSL captures
  that in constrained form; sandbox security burden documented by CE-MCP attacks).
- Vector memory products (unreproducible benchmark wars; working-state layer solves our
  actual problem).
- Multi-agent orchestration as the core loop (15× tokens; CRM write dependencies).

## Sources (key)

OpenClaw docs (skills/memory/compaction/subagents/system-prompt) · Claude Code docs + minusx
& Southbridge analyses · Agent Skills spec (agentskills.io) · goose PRs #2654/#3933/#6250/#7989 ·
OpenHands condenser code + arxiv 2511.03690 · JetBrains "Complexity Trap" arxiv 2508.21433 ·
smolagents source + open-deep-research blog · Aider repo-map/udiff/architect posts · Manus
context-engineering blog + Dec 2025 revisions · Cline ContextManager.ts · Letta/MemGPT
arxiv 2310.08560 + memory-blocks docs + sleep-time arxiv 2504.13171 · Mem0 arxiv 2504.19413 +
Zep rebuttal + LoCoMo audit · Zep/Graphiti arxiv 2501.13956 · Anthropic context-engineering +
context-editing (+39%/−84% numbers) · IDSS arxiv 2608.15755 · Agent Zero/AutoGen docs.
