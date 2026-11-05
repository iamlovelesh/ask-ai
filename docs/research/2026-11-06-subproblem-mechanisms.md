# Mechanism research: four sub-problems of a reliable tool-using CRM agent

Research agent report, 2026-11-06. **[obs]** = directly observed in a primary source; **[inf]** = inference/synthesis.

## 1. Computation over large result sets

### a) Code execution

- **smolagents / CodeAct:** code actions deliver ~30% fewer steps and up to ~20% higher success than JSON tool calls (arXiv 2402.01030; https://huggingface.co/learn/agents-course/en/unit2/smolagents/code_agents) **[obs]**.
- **Anthropic Programmatic Tool Calling (PTC):** model writes Python in a sandbox; tools invoked from code; intermediate results stay out of model context. ~37% token reduction on complex multi-tool tasks; 24% fewer input tokens with ~11% accuracy improvement in related benchmarks; up to 98.7% reduction for pipeline workflows (https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) **[obs — vendor numbers]**.
- **Cloudflare Code Mode:** MCP schemas → TypeScript API in isolated sandbox; whole Cloudflare API (2,500+ endpoints) in ~1,000 tokens (https://blog.cloudflare.com/code-mode) **[obs]**.
- **Uber:** "code-mode" escape hatch for heaviest cases; >50% token reduction even on small result sets (https://www.uber.com/us/en/blog/efficient-software-factory/) **[obs]**.
- **Safety with confirmation gates:** PTC tools carry `allowed_callers`; tools not opted into code execution still surface as individual `tool_use` blocks (code execution **pauses** for client-side approval). Docs warn "only opt in tools that are safe for programmatic/repeated execution" **[obs]**. 2026 production stance: **code execution for reads/aggregation, direct gated tool calls for writes** **[inf, strongly supported]**. Cost: sandbox + audit trail becomes "a script ran" unless every in-sandbox invocation is logged.

### b) Query-shaped tools (text-to-SQL)

Raw text-to-SQL unreliable; **semantic-layer-constrained SQL works**: Cortex Analyst ~78% with semantic model vs ~57% without, same LLM (https://atlan.com/know/snowflake/cortex-analyst-vs-text-to-sql/) **[obs — vendor numbers]**; "modeling the semantic layer, not the vendor, is what moves accuracy" (https://arxiv.org/pdf/2604.25149) **[obs]**. Guardrails: read-only connection, allowlisted views, row limits, SQL shown in trace **[inf]**.

### c) Deterministic server-side helpers / result handles

MCP spec 2025-06-18 added **ResourceLink** (URI handles instead of embedded payloads); "dual response" pattern — handle + small sample + summary stats, server-side transforms taking the handle as input (https://arxiv.org/html/2510.05968v1, https://microsoft.github.io/mcscatblog/posts/mcp-resources-as-tool-inputs/) **[obs]**. FastMCP recommends a visible handle the model passes back (https://gofastmcp.com/servers/tools) **[obs]**. Claude Code's microcompaction (tool results to disk, reference in context) is the client-side version **[obs, secondary]**.

**Standard in 2026:** code execution over a result handle is the convergent pattern (Anthropic, Cloudflare, Uber, smolagents). Helper-endpoint menus exist mainly in MCP server design guides — they cap expressiveness **[inf]**. Query tools win where a semantic layer exists.

## 2. Date/time handling

- **Failure data:** PRIMETIME (arXiv 2504.16155): datetime parsing and *arithmetic* individually unreliable; wrong-direction relative offsets, memorized day counts, next-weekday errors **[obs]**. Epoch-ms is the worst case: 13-digit arithmetic that tokenizes badly **[inf]**.
- **Mitigation #1 — inject resolved "now":** Claude Code injects current date into env/context **[obs]**; ChatGPT system prompt carries `Current date:` **[obs]**; derived anchors (start-of-week, 30-days-ago as ISO) are a documented agent pattern **[obs, secondary]**.
- **Mitigation #2 — never let the model emit epoch; resolve server-side:** `"format": "date"`/`"date-time"` ISO-8601 parameters (https://devblogs.microsoft.com/agent-framework/diving-into-function-calling-and-its-json-schema-in-semantic-kernel-python/, AWS Q schema best practices) **[obs]**. Stronger: accept natural-language relatives resolved server-side with deterministic parsers (Duckling, chrono-node) **[obs for libraries]**.
- **Consensus:** inject ISO "now" + anchors, ISO-8601-only parameters, server resolves relatives, **server echoes the resolved absolute range back in the tool result** so the model can confirm it to the user **[inf, synthesis]**.

## 3. Multi-turn context continuity

- **CLIs:** Claude Code, Codex CLI, OpenCode keep the **verbatim transcript**, intervening only under pressure — microcompaction (offload bulky *tool results*, keep references) then auto-compaction near the limit **[obs, secondary]**. User/assistant turns preserved verbatim far longer than tool outputs — which is where "the oldest one" scope lives.
- **Complexity Trap (arXiv 2508.21433, JetBrains/NeurIPS 2025):** observation masking (hide tool outputs older than last ~4) halves cost while matching/beating LLM summarization **[obs]**.
- **OpenHands:** condenser default, but SDK preserves the full event log; 2026 pain around condenser fallback (software-agent-sdk#6048) **[obs]**.
- **2026 study (arXiv 2605.18854):** of 8 condensation strategies, **ObservationMasking the only net-positive** (+8.6% savings, 100% completion); LLM summarization added 23.6–93.9% overhead with no significant quality gain **[obs]**.
- **Implication:** "lost filter scope" is a state problem, not a compression problem. Keep conversational turns verbatim; mask old tool outputs; make scope explicit and durable (resolved filters + result handle echoed into the transcript) so follow-ups resolve against an artifact **[inf, synthesis]**.

## 4. Answer faithfulness

- **Trace-in-context is necessary but insufficient:** "hallucinated correctness" documented — LLM judges scored a plausible answer >0.85 when the trace showed no retrieval (arXiv 2606.04990, 2605.24219) **[obs]**.
- **Production grounding check:** Salesforce Atlas runs a grounding check before every response — answer grounded in retrieved data, in-scope, free of unverified claims; on failure retries then refuses (https://help.salesforce.com/s/articleView?id=005134880) **[obs]**.
- **Deterministic checks beat LLM-as-judge where state is checkable:** GroundEval (arXiv 2606.22737) **[obs]**. Fabrication-after-tool-failure: explicit `retrieval_status: OK|FAILED` cut dishonesty 14.10% → 0.87% (arXiv 2609.14758) **[obs]**.
- **Honest DENIED reporting:** Claude Code injects the denial *as the tool result* ("User denied this action") so refusal is in-trace and the model cannot claim success without contradicting its own context (https://code.claude.com/docs/en/agent-sdk/user-input) **[obs]**.

## Mechanism recommendations with confidence levels

1. **Large-result computation:** dominant = result handle + sandboxed code execution for reads, writes excluded and directly gated — *high confidence*. Runner-up, and the ship-first choice for a 500-action SQLite catalog: a small fixed set of deterministic server-side transforms (`aggregate(handle, op, field)`, `sort(handle, field, dir, limit)`) — *medium-high* **[inf]**. Text-to-SQL only with a semantic layer.
2. **Dates:** inject ISO "now" + anchors, ISO-8601-only schema fields, ban epoch params, resolve relatives server-side, echo resolved range back — *high confidence*, near-universal.
3. **Continuity:** verbatim user/assistant turns + observation-masking of stale tool outputs (keep last ~4), never summarize until forced — *high confidence*; plus a structured "active scope" artifact — *medium-high, inference*.
4. **Faithfulness:** execution-ledger-grounded composition + cheap post-hoc grounding check (Atlas pattern), denials injected as explicit tool results — *medium-high*. Prefer deterministic ledger checks for countable claims (records written, actions denied, totals); trace-aware LLM-judge only for non-countable claims.
