# Memory Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent durable, user-scoped memory that is written (by tool + async extractor), consolidated, recalled into the prompt, and manageable by the user.

**Architecture:** One user-scoped `memories` table in the durable `sessions.db`. Two write paths — a `memory__save` tool and a fire-and-forget post-turn extractor that consolidates via ADD/UPDATE/DELETE/NOOP with soft-invalidation. Recall mirrors the existing skills mechanism: a `<memories>` block in the (per-turn) user prompt plus a `memory__recall` tool; no embeddings. A web panel + HTTP API provide view/edit/delete, a global off switch, and per-session incognito. Memory counts as a trusted source for the honesty rails.

**Tech Stack:** TypeScript (ESM, Node ≥22.5), `node:sqlite`, `@openai/agents`, `ai` v5 over OpenRouter (`llmCall`), zod v4, Fastify v5 (server); Vue 3 + Pinia + vue-router (web); Vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-memory-layer-design.md`

## Global Constraints

- ESM with explicit `.js` import extensions; Node ≥22.5; no `any` (use `unknown`+narrow); explicit types on exported APIs.
- **No new runtime dependencies** — no vector DB, no embeddings. Lexical only (plain filter / `minisearch`/FTS5 already present).
- Persistence is `node:sqlite` in **`sessions.db` only** (never the resettable CRM db). New tables via `CREATE TABLE IF NOT EXISTS` added to `sessions-db.ts`'s `SCHEMA` array — **never `ALTER TABLE … ADD COLUMN`** (not idempotent in this build).
- Timestamps use `wallClockNow()` (from `store/clock.ts`); ids use `randomUUID()` (from `node:crypto`).
- Immutability (spread, no in-place mutation of returned rows); files < 800 lines; functions < 50 lines.
- Extraction is **async, best-effort, and must never throw into a turn**; it runs under the existing `costMeter`/`BudgetExceededError` guard on a cheap model.
- The system prompt must stay **byte-stable** across turns (the Memory section added to it is static). All per-turn memory content rides in the **user** prompt.
- Recalled memory text must **never** be pushed into `exits.toolOutputs` (the NumberCheck evidence pool); it is passed to `numberCheck` explicitly as `extraEvidence`.
- Vitest, TDD, ≥80% coverage. Server tests in `server/test/*.test.ts` (LLM mocked via `server/test/helpers/mock-llm.ts` + `__setTestFetch`); web tests in `web/src/**/__tests__/`. No `console.log` (server-side errors use `console.error`, matching `agent.ts`).
- Single-tenant: the acting user id is `process.env['DEMO_USER_ID'] || 'user_1'`.

## Review Focus

- **Prompt-injection inside a memory body** (e.g. a body containing `</memories>` or "ignore your rules"): at recall it must be sanitized/escaped and remain inert data, never close the block or act as an instruction. → Task 3 tests.
- **Malformed extractor output / stale target id** (garbage structured output, or UPDATE/DELETE naming an id that doesn't exist or isn't the user's): the consolidator no-ops and the extractor never throws. → Task 6 tests.
- **Memory volume over the inject-all byte budget**: recall degrades to a truncated summary + "use memory__recall" note, and the static system prompt stays byte-identical across turns (no KV-cache bust). → Task 3 tests.
- **Global-off and incognito**: global-off suppresses recall *and* all writes (tool + extractor); incognito keeps recall but suppresses all writes. → Task 7 tests.
- **Cross-user id on PATCH/DELETE**: an id belonging to another `user_id` must not be read, edited, or deleted — the scope filter holds even single-tenant. → Task 9 tests.

---

### Task 1: Memory types + store (schema, CRUD, supersede, settings)

**Files:**
- Create: `server/src/memory/types.ts`
- Create: `server/src/memory/store.ts`
- Modify: `server/src/store/sessions-db.ts:38-89` (append three tables + indexes to `SCHEMA`)
- Test: `server/test/memory-store.test.ts`

**Interfaces:**
- Consumes: `SessionsDb` (`store/sessions-db.ts:24`), `wallClockNow` (`store/clock.ts`), `randomUUID` (`node:crypto`).
- Produces:
  ```ts
  // types.ts
  export type MemoryCategory = 'preference' | 'fact' | 'goal' | 'context';
  export type MemoryKind = 'profile' | 'collection';
  export type MemorySource = 'tool' | 'extract' | 'user';
  export interface Memory {
    id: string; userId: string; scopeRef?: string;
    category: MemoryCategory; kind: MemoryKind; key?: string; body: string;
    source: MemorySource; sourceSession?: string; sourceSeq?: number;
    createdAt: number; updatedAt: number; supersededBy?: string; invalidAt?: number;
  }
  export interface NewMemory {
    userId: string; category: MemoryCategory; kind: MemoryKind; key?: string;
    body: string; source: MemorySource; scopeRef?: string;
    sourceSession?: string; sourceSeq?: number;
  }
  export interface MemoryPatch { body?: string; category?: MemoryCategory; }

  // store.ts
  export interface MemoryStore {
    listLive(userId: string): Memory[];              // invalid_at IS NULL, newest first
    get(id: string): Memory | undefined;
    add(input: NewMemory): Memory;
    supersede(oldId: string, input: NewMemory): Memory;
    invalidate(id: string): void;                    // soft
    remove(id: string): void;                        // hard delete (panel)
    update(id: string, patch: MemoryPatch): Memory | undefined;  // panel edit
    isEnabled(userId: string): boolean;              // default true
    setEnabled(userId: string, enabled: boolean): void;
    isIncognito(sessionId: string): boolean;         // default false
    setIncognito(sessionId: string, incognito: boolean): void;
  }
  // `now` is an injectable monotonic clock for deterministic tests; defaults to wallClockNow.
  export function createMemoryStore(db: SessionsDb, now?: () => number): MemoryStore;
  ```

- [ ] **Step 1: Write the failing tests** in `server/test/memory-store.test.ts` (open a tmp `SessionsDb` via `openSessions(':memory:')` or a tmp file; inject a monotonic `now = () => ++t`):
  - `add` then `listLive` returns the row; fields round-trip; `createdAt`/`updatedAt` set from injected clock.
  - `listLive` returns newest-first and **excludes** invalidated rows.
  - profile unique key: `add` a second live profile memory with the same `(userId, category, key)` throws (DB UNIQUE), but `supersede` succeeds.
  - `supersede(oldId, newInput)`: old row gets `invalidAt` + `supersededBy = new.id`, new row is live, and **no UNIQUE violation** (old invalidated before insert, one transaction).
  - `invalidate` hides from `listLive`; `get` still returns it with `invalidAt` set.
  - `remove` hard-deletes (`get` → undefined).
  - `update` changes body/category, bumps `updatedAt`, returns the new row; unknown id → undefined.
  - cross-user isolation: `listLive('user_2')` does not see `user_1`'s rows.
  - settings: `isEnabled` defaults true; `setEnabled(false)` persists; `isIncognito` defaults false; `setIncognito(true)` persists.
  - reopen: close + reopen the same file → rows and settings survive.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w server test -- memory-store`
