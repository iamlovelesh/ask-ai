# Built-in Memory in General-Purpose Agent Frameworks

Research date: 2026-11-06. Scope: how *general-purpose* agent frameworks ship
built-in memory, across six design axes: (1) scoping, (2) write/extraction,
(3) consolidation/forgetting, (4) recall/prompt-injection, (5) typing/taxonomy,
(6) default storage backend.

Every claim is cited with a URL and tagged **[O]** (observed directly in
source/docs text) or **[I]** (inference). A ~400-word synthesis for our
TypeScript + `node:sqlite` agent (which already has a compact always-in-prompt
"skills" index + load-on-demand tool) is in the companion report returned to the
caller; this file is the evidence base.

---

## TL;DR

- **Two camps.** The "SDK" camp (OpenAI Agents SDK, Vercel AI SDK) ships only
  **transcript persistence** — no extraction, no consolidation, no semantic
  recall. The "framework" camp (LangGraph/LangMem, LlamaIndex, CrewAI, Agno,
  Semantic Kernel, AutoGen) ships richer memory, but the *mature* long-term
  features are frequently delegated to a 3rd-party service (**Mem0** recurs
  everywhere).
- **Two write paths recur:** a **hot-path model-callable tool** (the LLM decides
  to save/update/delete) and a **background extractor** (an LLM reflects on the
  turn after it completes). LangMem names these "conscious" vs "subconscious";
  Agno exposes them as `enable_agentic_memory` vs `update_memory_on_run`.
- **Vector DB is NOT required for user-memory** in several designs. Agno stores
  user memories **relationally (SQLite)** and recalls by *full injection* or
  *LLM-as-ranker*, never embeddings. LangGraph's `BaseStore`, LlamaIndex's
  fact block, and CrewAI's long-term tier are all usable without a vector DB;
  the vector index is an opt-in for semantic `search`.
- **Recall splits three ways:** always-in-context (inject everything),
  retrieval top-K (semantic or lexical), or a model-callable recall tool. Many
  frameworks default to *inject-all* for the small user-memory set and reserve
  top-K vectors for large corpora.

---

## Comparison table

| Framework | User (cross-convo) scope | Session/thread scope | Write trigger | Extraction | Consolidation / forgetting | Recall / injection | Taxonomy | Default store | Vector DB required? |
|---|---|---|---|---|---|---|---|---|---|
| **LangGraph + LangMem** | namespace tuple incl. `user_id`, e.g. `(user_id,"memories")` [O] | `thread_id` + checkpointer [O] | **both**: hot-path tool `manage_memory` + background `create_memory_store_manager`/`ReflectionExecutor` [O] | LLM extraction in background manager; schemas = Pydantic [O] | `enable_inserts`/`enable_updates`/`enable_deletes`; profile (overwrite) vs collection (dedupe) [O] | all 3: checkpoint msgs always-in-ctx; `search_memory` tool; programmatic `store.search` top-K [O] | **named** semantic / episodic / procedural [O] | short-term `SqliteSaver`/`InMemorySaver`; long-term `InMemoryStore`/Postgres [O] | **No** — KV+filter works; vector index opt-in [O] |
| **LlamaIndex `Memory`** | no first-class `user_id`; use stable `session_id` or metadata filter [O] | `session_id` (UUID) [O] | **background**, token-pressure flush → blocks [O] | `FactExtractionMemoryBlock` (LLM); `VectorMemoryBlock` (embed) [O] | exact-dup skip + LLM condense at `max_facts`; priority truncation [O] | FIFO always-in-ctx + blocks by priority; vector top-K=2 semantic [O] | compose blocks (static/fact/vector); no fixed taxonomy [O] | SQLite (`SQLAlchemyChatStore`) [O] | **No** — only if `VectorMemoryBlock` used [O] |
| **CrewAI (classic ≤0.x)** | only via Mem0 `user_id` [O] | no session_id; agent-role + storage-type dir [O] | **auto after each task**, sync [O] | LTM = task-evaluator suggestions+score; STM/entity = RAG add [O] | minimal; append-only; LTM read-dedup; wholesale reset only [O] | per-tier block injected each task; STM/entity semantic (Chroma); LTM lexical (SQLite) [O] | fixed 5-way: short/long/entity/contextual/external(+user) [O] | **Chroma (STM/entity) + SQLite (LTM)** [O] | **Yes** for STM/entity (Chroma bundled); LTM only SQLite [O] |
| **CrewAI (unified 1.x)** | hierarchical scopes + `source="user:alice"` + `private` [O] | scope subtree / `slice` [O] | auto after task, background thread [O] | LLM infers scope/category/importance [O] | LLM keep/update/delete/insert @0.85; batch dedup @0.98 [O] | shallow (vector) / deep (LLM `RecallFlow`); composite score [O] | no tiers; scope+categories+importance+source [O] | **LanceDB** (vector) default [O] | **Yes** (LanceDB default) [O] |
| **OpenAI Agents SDK** | none (session_id is just a key) [O] | `session_id` string via `Session` protocol [O] | **auto transcript append** at run boundaries; opt-in via `session=` [O] | none (raw items; compaction = size mgmt) [O] | `pop_item`/`clear_session`; per-run `limit`/callback; no dedupe/TTL [O] | **always-in-context**: whole transcript re-prepended; no search [O] | none [O] | `SQLiteSession` (in-mem or file); or hosted Conversations API [O] | **No** (no semantic layer at all) [O] |
| **Vercel AI SDK** | none [O] | chat `id` (dev-chosen) [O] | **explicit, dev-wired** in `onFinish`/`onEnd` [O] | none [O] | none in SDK [O] | whole thread re-injected via `initialMessages`; no search [O] | none [O] | **none** (bring your own) [O] | **No** |
| **Semantic Kernel (legacy)** | none (collection string only) [O] | none; collection string [O] | **explicit only** (`Save`/`SaveInformationAsync`) [O] | none (agent-provider layer adds auto) [O] | upsert-by-key + `Remove`; no auto reconcile [O/I] | model-callable top-K semantic (`Recall`) [O] | untyped records [O] | in-memory (`VolatileMemoryStore`/"In-Memory") [O] | **No** to start (in-mem default) [O] |
| **AutoGen (core `ListMemory`)** | none | per-instance (one list / one collection) [O] | **explicit `await memory.add()`** by dev code; agent loop read-only [O] | none in core; Task-Centric experimental LLM extract [O] | `ListMemory` append-only, `clear()` only; "no dedup" in Chroma [O] | `update_context` → SystemMessage; `ListMemory` **injects ALL** (query ignored) [O] | `MemoryContent` mime+metadata; no semantic taxonomy [O] | in-process list, ephemeral [O] | **No** — only Chroma/Mem0 use external [O] |
| **Agno (v3)** | **first-class `user_id`** (→`"default"` if None) [O] | `session_id` + `num_history_runs` (default 3) [O] | **both**: auto `update_memory_on_run` (background thread) + agentic `update_user_memory` tool [O] | `MemoryManager` LLM extraction; default `gpt-4o` [O] | tool gates add/update/delete; prompt dedupe; `optimize_memories`; strategies [O] | **inject-ALL by default** into `<memories_from_previous_interactions>`; optional `search_user_memories` (`last_n`/`first_n`/agentic-LLM, **no vectors**) [O] | 3 tiers: session history / user memories / session summaries; `topics` tags [O] | **SQLite (`SqliteDb`)** — one DB, relational tables (`agno_memories`) [O] | **No** — relational; vectors only for Knowledge/RAG tier [O] |

