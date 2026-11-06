# How production OSS CRMs/ERPs build their AI agents — survey & synthesis

Date: 2026-11-06. Source-level review (actual GitHub source, cited in the three underlying reports) of: **an OSS CRM, NocoBase, Frappe/ERPNext ecosystem (Raven, Frappe Flow, MCP servers, Assistant Core), Krayin, Chatwoot Captain, Huly, Odoo 19 (OEE), Budibase, EspoCRM**. Full per-product details live in the research agents' reports (summarized here); this file is the decision synthesis.

## 1. The landscape in one table

| Product | Agent? | Loop | Tool origin | Writes | Approval | Standout rail |
|---|---|---|---|---|---|---|
| the OSS reference CRM | Yes (strongest) | Vercel AI SDK, 300 steps | **Generated from object metadata** (11 CRUD ops/object) + catalog-in-prompt + `learn_tools`/`execute_tool` meta-tools | Direct, permission-pruned schemas, actor-attributed | `propose_tool_call` pausing tool with **snapshot + re-read conflict check**, field-scoped edits | 16KB output spill-to-file + navigation tools; `[[record:uuid]]` citation tokens |
| NocoBase | Yes | LangChain/LangGraph, 200 | Hand-registered + **workflows-as-tools** + skill groups unlocked at runtime | **No free CRUD** — UI form-fill (user submits), admin workflows | LangGraph interrupts (approve/reject/edit) | Tool-result integrity middleware; frontend tools never submit |
| Frappe Flow (official) | Yes | native | **8 generic schema-discovery tools** | via DocType API, user perms | per-tool confirmation (claim) | discovery-first tool design |
| Raven (Frappe chat) | Yes | openai-agents SDK (max_turns 5) | admin-configured records → generic handlers | Frappe ORM as the messaging user | none (per-bot write flag) | savepoint/rollback dry-runs |
| Chatwoot Captain | Yes (best rails) | own gem / RubyLLM, 10–20 | hand-written + user HTTP tools | ActiveRecord, account+role scoped | **frozen-target approval cards** (IDs resolved at proposal, 500 cap, TTL) | **NumberCheck + LinkCheck** deterministic draft verifiers; saved result-sets; false-promise classifier |
| Odoo 19 (OEE) | Yes | hand-rolled, config caps 20×20 | admin-built server actions in topics | ORM with `sudo(False)` — requester's rights | none ("don't ask for confirmation"); chatter audit | **validate filters/group-bys vs live schema**; relative-date cheat-sheet; access-checked citations |
| Budibase | Yes | Vercel AI SDK, 30 steps + 1-step router | **generated per-table from schema** (zod) | requester-principal authz per call | **conditional escalation gate** (data-filter rules; pending → toolChoice none) | router→operation bundles; sticky session operation |
| Krayin | No (single-shot extraction) | — | — | via the human form pipeline; model never supplies IDs | human reviews pre-filled form | validate LLM output through the same form requests humans use |
| Huly | Thin (2 tools) | SDK default | hand-written | as bot account (weak) | none | (cautionary example: silent fallback on hallucinated id) |
| EspoCRM | No (paid, non-agentic) | — | — | — | — | — |

## 2. What the industry agrees on (and where we stand)

| Consensus pattern | Products | Our status |
|---|---|---|
| Native tool-calling loop with step caps | all agents | ✅ (same SDK as Raven) |
| Tools carry the REQUESTER's permissions; AccessErrors flow back as tool results | Odoo, Budibase, the OSS reference CRM, NocoBase, Raven, Chatwoot | ✅ (demo-user model; single-tenant) |
| Current date + timezone + user identity injected per turn; relative dates resolved deterministically | Odoo (cheat-sheet!), the OSS reference CRM, Chatwoot (run-pinned) | ✅ (anchors, weekday words, run-pinned clock) |
| Aggregation pushed server-side; model passes result-set references, never rows | Chatwoot saved sets, the OSS reference CRM `group_by_*` | ✅ (`data__*_ref` over handles) |
| IDs only from tool output / verified principal; never user- or model-invented | Chatwoot, the OSS reference CRM | ✅ (provenance firewall) |
| Byte-budgeted, never-mid-token tool output with explicit "more exists" + escape hatch | the OSS reference CRM (spill+nav tools), NocoBase (envelope), Budibase | ✅ (row-aware truncation + refs) |
| Graceful loop exhaustion (final no-tool call / honest summary) | Chatwoot, NocoBase | ✅ (maxTurns handler + disclosure) |
| Human approval for risky writes, exact-target freezing | Chatwoot, the OSS reference CRM, Budibase, NocoBase | ◐ gate exists; **no snapshot-and-recheck** |
| Model-facing tool surface is SMALL: generated families / catalog + on-demand schemas / operation routing | the OSS reference CRM, Budibase, Frappe Flow, NocoBase | ◐ retrieval shortlist + dynamic binding; **retrieval misses still possible** |
| Deterministic post-hoc draft verification (numbers/links vs tool outputs) | Chatwoot (NumberCheck/LinkCheck), Odoo (citation verify), Budibase (`report_used_sources`) | ❌ our grounding check only fires on zero-step turns |

**Conclusion:** our architecture is the industry architecture — nothing fundamental is wrong. Six human-test rounds rebuilt, via evidence, the same rail set the best OSS agents converged on. Three named gaps remain, each with a proven reference implementation.

## 3. The "fix properly" plan (adoption order)

**P1 — Catalog-in-prompt (pattern; kills the retrieval-miss class entirely).**
Embed the FULL action catalog as names + one-line descriptions in the system prompt (≈500 lines, prefix-cacheable), keep ~20 preloaded tools + our existing dynamic binding as the `learn_tools` equivalent. The model always KNOWS every capability; schemas load on demand. Effort: small (we have `catalog-summary.ts` from the baseline agent). Risk: +~6–8k cached prompt tokens.

**P2 — NumberCheck (Chatwoot's pattern; closes the fabrication family for ALL turns, not just zero-step ones).**
Deterministic post-answer verifier: extract every number/date from the draft; pass if present in (or derivable by sum/avg/percent/time-conversion from) this turn's tool outputs; on failure, one grounded re-run (we already have the forced-tool retry machinery). Model-free, cheap, catches sample-superlatives and cross-record contamination that prompt rules can't.

**P3 — Snapshot-and-recheck approvals (pattern; closes the gate-drift window).**
At `confirmation.required`, snapshot the targeted records' current values; after approval, re-read and refuse with `status: conflict` if they drifted. Freezes exactly what the human approved. Effort: moderate (gate path only).

**P4 (strategic, post-ship) — generated tool families.**
a common generate per-entity CRUD from metadata and prune per principal. Our 500-action catalog is the assignment's given domain layer, so this is a projection change, not a rewrite: derive the model-facing families from the catalog's own schemas. Biggest long-term simplification; not needed for ship.

## 4. What this closes, evidence-wise
- Retrieval miss / tool starvation (round-5 F31 family) → P1 structural.
- Fabricated numbers/dates on stepped turns (round-6 G1/F37/F34 residue) → P2 deterministic.
- Approve-then-drift (so far theoretical; the OSS reference CRM treats it as real) → P3.
