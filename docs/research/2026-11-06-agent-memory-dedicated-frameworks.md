# Dedicated Agent-Memory Frameworks: How mem0, Letta/MemGPT, and Zep/Graphiti Implement Memory

**Date:** 2026-11-06
**Scope:** Primary-source deep dive into three dedicated agent-memory frameworks, focused on scoping, write/extraction, consolidation/forgetting, recall, typing, and cost/latency — to inform a two-tier (user + session) memory layer in a TypeScript/SQLite agent.

**Legend:** `[O]` = directly observed in a primary source (paper / docs / source code). `[I]` = inference or synthesis across sources.

> **Critical nuance up front (mem0):** mem0 ships *two* extract/update designs. The canonical **two-LLM-call ADD/UPDATE/DELETE/NOOP** pipeline is what the paper and `prompts.py` (`DEFAULT_UPDATE_MEMORY_PROMPT`) describe. The current OSS `main` branch `_add_to_vector_store` has been refactored to a **single-call, additive-only "V3" pipeline** (hash-based dedup, no UPDATE/DELETE/NOOP). Both are documented below. Graph memory has also been removed from the OSS SDK (Platform-only now).

---

## Comparison Table

| Dimension | **mem0** | **Letta / MemGPT** | **Zep / Graphiti** |
|---|---|---|---|
| **Core model** | Fact-sentence store with extract→update LLM pipeline; optional entity graph (Mem0g / Platform) | OS-inspired virtual-memory paging between in-context and out-of-context tiers | Bi-temporal knowledge graph (episodes → entities/facts → communities) |
| **Scoping identifiers** | `user_id`, `agent_id`, `run_id` (session), `app_id`; combinable via metadata filters `[O]` | Memory blocks by `label` (persona/human); blocks shareable/attachable across agents; per-agent state `[O]` | `user` graph + `thread` (session) that auto-rolls into user graph; OSS `group_id` partition; generic `graph_uuid` `[O]` |
| **Write trigger** | Automatic background extraction on each message pair `[O]` | Inline LLM tool calls during the turn + async sleep-time agent `[O]` | Automatic ingestion per episode (`add_episode` / `thread.add_messages`), async-first `[O]` |
| **Sync/async** | Can run async; paper describes 2 LLM calls per add `[O]` | Inline = sync; consolidation = async background `[O]` | Async-first (`await`) `[O]` |
| **Consolidation / conflict** | LLM decides **ADD / UPDATE / DELETE / NONE(NOOP)** vs top-10 similar (classic); V3 branch is additive-only w/ MD5 dedup `[O]` | Self-edit tools (append/replace); recursive summarization on memory pressure; sleep-time consolidation `[O]` | LLM contradiction check → **edge invalidation** (sets `invalid_at`, never deletes); bi-temporal history preserved `[O]` |
| **Recall** | Hybrid: semantic + BM25 keyword + entity boost + temporal, reranked to top-K; injected via prompt `[O]` | Core blocks always in-context; archival/recall queried via tools (semantic + text) `[O]` | Hybrid: cosine + BM25 + graph BFS, reranked (RRF/MMR/graph-distance/cross-encoder); one-call context block `[O]` |
| **Typing/taxonomy** | Functional categories (preference/decision/fact/goal/feedback); distinct **procedural** mode; no cognitive enum stored `[O]` | Storage-location tiers (blocks/recall/archival/files); no cognitive enum; defaults `persona`/`human` `[O]` | Typed nodes & edges via Pydantic (9 default entity types, 2 default edge types); custom ontology `[O]` |
| **Cost/latency headline** | ~91% lower p95 latency, >90% token savings vs full-context; ~7k tokens/convo (LOCOMO) `[O]` | Tier cascade + recursive summarization cap tokens; sleep-time moves cost off critical path `[O]` | ~90% latency reduction, 115k→1.6k avg context tokens (LongMemEval); cost paid at write time `[O]` |
| **Store** | SQL (facts/history) + vector DB (embeddings) + entity store; graph Platform-only `[O]` | DB-persisted state + vector DB for archival `[O]` | Graph DB (Neo4j/FalkorDB etc.), 1024-dim embeddings + Lucene full-text `[O]` |

---

## mem0 (mem0ai)

