# Tool-Calling Loop Architectures in Open-Source Agent Frameworks (Nov 2026)

Research agent report, 2026-11-06, from current main-branch source files and official docs. **[source]** = observed in code, **[docs]** = official docs/blog, **[inference]** = inference.

## 1. Per-framework summary table

| Framework | Loop mechanism | Tool results fed back as | Step budget (default) | Dynamic subsets | HITL gate | Stuck/loop safety |
|---|---|---|---|---|---|---|
| OpenAI Agents SDK | Native FC; schemas auto-generated from fn signatures [docs] | Run items appended, loop re-runs [docs] | `DEFAULT_MAX_TURNS = 10`, `MaxTurnsExceeded` [source] | `is_enabled` per tool; handoffs-as-tools; `as_tool()` [docs] | `needs_approval` → `NextStepInterruption`; serializable `RunState` [docs/source] | max_turns + guardrails only [inference] |
| Vercel AI SDK v5/v6 | Native FC; Zod/JSON `inputSchema` validates calls [docs] | Prior steps' tool calls/results in messages [docs] | `generateText`: 1 step; `ToolLoopAgent`: 20 [docs] | `activeTools` + `prepareStep` per step [docs] | v6 `toolApproval`, `addToolApprovalResponse`, replay history [docs] | `stopWhen` predicates (count/cost/custom); `repairToolCall` [docs] |
| LangGraph `create_react_agent` | Native FC via `bind_tools` [source] | `ToolMessage` (parallel execution) [source] | `recursion_limit` + `remaining_steps` [docs/source] | `langgraph-bigtool`: `retrieve_tools` tool + store, then native binding [docs] | `interrupt()` + `Command(resume=…)`; node re-runs from top [docs] | Error-as-`ToolMessage` ("Please fix your mistakes."); no repeat detection [source] |
| smolagents | ToolCallingAgent: native tool_calls (text-parse fallback); CodeAgent: generated Python [source] | Observations on memory steps [source] | `max_steps = 20`; then forced `provide_final_answer` [source] | None built in [inference] | None built in; `UserInputTool` is blocking `input()` [source] | `AgentError` recorded, loop continues; budget only [source] |
| Claude Agent SDK | Native Anthropic tool use (the Claude Code loop) [docs] | Native `tool_result` blocks [docs] | `maxTurns` (0 = unlimited); auto-compaction [docs] | Tool Search Tool / deferred loading [docs] | permission chain → `canUseTool` callback; gate is **pre-execution** [docs] | Compaction; deny-message fed back as tool result [docs] |
| goose (Block) | Native FC state machine (Rust); "toolshim" text-parse mode for weak local models [source/docs] | `ToolResponse` messages [source] | `GOOSE_MAX_TURNS` default 1000 (subagents 25); turn-budget hint at 50% [source/docs] | Vector/LLM tool router **removed** after failures [source/issues] | Modes auto/approve/smart_approve/chat; persisted allowlist; stale approvals expire [source] | Parse errors fed back ("Correct the arguments and try again."); `ops_exit_on_error` [source] |
| OpenHands | Native FC (since CodeAct 2.1); `NonNativeToolCallingMixin` regex fallback [source/paper] | Observation events → tool messages [source] | `max_iterations` 100 (app) / 500 (SDK); `$` budget [docs] | None — small fixed tool set [inference] | `SecurityAnalyzer` risk rating + `WAITING_FOR_CONFIRMATION` pre-execution pause [paper/source] | **`StuckDetector`** — see §5 [source] |

## 2. Core loop shape — the universal pattern

Every framework surveyed implements the same skeleton: **send native per-tool JSON schemas to the provider's function-calling API; execute returned tool calls; append results as provider-native tool-result messages; repeat until the model emits text with no tool calls.**

