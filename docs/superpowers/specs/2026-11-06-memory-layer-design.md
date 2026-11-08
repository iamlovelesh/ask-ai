# Memory Layer — Design

Date: 2026-11-06
Status: Draft for approval
Owner: Lovelesh
Scope: `server/` (new memory module + store + API) and `web/` (Memories panel)

---

## 1. Intent & why

The agent has **no cross-conversation memory**. Each new session starts cold.
In-session recall is handled by `recent-turns` (last 3 turns verbatim, older
collapsed to one line — no summarization), and the CRM database holds domain
records. But everything *about the user* — their preferences, working style,
recurring goals, and context from past chats — evaporates when a session ends.

The survey of production CRM agents (`docs/research/2026-11-06-oss-crm-agents-survey.md`)
showed most of them treat the **CRM database itself as memory**. That means the
gap worth filling is precisely the set of durable facts that are **not** in the
CRM: who this user is and how they like to work.

We are building a **generic, two-tier memory layer** — not a one-off for a
single use case — patterned on the proven designs surveyed in the three
research docs below, but implemented natively on this codebase's own
primitives (SQLite, OpenRouter client with cost guard, the tool pattern, the
skills recall mechanism). We are **not** adopting mem0/Zep/Letta as
dependencies — only their pipeline shapes.

Supporting research (all committed under `docs/research/`):
- `2026-11-06-agent-memory-dedicated-frameworks.md` (mem0, Letta/MemGPT, Zep/Graphiti)
- `2026-11-06-agent-memory-frameworks.md` (LangGraph/LangMem, LlamaIndex, CrewAI, Agno, SDKs)
- `2026-11-06-agent-memory-products-and-theory.md` (ChatGPT/Claude/Gemini memory, Generative Agents, MemGPT, surveys)

### Why build, not buy (decided)
- mem0's architecture centers on a vector store + embeddings (optionally a graph
  DB); our stack is `node:sqlite` with no vector DB and a single OpenRouter
  provider. For a per-user set of *dozens* of facts, research was unanimous that
  **inject-all beats top-K embedding retrieval** — a vector store would be unused weight.
- mem0 is Python-first; its hosted API would ship CRM conversation data to a
  third party, against our privacy posture.
- The hard parts already exist here (durable SQLite, LLM client with cost guard,
  tool registration, FTS5, skills-style recall). The layer is mostly glue + two
  prompts. Building it keeps native integration with the event log, confirmation
  gate, cost meter, and virtual clock.

---

## 2. Goals / non-goals / anti-goals

### Goals
1. The agent **remembers durable facts about the user across conversations** and
   acts on them without being re-told.
2. Memory is **written two ways**: an explicit `memory__save` tool the model
   calls, and an **async background extractor** after each turn.
3. New information **consolidates** with old (dedupe, update, supersede) rather
   than piling up contradictions.
4. Recall is **cheap at read time** and mirrors the existing skills mechanism.
5. Users can **see, edit, delete** their memories and turn memory **off**
   (global switch + per-session incognito).
6. The layer is **generic** — a `category`-typed fact store, not hard-wired to
   any single scenario.

### Non-goals (v1)
- Embeddings / semantic vector recall (schema reserves room; not built).
- Per-customer / per-deal memory isolation (schema reserves a `scope_ref`
  column; recall stays per-user).
- Reflection trees, numeric importance scoring, decay/forgetting curves.
- A separate session-scoped fact store (session tier = existing `recent-turns`).
- Multi-tenant user management (single-tenant `DEMO_USER_ID` model stays).

### Anti-goals (these would make it a failure even if it "works")
- **Latency on the hot path.** Extraction must never delay the user's answer.
- **Silent memory the user can't inspect or correct.** No black box.
- **Remembering secrets/PII.** A sensitive-data denylist is mandatory, not optional.
- **Busting the system-prompt KV cache.** Per-turn memory content rides in the
  user message, never the cacheable system prompt.
- **Cross-contamination / leakage** of one session's ephemeral noise into durable
  memory via over-eager extraction. Salience gating is required.