**Primary sources:** paper "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory" (https://arxiv.org/abs/2504.19413, HTML https://arxiv.org/html/2504.19413v1); `mem0/configs/prompts.py` and `mem0/memory/main.py` (https://github.com/mem0ai/mem0); docs https://docs.mem0.ai.

### 1. Memory pipeline (extract → update)
- **Classic / paper two-phase design.** Phase 1 (extract): one LLM call over "a pair of messages," using a retrieved **conversation summary S** plus the last `m = 10` recent messages, producing salient memories Ω. `[O]` https://arxiv.org/html/2504.19413v1
- Phase 2 (update): retrieves "the top `s` semantically similar memories using vector embeddings" (`s = 10`), then a second LLM call decides the operation. `[O]` https://arxiv.org/html/2504.19413v1
- In classic OSS this is two `llm.generate_response` calls: `FACT_RETRIEVAL_PROMPT` then `DEFAULT_UPDATE_MEMORY_PROMPT`. `[I]` / docs https://docs.mem0.ai/core-concepts/memory-operations
- **Current `main` branch "V3" code** (`_add_to_vector_store`, explicitly labeled `# === V3 PHASED BATCH PIPELINE ===`): Phase 0 gathers context (`get_last_messages(..., limit=10)` + `parse_messages`); Phase 1 retrieves existing memories (`vector_store.search(..., top_k=10, ...)`); Phase 2 is a **single** `generate_response` call with `ADDITIVE_EXTRACTION_PROMPT`. Retrieved memories are re-indexed to integer IDs ("Map UUIDs to integers (anti-hallucination)"). This path is **additive-only**: batch-embed, dedup by MD5 hash (`mem_hash in existing_hashes or ... seen_hashes`), insert, history `"event": "ADD"`. No UPDATE/DELETE/NOOP branch. `[O]` https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py
- Docs corroborate the additive stance: "New memories are added without overwriting or deleting existing memories." `[O]` https://docs.mem0.ai/core-concepts/memory-operations

### 2. The ADD/UPDATE/DELETE/NOOP decision
- Paper: the update LLM chooses "ADD for creation," "UPDATE for augmentation," "DELETE for removal," or "NOOP when the candidate fact requires no modification." `[O]` https://arxiv.org/html/2504.19413v1
- Code prompt `DEFAULT_UPDATE_MEMORY_PROMPT` (verbatim): *"You are a smart memory manager which controls the memory of a system. You can perform four operations: (1) add into the memory, (2) update the memory, (3) delete from the memory, and (4) no change."* `[O]` https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py
- JSON event enums emitted: `"ADD"`, `"UPDATE"`, `"DELETE"`, `"NONE"` (code uses `NONE`; paper prose says `NOOP`). `[O]`
- **Not** a native tool/function-call API — it is **structured-JSON output** (`response_format={"type": "json_object"}`): the LLM gets old memories as an ID+text list and returns `{"memory": [{"id","text","event","old_memory"?}]}`. `[O]` / `[I]`
- Per-operation guidance (verbatim highlights): ADD = "new information not present... generate a new ID"; UPDATE = "already present but... totally different... keep the same ID" (and "Likes" vs "Loves cheese pizza" → no update, same info); DELETE = "contradicts the information present"; NONE = "already present." `[O]`
- Dispatch functions: `_create_memory`, `_update_memory`, `_delete_memory` (sync + async). `[O]`

### 3. Scoping
- Identifier keys: `user_id` (person/account), `agent_id` (agent persona), `run_id` (session/thread), `app_id` (surface). Docs recommend always scoping searches. `[O]` https://docs.mem0.ai/platform/features/entity-scoped-memory , https://docs.mem0.ai/cookbooks/essentials/entity-partitioning-playbook
- V3 code builds the filter from exactly these keys: `search_filters = {k: v for ... if k in ("user_id", "agent_id", "run_id") and v}`. `[O]`
- Agent-scoped mode: `is_agent_scoped = bool(filters.get("agent_id")) and not filters.get("user_id")` appends `AGENT_CONTEXT_SUFFIX`. Memories can be scoped to a user alone, agent alone, or any combination; `run_id` partitions by session. Facts are attributed (`attributed_to: "user"` / assistant). `[O]`
- Combinations work because filters are a metadata dict; search also supports `AND/OR/NOT`, comparison operators, and wildcard `"*"`. `[I]`

### 4. Vector + graph store
- Stores: SQL (facts + metadata/history), vector DB (embeddings), entity store. `[O]` https://docs.mem0.ai/core-concepts/memory-types
- **Graph memory removed from OSS SDK** — "a Mem0 Platform feature, built in and always on"; ~4000 lines of Neo4j/Memgraph/Kuzu/Apache AGE/Neptune drivers removed. `[O]` https://docs.mem0.ai/open-source/graph_memory/overview
- **Mem0g (paper):** a directed labeled graph G=(V,E,L) — nodes = entities, edges = relationships, labels = semantic types; relationships are triplets `(v_s, r, v_d)` from LLM entity/relationship generators. `[O]` https://arxiv.org/html/2504.19413v1
- Mem0 vs Mem0g: Mem0g adds relational/temporal structure, ~2% higher overall, better on temporal, but ~2× tokens/latency. `[O]`

### 5. Recall / search
- V3 `_search_vector_store` is **hybrid + reranked**, not plain top-K: embed query → semantic over-fetch (`internal_limit = max(limit*4, 60)`) → parallel `keyword_search` → normalized **BM25** → **entity boosts** → `score_and_rank(...)` down to `limit` (default `threshold=0.1`). `[O]` https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py
- Docs name four signals: Semantic, Keyword, Entity, Temporal. `[O]` https://docs.mem0.ai/core-concepts/memory-types
- Injected via `MEMORY_ANSWER_PROMPT` into the answering LLM's system prompt. `[O]`

### 6. Typing / taxonomy
- No stored cognitive (episodic/semantic) enum. Functional categories: Preferences, Decisions, Facts & Account Info, Goals & Plans, Feedback. `[O]` https://docs.mem0.ai/core-concepts/memory-types
- Exception: a distinct **procedural memory** mode (`PROCEDURAL_MEMORY_SYSTEM_PROMPT`, used to summarize agent run histories). `[O]`
- FACT_RETRIEVAL_PROMPT enumerates seven content categories as extraction guidance, not stored labels. `[I]`

### 7. Cost / latency (LOCOMO)
- Headline: "26% relative improvement" in LLM-as-a-Judge over OpenAI memory, "91% lower p95 latency," ">90% token cost" savings vs full-context. `[O]` https://arxiv.org/html/2504.19413v1
- Latency p50/p95 (s): Mem0 0.708/1.440 (search-only 0.148/0.200); Mem0g 1.091/2.590; Full-context 9.870/17.117. `[O]`
- Tokens/convo: Mem0 ≈7k; Mem0g ≈14k; Full-context ≈26k; Zep >600k. `[O]`

---

## Letta / MemGPT

**Primary sources:** MemGPT paper "Towards LLMs as Operating Systems" (https://arxiv.org/abs/2310.08560, HTML https://ar5iv.labs.arxiv.org/html/2310.08560); Letta docs https://docs.letta.com; blog https://www.letta.com/blog/sleep-time-compute/.

### 1. OS-inspired memory model
- "Virtual context management... drawing inspiration from hierarchical memory systems in traditional operating systems that provide the appearance of large memory resources through data movement between fast and slow memory." `[O]` https://arxiv.org/abs/2310.08560
- **Main context** (in-prompt / fast "RAM") vs **external context** (out-of-context / slow "disk"): external data "must always be explicitly moved into main context." `[O]` https://ar5iv.labs.arxiv.org/html/2310.08560
- Letta frames it as **in-context vs out-of-context**; core memories are injected into the window, other state persisted in a DB "never lost, even once evicted." `[O]` https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/ , https://docs.letta.com/guides/agents/memory
- Paging via a **Queue Manager**; main context has three sections: static **system instructions**, read/write **working context**, and a **FIFO queue** whose first index holds a recursive summary of evicted messages. `[O]`

### 2. Core vs recall vs archival memory
- **Core memory (in-context blocks):** "always visible — no retrieval needed," prepended as `<memory_blocks>` XML; defaults `persona` + `human`; recommended <50k chars/block, <20 blocks/agent. `[O]` https://docs.letta.com/guides/core-concepts/memory/memory-blocks/ , https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/
- **Recall memory:** the message database (paper "recall storage"); searched via `conversation_search` across any past conversation (recently moved to a "recall subagent" in newer versions). `[O]` https://ar5iv.labs.arxiv.org/html/2310.08560
- **Archival memory:** "a semantically searchable database" (vector DB), agent-immutable, unlimited, tag-based, items capped ~300 tokens; must be queried on-demand. `[O]` https://docs.letta.com/guides/core-concepts/memory/archival-memory/

### 3. Memory blocks
- A block = structured persistent context section ("coordination primitive"). Fields: `label`, `description` ("critical for agent understanding"), `value`, `limit`, `read_only` (default false). `[O]` https://docs.letta.com/guides/core-concepts/memory/memory-blocks/
- Blocks can be **attached/detached** and **shared** across multiple agents at once; updates are visible everywhere, enabling coordination without agent-to-agent messaging. `[O]` https://docs.letta.com/guides/agents/multi-agent-shared-memory

### 4. Self-editing memory tools
- The LLM edits its own memory via tool calls: `core_memory_append`, `core_memory_replace`, `archival_memory_insert` ("store new information with optional tags"), `archival_memory_search` ("query for semantically relevant memories with optional tag filtering"), `conversation_search`. `[O]` https://docs.letta.com/guides/agents/memory , https://docs.letta.com/guides/core-concepts/memory/archival-memory/
- Decision to edit is the agent's own judgment during a turn, guided by each block's `description`; "the agent decides where the lesson belongs and commits the update." `[O]` / `[I]`

### 5. Write / extraction triggers
- Base MemGPT/Letta = **inline synchronous tool calls** during the turn. `[O]` / `[I]`
- **Heartbeat** chaining: `request_heartbeat=true` returns control to the processor after a tool completes, letting the LLM run again (search → read → edit). `[O]` https://ar5iv.labs.arxiv.org/html/2310.08560
- **Memory-pressure** warning at ~70% of context window inserts a system warning to flush important data; at 100% the queue manager evicts ~50% and generates a new **recursive summary** from prior summary + evicted messages (evicted messages stay in recall). `[O]`

### 6. Sleep-time compute / background consolidation
- Sleep-time compute = letting models "think" during downtime. A sleep-time-enabled agent is **two agents**: a primary agent + a sleep-time agent that manages the primary's in-context memory asynchronously, turning "raw context" into "learned context." `[O]` https://www.letta.com/blog/sleep-time-compute/
- Docs: three operations — review conversations, consolidate lessons, update memory (via **MemFS**, a git-backed memory filesystem). Triggers: after N agent steps, or when the context window is compacted; optional review phase. Marked experimental. `[O]` https://docs.letta.com/guides/agents/architectures/sleeptime/ , https://docs.letta.com/concepts/memfs

### 7. Recall mechanism
- Core blocks always in-context (no retrieval). Archival/recall queried on-demand via tools; archival = semantic (vector) search, recall = message/text search. `[O]`
- Tier ladder: Memory Blocks (in-context, <50k chars) → Files (in-context read-only, ~5MB, semantic + grep) → Archival (out-of-context, ~300 tokens/item, tool-queried) → External RAG. `[O]` https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/
- Retrieved recall messages are re-appended to the FIFO queue by the queue manager. `[O]`

### 8. Typing / taxonomy
- No enforced semantic/episodic/procedural enum. Organization is by **storage location** (blocks/recall/archival/files) + user-defined labeled blocks (defaults `persona`/`human`). Developers emulate typing via distinct labeled blocks and archival tags. `[O]` / `[I]`

### 9. Cost / latency
- Tier cascade keeps only critical data in-context; recursive summarization bounds token growth. `[O]`
- Sleep-time compute "removes memory management from the critical interaction path, improving latency," described as "a Pareto improvement" — it spends extra background tokens (two agents) to buy lower user-facing latency and higher memory quality. `[O]` / `[I]` https://www.letta.com/blog/sleep-time-compute/

---

## Zep / Graphiti

**Primary sources:** Zep paper "A Temporal Knowledge Graph Architecture for Agent Memory" (https://arxiv.org/abs/2501.13956, HTML https://arxiv.org/html/2501.13956v1); Graphiti GitHub (https://github.com/getzep/graphiti); Zep docs https://help.getzep.com.

### 1. Temporal knowledge graph model
- Three hierarchical subgraph tiers: **episode subgraph (𝒢ₑ)** = raw messages/text/JSON as episodic nodes, "non-lossy data store"; **semantic entity subgraph (𝒢ₛ)** = extracted/resolved entity nodes + relationship edges (facts); **community subgraph (𝒢_c)** = clusters of strongly connected entities with summaries. `[O]` https://arxiv.org/html/2501.13956v1
- GitHub framing: Episodes = ground-truth stream ("every derived fact traces back here"); Nodes = entities with evolving summaries; Edges = "triplets (Entity → Relationship → Entity) with temporal validity windows." `[O]` https://github.com/getzep/graphiti
- An **episode** = a unit of raw ingested data; entities connect to it via `MENTIONS` edges, giving point-in-time querying and provenance. `[O]` https://help.getzep.com/graphiti/graphiti/adding-episodes

### 2. Bi-temporal model
- Two independent timelines: **T** (event/chronological) with `valid_at` / `invalid_at` (paper `t_valid`/`t_invalid`) = when a fact became/stopped being true; **T'** (transactional/ingestion) with `created_at` / `expired_at` (paper `t'_created`/`t'_expired`) = when the system learned/invalidated it. `[O]` https://arxiv.org/html/2501.13956v1
- Lets the graph represent "both current relationship states and historical records of relationship evolution." Validity extracted from episode context using `t_ref` (the episode reference time), handling absolute and relative timestamps. `[O]`

### 3. Fact versioning / invalidation (KEY)
- On new info, Graphiti "employs an LLM to compare new edges against semantically related existing edges to identify potential contradictions." `[O]` https://arxiv.org/html/2501.13956v1
- **Invalidation (exact):** "When the system identifies temporally overlapping contradictions, it invalidates the affected edges by setting their `t_invalid` to the `t_valid` of the invalidating edge." Policy "consistently prioritizes new information." `[O]`
- **Non-destructive:** facts are "invalidated — not deleted"; GitHub: "automatic fact invalidation with temporal history preserved" — explicitly contrasted with summarization-based systems. `[O]` https://github.com/getzep/graphiti
- Edge pipeline: fact/edge extraction → embedding + edge dedup ("similar to entity resolution") → temporal extraction/invalidation. Bulk path `add_episode_bulk()` "resolves invalidated edges and extracts temporal dates before it saves." `[O]`
- A "fact version" = two+ edges between the same entities with non-overlapping validity intervals; the superseded edge keeps `valid_at` but gains `invalid_at` = new edge's `valid_at`. `[I]`

### 4. Scoping: session vs user graph
- A **user** has "a user graph and thread history"; **threads** = "conversation threads of a user," and "by default, all messages added to any thread of that user are ingested into that user's graph" — sessions auto-roll-up to user. `[O]` https://help.getzep.com/concepts
- Two graph structures: per-user **user graph**, and a generic/group **graph** addressed by `graph_uuid` for "shared or domain context not owned by one Zep user." `[O]`
- Graphiti OSS uses `group_id` for multi-tenant partitioning; the hosted user/graph model sits on top of it. `[O]` / `[I]` https://github.com/getzep/graphiti

### 5. Write / extraction pipeline
- Ingestion via `add_episode(name, episode_body, source, source_description, reference_time)`; `EpisodeType` = text / message ("speaker: message") / json. Hosted: `thread.add_messages` + `graph.episode.add`. Async-first (`await`). `[O]` https://help.getzep.com/graphiti/graphiti/adding-episodes , https://help.getzep.com/concepts
- LLM stages per episode: (1) entity extraction (current + last n=4 messages, speaker auto-extracted, reflexion-style reflection to cut hallucinations); (2) entity resolution/dedup (1024-dim embeddings + full-text search + LLM resolution prompt); (3) fact/edge extraction; (4) edge dedup (embeddings); (5) temporal extraction + contradiction/invalidation. `[O]` https://arxiv.org/html/2501.13956v1
- → ~4–5 LLM-driven stages + embeddings per episode (main cost driver). `[I]`

### 6. Recall / retrieval
- **Hybrid search** = cosine semantic (φ_cos) + Okapi BM25 full-text (φ_bm25, via Neo4j/Lucene) + breadth-first graph search (φ_bfs, n-hops). Rerankers: RRF (default), MMR (`mmr_lambda`), episode-mentions, node-distance (from a centroid), cross-encoder. `[O]` https://arxiv.org/html/2501.13956v1 , https://github.com/getzep/graphiti
- Scoped ops: `graph.search_edges` (facts), `graph.search_nodes` (entities+summaries), `graph.search_episodes` (raw), `graph.search_observations`, `graph.search_thread_summaries`. One-call retrieval: `thread.get_context` / `graph.get_context` (cross-scope rerank → single materialized context block). `[O]` https://help.getzep.com/searching-the-graph , https://help.getzep.com/concepts
- **Context block format:** facts as `- {FACT} (Date range: {valid_at} - {invalid_at})` inside `<FACTS>`; entities as `- {NAME}: {summary}` inside `<ENTITIES>`. "present" = currently valid; a past end date = "used to be valid but NOT CURRENTLY VALID." Injection: after history, before latest user request (OpenAI) / via `tool_result` (Anthropic) — kept in the untrusted-data channel. `[O]` https://help.getzep.com/cookbook/customize-your-context-block

### 7. Typing / taxonomy
- Nodes and edges are **typed and user-definable** via Pydantic. Custom entity types extend `EntityModel` (fields `EntityText`/`EntityBoolean`, ≤10 fields); custom edge types extend `EdgeModel` with `sourceTargets`. `[O]` https://help.getzep.com/entity-types
- 9 default entity types: User, Assistant, Preference, Location, Event, Object, Topic, Organization, Document. 2 default edge types: `LOCATED_AT`, `OCCURRED_AT`. README: "prescribed and learned ontology." `[O]`
- "Fact types" = the custom/default edge types. `[I]`

### 8. Cost / latency
- Levers: bounded per-call context (current + n=4 messages); reflexion reflection; embedding + full-text candidate narrowing before LLM resolution. `[O]` https://arxiv.org/html/2501.13956v1
- DMR: Zep 94.8% vs MemGPT 93.4% (gpt-4-turbo). LongMemEval (~115k-token convos): gpt-4o-mini 63.8% acc / 3.20s / 1.6k context vs full-context 55.4% / 31.3s / 115k; gpt-4o 71.2% / 2.58s / 1.6k vs 60.2% / 28.9s / 115k. `[O]`
- Headline: +15.2% / +18.5% accuracy, **~90% latency reduction**, context 115k→1.6k tokens. Latency win is mostly a context-size effect; extraction cost is paid at **write** (async), keeping read latency low. `[O]` / `[I]` https://arxiv.org/abs/2501.13956

---

## Sources

**mem0:** https://arxiv.org/abs/2504.19413 · https://arxiv.org/html/2504.19413v1 · https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py · https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py · https://docs.mem0.ai/core-concepts/memory-operations · https://docs.mem0.ai/core-concepts/memory-types · https://docs.mem0.ai/open-source/graph_memory/overview · https://docs.mem0.ai/platform/features/entity-scoped-memory · https://docs.mem0.ai/cookbooks/essentials/entity-partitioning-playbook

**Letta / MemGPT:** https://arxiv.org/abs/2310.08560 · https://ar5iv.labs.arxiv.org/html/2310.08560 · https://docs.letta.com/guides/core-concepts/memory/memory-blocks/ · https://docs.letta.com/guides/core-concepts/memory/archival-memory/ · https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/ · https://docs.letta.com/guides/agents/memory · https://docs.letta.com/guides/agents/custom-memory · https://docs.letta.com/guides/agents/multi-agent-shared-memory · https://docs.letta.com/guides/agents/architectures/sleeptime/ · https://docs.letta.com/concepts/memfs · https://www.letta.com/blog/sleep-time-compute/

**Zep / Graphiti:** https://arxiv.org/abs/2501.13956 · https://arxiv.org/html/2501.13956v1 · https://github.com/getzep/graphiti · https://help.getzep.com/concepts · https://help.getzep.com/graphiti/graphiti/adding-episodes · https://help.getzep.com/searching-the-graph · https://help.getzep.com/entity-types · https://help.getzep.com/cookbook/customize-your-context-block
