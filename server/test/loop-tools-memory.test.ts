import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VirtualClock } from '../src/store/clock';
import { openSessions } from '../src/store/sessions-db';
import { createMemoryStore, type MemoryStore } from '../src/memory/store';
import { buildTurnTools, StuckTracker, type BuildTurnToolsInput, type LoopExits } from '../src/loop/tools';

const paths: string[] = [];
function freshMemory(): MemoryStore {
  const p = join(tmpdir(), `sessions-tooltest-${randomUUID()}.db`);
  paths.push(p);
  let t = 1000;
  return createMemoryStore(openSessions(p), () => (t += 1));
}

afterAll(() => {
  for (const p of paths) for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(p + s)) rmSync(p + s, { force: true });
});

function freshExits(): LoopExits {
  return { denied: false, writesLanded: 0, writeActions: new Map(), toolOutputs: [], appliedFilters: [], stop: () => {} };
}

function buildInput(memory: MemoryStore | undefined, memoryWritable: boolean, exits: LoopExits): BuildTurnToolsInput {
  const stubRegistry = { get: () => undefined, all: () => [] } as unknown as BuildTurnToolsInput['registry'];
  return {
    registry: stubRegistry,
    cards: [],
    crm: {} as BuildTurnToolsInput['crm'],
    refs: {} as BuildTurnToolsInput['refs'],
    confirm: {} as BuildTurnToolsInput['confirm'],
    clock: new VirtualClock(),
    turnId: 't_1',
    emit: () => {},
    sessionCtx: { usedActionSlugs: [], activeModules: [] },
    exits,
    stuck: new StuckTracker(),
    markTtfur: () => {},
    counters: { stepsOk: 0, stepsFailed: 0, step: 0, gateWaitMs: 0, virtualReads: 0 },
    planHash: 'h',
    actingUserId: 'user_1',
    knownIds: new Set<string>(),
    ...(memory !== undefined ? { memory, memoryWritable } : {}),
  };
}

function findTool(tools: ReturnType<typeof buildTurnTools>, name: string): { invoke: (ctx: unknown, input: string) => Promise<unknown> } | undefined {
  return tools.find((t) => (t as { name?: string }).name === name) as never;
}

async function invoke(tools: ReturnType<typeof buildTurnTools>, name: string, args: unknown): Promise<string> {
  const t = findTool(tools, name);
  if (!t) throw new Error(`tool ${name} not built`);
  return (await t.invoke({}, JSON.stringify(args))) as string;
}

describe('memory__save tool', () => {
  it('writes a benign memory with source "tool" and kind derived from key', async () => {
    const memory = freshMemory();
    const tools = buildTurnTools(buildInput(memory, true, freshExits()));
    const res = await invoke(tools, 'memory__save', { category: 'preference', body: 'prefers EU dates', key: 'date-format' });
    expect(res).toMatch(/saved/i);
    const live = memory.listLive('user_1');
    expect(live).toHaveLength(1);
    expect(live[0]!.source).toBe('tool');
    expect(live[0]!.kind).toBe('profile');
    expect(live[0]!.key).toBe('date-format');
  });

  it('writes a collection memory (no key)', async () => {
    const memory = freshMemory();
    const tools = buildTurnTools(buildInput(memory, true, freshExits()));
    await invoke(tools, 'memory__save', { category: 'goal', body: 'weekly pipeline review' });
    expect(memory.listLive('user_1')[0]!.kind).toBe('collection');
  });

  it('skips a sensitive body and writes nothing', async () => {
    const memory = freshMemory();
    const tools = buildTurnTools(buildInput(memory, true, freshExits()));
    const res = await invoke(tools, 'memory__save', { category: 'fact', body: 'card 4111 1111 1111 1111' });
    expect(res).toMatch(/skipped/i);
    expect(memory.listLive('user_1')).toHaveLength(0);
  });

  it('writes nothing and reports off when not writable (incognito)', async () => {
    const memory = freshMemory();
    const tools = buildTurnTools(buildInput(memory, false, freshExits()));
    const res = await invoke(tools, 'memory__save', { category: 'preference', body: 'prefers EU dates' });
    expect(res).toMatch(/off/i);
    expect(memory.listLive('user_1')).toHaveLength(0);
  });
});

describe('memory__recall tool', () => {
  it('returns matching bodies and does not pollute the NumberCheck evidence pool', async () => {
    const memory = freshMemory();
    memory.add({ userId: 'user_1', category: 'goal', kind: 'collection', body: 'quarterly target is $50,000', source: 'user' });
    const exits = freshExits();
    const tools = buildTurnTools(buildInput(memory, true, exits));
    const res = await invoke(tools, 'memory__recall', { query: 'target' });
    expect(res).toMatch(/\$50,000/);
    expect(exits.toolOutputs).toHaveLength(0);
  });
});

describe('memory tools absent when no store', () => {
  it('builds neither tool when input.memory is undefined', () => {
    const tools = buildTurnTools(buildInput(undefined, true, freshExits()));
    expect(findTool(tools, 'memory__save')).toBeUndefined();
    expect(findTool(tools, 'memory__recall')).toBeUndefined();
  });
});