---

## 3. Constraints (from the existing architecture)

(Source: explorer's architecture map; file refs are current as of this date.)

- **Durable store** is `server/data/sessions.db` via `node:sqlite`, schema as
  idempotent `CREATE TABLE IF NOT EXISTS` DDL in
  `server/src/store/sessions-db.ts` (tables `sessions`, `events`, `refs`,
  `spans`). **No migration framework** — add DDL and it applies on open.
- **The CRM db** (`crm-{profile}.db`) is template-resettable; memory must **not**
  live there (it would be wiped on reset). Memory goes in `sessions.db`.
- **Turn flow**: `runLoopTurn` in `server/src/loop/agent.ts` — an
  `AsyncGenerator`. It already emits a `memory.snapshot` event in `finalize()`
  (currently wired to an *empty* state, leftover from the retired plandsl
  pipeline). `finalize()` is the natural post-answer hook.
- **Tools**: `@openai/agents` `tool({name, description, parameters, execute})`,
  built per-turn by `buildTurnTools` in `server/src/loop/tools.ts`. Standing
  tools are registered there; a memory store is threaded via
  `BuildTurnToolsInput`. The **skills** tool
  (`session__load_skills`) is the closest precedent for a read tool: it returns
  on-demand text and is deliberately kept out of the NumberCheck evidence pool.
- **Prompts**: `server/src/loop/prompts.ts`. The **system prompt is static for
  KV-cache reuse**; per-turn material (now, anchors, `<previous_turns>`,
  request) rides in the **user prompt** (`buildLoopUserPrompt`). A recalled
  memories block therefore belongs in the user prompt.
- **LLM client**: `server/src/llm/client.ts` `llmCall()` (Vercel AI SDK over
  OpenRouter, with `generateObject` for structured output and a process-wide
  `costMeter` / `BudgetExceededError` guard). This is what the extractor/
  consolidator will use (structured output via zod).
- **Clock**: `server/src/store/clock.ts` — the `VirtualClock` is **pinned**
  (default `2026-11-04T10:00:00Z`, never ticks), so it is **wrong** for memory
  timestamps: every memory would carry an identical time and panel ordering /
  reopen tests would be meaningless. Therefore `created_at`/`updated_at`/
  `invalid_at` all use `wallClockNow()` (real bookkeeping, exactly like the
  `sessions` table's own `created_at`/`updated_at`). **Decision:** v1 has no
  separate agent-reasoned "learned on" (virtual-clock) column — `created_at`
  (wall-clock, surfaced in the panel) is sufficient; add one later only if the
  agent must reason about *when* within the pinned timeline a fact was learned.
- **User identity**: `DEMO_USER_ID` / `currentUser` (`agent.ts`). `user_id` is
  the memory scope key.
- **Lexical search** available: `minisearch` (BM25) already a dependency, and
  SQLite **FTS5** is available in `node:sqlite` — either can rank memories if the
  set grows beyond inject-all.
- **Testing**: Vitest; TDD is the house workflow. Every module ships with tests.

---

## 4. The design (decided)

### 4.1 Data model — one table, metadata-scoped

Add to `sessions-db.ts` DDL (durable, never reset):

```sql
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,          -- uuid
  user_id       TEXT NOT NULL,             -- scope key (DEMO_USER_ID today)
  scope_ref     TEXT,                      -- RESERVED (nullable): e.g. 'account:acme'
                                           -- for future per-customer isolation
  category      TEXT NOT NULL,             -- 'preference' | 'fact' | 'goal' | 'context'
  kind          TEXT NOT NULL,             -- 'profile' (overwrite-in-place) | 'collection' (dedupe-many)
  key           TEXT,                      -- stable slug for profile facts (e.g. 'date-format'); null for collection
  body          TEXT NOT NULL,             -- the memory text (the fact)
  source        TEXT NOT NULL,             -- 'tool' | 'extract' | 'user' (how it was written)
  source_session TEXT,                     -- session id it originated in
  source_seq    INTEGER,                   -- event seq for provenance
  created_at    INTEGER NOT NULL,          -- wall-clock ms (wallClockNow) — real bookkeeping for ordering
  updated_at    INTEGER NOT NULL,          -- wall-clock ms
  superseded_by TEXT,                      -- id of the memory that replaced this (soft-invalidate)
  invalid_at    INTEGER                    -- wall-clock ms when soft-invalidated; NULL = live
);
CREATE INDEX IF NOT EXISTS idx_memories_user_live
  ON memories(user_id) WHERE invalid_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_profile_key
  ON memories(user_id, category, key) WHERE kind='profile' AND invalid_at IS NULL;
```

Design notes:
- **Scope = WHERE filter**, not separate stores (mem0/LangGraph/Agno pattern).
  v1 recall filters by `user_id AND invalid_at IS NULL`. `scope_ref` is written
  but ignored by recall until per-customer isolation is enabled later.
- **Soft-invalidate, never hard-delete** from the pipeline (Zep). A user-initiated
  delete via the panel *does* hard-delete (their data, their call).
- **`kind` is the conflict dial**: `profile` facts (one per `key`, overwrite in
  place — e.g. "prefers EU dates"); `collection` facts (many, deduped by the
  consolidator — e.g. recurring goals).
- **Category** is the loose taxonomy (Claude Code's own set). No rigid
  episodic/semantic enum.
- **`scope_ref` is deliberately excluded from the unique index** in v1 because
  it stays NULL (per-user scope). When per-customer isolation is enabled later,
  the unique index **must** be widened to include `scope_ref`, or two profile
  facts differing only by `scope_ref` would wrongly collide. Noted here so the
  future change is a known one-line index swap, not a surprise.

### 4.2 Store module

`server/src/memory/store.ts` — a `MemoryStore` class modeled on the existing
`RefStoreImpl` pattern (a sqlite accessor over the long-lived `sessions.db`
handle; **user-scoped**, not session-scoped — it is keyed by `user_id`).

**New plumbing required (none of these fields exist yet):**
- `BuildTurnToolsInput.memory` and the `LoopSessionDeps.memory` hop it rides on
  (mirror how `refs`/`refsFor` are threaded).
- Construction site in `turn-runtime.ts drive()`, where a single `MemoryStore`
  is built over `sessionsDb` and passed down (alongside `refsFor`). The scope
  key `actingUserId` already exists on `BuildTurnToolsInput`.
- `llmCall`'s `Stage` union gains an `'extract'` (or `'memory'`) value for cost
  attribution (trivial type addition).

Methods:
- `listLive(userId): Memory[]`
- `get(id): Memory | undefined`
- `add(input): Memory`
- `supersede(oldId, newInput): Memory` — **order matters** because of the partial
  unique index on `(user_id, category, key)` for live profile rows: mint the new
  id first, then within a single manual transaction (`BEGIN` … `COMMIT`)
  **invalidate the old row first** (set `invalid_at` + `superseded_by` = new id),
  **then insert the new row**. Inserting first would throw a UNIQUE violation.
  `SessionsDb` exposes only `all/get/run/close` (no tx wrapper), so the store
  issues `BEGIN`/`COMMIT` via `run()` itself; a crash mid-transaction rolls back
  (acceptable; extractor is best-effort and retries next turn).
- `invalidate(id)` (soft)
- `remove(id)` (hard — panel delete only)
- `update(id, patch)` (panel edit only)

Pure, immutable inputs/outputs (house style). No mutation of returned rows.

### 4.3 Write path A — the `memory__save` tool (hot path)

A standing tool registered in `buildTurnTools`, threaded via
`BuildTurnToolsInput.memory`. Shape (mirrors `session__load_skills` as a
`session__`/`memory__` namespaced tool that returns a short string observation):

```
memory__save({ category, body, key? })
  → validates (zod), applies the denylist (§4.7), writes via store.add with
    source='tool', returns "saved" | "skipped: <reason>"
```

The model is instructed (system prompt, §4.6) to call it when the user states a
durable preference/goal/fact. Like skills, this tool's result is **not** fed
into the NumberCheck evidence pool.

### 4.4 Write path B — async background extractor + consolidator

Triggered from `finalize()` in `agent.ts` **after** `answer.final` is emitted —
fire-and-forget (not awaited on the turn's critical path). Debounced to **once
per completed turn**.

**Status gate (decided):** `finalize()` is reached by every exit
(`done`/`clarify`/`refused`/`failed`/`cancelled`/deadline). The extractor runs
**only when `status === 'done'`** — the substantive, successful turns. This
avoids spending a cheap LLM call on error/refusal/cancel turns (whose "final
answer" is an error string) and directly serves the "no ephemeral noise"
anti-goal. `clarify` turns are excluded in v1 too (conservative; revisit if we
find useful facts stated in clarification turns being missed).

**Lifecycle caveat (accepted):** the fire-and-forget extractor runs outside
`TurnRuntime.running`, so the ALREADY_RUNNING guard does not cover it — a new
turn may begin while a prior extractor is mid-LLM-call. This is safe because
`node:sqlite` writes are synchronous/atomic per statement and the store is
keyed by `user_id` (not the turn). Process shutdown mid-extraction silently
loses that one write; acceptable because extraction is best-effort and the next
turn re-reads fresh material. A code comment must state this explicitly.

Pipeline (mem0 extract→update, implemented with `llmCall` + `generateObject`):

1. **Salience gate + extract** (one cheap-model call): given the turn's user
   message + final answer (and the running memory index), return `candidates:
   MemoryCandidate[]` (possibly empty). Empty → stop, zero further cost.
2. **Consolidate** (one cheap-model call per candidate batch): given each
   candidate + the top matching existing live memories (matched by `key` for
   profile, by lexical/FTS5 similarity for collection), decide one of
   **ADD / UPDATE / DELETE / NOOP**. Apply via the store (UPDATE =
   `supersede`, DELETE = `invalidate`).

Cost/latency controls:
- Runs on a **cheap model** (Haiku-class, via the existing model id plumbing).
- Under the existing `costMeter` / `BudgetExceededError` guard — a failed or
  budget-exceeded extraction logs and no-ops; it never throws into the turn.
- Skipped entirely for **incognito** sessions (§4.5) and when memory is globally
  **off** (§4.5).
- An extraction failure is invisible to the user (best-effort, next turn retries
  on fresh material).

Open implementation choice (builder's call, §6): whether to also run a
**session-end roll-up** pass (consolidate the whole session once at the end) in
addition to per-turn extraction, or rely on per-turn only. Default: per-turn
only for v1; session-end roll-up deferred unless per-turn proves lossy.

### 4.5 Off switch & incognito

**Storage mechanism (decided):** `ALTER TABLE … ADD COLUMN` is **not** idempotent
in this `node:sqlite` build (a second run throws `duplicate column name`), so the
"add a column to an existing table" option is **rejected** — it would crash on
reopen. Both flags live in **new tables** created with `CREATE TABLE IF NOT
EXISTS` (the only mechanism §3 guarantees), in `sessions.db` (never reset):
- `memory_settings(user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER)`.
- `session_memory_flags(session_id TEXT PRIMARY KEY, incognito INTEGER NOT NULL DEFAULT 0)`
  (a per-session flag table, not a `sessions` column).

Behavior:
- **Global off** (`memory_settings.enabled = 0`), read at turn start: no recall
  injection, no tool write, no extractor.
- **Incognito session** (`session_memory_flags.incognito = 1`): recall still
  *reads* existing memories (default = **recall ON, write OFF** — "use what you
  know, learn nothing new"); the `memory__save` tool and the extractor are both
  suppressed for that session.

### 4.6 Recall — mirror the skills mechanism

Two parts, both in the **user prompt** (never the cacheable system prompt):

1. **Always-injected memories index** — a compact `<memories>` block built each
   turn from `store.listLive(userId)`, rendered as short `category/key: body`
   lines (budget-capped; if it would exceed the cap, fall back to a one-line
   summary index + rely on the recall tool). Populated via a new `recalled`
   field on `LoopUserPromptInput`, set in `agent.ts` alongside
   `<previous_turns>`.
2. **`memory__recall({ query })` tool** — on-demand full-body fetch /
   lexical search (FTS5 or minisearch) for when the index is summarized or the
   model wants more. Mirrors `session__load_skills`.

For v1's expected volume (dozens of facts) the index will usually be the full
set (**inject-all**, per research). The recall tool is the graceful-degradation
path as volume grows — and the seam where embeddings slot in later.

System-prompt additions (static, cacheable): a short "Memory" section in
`SYSTEM_PROMPT` telling the model (a) it has durable memory about this user,
(b) when to call `memory__save`, (c) that the `<memories>` block is
authoritative user context, (d) never to store secrets/credentials.

### 4.6.1 Interaction with the honesty rails (NumberCheck & grounding) — **decided**

Recalled memories ride in the **user prompt**, not `exits.toolOutputs`. But two
deterministic rails only trust tool outputs + user text:
- `numberCheck(finalText, exits.toolOutputs, userText)` flags any figure in the
  answer not supported by those sources.
- `needsGrounding` (DATA_CLAIM_RE) forces a wasted grounded re-run on a
  zero-tool answer that states a data claim.

So an answer that legitimately restates a figure/date recalled **from memory**
(e.g. "your quarterly target is $50k") would get a spurious `⚠ could not verify`
caution, and a memory-only answer could trigger a pointless grounded re-run.
The provenance instinct ("keep memory out of the evidence pool") conflicts with
these rails.

**Resolution (decided):** treat the recalled
`<memories>` text as an **allowed verification source** — pass it into
`numberCheck` as an additional supported-source corpus, and let it satisfy
`needsGrounding` so a memory-grounded answer does not force a re-run. Rationale:
a recalled memory *is* grounded data (it was written under the denylist + a
save/extract decision), so restating it is not fabrication. To keep the honesty
guarantee crisp, pair this with a light provenance cue: when an answer's figures
are supported only by memory (no tool output this turn), the model is instructed
to attribute it ("from what I remember, …"). This preserves "never fabricate"
while removing false warnings. See §8 for the alternative considered.

### 4.7 Privacy — sensitive-data denylist (mandatory)

Applied at **both** write paths before anything is persisted (Anthropic's model,
per the products research): never store government IDs, financial account /
card / credential data, criminal/immigration/health data, or anything that looks
like a secret/token. Implemented as a deterministic pre-write filter
(`server/src/memory/denylist.ts`) plus an instruction in the extractor prompt.
A rejected write returns `skipped: sensitive` (tool) or is dropped silently
(extractor). Also validate memory bodies for prompt-injection / control-token
content before injecting at recall time.

### 4.8 Control surface — API + web panel

HTTP endpoints (Fastify, alongside `server/src/api/sessions.ts`):
- `GET /api/memories` → list live memories for the user.
- `PATCH /api/memories/:id` → edit body/category.
- `DELETE /api/memories/:id` → hard delete.
- `PUT /api/memories/settings` → global on/off.
- `PATCH /api/sessions/:id` (or dedicated route) → incognito on/off.

**Web Memories panel** (`web/`): list grouped by category, inline edit, delete,
a global memory on/off switch, and a per-session incognito toggle. Visual
design follows the existing enterprise UI direction already
established in the web app. A mockup will be produced during planning/
implementation.

---

## 5. How it ties together (turn lifecycle)

```
POST /messages → runLoopTurn:
  turn.started
  load prior events (recent-turns, unchanged)
  build recalled = render(store.listLive(userId))        ← NEW (recall)
  build tools incl. memory__save, memory__recall          ← NEW
  build system prompt (static, + Memory section)          ← NEW (static)
  build user prompt incl. <memories> block                ← NEW (recall)
  run @openai/agents loop (model may call memory__save)    ← NEW (write A)
  grounding / numbercheck re-run (unchanged)
  finalize():
     answer.final                                          (unchanged)
     memory.snapshot                                       (unchanged event)
     fire-and-forget extractor+consolidator(turn)          ← NEW (write B, async)
     touchSession                                          (unchanged)
```

Incognito/off short-circuits the NEW steps per §4.5.

---

## 6. What's left to the builder

- Exact cheap-model id for extraction (reuse the model allowlist/`plannerModel`
  plumbing; pick the cheapest capable tier — a fixed Haiku-class id, not the
  user-selected `turnModel`).
- `<memories>` byte budget and the summarize-vs-inject-all threshold.
- Index/search mechanism for the recall tool (FTS5 vs minisearch) — both
  present; pick one.
- Panel visual details (mockup during implementation).

Resolved by the builder-check (no longer open): timestamps use wall-clock;
status gate = `done` only; settings/incognito live in new `CREATE TABLE IF NOT
EXISTS` tables (not ALTER columns); supersede order (invalidate-then-insert in a
manual tx); no session-end roll-up in v1 (per-turn only). Everything in §4 is
decided; the items above are local calls that don't change *what* gets built.

---

## 7. Test plan (TDD, Vitest)

- **Store**: add/get/listLive/supersede/invalidate/remove/update; unique profile
  key constraint; soft-invalidate hides from `listLive`; survives reopen.
- **Denylist**: rejects secrets/IDs/financial/credential patterns; passes benign
  preferences.
- **Consolidation**: ADD creates; UPDATE supersedes the right row and links
  `superseded_by`; DELETE soft-invalidates; NOOP no-ops; profile overwrite vs
  collection dedupe behave per `kind`. (Consolidator LLM mocked via the existing
  mock-llm helper.)
- **Extractor**: empty candidates → no writes; salience gate drops trivia;
  budget-exceeded / LLM error → no-op, never throws into the turn.
- **Recall rendering**: `<memories>` block format; inject-all under budget;
  summarize + recall-tool path over budget; off/incognito suppress recall/write.
- **Tools**: `memory__save` writes with `source='tool'` and applies denylist;
  `memory__recall` returns bodies; neither pollutes NumberCheck evidence.
- **API**: list/edit/delete/settings/incognito endpoints; auth scoping to user.
- **Integration**: two sequential sessions — fact learned in session A is
  recalled in session B; deleting it in the panel removes it from session C's
  recall.
- **Honesty-rail interaction** (§4.6.1): a figure recalled from memory and
  restated in the answer is **not** flagged by `numberCheck` and does **not**
  trigger a `needsGrounding` re-run (once memory is an allowed source). The most
  likely correctness regression — must be covered.
- **Recall stays out of the evidence pool**: the always-injected `<memories>`
  block is in the user prompt and is **not** present in `exits.toolOutputs`
  (distinct from being an allowed `numberCheck` corpus — it is passed explicitly,
  not via the tool-output channel).
- **KV-cache stability**: adding the static "Memory" section to `SYSTEM_PROMPT`
  keeps the system prompt byte-stable across turns (anti-goal #4) — a simple
  byte-equality assertion across two turns.
- **Concurrency**: a second turn starting while the prior fire-and-forget
  extractor writes on the shared `sessions.db` handle does not corrupt state or
  throw.

---

## 8. Alternatives considered (for §4.6.1)

The alternative to making memory an allowed verification source is to **keep the
rails strict** and require the model to *re-fetch from the CRM* any figure it
wants to state, treating memory as hint-only (never quotable). Rejected for v1:
much of what we remember (preferences, goals, user-stated targets) has **no CRM
row to re-fetch**, so strict rails would make memory unusable for exactly the
facts it exists to hold, and would emit false warnings on correct answers. The
recommended approach (memory = allowed source + "from memory" provenance cue)
keeps fabrication protection for genuinely unsupported figures while letting the
agent use what it legitimately knows. If a future need arises to distinguish
"CRM-verified" from "remembered" figures in the UI, that is an additive
provenance tag, not a rail change.