---

## LangGraph + LangMem (LangChain)

Two-layer design: **LangGraph** owns the persistence primitives (checkpointer =
short-term; `BaseStore` = long-term). **LangMem** is a separate library on top of
`BaseStore` that adds extraction/consolidation logic and agent-facing tools.
[O] https://docs.langchain.com/oss/python/langgraph/persistence ,
[O] https://langchain-ai.github.io/langmem/

### 1. Scoping
- **Short-term** is scoped by **`thread_id`** passed in the run config
  `{"configurable": {"thread_id": "thread-1"}}`; the checkpointer keys
  checkpoints on it. Compiled in via `graph = builder.compile(checkpointer=...)`.
  [O] https://docs.langchain.com/oss/python/langgraph/persistence
- **Long-term** uses `BaseStore`, keyed by **namespace tuple + key**, persisting
  across all threads. Scoping level is *purely a convention in the tuple*: docs
  use `(user_id, "memories")`; agent/org/app scope are just different tuple
  prefixes. [O] https://docs.langchain.com/oss/python/langgraph/add-memory ;
  [I] the tuple is the only scoping mechanism — there is no separate "user" vs
  "agent" API.
- `BaseStore` core API (from source): `get(namespace, key)`,
  `put(namespace, key, value, index=...)`, `search(namespace_prefix, *, query,
  filter, limit=10, offset=0)`, `delete`, `list_namespaces`, plus async
  `aget/aput/asearch/...`. [O]
  https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/checkpoint/langgraph/store/base/__init__.py
- LangMem's `create_memory_store_manager` default namespace is
  `("memories", "{langgraph_user_id}")` — user-scoped by default, with a
  runtime-substituted placeholder. [O]
  https://langchain-ai.github.io/langmem/reference/memory/