Expected: FAIL (module/table not found).

- [ ] **Step 3: Add DDL to `sessions-db.ts` `SCHEMA`** — three `CREATE TABLE IF NOT EXISTS` statements + indexes, copied from spec §4.1 (`memories` with the partial unique index on `(user_id, category, key) WHERE kind='profile' AND invalid_at IS NULL` and the partial index on live rows by user), plus `memory_settings(user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER)` and `session_memory_flags(session_id TEXT PRIMARY KEY, incognito INTEGER NOT NULL DEFAULT 0)`.

- [ ] **Step 4: Implement `types.ts` and `createMemoryStore` in `store.ts`** — a class modeled on `RefStoreImpl` (`agent/refs.ts:142`). `supersede` order (spec §4.2): mint new id, `db.run('BEGIN')`, UPDATE old row set `invalid_at`+`superseded_by`, INSERT new row, `db.run('COMMIT')` (wrap in try/`ROLLBACK`). Map rows ↔ `Memory` with a `rowToMemory` helper (null columns → omitted optional fields). `isEnabled`/`isIncognito` read the settings tables with `INSERT OR REPLACE` writers.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm -w server test -- memory-store`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/memory/types.ts server/src/memory/store.ts server/src/store/sessions-db.ts server/test/memory-store.test.ts
git commit -m "feat(memory): user-scoped memory store + settings tables"
```

---

### Task 2: Sensitive-data denylist

**Files:**
- Create: `server/src/memory/denylist.ts`
- Test: `server/test/memory-denylist.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DenylistResult { allowed: boolean; reason?: string; }
  export function screenMemory(body: string): DenylistResult;
  ```

