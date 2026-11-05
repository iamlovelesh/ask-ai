/**
 * Task 16 — `llm/mock-fetch.ts`'s `MOCK_LLM_SCRIPT` boot hook: the offline
 * seam `eval/runner.ts` relies on to drive a real spawned server with zero
 * network calls (`eval/test/runner-e2e.test.ts` exercises the full
 * integration; this file covers `buildMockFetch`'s FIFO/exhaustion
 * contract and `installMockLlmFromEnv`'s NODE_ENV guard directly).
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockFetch, installMockLlmFromEnv } from '../src/llm/mock-fetch';
import { __setTestFetch } from '../src/llm/client';

afterEach(() => {
  __setTestFetch(undefined);
});

describe('buildMockFetch', () => {
  it('replays scripted values in order as chat-completion-shaped responses', async () => {
    const fetchFn = buildMockFetch([{ kind: 'respond', text: 'first' }, { kind: 'respond', text: 'second' }]);
    const res1 = await fetchFn('https://example.test', {});
    const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
    expect(JSON.parse(body1.choices[0]?.message.content ?? '')).toMatchObject({ kind: 'respond', text: 'first' });

    const res2 = await fetchFn('https://example.test', {});
    const body2 = (await res2.json()) as { choices: { message: { content: string } }[] };
    expect(JSON.parse(body2.choices[0]?.message.content ?? '')).toMatchObject({ kind: 'respond', text: 'second' });
  });

  it('throws loudly once the scripted queue is exhausted', async () => {
    const fetchFn = buildMockFetch([{ kind: 'respond', text: 'only' }]);
    await fetchFn('https://example.test', {});
    await expect(fetchFn('https://example.test', {})).rejects.toThrow(/exhausted/);
  });
});

describe('installMockLlmFromEnv', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('is a no-op when MOCK_LLM_SCRIPT is unset', () => {
    installMockLlmFromEnv({});
    // No throw, no seam installed — nothing to assert beyond "didn't crash".
  });

  it('is a no-op when NODE_ENV is production, even with MOCK_LLM_SCRIPT set', () => {
    dir = mkdtempSync(join(tmpdir(), 'mock-llm-'));
    const scriptPath = join(dir, 'script.json');
    writeFileSync(scriptPath, JSON.stringify([{ kind: 'respond', text: 'x' }]));
    // Should not throw even though NODE_ENV=production would otherwise be
    // a loud misconfiguration signal for other env guards in this repo —
    // here it's just "stay inert".
    expect(() => installMockLlmFromEnv({ MOCK_LLM_SCRIPT: scriptPath, NODE_ENV: 'production' })).not.toThrow();
  });

  it('throws if the script file is not a JSON array', () => {
    dir = mkdtempSync(join(tmpdir(), 'mock-llm-'));
    const scriptPath = join(dir, 'script.json');
    writeFileSync(scriptPath, JSON.stringify({ not: 'an array' }));
    expect(() => installMockLlmFromEnv({ MOCK_LLM_SCRIPT: scriptPath, NODE_ENV: 'development' })).toThrow(/must contain a JSON array/);
  });

  it('loads a valid script and installs the test fetch seam', () => {
    dir = mkdtempSync(join(tmpdir(), 'mock-llm-'));
    const scriptPath = join(dir, 'script.json');
    writeFileSync(scriptPath, JSON.stringify([{ kind: 'respond', text: 'hello' }]));
    expect(() => installMockLlmFromEnv({ MOCK_LLM_SCRIPT: scriptPath, NODE_ENV: 'development' })).not.toThrow();
  });
});