### 2. Write / extraction — BOTH hot-path and background
LangMem's conceptual guide names these **"Conscious Formation" (hot path,
"adds perceptible latency")** vs **"Subconscious Formation" (background,
reflect after the conversation ... without slowing the immediate
interaction")**. [O] https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- **Hot path (model-callable tools):** `create_manage_memory_tool(...)` and
  `create_search_memory_tool(...)` added to `create_react_agent(tools=[...],
  store=store)`. The emitted `manage_memory(content, id, action)` lets the LLM
  create/update/delete; `actions_permitted=("create","update","delete")`
  default. Write happens **synchronously when the model calls the tool**. [O]
  https://langchain-ai.github.io/langmem/guides/memory_tools/ ,
  https://langchain-ai.github.io/langmem/reference/tools/
- **Background (automatic):** `create_memory_manager(model, *, schemas=(Memory,),
  enable_inserts=True, enable_updates=True, enable_deletes=False)` extracts but
  does not persist; `create_memory_store_manager(...)` persists to a `BaseStore`
  and uses `query_model`/`query_limit=5` to pull existing memories to reconcile
  against. Invoked `await memory_manager.ainvoke(to_process)` after a turn. [O]
  https://langchain-ai.github.io/langmem/reference/memory/ ,
  https://langchain-ai.github.io/langmem/background_quickstart/
- **`ReflectionExecutor`** debounces/delays background extraction:
  `executor.submit(to_process, after_seconds=delay)`; it "cancels old tasks when
  new messages arrive," so extraction runs once on the complete conversation. [O]
  https://langchain-ai.github.io/langmem/guides/delayed_processing/

### 3. Consolidation / forgetting
- Managed by the three flags above; conceptually the system "must reconcile new
  information ... deleting/invalidating or updating/consolidating existing
  memories." [O] conceptual_guide. Mechanism: the manager searches existing
  memories, and the LLM decides patch-by-`id` vs insert vs delete. [O]
  reference/tools + [I] same reconciliation underlies the background manager.
- **Profile vs Collection** changes forgetting behavior: a *profile* is a single
  document updated in place (stale facts overwritten); a *collection* stores many
  records with "insertion/deletion/consolidation logic." [O] conceptual_guide.
- Short-term trimming: `trim_messages(..., strategy="last", max_tokens=128)`;
  permanent delete via `RemoveMessage(id=m.id)` or `RemoveMessage(id=
  REMOVE_ALL_MESSAGES)`. [O] https://docs.langchain.com/oss/python/langgraph/add-memory

### 4. Recall
- Three strategies coexist: **always-in-context** (checkpointed message list is
  thread state), a **model-callable recall tool** (`search_memory`), and
  **programmatic top-K** inside a node (`memories = await
  runtime.store.asearch(namespace, query="...", limit=3)` then prepend). [O]
  add-memory + [I].
- **Semantic vs lexical:** `store.search(..., query=...)` does natural-language
  semantic search but **"requires vector store implementation"** + an embedding
  index; `filter` is a dict for structured/lexical filtering. Semantic is opt-in:
  `InMemoryStore(index={"embed": embeddings, "dims": 1536})`. Without an index,
  `search()` returns nothing semantically. [O] base store source;
  https://www.langchain.com/blog/semantic-search-for-langgraph-memory ;
  field selection via `IndexConfig.fields` (JSON-path). [O] base store source.

### 5. Typing / taxonomy
- **LangMem explicitly names the three cognitive types:** **semantic** ("Facts &
  Knowledge," profiles/collections), **episodic** ("Past Experiences"),
  **procedural** ("System Behavior," encoded in prompts, refined via
  `create_prompt_optimizer`). [O] conceptual_guide. LangGraph core docs only say
  "short-term" vs "long-term." [O] add-memory. Memory shape = Pydantic `BaseModel`
  via `schemas=`. [O] reference/memory.

### 6. Storage backend
- Short-term: `InMemorySaver`, `SqliteSaver`, `PostgresSaver`. [O] persistence.
- Long-term: `InMemoryStore` (dev) and Postgres store (prod). **A vector DB is
  NOT required** — the store works as plain KV (namespace+key) with `filter`;
  the embedding layer is only for semantic `search`. Postgres semantic search is
  backed by pgvector ([I] — pages confirm "Postgres store supports semantic
  search" but did not literally print "pgvector"). Embedding provider is pluggable
  (`init_embeddings("openai:text-embedding-3-small")`, dims 1536). [O] base store
  source, langmem overview, add-memory.

---

## LlamaIndex

Current system = the `Memory` class + "memory blocks" (supersedes legacy
`ChatMemoryBuffer`/`ChatSummaryMemoryBuffer`). `Memory` is "a memory module that
waterfalls into memory blocks," orchestrating a FIFO message queue + a list of
blocks. Built via `Memory.from_defaults(...)`. [O]
https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/ ,
https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/memory/memory.py

Defaults (source): `DEFAULT_TOKEN_LIMIT=30000`, `DEFAULT_FLUSH_SIZE=3000`
(`=0.1*token_limit`), `chat_history_token_ratio=0.7`, `insert_method=
InsertMethod.SYSTEM`. [O] memory.py

Three built-in blocks (all extend `BaseMemoryBlock[T]` with `priority`
— "0 = never truncate" — and `accept_short_term_memory`):
- **`StaticMemoryBlock`** — constant content; `_aput` is a no-op. [O]
  .../memory_blocks/static.py
- **`FactExtractionMemoryBlock`** — LLM extracts `<fact>…</fact>` from ejected
  messages against `<existing_facts>`; `max_facts=50`; when exceeded runs an LLM
  **condense** pass that rewrites the whole list (merge related, drop redundant);
  dedup is exact-string on insert. [O] .../fact.py
- **`VectorMemoryBlock`** — RAG over a `BasePydanticVectorStore`;
  `similarity_top_k=2`, `retrieval_context_window=5`; stores each ejected message
  as a `TextNode` with `metadata={"session_id": …}`. [O] .../vector.py

### Dimensions
1. **Scoping:** `session_id: str` (defaults to a generated UUID) is the primary
   key for all chat-store reads/writes. **No first-class `user_id`** — "user"
   scope = pick a stable `session_id` or add a `MetadataFilter(key="session_id")`
   on a persistent vector store. Memory is passed per-run: `await agent.run("...",
   memory=memory)`. [O] memory.py + docs.
2. **Write/extraction:** **automatic, triggered by token pressure, not tool
   calls.** When active-queue tokens exceed `token_limit * chat_history_token_ratio`,
   the oldest messages (≤`token_flush_size`) are flushed and "waterfalled" to
   every block via `block.aput(..., from_short_term_memory=True)` concurrently.
   No built-in save-tool. Core async (`aput/aget`); sync wrappers call
   `asyncio_run`. [O] memory.py `_manage_queue`.
3. **Consolidation/forgetting:** Fact block = exact-dup skip + LLM condense at
   `max_facts` (guarded against wiping to empty). Vector block = append-only, no
   dedup/delete. Read-time `_truncate_memory_blocks` truncates by ascending
   `priority` (0 never). [O] fact.py, vector.py, memory.py.
4. **Recall:** Blended — FIFO history always returned, plus each block's `_aget`,
   rendered through an XML `<memory>` template. `insert_method` controls
   placement (SYSTEM default prepends to system message; USER prepends to latest
   user message). Static + Fact = always-in-context; Vector = retrieval top-K
   (semantic, k=2), optional `session_id` filter. [O] memory.py, vector.py.
5. **Typing:** No fixed taxonomy — compose blocks (static / fact / vector / custom
   `BaseMemoryBlock`). [O] docs + memory.py.
6. **Storage:** Short-term queue → **SQLite** via `SQLAlchemyChatStore(table_name=
   "llama_index_memory")`; accepts `async_database_uri` (e.g. Postgres). **Vector
   DB NOT required** unless you use `VectorMemoryBlock`. Extracted facts live in
   the block's own state, not a DB. [O] memory.py, docs, vector.py, fact.py.

---

## CrewAI

CrewAI has **two distinct memory architectures**. The classic tiered system is
what the brief describes; the current (v1.x) line replaced it with a unified
single-class design.

### Classic tiered memory (≤0.x, verified v0.119.0)
Enabled with `Crew(..., memory=True)`. Six components: short-term, long-term,
entity, contextual (combiner), external, and user (deprecated → external). [O]
https://github.com/crewAIInc/crewAI/blob/v0.119.0/docs/concepts/memory.mdx

**`ContextualMemory.build_context_for_task(task, context)`** is the combiner
(source): `query = f"{task.description} {context}"`; appends in order
`_fetch_ltm_context` ("Historical Data:"), `_fetch_stm_context`
("Recent Insights:"), `_fetch_entity_context` ("Entities:"),
`_fetch_external_context` ("External memories:"), and — *only if
`memory_provider == "mem0"`* — `_fetch_user_context`
("User memories/preferences:"). [O]
https://github.com/crewAIInc/crewAI/blob/v0.119.0/src/crewai/memory/contextual/contextual_memory.py

1. **Scoping:** STM/entity (`RAGStorage`) build a ChromaDB collection name from
   storage type + **sanitized agent role**, under `db_storage_path()`. **User
   scope only via Mem0 `user_id`** (`memory_config={"provider":"mem0","config":
   {"user_id":"john",...}}`); without Mem0, `_fetch_user_context` is skipped.
   No session_id concept. [O]
   https://github.com/crewAIInc/crewAI/blob/v0.119.0/src/crewai/memory/storage/rag_storage.py ,
   classic docs, contextual_memory.py.
2. **Write/extraction:** **automatic after each task**, synchronous. LTM write is
   evaluation-derived — row schema `task_description, metadata(JSON), datetime,
   score`; `ContextualMemory` reads `metadata["suggestions"]` + quality `score`.
   [O] https://github.com/crewAIInc/crewAI/blob/v0.119.0/src/crewai/memory/storage/ltm_sqlite_storage.py ;
   [I] a `TaskEvaluator`/`LongTermMemoryItem` produces those suggestions/scores;
   `_create_short_term_memory` etc. method names [I].
3. **Consolidation/forgetting:** minimal. STM/entity append-only (no dedup/update).
   LTM `load()` orders by `datetime DESC, score ASC`, returns `latest_n`;
   read-time dedupe of suggestion strings via `dict.fromkeys`. Forgetting =
   wholesale `reset()` (`DELETE FROM long_term_memories` / remove storage dir)
   via `crewai reset-memories`. [O] ltm_sqlite_storage.py, rag_storage.py.
4. **Recall:** per-tier query → combined text injected into the task prompt.
   STM/entity semantic (Chroma, `search(query, limit=3, score_threshold=0.35)`);
   **LTM lexical/keyed** (SQLite match on `task_description`). Not a model-callable
   tool. [O] contextual_memory.py, rag_storage.py, ltm_sqlite_storage.py.
5. **Typing:** fixed 5-way (short/long/entity/external/user) + contextual
   orchestrator. [O] classic docs + contextual_memory.py.
6. **Storage:** STM + entity → **ChromaDB** (`chromadb.PersistentClient`, default
   embedder `OpenAIEmbeddingFunction("text-embedding-3-small")`); LTM → **SQLite**
   (`long_term_memory_storage.db`). Root via `CREWAI_STORAGE_DIR` →
   `appdirs.user_data_dir`. **A vector DB (Chroma) is effectively required** for
   STM/entity when `memory=True`; LTM needs only stdlib SQLite. [O] rag_storage.py,
   ltm_sqlite_storage.py, paths.py.

### Unified memory (current, v1.x / `main`)
One `Memory` class (`from crewai import Memory`) with `remember()`/`recall(query,
limit, depth)`/`forget()`; it **"replaces separate short-term, long-term, entity,
and external memory types."** The `main` source deleted the `short_term/`,
`long_term/`, `entity/`, `contextual/` dirs. [O]
https://github.com/crewAIInc/crewAI/blob/main/docs/edge/en/concepts/memory.mdx ,
https://github.com/crewAIInc/crewAI/tree/main/lib/crewai/src/crewai/memory
- **Scoping:** hierarchical filesystem-like scopes (`/agent/researcher`) +
  `source="user:alice"` + `private=True`. [O] edge docs.
- **Write:** auto `extract_memories()` → `remember` after each task; the LLM
  infers scope/category/importance; `remember_many()` non-blocking (thread pool),
  `recall()` runs a `drain_writes()` barrier. [O] edge docs.
- **Consolidation:** on save, if similarity > `consolidation_threshold` (0.85) the
  LLM decides keep/update/delete/insert_new (real conflict resolution);
  intra-batch dedup drops cosine ≥ `batch_dedup_threshold` (0.98). [O] edge docs.
- **Recall:** `depth="shallow"` (pure vector + composite score) vs `depth="deep"`
  (LLM `RecallFlow`); score = `semantic_weight*similarity + recency_weight*decay +
  importance_weight*importance` (0.5/0.3/0.2, half-life 30d). [O] edge docs.
- **Storage:** **default LanceDB** (a vector store) under `./.crewai/memory` or
  `$CREWAI_STORAGE_DIR/memory`; default embedder `text-embedding-3-large`
  (3072-dim); LLM `gpt-4o-mini`. A vector store **is** required here. [O] edge docs.

---

## OpenAI Agents SDK

**Headline: short-term transcript persistence only.** No long-term/semantic/user
memory, no extraction, no consolidation, no dedupe. [O]
https://openai.github.io/openai-agents-python/sessions/

"Built-in session memory ... automatically maintain conversation history across
multiple agent runs." The **`Session` protocol** exposes `session_id`,
`get_items(limit)`, `add_items(items)`, `pop_item()`, `clear_session()` — all
**transcript operations**; there is no `search`/`query`/summarize in the
protocol. [O] sessions.

1. **Scoping:** thread/conversation, keyed by a free-form `session_id` string.
   **No user/agent model** — "A session ID selects conversation history; the
   session ID does not authenticate a user." Conventions like `"user_12345"` are
   naming guidance only. [O] sessions.
2. **Write/extraction:** **automatic transcript append** at every run boundary
   (before run: prepend history; after run: store all new items), opt-in by
   passing `session=` to `Runner.run(...)`. No fact extraction;
   `OpenAIResponsesCompactionSession` compaction is size management, not semantic
   distillation. [O] sessions.
3. **Consolidation/forgetting:** none semantically — only `pop_item()` (undo last)
   and `clear_session()` (wipe), per-run `SessionSettings(limit=50)`, and a
   `session_input_callback` to trim history. No dedupe/TTL. [O] sessions.
4. **Recall:** **always-in-context** — the whole (optionally truncated) transcript
   re-prepended each run. Not retrieval, not semantic, not lexical. [O] sessions.
5. **Typing:** none — untyped `TResponseInputItem`s. [O/I].
6. **Storage:** default `SQLiteSession` (`SQLiteSession("user_123")` in-memory;
   `SQLiteSession("user_123","conversations.db")` file); backends also include
   `RedisSession`, `SQLAlchemySession`, `MongoDBSession`, `AdvancedSQLiteSession`,
   `EncryptedSession`; hosted `OpenAIConversationsSession`. JS parity:
   `MemorySession`, `OpenAIConversationsSession`,
   `OpenAIResponsesCompactionSession`. [O] sessions,
   https://openai.github.io/openai-agents-js/guides/running-agents/

**Bolt-on long-term:** Mem0 via `@function_tool`-wrapped `search_memory`/
`save_memory` over `MemoryClient` + `user_id` (`mem0.add(..., user_id=...)`,
`mem0.search(query, filters={"user_id":...}, top_k=3)`). Mem0 does the extraction
+ semantic recall; "it relies on explicit tool calls to determine what gets
saved." [O] https://docs.mem0.ai/integrations/openai-agents-sdk ,
https://mem0.ai/blog/how-to-add-memory-to-openai-agents-sdk

---

## Vercel AI SDK

**Headline: message persistence patterns only — no memory module.** "The Vercel
AI SDK provides message persistence only — no built-in long-term memory ... no
semantic search, message summarization, or any higher-level memory management
features. Those require custom implementation." [O]
https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence

There is **no `Memory`/`Session` class**. Persistence is a recipe using SDK
building blocks: `useChat` with `initialMessages`, `onFinish`/`onEnd` to trigger
saving, `generateId()`/`createIdGenerator()`, `validateUIMessages()`, and
**developer-written** `loadChat(id)`/`saveChat({chatId, messages})`. Persist in
`UIMessage` format (carries `id`/`createdAt`). [O] same page.

1. **Scoping:** thread/chat via a dev-chosen `id`; no user/agent primitive. [O/I].
2. **Write:** explicit, dev-wired on response completion (`onFinish`/`onEnd`). No
   auto-extraction. [O].
3. **Consolidation/forgetting:** none in the SDK. [O/I].
4. **Recall:** whole-thread re-injection via `initialMessages`; no search. [O].
5. **Typing:** none (`UIMessage`/`ModelMessage`). [O/I].
6. **Storage:** none defaulted — storage-agnostic. [O/I].

**Bolt-on:** persist `UIMessage[]` yourself; tools that read/write a store; or the
**Mem0 community provider** `@mem0/vercel-ai-provider` (`createMem0()`,
`addMemories()`, `retrieveMemories()`, scoped by `user_id`). [O]
https://ai-sdk.dev/providers/community-providers/mem0

---

## Microsoft Semantic Kernel

Two generations plus a separate successor product.
- **Legacy "semantic memory"**: `ISemanticTextMemory`/`SemanticTextMemory` +
  `IMemoryStore` connectors + `TextMemoryPlugin`. Now explicitly legacy. [O]
  https://learn.microsoft.com/en-us/semantic-kernel/concepts/vector-store-connectors/memory-stores
- **Vector Store abstractions** (the replacement): `VectorStore`/
  `VectorStoreCollection` (`Microsoft.Extensions.VectorData`) +
  `VectorStoreTextSearch`. [O]
  https://learn.microsoft.com/en-us/semantic-kernel/concepts/vector-store-connectors/
- **SK agent memory** via `AgentThread.AIContextProviders` with `Mem0Provider` /
  `WhiteboardProvider` (experimental, C#-only). [O]
  https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-memory
- **Microsoft Agent Framework** — separate successor ("direct successor to both
  Semantic Kernel and AutoGen") with `AIContextProvider`, `TextSearchProvider`,
  `FoundryMemoryProvider`. [O] https://learn.microsoft.com/en-us/agent-framework/overview/

Legacy API: `SemanticTextMemory(IMemoryStore storage, ITextEmbeddingGenerationService
embeddingGenerator)` — **a store + a mandatory embedding generator**. [O]
https://learn.microsoft.com/en-us/dotnet/api/microsoft.semantickernel.memory.semantictextmemory .
`TextMemoryPlugin` (v1.45.0-alpha) exposes four model-callable functions:
**`Recall`** (`input, collection, relevance, limit`), **`Save`** (`input, key,
collection`), **`Retrieve`** (`key, collection`), **`Remove`** — with constants
`DefaultCollection="generic"`, `DefaultLimit=1`. [O]
https://raw.githubusercontent.com/microsoft/semantic-kernel/main/dotnet/src/Plugins/Plugins.Memory/TextMemoryPlugin.cs

1. **Scoping:** legacy has **no built-in user/session scope** — only the
   developer-chosen `collection` string per call. First-class user/thread scope
   exists only in the provider layer (`Mem0Provider` `UserId`/`ThreadId`) and
   Agent Framework (`FoundryMemoryProvider(scope="user-123")`). [O] agent-memory,
   https://learn.microsoft.com/en-us/agent-framework/get-started/memory
2. **Write/extraction:** legacy **explicit only** (`SaveInformationAsync`, or the
   model calls `TextMemoryPlugin.Save`); no background extraction; all async. The
   agent providers add **automatic background extraction** (every thread message →
   Mem0/whiteboard). [O] agent-memory.
3. **Consolidation/forgetting:** legacy = upsert-by-id + explicit `RemoveAsync`,
   no reconciliation [O-shape/I]. `WhiteboardProvider` has an LLM add/update/remove
   maintenance step + capacity eviction (`MaxWhiteboardMessages`); Mem0 delegates
   consolidation to its service. [O] agent-memory.
4. **Recall:** legacy = **model-callable retrieval top-K** (`Recall`, semantic
   cosine via `minRelevanceScore`, default 0.7). Agent providers inject matched
   memories on every invocation. Agent Framework `TextSearchProvider` defaults to
   `BeforeAIInvoke` injection and supports `vector` and `keyword_hybrid` (lexical).
   [O] search API page, agent-memory,
   https://learn.microsoft.com/en-us/agent-framework/agents/rag
5. **Typing:** legacy records essentially untyped (`id, text, description,
   additionalMetadata, embedding`; local-copy vs reference). `WhiteboardProvider`
   adds requirements/proposals/decisions/actions. [O] agent-memory.
6. **Storage:** a store is required, but the zero-dependency default is
   **in-memory** (`VolatileMemoryStore` legacy / "In-Memory" connector new). **No
   external vector DB required to start.** SQLite connector = `Connectors.SqliteVec`.
   [O] out-of-the-box-connectors,
   https://learn.microsoft.com/en-us/semantic-kernel/support/migration/vectorstore-may-2025

---

## Microsoft AutoGen (v0.4+, Python)

The **`Memory` protocol** (`autogen_core.memory`) is an async ABC with
`update_context(model_context)`, `query(query)`, `add(content)`, `clear()`,
`close()`. Types: `MemoryContent(content, mime_type, metadata)`,
`MemoryMimeType`, `MemoryQueryResult`, `UpdateContextResult`. **The base protocol
has no user_id or session concept** — `add()` takes only content. [O]
https://raw.githubusercontent.com/microsoft/autogen/main/python/packages/autogen-core/src/autogen_core/memory/_base_memory.py ,
https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/memory.html

- **`ListMemory`:** in-memory list; `add()` appends (no dedupe/extraction);
  `query()` **ignores the query and returns ALL contents**; `update_context()`
  injects **every** item as one `SystemMessage`. [O]
  https://raw.githubusercontent.com/microsoft/autogen/main/python/packages/autogen-core/src/autogen_core/memory/_list_memory.py
- **`AssistantAgent`** integration: `memory: Sequence[Memory] | None`; in
  `on_messages_stream` STEP 2 "Update model context with any relevant memory"
  runs before inference, calling `update_context` on each memory. **Read-only —
  the agent never calls `add()` itself.** [O]
  https://raw.githubusercontent.com/microsoft/autogen/main/python/packages/autogen-agentchat/src/autogen_agentchat/agents/_assistant_agent.py
- **`ChromaDBVectorMemory`** (`autogen_ext`): `collection_name`,
  `distance_metric="cosine"`, `k=3`, `persistence_path="./chroma_db"`; embedders
  Sentence-Transformers `all-MiniLM-L6-v2` (default) or OpenAI `text-embedding-
  ada-002`; semantic top-k, "No deduplication performed"; query = last message.
  [O] .../autogen_ext/.../chromadb/_chroma_configs.py and `_chromadb.py`.
- **`Mem0Memory`** (`autogen_ext`): `user_id` (auto-UUID), `limit=10`,
  `is_cloud=True` — **the only built-in with a real user concept**; wrapper
  forwards to Mem0, which does extraction/consolidation ([I]). [O]
  .../autogen_ext/.../mem0/_mem0.py.
- **Task-Centric Memory** (experimental): `MemoryController` + `MemoryBank` — the
  one component with **built-in automatic LLM extraction** (`train_on_task`,
  `learn_from_failure`); stores `Memo{task, insight}` with pickle persistence +
  ChromaDB similarity. Not on the `Memory`-protocol path. [O]
  .../experimental/task_centric_memory/memory_controller.py.

Dimensions: **(1) scoping** — base protocol has none; `ListMemory`/`Chroma` scope
= the instance; Mem0 = per-`user_id`; "agent" scope = which agent you attach
`memory=[...]` to. **(2) write** — explicit `await memory.add()` for List/Chroma
(agent loop reads only); Mem0 backend-extracts; Task-Centric auto-extracts; all
async. **(3) consolidation** — List append-only/`clear()`; Chroma "no dedup";
Mem0 backend merges. **(4) recall** — unified via `update_context` → SystemMessage;
List **injects ALL** (query ignored); Chroma/Mem0 top-K semantic from last
message. **(5) typing** — `MemoryContent` mime+metadata, no built-in
episodic/semantic taxonomy. **(6) storage** — `ListMemory` = in-process ephemeral
list; a vector DB is **not** required generally (only Chroma/Redis/Mem0 use
external). [O] all source files above.

---

## Agno (formerly Phidata)

API renamed across three eras; current = **v3.x** (latest `v3.1.12`, 2026-10-29).
[O] https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/agent/agent.py .
In v3, `enable_user_memories` and `search_session_history`/`num_history_sessions`
were **removed**; the automatic flag is now **`update_memory_on_run`**;
cross-session search is **`search_past_sessions`**/`num_past_sessions_to_search`.
Docs lag the code (still mention `enable_user_memories`). [O] agent.py;
https://www.agno.com/articles/memory ([I] doc drift).

**Three tiers (taxonomy):** (1) **session history** (runs/messages keyed by
`session_id`), (2) **user memories** (`UserMemory` via `MemoryManager`,
third-person facts keyed by `user_id`, cross-session), (3) **session summaries**
(stored on the session record `session.summary`). `UserMemory` fields: `memory,
memory_id, topics: List[str], user_id, input, created_at, updated_at, feedback,
agent_id, team_id`. [O]
https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/db/schemas/memory.py ,
https://docs.agno.com/basics/memory/agent/overview

1. **Scoping:** `session_id` (session), **first-class `user_id`** (primary key for
   memories; **falls back to literal `"default"` if None**), plus `agent_id`/
   `team_id` attribution. `user_id` passed at call time
   (`agent.print_response(..., user_id=...)`). Gotcha: `clear()`→`db.clear_memories()`
   is **not** user-scoped unless `user_id` passed. [O]
   https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/memory/manager.py
2. **Write/extraction — BOTH + manual:**
   - **Automatic background:** `update_memory_on_run=True` runs
     `MemoryManager.create_user_memories(...)` **after each run, in a background
     thread/asyncio task**. [O]
     https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/agent/_managers.py
   - **Agentic (model-driven):** `enable_agentic_memory=True` adds the
     `update_user_memory` tool; the model decides add/update/delete/clear; a
     `<updating_user_memories>` block is injected into the system prompt. Agentic
     takes precedence (mutually exclusive). [O]
     https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/agent/_default_tools.py ,
     https://docs.agno.com/memory/agent/agentic-memory
   - **Manual:** `add_user_memory`, `replace_user_memory`, `delete_user_memory`,
     `get_user_memories`, `search_user_memories`, `clear_user_memories` (+ async).
     Extraction model default `OpenAIChat(id="gpt-4o")`. [O] manager.py.
3. **Consolidation/forgetting:** `MemoryManager` gates tools via `add_memories=True,
   update_memories=True, delete_memories=False, clear_memories=False`. Extraction
   prompt instructs dedupe ("rather update existing memories"; preserve what
   preferences "used to be"); the model sees `<existing_memories>` to pick
   add/update/delete/no-op. Also `optimize_memories` + pluggable **strategies**. [O]
   manager.py.
4. **Recall — two paths, NO vectors in the user-memory path:**
   - **Default = full injection** (not top-K): `add_memories_to_context` injects
     **ALL** the user's memories into the system prompt inside
     `<memories_from_previous_interactions>`, keyed by `user_id`, no similarity
     ranking. [O]
     https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/agent/_messages.py
   - **Explicit `search_user_memories`:** `retrieval_method ∈ {"last_n","first_n",
     "agentic"}`, default `"last_n"` (recency). `"agentic"` = **LLM-as-ranker
     picks relevant IDs** (not embedding similarity). [O] manager.py.
   - **Session history:** `add_history_to_context=True` (`num_history_runs`
     default **3**); `read_chat_history=True` adds a `get_chat_history` tool;
     cross-session via `search_past_sessions`. Session summary injected into
     `<summary_of_previous_interactions>`. [O] agent.py, _default_tools.py, _messages.py.
5. **Typing:** three tiers above; user memories carry LLM-assigned `topics` tags,
   `feedback`, timestamps, `agent_id`/`team_id`. [O] db/schemas/memory.py.
6. **Storage:** unified `Db` backends — `SqliteDb`, `PostgresDb`, `MongoDb`,
   `RedisDb`, `InMemoryDb`. One `Db` holds all tiers in relational tables
   (default `agno_sessions`, `agno_runs`, **`agno_memories`**, `agno_metrics`);
   summaries live on the session record. **A vector DB is NOT required** — user
   memories are relational, recalled by full injection or LLM-ID selection
   (vector DBs like `PgVector`/`ChromaDb` are only for the separate Knowledge/RAG
   tier). **No implicit default DB:** if `db is None`, "Memories will not be
   stored" — you must pass `SqliteDb(...)` or `InMemoryDb()`. [O]
   https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/db/base.py ,
   https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/db/sqlite/sqlite.py

---

## Cross-cutting patterns (for a SQLite, no-vector-DB TypeScript agent)

1. **Two-tier split is universal:** short-term = the (checkpointed) transcript
   keyed by thread/session; long-term = extracted facts keyed by user. LangGraph,
   LlamaIndex, CrewAI, Agno, SK agent providers all draw this line.
2. **Scope = namespacing, not a bespoke API.** LangGraph's namespace tuple
   `(user_id, "memories")` and Agno's `user_id` (→`"default"`) are the cleanest
   models: a composite key `(user_id, kind, key)` is enough.
3. **Two write paths, often both:** hot-path **model-callable tool**
   (`manage_memory`, `update_user_memory`) and **background extractor**
   (`create_memory_store_manager` + `ReflectionExecutor`, Agno
   `update_memory_on_run`, LlamaIndex token-flush). Background is debounced to run
   once per completed turn/conversation.
4. **Consolidation is LLM-mediated patch-by-id:** show the model
   `<existing_memories>` + `enable_inserts/updates/deletes` gates; it chooses
   create/update/delete. Profile (overwrite) vs collection (dedupe) is the key
   dial (LangMem). CrewAI-classic/LlamaIndex-vector do almost no consolidation.
5. **Vector DB is optional for the user-memory tier.** Agno (relational +
   inject-all / LLM-ranker), LangGraph (KV + filter), SK (in-memory default), and
   LlamaIndex-fact all work without embeddings. Vectors matter only when the
   memory set is too large to inject wholesale — then top-K semantic search wins.
6. **Recall for a *small* user-memory set defaults to inject-all** (Agno,
   AutoGen `ListMemory`, LangMem profiles). Retrieval top-K (semantic) is reserved
   for large corpora; a model-callable recall tool is the third option and pairs
   naturally with an always-in-prompt catalog (our skills pattern).

---

## Caveats / confidence notes

- LangGraph: concept/reference pages now redirect to docs.langchain.com /
  reference.langchain.com; exact signatures came from GitHub source. pgvector as
  the concrete Postgres semantic backend is [I].
- CrewAI: `docs.crewai.com` is a client-rendered SPA (WebFetch returns the shell);
  all CrewAI claims use GitHub raw/API. Classic write-trigger method names and the
  `TaskEvaluator` path are [I]; the LTM row schema and read path are [O].
- OpenAI Agents SDK: `raw.githubusercontent` repo path 404'd; claims are from the
  rendered official docs (primary).
- SK `TextMemoryPlugin` ships v1.45.0-**alpha**; SK agent memory is
  experimental/C#-only; Agent Framework GA dates seen only via search summaries [I].
- Agno: docs lag the v3 rename (`enable_user_memories` → `update_memory_on_run`)
  [I]; structural claims are from current `main` source [O].
- Mem0's fact-extraction/merge behavior (used by OpenAI SDK, Vercel, SK, AutoGen
  bolt-ons) is Mem0-backend behavior [I], inferred from the wrappers' delegation.

### Primary source index
- LangGraph persistence / add-memory: https://docs.langchain.com/oss/python/langgraph/persistence , https://docs.langchain.com/oss/python/langgraph/add-memory
- BaseStore source: https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/checkpoint/langgraph/store/base/__init__.py
- LangMem: https://langchain-ai.github.io/langmem/ , .../concepts/conceptual_guide/ , .../reference/memory/ , .../reference/tools/ , .../guides/memory_tools/ , .../background_quickstart/ , .../guides/delayed_processing/
- LlamaIndex: https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/ , https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/memory/memory.py (+ memory_blocks/static.py, fact.py, vector.py)
- CrewAI classic (v0.119.0): contextual_memory.py, storage/ltm_sqlite_storage.py, storage/rag_storage.py, utilities/paths.py, docs/concepts/memory.mdx
- CrewAI unified: https://github.com/crewAIInc/crewAI/blob/main/docs/edge/en/concepts/memory.mdx
- OpenAI Agents SDK: https://openai.github.io/openai-agents-python/sessions/ , https://openai.github.io/openai-agents-js/guides/running-agents/ ; Mem0: https://docs.mem0.ai/integrations/openai-agents-sdk
- Vercel AI SDK: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence , https://ai-sdk.dev/providers/community-providers/mem0
- Semantic Kernel: https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-memory , .../concepts/vector-store-connectors/memory-stores , TextMemoryPlugin.cs source ; Agent Framework: https://learn.microsoft.com/en-us/agent-framework/overview/
- AutoGen: _base_memory.py, _list_memory.py, _assistant_agent.py, autogen_ext chromadb/_chromadb.py, mem0/_mem0.py, experimental/task_centric_memory/* ; docs https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/memory.html
- Agno: agent.py, memory/manager.py, agent/_managers.py, agent/_default_tools.py, agent/_messages.py, db/schemas/memory.py, db/base.py, db/sqlite/sqlite.py (all raw.githubusercontent agno-agi/agno/main) ; https://docs.agno.com/basics/memory/agent/overview