- [ ] **Step 1: Write the failing tests** — `screenMemory` returns `allowed:false` with a reason for: a credit-card-shaped number (13–16 digits, with/without spaces/dashes), an SSN `\d{3}-\d{2}-\d{4}`, an API-key/token (`sk-…`, long hex/base64 ≥ 32 chars, `Bearer …`), a line containing `password`/`passcode`/`secret is`; and `allowed:true` for benign preferences ("prefers EU date format", "quarterly target is $50k", "works in sales ops").

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w server test -- memory-denylist`
Expected: FAIL

- [ ] **Step 3: Implement `screenMemory`** — a list of labeled regex rules; first match wins and returns its reason; otherwise allowed. Pure function.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w server test -- memory-denylist`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/denylist.ts server/test/memory-denylist.test.ts
git commit -m "feat(memory): sensitive-data denylist screen"
```

---

### Task 3: Recall rendering + prompt injection points

**Files:**
- Create: `server/src/memory/render.ts`
- Modify: `server/src/loop/prompts.ts:21-149` (static Memory section in `SYSTEM_PROMPT`), `:188-217` (`LoopUserPromptInput` + `buildLoopUserPrompt`)
- Test: `server/test/memory-render.test.ts`, extend `server/test/loop-prompts.test.ts`

**Interfaces:**
- Consumes: `Memory` (Task 1).
- Produces:
  ```ts
  // render.ts
  export interface RenderMemoriesOptions { budgetChars?: number; } // default 4000
  export function renderMemories(memories: readonly Memory[], opts?: RenderMemoriesOptions): string; // inner block text; '' if none
  export function sanitizeForPrompt(body: string): string; // newlines→spaces; strip '<'/'>' and any '</memories' sequence
  // prompts.ts — LoopUserPromptInput gains:
  //   recalledMemories?: string;   // pre-rendered inner block text; omitted/'' => no block
  ```

- [ ] **Step 1: Write the failing tests:**
  - `render.ts`: empty list → `''`. Non-empty → one line per memory `- [preference] date-format: prefers EU dates` (profile shows `key: body`; collection shows `body`). Over `budgetChars` → each body truncated and a trailing line `(… more in memory — use memory__recall)`; result length ≤ budget + margin. `sanitizeForPrompt` collapses newlines and neutralizes a body containing `</memories>` and `ignore your rules` (the text remains but cannot close the block / is clearly data).
  - `loop-prompts.test.ts`: `buildLoopUserPrompt` with `recalledMemories` non-empty includes a `<memories>` block **before** `<previous_turns>`; with it omitted/empty, no `<memories>` block appears. `buildLoopSystemPrompt(catalog)` is **byte-identical** when called twice with the same catalog (Memory section is static), and contains a "Memory" section mentioning `memory__save`/`memory__recall` and "from what I remember".

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w server test -- memory-render loop-prompts`
Expected: FAIL

- [ ] **Step 3: Implement `render.ts`**; add the static **Memory** section to `SYSTEM_PROMPT` (tells the model it has durable memory about this user, when to call `memory__save`, that `<memories>` is authoritative user context, to attribute memory-derived figures with "from what I remember", and never to store secrets); add `recalledMemories?: string` to `LoopUserPromptInput` and emit a `<memories>`-wrapped block in `buildLoopUserPrompt` immediately before `<previous_turns>` when non-empty. Apply `sanitizeForPrompt` inside `renderMemories`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w server test -- memory-render loop-prompts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/render.ts server/src/loop/prompts.ts server/test/memory-render.test.ts server/test/loop-prompts.test.ts
git commit -m "feat(memory): recall rendering + prompt injection (user block + static Memory section)"
```

---

### Task 4: NumberCheck accepts memory as evidence

**Files:**
- Modify: `server/src/loop/number-check.ts:59-60`
- Test: extend `server/test/` NumberCheck tests (create `server/test/number-check-memory.test.ts` if none exists for this file).

**Interfaces:**
- Produces: `numberCheck(draft: string, toolOutputs: readonly string[], userText?: string, extraEvidence?: readonly string[]): NumberCheckResult` (new optional 4th param, default `[]`).

- [ ] **Step 1: Write the failing test** — a figure present only in `extraEvidence` (e.g. `"$50,000"`) is **supported** (`ok:true`); the same figure absent from outputs/userText/extraEvidence is `unsupported`. A date present only in `extraEvidence` is supported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- number-check-memory`
Expected: FAIL

