import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSessions } from '../src/store/sessions-db';
import { createMemoryStore, type MemoryStore } from '../src/memory/store';
import { runMemoryExtraction } from '../src/memory/extract';
import {
  __setTestFetch,
  __setTestBackoffOptions,
  costMeter,
  meterLlmCost,
  budgetUsd,
} from '../src/llm/client';
import { queueMockLlm } from './helpers/mock-llm';

const paths: string[] = [];
function freshMemory(): MemoryStore {
  const p = join(tmpdir(), `sessions-extracttest-${randomUUID()}.db`);
  paths.push(p);
  let t = 1000;
  return createMemoryStore(openSessions(p), () => (t += 1));
}

function run(memory: MemoryStore): Promise<void> {
  return runMemoryExtraction({
    memory,
    userId: 'user_1',
    sessionId: 's_1',
    turnId: 't_1',
    userText: 'I prefer EU date format',
    answerText: 'Got it.',
    model: 'mock-model',
  });
}

beforeEach(() => {
  costMeter.__resetForTest();
  __setTestBackoffOptions({ baseMs: 1 });
});
afterEach(() => {
  __setTestFetch(undefined);
  __setTestBackoffOptions(undefined);
  costMeter.__resetForTest();
});
afterAll(() => {
  for (const p of paths) for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(p + s)) rmSync(p + s, { force: true });
});

const salientCandidate = {
  category: 'preference',
  kind: 'collection',
  body: 'prefers EU date format',
  salient: true,
};

describe('runMemoryExtraction', () => {
  it('writes nothing when there are no candidates', async () => {
    const memory = freshMemory();
    __setTestFetch(queueMockLlm([{ candidates: [] }]).fetch);
    await run(memory);
    expect(memory.listLive('user_1')).toHaveLength(0);
  });

  it('drops a non-salient candidate (no consolidation call)', async () => {
    const memory = freshMemory();
    const q = queueMockLlm([{ candidates: [{ ...salientCandidate, salient: false }] }]);
    __setTestFetch(q.fetch);
    await run(memory);
    expect(memory.listLive('user_1')).toHaveLength(0);
    expect(q.callCount()).toBe(1); // extract only, never consolidate
  });

  it('ADD creates a new memory with source "extract"', async () => {
    const memory = freshMemory();
    __setTestFetch(queueMockLlm([{ candidates: [salientCandidate] }, { op: 'ADD' }]).fetch);
    await run(memory);
    const live = memory.listLive('user_1');
    expect(live).toHaveLength(1);
    expect(live[0]!.source).toBe('extract');
    expect(live[0]!.body).toBe('prefers EU date format');
  });

  it('UPDATE supersedes an existing profile memory', async () => {
    const memory = freshMemory();
    const old = memory.add({ userId: 'user_1', category: 'preference', kind: 'profile', key: 'date-format', body: 'prefers US dates', source: 'tool' });
    __setTestFetch(
      queueMockLlm([
        { candidates: [{ category: 'preference', kind: 'profile', key: 'date-format', body: 'prefers EU dates', salient: true }] },
        { op: 'UPDATE', targetId: old.id },
      ]).fetch,
    );
    await run(memory);
    const live = memory.listLive('user_1');
    expect(live).toHaveLength(1);
    expect(live[0]!.body).toBe('prefers EU dates');
    expect(memory.get(old.id)!.invalidAt).toBeGreaterThan(0);
  });

  it('DELETE invalidates an existing memory', async () => {
    const memory = freshMemory();
    const old = memory.add({ userId: 'user_1', category: 'fact', kind: 'collection', body: 'stale fact', source: 'tool' });
    __setTestFetch(
      queueMockLlm([{ candidates: [salientCandidate] }, { op: 'DELETE', targetId: old.id }]).fetch,
    );
    await run(memory);
    expect(memory.listLive('user_1')).toHaveLength(0);
    expect(memory.get(old.id)!.invalidAt).toBeGreaterThan(0);
  });

  it('NOOP changes nothing', async () => {
    const memory = freshMemory();
    __setTestFetch(queueMockLlm([{ candidates: [salientCandidate] }, { op: 'NOOP' }]).fetch);
    await run(memory);
    expect(memory.listLive('user_1')).toHaveLength(0);
  });

  it('drops a denylisted candidate before any consolidation call', async () => {
    const memory = freshMemory();
    const q = queueMockLlm([{ candidates: [{ ...salientCandidate, body: 'card 4111 1111 1111 1111' }] }]);
    __setTestFetch(q.fetch);
    await run(memory);
    expect(memory.listLive('user_1')).toHaveLength(0);
    expect(q.callCount()).toBe(1);
  });

  it('no-ops (no throw) when a consolidation op names a non-existent id', async () => {
    const memory = freshMemory();
    __setTestFetch(queueMockLlm([{ candidates: [salientCandidate] }, { op: 'UPDATE', targetId: 'mem_nope' }]).fetch);
    await expect(run(memory)).resolves.toBeUndefined();
    expect(memory.listLive('user_1')).toHaveLength(0);
  });

  it('resolves (never throws) and writes nothing when the budget is exhausted', async () => {
    const memory = freshMemory();
    meterLlmCost(budgetUsd() + 1); // push cumulative over the ceiling
    __setTestFetch(queueMockLlm([{ candidates: [salientCandidate] }]).fetch);
    await expect(run(memory)).resolves.toBeUndefined();
    expect(memory.listLive('user_1')).toHaveLength(0);
  });

  it('resolves (never throws) when the LLM call errors', async () => {
    const memory = freshMemory();
    __setTestFetch(queueMockLlm([]).fetch); // exhausted → throws inside llmCall
    await expect(run(memory)).resolves.toBeUndefined();
    expect(memory.listLive('user_1')).toHaveLength(0);
  });
});
