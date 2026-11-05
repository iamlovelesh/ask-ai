import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, tool } from '@openai/agents';
import { costMeter, __setTestSpans } from '../src/llm/client';
import { BudgetExceededError } from '../src/llm/client';
import type { Span, SpanEndPatch, SpanHandle, Spans, SpanStart } from '../src/events/trace';
import { createLoopRunner, runLoopOnce, LoopDeadlineError } from '../src/llm/agents-runtime';

// --- fakes -------------------------------------------------------------------

interface SeenRequest {
  url: string;
}

function toolCallResponse(name: string, args: Record<string, unknown>): unknown {
  return {
    id: 'gen-1', object: 'chat.completion', created: 1, model: 'anthropic/claude-haiku-4.5',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

function textResponse(text: string): unknown {
  return {
    id: 'gen-2', object: 'chat.completion', created: 2, model: 'anthropic/claude-haiku-4.5',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 },
  };
}

function scriptedFetch(script: unknown[], seen: SeenRequest[], delayMs = 0): typeof fetch {
  let i = 0;
  return (async (input: string | URL | Request) => {
    seen.push({ url: String(input instanceof Request ? input.url : input) });
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const payload = script[Math.min(i, script.length - 1)];
    i += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

class FakeSpans implements Spans {
  started: SpanStart[] = [];
  ended: SpanEndPatch[] = [];
  start(partial: SpanStart): SpanHandle {
    this.started.push(partial);
    return { id: `sp_${this.started.length}`, turnId: partial.turnId, startedAt: 0 };
  }
  end(_handle: SpanHandle, patch?: SpanEndPatch): void {
    this.ended.push(patch ?? {});
  }
  forTurn(): Span[] { return []; }
  close(): void {}
}

function makeAgent(): Agent {
  const t = tool({
    name: 'crm__search',
    description: 'search',
    parameters: z.object({ query: z.string() }),
    execute: async () => JSON.stringify({ items: [], total: 0 }),
  });
  return new Agent({ name: 'rt-test', model: 'anthropic/claude-haiku-4.5', instructions: 'agent', tools: [t], modelSettings: { parallelToolCalls: false } });
}

// --- tests -------------------------------------------------------------------

describe('agents-runtime', () => {
  let spans: FakeSpans;

  beforeEach(() => {
    costMeter.__resetForTest();
    spans = new FakeSpans();
    __setTestSpans(spans);
    process.env['EVAL_BUDGET_USD'] = '25';
  });

  afterEach(() => {
    __setTestSpans(undefined);
    delete process.env['EVAL_BUDGET_USD'];
  });

  it('runs a 2-step tool loop, meters cost, emits one llm span per model call', async () => {
    const seen: SeenRequest[] = [];
    const runner = createLoopRunner({ testFetch: scriptedFetch([toolCallResponse('crm__search', { query: 'acme' }), textResponse('All done.')], seen) });
    const result = await runLoopOnce({ runner, agent: makeAgent(), input: 'find acme', maxTurns: 5, deadlineMs: 30_000, turnId: 't_rt1' });
    expect(result.finalOutput).toBe('All done.');
    expect(seen).toHaveLength(2);
    expect([...new Set(seen.map((s) => new URL(s.url).host))]).toEqual(['openrouter.ai']);
    expect(costMeter.total()).toBeGreaterThan(0);
    const llmSpans = spans.started.filter((s) => s.kind === 'llm');
    expect(llmSpans).toHaveLength(2);
    expect(llmSpans.every((s) => s.turnId === 't_rt1')).toBe(true);
    const endedWithTokens = spans.ended.filter((p) => (p.tokensIn ?? 0) > 0);
    expect(endedWithTokens).toHaveLength(2);
  });

  it('throws BudgetExceededError before any model call when the meter is at the cap', async () => {
    process.env['EVAL_BUDGET_USD'] = '0';
    const seen: SeenRequest[] = [];
    const runner = createLoopRunner({ testFetch: scriptedFetch([textResponse('x')], seen) });
    await expect(
      runLoopOnce({ runner, agent: makeAgent(), input: 'hello', maxTurns: 2, deadlineMs: 5_000, turnId: 't_rt2' }),
    ).rejects.toThrow(BudgetExceededError);
    expect(seen).toHaveLength(0);
  });

  it('maxTurns exhaustion yields the honest fallback final output without an extra model call', async () => {
    const seen: SeenRequest[] = [];
    const runner = createLoopRunner({ testFetch: scriptedFetch([toolCallResponse('crm__search', { query: 'x' })], seen) });
    const result = await runLoopOnce({ runner, agent: makeAgent(), input: 'loop forever', maxTurns: 1, deadlineMs: 30_000, turnId: 't_rt3' });
    expect(typeof result.finalOutput).toBe('string');
    expect(result.finalOutput as string).toMatch(/could not finish|ran out/i);
    expect(seen).toHaveLength(1);
  });

  it('deadline exceeded raises LoopDeadlineError without waiting out the model call', async () => {
    const seen: SeenRequest[] = [];
    const runner = createLoopRunner({ testFetch: scriptedFetch([textResponse('late')], seen, 1500) });
    await expect(
      runLoopOnce({ runner, agent: makeAgent(), input: 'hello', maxTurns: 2, deadlineMs: 150, turnId: 't_rt4' }),
    ).rejects.toThrow(LoopDeadlineError);
  });
});