- [ ] **Step 3: Implement** — change line 60 to `const outputs = [...toolOutputs, ...extraEvidence].join('\n')` and add the `extraEvidence: readonly string[] = []` parameter. (Folding into `outputs` makes memory feed the numeric pool, the date pool, and the id/name evidence uniformly.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- number-check-memory`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/loop/number-check.ts server/test/number-check-memory.test.ts
git commit -m "feat(memory): numberCheck accepts recalled memory as evidence"
```

---

### Task 5: `memory__save` + `memory__recall` tools

**Files:**
- Modify: `server/src/loop/tools.ts:286-309` (`BuildTurnToolsInput`), `:1033-1050` (standing-tool construction + the `tools.push(...)` registration)
- Test: `server/test/loop-tools-memory.test.ts`

**Interfaces:**
- Consumes: `MemoryStore` (Task 1), `screenMemory` (Task 2), `exits`/`actingUserId` already on `BuildTurnToolsInput`.
- Produces: `BuildTurnToolsInput` gains `memory?: MemoryStore;` and `memoryWritable?: boolean;`. Two tools registered only when `input.memory` is defined.
  - `memory__save({ category: MemoryCategory, body: string, key?: string })` → applies `screenMemory`; kind = `key ? 'profile' : 'collection'`; writes via `memory.add({ userId: actingUserId, source: 'tool', ... })`; returns `"saved"`, `"skipped: sensitive"`, or (when `memoryWritable === false`) `"memory is off for this chat — not saved"`.
  - `memory__recall({ query: string })` → lexical filter over `memory.listLive(actingUserId)`; returns matching bodies joined, or "no matching memories". **Does NOT push to `exits.toolOutputs`.**

- [ ] **Step 1: Write the failing tests** (build tools via `buildTurnTools` with a real in-memory `MemoryStore` and a stub registry/cards=[]):
  - calling `memory__save`'s `execute` with a benign body writes a row with `source:'tool'` and `kind` derived from `key`; a sensitive body returns `"skipped: sensitive"` and writes nothing.
  - with `memoryWritable:false`, `memory__save` writes nothing and returns the off message.
  - `memory__recall` returns matching bodies and leaves `exits.toolOutputs` empty.
  - when `input.memory` is undefined, neither tool name appears in the built tools.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w server test -- loop-tools-memory`
Expected: FAIL

- [ ] **Step 3: Implement** — add the fields to `BuildTurnToolsInput`; construct the two `tool(...)` definitions mirroring `loadSkillsTool` (`tools.ts:1033`); push them (guarded on `input.memory`) into the standing `tools.push(...)` list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w server test -- loop-tools-memory`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/loop/tools.ts server/test/loop-tools-memory.test.ts
git commit -m "feat(memory): memory__save and memory__recall tools"
```

---

### Task 6: Extractor + consolidator pipeline

**Files:**
- Create: `server/src/memory/extract.ts`
- Modify: `server/src/llm/client.ts:18` (add `'extract'` to the `Stage` union)
- Test: `server/test/memory-extract.test.ts`

**Interfaces:**
- Consumes: `MemoryStore` (Task 1), `screenMemory` (Task 2), `llmCall`/`BudgetExceededError` (`llm/client.ts`), zod.
- Produces:
  ```ts
  export interface MemoryExtractionInput {
    memory: MemoryStore; userId: string; sessionId: string; turnId: string;
    userText: string; answerText: string; model: string;
  }
  export async function runMemoryExtraction(input: MemoryExtractionInput): Promise<void>; // best-effort; never throws
  ```

- [ ] **Step 1: Write the failing tests** (mock LLM via `server/test/helpers/mock-llm.ts` + `__setTestFetch`; use an in-memory `MemoryStore`):
  - extractor returns **no candidates** → store unchanged.
  - a non-salient candidate (gate `salient:false`) is dropped.
  - a salient candidate with op **ADD** → `listLive` grows by one with `source:'extract'`.
  - op **UPDATE** against an existing profile key → old row invalidated, new row live (via `supersede`).
  - op **DELETE** against an existing id → that row invalidated.
  - op **NOOP** → no change.
  - a candidate whose body hits the denylist is dropped before any consolidation call.
  - a consolidation op naming a **non-existent id** → no-op, no throw.
  - LLM throwing `BudgetExceededError` (and a generic error) → `runMemoryExtraction` resolves (does not reject) and leaves the store unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w server test -- memory-extract`
Expected: FAIL

- [ ] **Step 3: Implement** the two-call pipeline (spec §4.4) inside one top-level `try { … } catch (err) { console.error('[memory] extract failed', err); }`:
  1. `llmCall({ stage:'extract', model, schema: EXTRACT_SCHEMA, system, prompt })` → `{ candidates: { category, kind, key?, body, salient }[] }`. Keep `salient && screenMemory(body).allowed`.
  2. For each kept candidate, gather matches (`listLive(userId)` filtered by key for profile, by simple lexical overlap for collection), then `llmCall({ stage:'extract', model, schema: CONSOLIDATE_SCHEMA })` → `{ op, targetId? }`; apply ADD/UPDATE/DELETE/NOOP via the store (UPDATE→`supersede`, DELETE→`invalidate`, guarding that `targetId` resolves to a live row owned by `userId`).
  Define `EXTRACT_SCHEMA`/`CONSOLIDATE_SCHEMA` as zod objects.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w server test -- memory-extract`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/extract.ts server/src/llm/client.ts server/test/memory-extract.test.ts
git commit -m "feat(memory): async extractor + ADD/UPDATE/DELETE/NOOP consolidator"
```

---

### Task 7: Wire recall, evidence, grounding, and extraction into the loop agent

**Files:**
- Modify: `server/src/loop/agent.ts:56-76` (`LoopSessionDeps`), `:242-284` (`finalize`), `:286-324` (hoist `demoUserId`; build `recalled`; thread into tools + user prompt), `:416-468` (numberCheck `extraEvidence` + grounding gate)
- Test: `server/test/loop-agent-memory.test.ts`

**Interfaces:**
- Consumes: `MemoryStore` (Task 1), `renderMemories` (Task 3), `numberCheck` 4-arg (Task 4), memory tools (Task 5), `runMemoryExtraction` (Task 6).
- Produces: `LoopSessionDeps` gains `memory?: MemoryStore; memoryEnabled?: boolean; memoryWritable?: boolean; extractModel?: string;`.

- [ ] **Step 1: Write the failing tests** (drive `runLoopTurn` with a scripted mock LLM + in-memory `MemoryStore`, test budgets small):
  - with a pre-seeded memory, the user prompt passed to the model contains a `<memories>` block (assert via a capturing mock or by spying on `buildLoopUserPrompt` input through the fetch body).
  - a zero-step answer restating a figure present only in memory is **not** appended with `⚠ could not verify` and does **not** trigger the grounded re-run (assert only one model call).
  - after a `status:'done'` turn with `memoryWritable:true`, `runMemoryExtraction` is invoked (inject a spy via `extractModel` + mock, or assert a resulting store write under a scripted extractor); after a `refused`/`clarify`/`failed` turn, it is **not** invoked.
  - with `memoryEnabled:false` → no `<memories>` block and extractor not invoked; with `memoryWritable:false` (incognito) → `<memories>` block present (recall on) but extractor not invoked.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w server test -- loop-agent-memory`
Expected: FAIL

- [ ] **Step 3: Implement:**
  - Add the four fields to `LoopSessionDeps`.
  - Hoist `demoUserId`/`currentUser` resolution above the `finalize` definition (so `finalize` can read `demoUserId`). Compute `const memoryOn = sessionDeps.memory !== undefined && sessionDeps.memoryEnabled !== false;` and `const recalled = memoryOn ? renderMemories(sessionDeps.memory!.listLive(demoUserId)) : '';`.
  - Pass `memory: sessionDeps.memory, memoryWritable: sessionDeps.memoryWritable !== false` into `buildTurnTools`.
  - Pass `recalledMemories: recalled` into `buildLoopUserPrompt`.
  - At the three `numberCheck(...)` calls (agent.ts:425,435, and the belt at :463 path), pass `recalled ? [recalled] : []` as the new 4th arg.
  - Grounding gate (agent.ts:422): compute `const groundedByMemory = recalled !== '' && !AUDIT_CLAIM_RE.test(finalText) && numberCheck(finalText, [], userText, [recalled]).ok;` and change the condition to `if (needsGrounding(...) && !groundedByMemory)`. Skip the final zero-read belt caution (`:462-467`) when `groundedByMemory`.
  - In `finalize`, after `eventLog.touchSession(...)`, if `status === 'done' && memoryOn && sessionDeps.memoryWritable !== false && sessionDeps.memory`, fire `void runMemoryExtraction({ memory: sessionDeps.memory, userId: demoUserId, sessionId, turnId, userText, answerText: finalText, model: sessionDeps.extractModel ?? turnModel }).catch(() => {})`. Add a code comment noting the detached-work lifecycle caveat (spec §4.4).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w server test -- loop-agent-memory`
Expected: PASS

- [ ] **Step 5: Run the full loop suite to catch regressions**

Run: `npm -w server test -- loop-agent`
Expected: PASS (existing loop-agent tests still green).

- [ ] **Step 6: Commit**

```bash
git add server/src/loop/agent.ts server/test/loop-agent-memory.test.ts
git commit -m "feat(memory): recall, memory-as-evidence, grounding, and post-turn extraction in the loop"
```

---

### Task 8: Runtime wiring (construct store, read flags, thread deps)

**Files:**
- Modify: `server/src/api/turn-runtime.ts:117-150` (field + accessor), `:232-250` (loop branch deps)
- Test: extend `server/test/turn-runtime.test.ts`

**Interfaces:**
- Consumes: `createMemoryStore` (Task 1), `LoopSessionDeps` (Task 7).
- Produces: `SessionRuntime` constructs one `MemoryStore` over `this.sessionsDb` and threads `memory`/`memoryEnabled`/`memoryWritable`/`extractModel` into the loop branch.

- [ ] **Step 1: Write the failing test** — after a loop turn through `SessionRuntime`, assert the memory deps reach `runLoopTurn` (spy/mock `runLoopTurn`, or assert behavior: with the store's `setEnabled(user,false)` no recall/extraction happens; with incognito set via `setIncognito(session,true)` recall happens but no write). Assert `memoryWritable = enabled && !incognito`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server test -- turn-runtime`
Expected: FAIL

- [ ] **Step 3: Implement** — add `private memoryStore?: MemoryStore;` + `private memoryFor(): MemoryStore` (lazily `createMemoryStore(this.sessionsDb)`, cached). In the `runLoopTurn` branch of `drive()`, read `const userId = process.env['DEMO_USER_ID'] || 'user_1'; const mem = this.memoryFor(); const enabled = mem.isEnabled(userId); const incognito = mem.isIncognito(sessionId);` and add to the `LoopSessionDeps` literal: `memory: mem, memoryEnabled: enabled, memoryWritable: enabled && !incognito, extractModel: <cheap model id — reuse defaultModelId() or a fixed Haiku-class slug>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server test -- turn-runtime`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/api/turn-runtime.ts server/test/turn-runtime.test.ts
git commit -m "feat(memory): wire memory store + flags through SessionRuntime"
```

---

### Task 9: HTTP API (memories + settings + incognito)

**Files:**
- Create: `server/src/api/memory.ts`
- Modify: `server/src/index.ts:12-16,65-68` (import + register)
- Test: `server/test/api-memory.test.ts`

**Interfaces:**
- Consumes: `AppDeps` (`api/types.ts`), `createMemoryStore` (Task 1), `sessionExists` (`turn-runtime.ts:40`).
- Produces: `export function registerMemoryRoutes(app: FastifyInstance, deps: AppDeps): void;`
  - `GET /api/memories` → `{ memories: Memory[] }` for `DEMO_USER_ID` (live only).
  - `PATCH /api/memories/:id` body `{ body?, category? }` (zod) → 200 updated | 404 if not found **or not owned by `DEMO_USER_ID`**.
  - `DELETE /api/memories/:id` → 204 | 404 if not owned.
  - `GET /api/memories/settings` → `{ enabled }`; `PUT /api/memories/settings` body `{ enabled: boolean }` → 204.
  - `PUT /api/sessions/:id/incognito` body `{ incognito: boolean }` → 204 | 404 if session missing.

**Review-focus test (cross-user):** PATCH/DELETE of an id owned by `user_2` while acting as `DEMO_USER_ID` → 404, and the row is unchanged.

- [ ] **Step 1: Write the failing tests** (build a Fastify app with `registerMemoryRoutes` and a tmp `sessionsDb`): list returns seeded live memories (not invalidated ones); PATCH edits; DELETE removes; settings GET/PUT round-trip and actually gate (after `PUT {enabled:false}`, `isEnabled` is false); incognito PUT sets the flag; invalid bodies → 400; unknown id → 404; **cross-user id → 404 + unchanged**.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w server test -- api-memory`
Expected: FAIL

- [ ] **Step 3: Implement** `registerMemoryRoutes` (mirror `sessions.ts` style: zod body schemas, `reply.code(...).send(...)`), constructing `const memory = createMemoryStore(deps.sessionsDb)` once; enforce ownership by checking `memory.get(id)?.userId === userId` before update/remove. Register in `index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w server test -- api-memory`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/api/memory.ts server/src/index.ts server/test/api-memory.test.ts
git commit -m "feat(memory): HTTP API for list/edit/delete/settings/incognito"
```

---

### Task 10: Web Memories panel

**Files:**
- Create: `web/src/stores/memory.ts`, `web/src/components/MemoriesPanel.vue`, `web/src/stores/__tests__/memory.test.ts`
- Modify: `web/src/router.ts` (add `/memories` route), `web/src/components/Sidebar.vue` (entry link)

**Interfaces:**
- Consumes: the Task 9 endpoints.
- Produces: a Pinia store `useMemoryStore` with state `{ memories: Memory[]; enabled: boolean }` and actions `fetchMemories()`, `updateMemory(id, patch)`, `deleteMemory(id)`, `fetchSettings()`, `setEnabled(enabled)`, `setIncognito(sessionId, incognito)` (each wraps `fetch` to `/api/memories…`). A `MemoriesPanel.vue` listing memories grouped by `category`, with per-item edit + delete and a global on/off toggle.

- [ ] **Step 1: Write the failing store test** (`web` vitest, mock `fetch`): `fetchMemories` populates `memories`; `deleteMemory` removes locally after a 204; `setEnabled` updates `enabled`; a non-OK response leaves state unchanged and surfaces an error.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w web test -- memory`
Expected: FAIL

- [ ] **Step 3: Implement** the store, then `MemoriesPanel.vue` (reuse the existing enterprise styling — IBM Plex fonts, the look established in `Sidebar.vue`/`ModelPicker.vue`), add the route and a Sidebar entry. Panel visual details are the implementer's call.

- [ ] **Step 4: Run test to verify it passes; typecheck the web build**

Run: `npm -w web test -- memory && npm -w web run build`
Expected: PASS + clean `vue-tsc` build.

- [ ] **Step 5: Commit**

```bash
git add web/src/stores/memory.ts web/src/components/MemoriesPanel.vue web/src/stores/__tests__/memory.test.ts web/src/router.ts web/src/components/Sidebar.vue
git commit -m "feat(memory): web Memories panel (list/edit/delete/off switch)"
```

---

### Task 11: Cross-session integration test

**Files:**
- Test: `server/test/memory-integration.test.ts`

**Interfaces:**
- Consumes: `SessionRuntime` (Task 8) or `runLoopTurn` directly (Task 7), a shared `MemoryStore`, the Task 9 API.

- [ ] **Step 1: Write the test** — with one shared `sessionsDb`: (a) run a turn in session A whose scripted model calls `memory__save` (or whose scripted extractor writes) a durable fact; assert it is in `listLive`. (b) Start session B; assert the fact appears in B's `<memories>` block / is usable in B's answer. (c) `DELETE /api/memories/:id`; start session C; assert the fact is gone from C's recall. (d) Set global off; assert session D gets no `<memories>` block and no new writes.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm -w server test -- memory-integration`
Expected: FAIL (until all prior tasks are integrated).

- [ ] **Step 3: Make it pass** — fixing any wiring gaps surfaced here (no new design; integration only).

- [ ] **Step 4: Run the whole server + web suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/test/memory-integration.test.ts
git commit -m "test(memory): cross-session recall + delete + off-switch integration"
```

---

## Notes for the implementer

- The acting user is always `process.env['DEMO_USER_ID'] || 'user_1'` (matches `agent.ts:294`). `scope_ref` stays `null` in v1 (per-user scope); do not filter on it.
- The extractor model should be a cheap tier; `defaultModelId()`/`plannerModel()` are acceptable sources — pick the cheapest capable slug and keep it in one place (Task 8).
- `<memories>` byte budget (Task 3) and the recall tool's lexical match (Tasks 5/6) are local calls; plain substring/token overlap is fine before reaching for `minisearch`/FTS5.
- Keep each new `memory/*.ts` file focused (< 400 lines); split if the extractor prompt strings grow large.