- OpenAI Agents SDK docs: "If the LLM produces tool calls, we run those tool calls, append the results, and re-run the loop" (https://openai.github.io/openai-agents-python/running_agents/). Loop is `while True:` in `src/agents/run.py` [source].
- Vercel: tools carry `inputSchema` that "is consumed by the LLM, and also used to validate the LLM tool calls" (https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) [docs].
- LangGraph: `model.bind_tools(…)`; two-node agent/tools graph; routes to END when the last `AIMessage` has no `tool_calls` [source].
- smolagents is the deliberate exception: `CodeAgent` generates Python executed in a sandbox, justified by CodeAct (https://huggingface.co/papers/2402.01030); but even its `ToolCallingAgent` reads native `tool_calls` first [source].
- goose and OpenHands both treat text-parsed tool calls as an explicit **degraded mode for models lacking native FC**: goose's toolshim benchmark found non-native models "often fail to invoke tools at appropriate times or produce malformed or inconsistently formatted tool calls" (https://block.github.io/goose/docs/guides/tool-shim/) [docs]; OpenHands moved **to** native FC in CodeAct 2.1 because structured calls "got the agent stuck in loops less often" (https://arxiv.org/html/2511.03690v1) [paper].

**Clarifying questions and refusals:** in six of seven frameworks there is no special channel — a text-only assistant turn ends the loop. Exceptions: Claude Agent SDK's first-class `AskUserQuestion` tool (https://code.claude.com/docs/en/agent-sdk/user-input) [docs]; smolagents' blocking `UserInputTool` + mandatory `final_answer` tool [source].

## 3. Meta-dispatch vs native schemas

**No surveyed framework uses a single generic dispatch tool as the model-facing interface.** The closest patterns converge on "discover, then call natively":

- **Anthropic Tool Search Tool** (Nov 2025): `defer_loading: true` tools are absent from context; search returns references "expanded into full definitions in Claude's context," then called natively. Measured: "Opus 4 improved from 49% to 74%"; Opus 4.5 79.5% → 88.1%; context from ~77K tokens to ~8.7K (−85%) (https://www.anthropic.com/engineering/advanced-tool-use) [docs]. Threshold guidance: above ~10 tools / >10K tokens of definitions [docs].
- **Uber's Omni MCP gateway** (800+ servers, 5,000+ tools) ships `discover_server`/`discover_tools`/`invoke_tool` meta-tools — but the agent "retrieve[s] individual schemas" **before** invoking; the schema is in context at call time (https://www.infoq.com/news/2026/11/uber-mcp-gateway-ai-agents/) [docs].
- MCP gateways (Arcade, Speakeasy/Gram `search_tools → describe_tools → execute_tool`) use the stable-dispatch shape for **transport/governance and KV-cache stability**, still surfacing schemas before execution [docs]. StackOne: with aggressive compression "the model has to guess" [docs].

**On params as a JSON-encoded string:** no published 2025–2026 benchmark directly measures `call_action(slug, paramsJson)` vs retrieved native schemas [inference from absence]. Indirect evidence is convergent:

- Aider's code-in-JSON benchmark: "all of the models did worse… when asked to return code in a structured JSON response"; more syntax errors when wrapping in JSON (https://aider.chat/2024/08/14/code-in-json.html) [docs] — same escaping surface as a `paramsJson` string.
- Stringified/double-encoded JSON args are an active failure class: vLLM double-encoding fix (vllm#54964), opencode nested-object-as-string Zod failures (#7512), goose unescaped control chars (#2892), Vercel escaped-quote failures (ai#11719) [source/issues].
- BFCL complicates "native always wins": results are model-dependent; some models score better in prompt mode (https://gorilla.cs.berkeley.edu/leaderboard.html) [docs].
- What JSON-blob-in-text forfeits regardless: provider-side schema validation/constrained decoding, and framework repair loops (Vercel `repairToolCall` on `InvalidToolInputError`; LangGraph's validation-error feedback) [docs/source].

## 4. Dynamic tool subsets from a large catalog

1. **Per-step masking of a static typed catalog** — Vercel `activeTools` via `prepareStep`; OpenAI `is_enabled` ("Disabled tools are completely hidden from the LLM at runtime") [docs].
2. **Retrieval-as-a-tool** — `langgraph-bigtool`: agent calls `retrieve_tools` backed by an embedding store; retrieved tool IDs are then bound natively (https://github.com/langchain-ai/langgraph-bigtool) [docs]. Anthropic Tool Search is the platform-grade version [docs].
3. **Routing by sub-agent** — OpenAI handoffs ("transfer_to_refund_agent") [docs].
4. **Masking, not removal** — Manus: changing tool definitions mid-loop "will invalidate the KV-cache" and leaves orphaned references → "schema violations or hallucinated actions"; mask logits with consistent prefixes instead (https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) [docs].
5. **The deletion:** goose shipped vector/LLM tool-selection routers and **removed them** after reliability failures (goose#3027, #3730) [source/issues].

Catalog-size evidence: RAG-MCP: 13.6% selection accuracy with full catalog vs ~43% with retrieval subsetting (arXiv 2505.03275); 2026 writeups: 84–95% at ~50 tools → 0–20% at ~740; practical safe zone ~10–40 tools in context [docs]. **Consensus for ~500 tools [inference]:** nobody puts all schemas in context; the dominant pattern is a stable retrieval/search tool returning a 10–40-tool shortlist called natively with full schemas.

## 5. HITL gates and idempotency

- **Pre-execution pause (no double-execution window):** Claude Agent SDK (`canUseTool` before execution; deny message returned as tool result), OpenHands (`WAITING_FOR_CONFIRMATION` + risk rating), goose (`ApprovalDecision::{Allow,Deny,Ask}`; **stale approvals produce `EXPIRED_APPROVAL_RESPONSE` instead of executing**) [source/docs].
- **Suspend-and-replay (idempotency pushed to app):** LangGraph `interrupt()` — "the runtime restarts the entire node from the beginning… any code that ran before the interrupt will execute again" (https://docs.langchain.com/oss/python/langgraph/interrupts) [docs]. OpenAI Agents SDK: "Approval permits a tool call to execute; it does not guarantee exactly-once execution… the application should assign a stable idempotency key" (https://openai.github.io/openai-agents-python/human_in_the_loop/) [docs]. Vercel v6 resumes by replaying message history; open resume bug (ai#10196).

## 6. Error feedback and loop safety

- **Error-as-observation is universal:** LangGraph `ToolMessage(status="error")` + "Please fix your mistakes."; OpenAI `default_tool_error_function`; Vercel `tool-error` parts; goose "Correct the arguments and try again."; smolagents records `AgentError` and continues [source/docs].
- **Budgets:** OpenAI 10 turns; Vercel 20 for ToolLoopAgent + `stopWhen` incl. cost caps; LangGraph `remaining_steps`; smolagents forces final answer at 20; goose 1000 + mid-budget hint; OpenHands 100/500 + dollar budgets.
- **Stuck detection exists in exactly one framework:** OpenHands' `StuckDetector` (on by default): repeating action-observation cycles (threshold 4), action-error cycles (3), agent monologue (3), alternating patterns — over the last 20 events, compared semantically ignoring IDs (https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py) [source].

## 7. Implications for a 500-action CRM agent (neutral findings)

1. The prototype's single `call_action` + `paramsJson` shape matches no surveyed framework's model-facing interface. Where dispatch meta-tools exist, the per-action schema is retrieved into context before invocation.
2. JSON-blob-in-text without native FC forfeits schema-validated repair loops and sits on a documented failure class; direct benchmarks absent, indirect evidence one-directional, BFCL caveat noted.
3. For 500 actions: retrieval → shortlist of 10–40 → native schemas, retrieval tool kept stable for KV-cache.
4. Loops feed real tool results back so the final answer is grounded in observations; error-as-observation replaces ref-grammar repair loops [inference].
5. Pre-execution gates avoid double-execution by construction; suspend-and-replay designs delegate exactly-once to app-level idempotency keys.
6. Loop safety floor: max-step budget + errors-fed-back; OpenHands' StuckDetector thresholds are a concrete, copyable spec.
