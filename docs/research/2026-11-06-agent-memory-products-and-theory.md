# Agent Memory in Shipping Products and the Academic Literature

Research synthesis, 2026-11-06. **[O]** = directly observed/stated in the cited source; **[I]** = inference. Every claim carries a URL. Primary sources preferred (official docs/help pages, arXiv, eng blogs). A few product rollout dates rely on reputable secondary tech reporting and are tagged.

Goal: inform the design of a generic **two-tier (per-user + per-session) memory layer for a CRM-style agent**. The six design dimensions tracked throughout: (1) scoping, (2) write/extraction, (3) consolidation/forgetting, (4) recall, (5) typing/taxonomy, (6) user control & privacy.

---

## Part A — Shipping products

### A0. The universal two-track pattern

Every consumer assistant separates **explicit/directive preferences** from **auto-extracted conversational memory**:

| Product | Explicit/directive track | Auto-extracted conversational track |
|---|---|---|
| ChatGPT | Custom Instructions | Saved memories + Reference chat history [O] ([help](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)) |
| Gemini | "Your instructions for Gemini" / Saved info | Memory of past chats ("Personal context") [O] ([support](https://support.google.com/gemini/answer/16598623?hl=en)) |
| Copilot | Custom Instructions | Copilot Memory [O] ([M365 blog](https://techcommunity.microsoft.com/blog/microsoft365insiderblog/unlock-the-power-of-personalization-copilot-memory-in-microsoft-365/4458242)) |
| Claude.ai | Project instructions / project knowledge | Memory "Topics" [O] ([support](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)) |
| Claude Code | CLAUDE.md (author-written) | Auto memory (Claude-written) [O] ([docs](https://code.claude.com/docs/en/memory)) |

**"Remember that…" works everywhere** — ChatGPT, Copilot, Claude all accept a conversational save command; Gemini routes explicit saves through an "Add" UI instead [O].

### A1. ChatGPT (OpenAI)

Sources: [Memory in ChatGPT (help)](https://help.openai.com/en/articles/8590148-memory-in-chatgpt), [Memory and new controls (blog)](https://openai.com/index/memory-and-new-controls-for-chatgpt/).

- **Two mechanisms.** "Saved memories" = "details that you explicitly ask ChatGPT to remember or that ChatGPT saves as useful context," stored as discrete, durable, editable items. "Reference chat history" = "insights ChatGPT gathers from past chats," a fluid model-managed summary that "can change as ChatGPT updates what is most useful to remember." [O]
- **(1) Scoping.** Cross-conversation, per-user: "memories evolve with your interactions and aren't linked to specific conversations. Deleting a chat doesn't erase its memories." Chat-history-derived memory has "no separate storage limit." Project-only memory isolates scope (regulated/Enterprise). [O]
- **(2) Write.** Both automatic and user-commanded: "ask it to remember something specific or let it pick up details itself." Closest thing to importance scoring: controls "can also include search, sorting, automatic prioritization, and version history" (plan-dependent) [O].
- **(3) Consolidation/forgetting.** "Improved Memory continually updates a broader summary of relevant context" (consolidating) vs legacy "explicit list of individual memory items." "Don't mention this again" reduces future references but "does not delete the original source." Deleted memories retained in logs up to 30 days [O].
- **(4) Recall.** Selective/retrieved: "Memory does not retain every detail… ChatGPT decides which available information is relevant to a response." A "Sources" affordance shows which memory/chat/instruction contributed [O].
- **(5) Typing.** Sources categorized (past chats, saved memories, custom instructions, saved files, connected apps). Custom Instructions explicitly distinguished from conversational memory [O].
- **(6) Control/privacy.** Settings → Personalization → Memory; Manage Memory to view/delete. Temporary Chat "do[es] not create or update memories." **Only vendor with an explicit behavioral carve-out**: "steer ChatGPT away from proactively remembering sensitive information, like your health details — unless you explicitly ask." In regulated/health workspaces "PHI should not be entered" and memory is off by default [O].
- **Rollout.** Tested Feb 2024; GA to Free/Plus/Team/Enterprise Sep 2024; chat-history reference Apr 2025; Free gets a "lightweight… short term continuity" version Jun 2025 [O].

### A2. Google Gemini

Sources: [personalization with memory](https://support.google.com/gemini/answer/16598469?hl=en), [personalization hub](https://support.google.com/gemini/answer/16598623?hl=en), [privacy hub](https://support.google.com/gemini/answer/13594961?hl=en), [Saved info](https://support.google.com/gemini?p=saved_info&hl=en), [rollout (9to5Google)](https://9to5google.com/2025/08/13/gemini-personal-context/).

- **(1) Scoping.** Cross-chat, durable: "Gemini can learn from your chats." Requires 18+, personal Google account, "Keep Activity on." Not available in Gems or Live [O].
- **(2) Write.** Past-chats Memory is auto-extraction with no per-item save UI; explicit saves go through the separate "Your instructions for Gemini" Add UI. No importance scoring documented [O/I].
- **(3) Consolidation/forgetting.** No dedup/merge/contradiction logic documented. Correction is conversational. **Deletion is indirect**: to forget a fact you "delete all chats with this info from Gemini Apps Activity" — no per-item delete [O].
- **(4) Recall.** Mechanism unstated; a "Did you use any info from past chats?" affordance implies selective use [O/I].
- **(5) Typing.** Implicit only (past chats vs instructions vs connected apps) [O/I].
- **(6) Control/privacy.** Menu → Personal Intelligence → Memory; Temporary Chat; memory import from other platforms. **No sensitive-category exclusion documented** — only feature-scope (Gems/Live) and account-type exclusions [O, absence].
- **Rollout.** "Personal context" + Temporary Chat Aug 13 2025, **on by default**; reportedly renamed "Memory" under "Personal Intelligence" ~Mar 2026 [O secondary].

### A3. Microsoft Copilot

Sources: [Introducing Copilot Memory](https://techcommunity.microsoft.com/blog/microsoft-copilot-blog/introducing-copilot-memory-a-more-productive-and-personalized-ai-for-the-way-you/4432059), [M365 Copilot Memory](https://techcommunity.microsoft.com/blog/microsoft365insiderblog/unlock-the-power-of-personalization-copilot-memory-in-microsoft-365/4458242).

- **(1) Scoping.** Cross-conversation per-user: remembers "preferences, working style, and recurring topics" over time [O].
- **(2) Write.** Auto-extraction ("I prefer Python for data science," "I'm working on Project Alpha") + explicit command. **Intent-gated importance filter**: "Copilot only saves information when there's a clear intent to remember" — "I prefer Python for all data science tasks" is saved; "Write Python code for k-means" is not [O].
- **(3) Consolidation/forgetting.** No dedup/contradiction logic documented; a "memory updated" signal appears on new logs; forget via natural language or settings [O].
- **(4) Recall.** Mechanism unstated [O/I].
- **(5) Typing.** Two explicit categories: Copilot Memory (auto facts) vs Custom Instructions (behavioral prefs) [O].
- **(6) Control/privacy.** "What do you know about me?" self-report; view/edit/delete in Settings → Personalization → Copilot Memory; memory citations to "see and delete personalization inputs." No category exclusion — sensitive content pushed to Temporary Chat. End-user + tenant-admin controls [O].
- **Rollout.** M365 Copilot (Enterprise license) GA Jul 2025, on by default Oct 2025; "not currently available for Agents" [O].

### A4. Anthropic Claude.ai + Projects

Sources: [Memory blog](https://claude.com/blog/memory), [chat search & memory (support)](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context), [What are projects?](https://support.claude.com/en/articles/9517075-what-are-projects).

- **(1) Scoping.** Per-user account memory **plus separate per-project memory**: "Claude creates a separate memory for each project." Inside a project Claude uses project memory + account memory "but not memory from other projects." Launched Team/Enterprise Sep 11 2025; Pro/Max Oct 23 2025 [O].
- **(2) Write.** Both: "Claude saves on its own, and you can also tell Claude to 'remember this.'" Saves "as a set of individual topics as you chat, rather than summarizing conversations after they end" [O].
- **(3) Consolidation/forgetting.** A user-editable **memory summary** "in one place for you to view and edit." Incognito chats excluded. No explicit dedup/decay/contradiction algorithm documented [O/I].
- **(4) Recall.** Framed as topics Claude pulls when relevant; exact always-in-context-vs-retrieved mechanics not published [I].
- **(5) Typing.** Organized as "Topics." For work targets "team's processes, client needs, project details, and priorities" [O].
- **(6) Control/privacy.** View/edit/delete per topic (Settings → Your Claude → Manage; or per-project Memory toggle). **Won't remember by default**: health, race, ethnicity, religion, politics, gender identity; **never** saves government IDs, criminal history, financial account numbers, immigration status. Opt-in "Include sensitive topics" toggle. Memory fully optional; enterprise admins can disable. Experimental import/export [O].
- **Projects RAG graduation.** Project knowledge is loaded into context directly, but "when your project knowledge approaches context limits, Claude seamlessly enables RAG mode to expand capacity by up to 10x" — an explicit always-in-context → retrieval graduation at the context ceiling [O].

### A5. Claude Code memory (this coding agent) — file-based pattern

Source: [How Claude remembers your project](https://code.claude.com/docs/en/memory). **Two complementary systems, both loaded at the start of every conversation**: author-written CLAUDE.md + Claude-written auto memory [O]. Local inspection of `~/.claude` on this machine corroborated the file layout (user-level `CLAUDE.md`/`AGENTS.md`/`rules/`; no project `CLAUDE.md` or `/memories` dir present here) [O, local].

**CLAUDE.md scopes (concatenated in load order, broadest → most specific — not overriding):** [O]

| Scope | Location | Shared with |
|---|---|---|
| Managed policy | `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS); `/etc/claude-code/CLAUDE.md` (Linux) | All users in org |
| User instructions | `~/.claude/CLAUDE.md` | You (all projects) |
| Project instructions | `./CLAUDE.md` or `./.claude/CLAUDE.md` | Team via source control |
| Local instructions | `./CLAUDE.local.md` (gitignored) | You (current project) |

- **Imports** via `@path` (relative/absolute), recursive up to 4 hops; external imports prompt a one-time approval. `AGENTS.md` read when no CLAUDE.md present. `.claude/rules/` holds topic files with YAML frontmatter `paths:` globs for **path-scoped** on-demand loading. Target <200 lines; files >4 MiB skipped [O].

**Auto memory — the file-with-frontmatter, categorized pattern:** [O]
- Claude-written; "decides what's worth remembering based on whether the information would be useful in a future conversation"; skips anything derivable from code/git or already in CLAUDE.md.
- **Four categories** (the `type` frontmatter field): `user` (role, expertise, working preferences), `feedback` (corrections you give / approaches you confirm), `project` (ongoing work, deadlines, decisions not derivable from code), `reference` (where to find external info — issue tracker, dashboard).
- Frontmatter also records `modified` (ISO-8601 write time).
- Storage: `~/.claude/projects/<project>/memory/` with a `MEMORY.md` index (one line per memory) + one topic file per memory (e.g. `user_role.md`, `feedback_testing.md`). Per-git-repo, machine-local, not shared across machines; subagents don't inherit it (except forks).
- **Recall is mixed**: CLAUDE.md ancestors + `MEMORY.md` (first 200 lines / 25 KB) + non-path-scoped rules are **always loaded** at session start; auto-memory **topic files**, path-scoped rules, and subdirectory CLAUDE.md are **retrieved on demand** via file tools.
- **Consolidation**: after each write, Claude Code checks `MEMORY.md` against 200-line/25 KB limits and is reminded to "keep one line per entry, move detail into topic files, and merge or drop stale entries"; over-limit content drops on next load. Memory files are excluded from the retention-cleanup sweep. CLAUDE.md conflicts are **not** auto-resolved ("Claude may pick one arbitrarily"); `/doctor prompt-audit` finds conflicts.
- **Control/privacy**: `/memory` lists files/toggles auto memory/opens the folder; `/context all` shows loaded memory; all files are plain markdown to read/edit/delete. Disable via `autoMemoryEnabled` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

### A6. Anthropic Memory Tool (API / Agent SDK)

Source: [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool). Status: stable.

- Tool config `{"type": "memory_20250818", "name": "memory"}`; **client-side / developer-controlled** — "Claude requests file operations, and your application runs them." The `/memories` path is a prefix your handler maps to real storage (per-user dir, DB keys). Available on all Claude 4+ models; ZDR/HIPAA-eligible since you control retention [O].
- **(1) Scoping.** Durable from first write; a later conversation continues when it sends the same `tools` entry and your handler serves the same store. Scope (per-user/project) is whatever the store implements [O].
- **(2) Write.** Automatic in-loop; the API auto-injects "IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE" with an "ASSUME INTERRUPTION" protocol; Claude decides what to persist; developers can constrain by topic [O].
- **(3) Consolidation/forgetting.** Pairs with **context editing** (clears tool results) and **compaction** (server-side summarization near the limit). Recommended safeguards: cap file/view sizes, "periodically delete memory files that haven't been accessed in a long time" [O].
- **(4) Recall.** Retrieved on demand via tool calls — "just-in-time context retrieval"; Claude `view`s `/memories` first, then reads relevant files [O].
- **(5) Typing.** No enforced categories; files arbitrary. A documented multi-session dev pattern uses progress-log + checklist + startup-reference as conventional roles [O].
- **(6) Operations / privacy.** Six commands on `/memories`: `view`, `create` (create/overwrite), `str_replace`, `insert`, `delete`, `rename` (cannot delete/rename the root). **Path-traversal protection required** (reject `../`, encoded variants; resolve canonical paths). "Claude usually refuses to write sensitive information to memory files," but developers should add validation [O].

---

## Part B — Academic literature

### B1. Cognitive-memory taxonomy: CoALA (Sumers/Yao et al. 2023)

Source: [CoALA (2309.02427)](https://arxiv.org/abs/2309.02427), [HTML v3](https://arxiv.org/html/2309.02427v3). The canonical port of Tulving's human-memory split onto LLM agents.

| Type | CoALA definition (agent context) | Maps to |
|---|---|---|
| **Working** | "active and readily available information… for the current decision cycle"; each LLM call builds its prompt from a subset, writes output back | In-context/session state [O] |
| **Episodic** | "experience from earlier decision cycles… history event flows, game trajectories" | Timestamped past events [O] |
| **Semantic** | "agent's knowledge about the world and itself"; often seeded from corpora | Decontextualized facts [O] |
| **Procedural** | "implicit knowledge stored in the LLM weights, and explicit knowledge written in the agent's code" | Reusable skills/routines [O] |

Two primitives: **retrieval = reading** LTM → working memory; **learning = writing** to LTM. CoALA supplies typing + the scoping axis (working = session vs the three long-term types) but no importance/decay formulas [O/I]. A later survey confirms CoALA is now "a default reference taxonomy," while newer work adds orthogonal axes — forms (token/parametric/latent), functions, dynamics [O] ([2505.00675](https://www.alphaxiv.org/abs/2505.00675)). Plain-language anchor: [types of AI agent memory](https://atlan.com/know/types-of-ai-agent-memory/) [O].

### B2. Survey: "A Survey on the Memory Mechanism of LLM-based Agents" (Zhang et al. 2024)

Source: [2404.13501](https://arxiv.org/abs/2404.13501), [HTML](https://arxiv.org/html/2404.13501). Organizes memory as **sources → forms → operations**:

- **Sources.** Inside-trial (within one interaction), cross-trial ("successful and failed actions and their insights" across attempts), external knowledge (APIs/tools) [O].
- **Forms.** Textual/non-parametric (complete / recent / retrieved interactions + external knowledge) vs parametric (fine-tuning or targeted memory-editing of weights) [O].
- **Operations.** **Writing** (project raw observations into "more informative and concise" content), **management** (merge redundant entries; reflect/summarize into "higher-level information"; forget "unimportant, early memories"), **reading** (retrieve by similarity between stored memory and next context) [O].
- **Short vs long** maps onto inside-trial vs cross-trial [O/I]. Retrieval abstracted from Park et al. as "similarity, time interval, and importance" (relevance/recency/importance) [O].

### B3. Generative Agents (Park et al. 2023) — the memory stream

Source: [2304.03442](https://arxiv.org/abs/2304.03442), [HTML v2](https://arxiv.org/html/2304.03442v2). Defined the recency+importance+relevance recall formula and reflection.

- **Memory stream** = time-indexed list of memory objects, each with a natural-language description, creation timestamp, most-recent-access timestamp. Element types: **observations** and **reflections** [O].
- **Retrieval score** = `α_recency·recency + α_importance·importance + α_relevance·relevance`, each term min-max normalized to [0,1]; **all α = 1** in their implementation [O].
  - **Recency** = exponential decay over sandbox hours since last retrieval, **decay factor 0.995** [O].
  - **Relevance** = cosine similarity of memory embedding vs query embedding [O].
  - **Importance** = LLM poignancy score assigned at write time. Exact prompt: rate "On the scale of 1 to 10, where 1 is purely mundane (e.g., brushing teeth…) and 10 is extremely poignant (e.g., a break up, college acceptance)." Groceries → 2; asking out a crush → 8 [O].
- **Reflection** = synthesized higher-level thoughts, stored back into the stream (enabling reflection trees). **Trigger**: "when the sum of the importance scores for the latest events… exceeds a threshold (150 in our implementation)" — roughly 2–3×/day. Mechanism: query the LLM with the 100 most recent records → generate salient high-level questions → retrieve → synthesize insights [O].
- No contradiction/dedup step; recency decay is the only (soft) forgetting pressure; nothing is hard-deleted [O/I].

### B4. MemGPT (Packer et al. 2023) — LLM as OS

Source: [2310.08560](https://arxiv.org/abs/2310.08560), [HTML v2](https://arxiv.org/html/2310.08560v2). OS-inspired tiered virtual context, self-edited via function calls.

- **Main context (in-context / "RAM")**: system instructions (read-only) + **working context** ("fixed-size read/write block… writeable only via MemGPT function calls" — facts, prefs, persona) + **FIFO queue** (rolling message history whose first slot holds "a recursive summary of messages… evicted") [O].
- **External context (out-of-context / "disk")**: **recall storage** (full message DB) + **archival storage** (arbitrary-length text with vector search) [O].
- **Self-editing / paging**: the LLM itself decides to move data between tiers via function calls [O].
- **Eviction/forgetting**: a queue manager fires a **warning** at ~70% of the window and a **flush** at 100%; on flush it evicts ~50% of messages and "generates a new recursive summary using the existing recursive summary and evicted messages." Evicted raw messages stay retrievable from recall storage — nothing truly forgotten [O].
- Scoping is explicit two-tier (main vs external); no importance score — eviction is FIFO+summary, not importance-ranked [O/I].

### B5. MemoryBank (Zhong et al. 2023) — Ebbinghaus decay

Source: [2305.10250](https://arxiv.org/abs/2305.10250), [PDF](https://arxiv.org/pdf/2305.10250).

- Stores three layers: raw conversation, LLM-summarized daily **event** summaries, and a running **user-personality** synthesis [O].
- **Forgetting curve**: retention `R = e^(−t/S)` (t = time since last use, S = strength). **S initialized to 1, incremented by 1 on each recall**, and recall resets the elapsed-time clock — spaced recall flattens future decay. Memories with `R < R_min` are dropped [O, formula via PDF + [forgetting curve](https://en.wikipedia.org/wiki/Forgetting_curve)]. Net: frequently recalled memories persist; untouched ones decay out — frequency+recency-weighted forgetting, not fixed TTL [I].
- No explicit contradiction operator; stale facts decay out rather than being merged/overwritten [I].

### B6. A-MEM (Xu et al. 2025) — Zettelkasten evolution

Source: [2502.12110](https://arxiv.org/abs/2502.12110), [review](https://www.themoonlight.io/en/review/a-mem-agentic-memory-for-llm-agents).

- Each new memory → structured **note** (content + LLM-generated contextual description, keywords, tags, timestamp) [O].
- **Link generation**: retrieve Top-k neighbors by cosine similarity, then an LLM decides which semantic links to create → an evolving memory graph (similarity gates candidates; LLM decides links) [O/I].
- **Memory evolution**: a new note can **trigger updates to existing notes' context/keywords/tags** — a merge/refine form of contradiction handling (update-in-place of metadata, not deletion) [O/I].

### B7. Reflection / self-consolidation

- **Reflexion** (Shinn et al. 2023, [2303.11366](https://arxiv.org/abs/2303.11366)): converts environmental feedback into "natural-language reflections stored in an explicit episodic memory" ("verbal reinforcement learning"); append-only lessons conditioning the next trial; no decay/dedup [O/I].
- **MemGPT recursive summarization** (B4) and **Generative Agents reflection** (B3) are the other two consolidation primitives. All three are append/compress-only — none has a contradiction operator [I].

### B8. Mem0 (Chhikara et al. 2025) — production extract+update with conflict resolution

Source: [2504.19413](https://arxiv.org/abs/2504.19413), [HTML](https://arxiv.org/html/2504.19413v1), [breakdown](https://memo.d.foundation/breakdown/mem0).

- **Two-phase pipeline.** **Extraction**: process the new message pair + a conversation summary + recent messages → candidate facts. **Update**: for each candidate, retrieve semantically similar existing memories, then an LLM picks one of **four operations — ADD / UPDATE / DELETE / NOOP** [O].
- This is **explicit LLM-based conflict resolution + dedup**: contradictions resolved by overwrite/delete, not append — distinct from MemoryBank (decay-out) and A-MEM (attribute rewrite). **Mem0g** graph variant adds conflict detection that marks old relationships obsolete [O/I].
- Results: on LOCOMO, **+26% relative** vs OpenAI memory (LLM-as-judge), **91% lower p95 latency** and **>90% token savings** vs full-context [O].

### B9. Contradiction handling — the three-way split [I]

| Strategy | Systems | Mechanism |
|---|---|---|
| **Decay-out** | MemoryBank | stale memory loses strength, pruned at R<R_min |
| **Attribute-rewrite / merge** | A-MEM, Mem0g | rewrite affected notes' context/tags; mark relations obsolete |
| **Explicit overwrite/delete** | Mem0 | LLM selects DELETE/UPDATE on conflict |

Pure reflection systems (Generative Agents, Reflexion, MemGPT summaries) are append/compress-only with **no** contradiction operator [I].

---

## Part C — Cross-cutting answers to the six dimensions

**(1) Scoping — session vs durable, and graduation.** Universal split: a **session/working tier** (in-context: MemGPT main context, CoALA working memory, the live conversation) vs a **durable per-user/per-project tier** (MemGPT external, episodic/semantic, product memory stores). Products graduate session→durable by (a) **explicit command** ("remember that…"), (b) **automatic salience judgment** (Copilot "clear intent to remember," Claude Code "useful in a future conversation," ChatGPT "useful context"), or (c) **context-pressure flush** (MemGPT eviction→summary, Projects→RAG at the ceiling). Per-project isolation is a recurring product requirement (Claude per-project memory, ChatGPT project-only memory) [O across cited sources].

**(2) Write/extraction + importance.** Three write paths coexist everywhere: automatic extraction, explicit UI save, user-commanded save. Importance scoring is rare in products (Copilot's binary "clear intent" gate is the main example) but central in theory — Generative Agents' **LLM poignancy 1–10 at ingestion** is the canonical mechanism; Mem0 instead extracts "salient facts" with no numeric score. Reflection passes (Generative Agents threshold 150; Reflexion verbal self-critique) synthesize higher-level memories from raw ones.

**(3) Consolidation/forgetting.** Four distinct mechanisms observed: **recency decay** (Generative Agents 0.995; MemoryBank Ebbinghaus R=e^(−t/S) with strength reinforcement), **summarization/compression** (MemGPT recursive summary, ChatGPT "broader summary," Claude memory summary), **merge/dedup** (survey "management"; A-MEM evolution; Mem0 UPDATE), and **explicit deletion** (Mem0 DELETE; "delete files not accessed in a long time"). Contradiction handling splits three ways (B9). Products largely punt on automatic contradiction resolution (Claude.ai, Gemini, Copilot document none); Mem0 is the clearest worked example.

**(4) Recall.** The theoretical gold standard is Generative Agents' **recency + importance + relevance** weighted, normalized sum. Products are **retrieved/selective** where documented (ChatGPT "decides which available information is relevant"; memory tool "just-in-time"); **always-in-context** for small pinned state (CLAUDE.md, MemGPT working context, MEMORY.md index). The dominant pattern is **hybrid**: a small always-loaded index/summary + larger on-demand retrieval, with graduation at the context ceiling (Projects RAG, Claude Code 200-line/25 KB index).

**(5) Typing/taxonomy.** Academia uses the clean CoALA four-way (working/episodic/semantic/procedural). Products mostly collapse to a **two-type** split — directive/preferences vs auto-extracted facts (A0) — except **Claude Code auto memory**, which ships a real four-category typing (`user` / `feedback` / `project` / `reference`) that maps loosely onto semantic(user/reference) + episodic(project) + procedural(feedback). Few products expose episodic-vs-semantic to users.

**(6) User control & privacy.** Baseline everywhere: view/edit/delete + a global off switch + an unpersonalized/temporary/incognito mode. Per-item deletion is standard except Gemini (delete source chats). **Sensitive-data posture**: Anthropic (claude.ai) and OpenAI publish explicit exclusions (health, race, religion, politics, gender; government IDs, financial/criminal/immigration data — Anthropic) or behavioral steering (OpenAI health). Gemini/Copilot instead route sensitive content to temporary chat. The memory tool mandates **path-traversal protection** and sensitive-data validation on the developer side.

---

## Part D — Guidance for a two-tier CRM-agent memory layer

See the returned synthesis for the condensed design recommendation; the evidence above supports: a small always-loaded per-user profile index + on-demand retrieval of durable facts; LLM salience-gated writes (not everything); an explicit extract→update pipeline with ADD/UPDATE/DELETE/NOOP for contradiction handling (Mem0-style); recency+importance+relevance recall scoring (Generative Agents-style) only once volume warrants it; per-item view/edit/delete + a sensitive-data denylist from day one.

### Consolidated source list

Products: [ChatGPT help](https://help.openai.com/en/articles/8590148-memory-in-chatgpt) · [OpenAI blog](https://openai.com/index/memory-and-new-controls-for-chatgpt/) · [Gemini memory](https://support.google.com/gemini/answer/16598469?hl=en) · [Gemini hub](https://support.google.com/gemini/answer/16598623?hl=en) · [Gemini privacy](https://support.google.com/gemini/answer/13594961?hl=en) · [Copilot blog](https://techcommunity.microsoft.com/blog/microsoft-copilot-blog/introducing-copilot-memory-a-more-productive-and-personalized-ai-for-the-way-you/4432059) · [M365 Copilot](https://techcommunity.microsoft.com/blog/microsoft365insiderblog/unlock-the-power-of-personalization-copilot-memory-in-microsoft-365/4458242) · [Claude memory blog](https://claude.com/blog/memory) · [Claude chat search & memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context) · [Claude projects](https://support.claude.com/en/articles/9517075-what-are-projects) · [Claude Code memory](https://code.claude.com/docs/en/memory) · [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

Papers: [CoALA 2309.02427](https://arxiv.org/abs/2309.02427) · [Memory survey 2404.13501](https://arxiv.org/abs/2404.13501) · [Generative Agents 2304.03442](https://arxiv.org/abs/2304.03442) · [MemGPT 2310.08560](https://arxiv.org/abs/2310.08560) · [MemoryBank 2305.10250](https://arxiv.org/abs/2305.10250) · [A-MEM 2502.12110](https://arxiv.org/abs/2502.12110) · [Reflexion 2303.11366](https://arxiv.org/abs/2303.11366) · [Mem0 2504.19413](https://arxiv.org/abs/2504.19413)

**Caveats [I]:** Several paper constants (Generative Agents decay 0.995 / threshold 150 / α=1; MemGPT ~70%/100%; MemoryBank R=e^(−t/S), S++, R_min; Mem0 ADD/UPDATE/DELETE/NOOP) were read from arXiv HTML renders and technical write-ups; spot-verify against camera-ready PDFs before quoting in publication. ChatGPT pages were fetched via an alternate path (403 on direct fetch). Some Gemini/Copilot rollout dates rely on secondary tech reporting where official pages omit them. claude.ai consumer recall mechanics (always-loaded vs retrieved) are not published and are marked [I].
