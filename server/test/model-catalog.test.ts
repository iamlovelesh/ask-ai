import { describe, it, expect, beforeEach } from 'vitest';
import {
  fetchModelCatalog,
  catalogHas,
  inferStreamsTools,
  __resetCatalogForTest,
} from '../src/llm/model-catalog';

function fakeFetch(models: { id: string; name?: string }[], calls: { n: number }): typeof fetch {
  return (async () => {
    calls.n += 1;
    return new Response(JSON.stringify({ data: models.map((m) => ({ id: m.id, name: m.name ?? m.id, context_length: 128000, pricing: { prompt: '0.000001' } })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('model catalog', () => {
  beforeEach(() => __resetCatalogForTest());

  it('fetches, trims, and sorts the OpenRouter model list', async () => {
    const calls = { n: 0 };
    const models = await fetchModelCatalog(fakeFetch([{ id: 'z/model' }, { id: 'a/model', name: 'A Model' }], calls));
    expect(models.map((m) => m.id)).toEqual(['a/model', 'z/model']); // sorted
    expect(models[0]).toMatchObject({ id: 'a/model', name: 'A Model' });
  });

  it('caches within the TTL (one network call for repeated fetches)', async () => {
    const calls = { n: 0 };
    const f = fakeFetch([{ id: 'a/model' }], calls);
    await fetchModelCatalog(f);
    await fetchModelCatalog(f);
    expect(calls.n).toBe(1);
  });

  it('catalogHas reflects the loaded catalog', async () => {
    const calls = { n: 0 };
    await fetchModelCatalog(fakeFetch([{ id: 'openai/gpt-4o' }], calls));
    expect(catalogHas('openai/gpt-4o')).toBe(true);
    expect(catalogHas('nope/nope')).toBe(false);
  });

  it('a failed fetch returns the stale cache (or empty), never throws', async () => {
    const failing: typeof fetch = (async () => new Response('err', { status: 500 })) as typeof fetch;
    const models = await fetchModelCatalog(failing);
    expect(Array.isArray(models)).toBe(true);
  });

  it('inferStreamsTools: OpenAI/Google stream tool calls, others do not', () => {
    expect(inferStreamsTools('openai/gpt-4o')).toBe(true);
    expect(inferStreamsTools('google/gemini-2.5-pro')).toBe(true);
    expect(inferStreamsTools('anthropic/claude-opus-4.5')).toBe(false);
    expect(inferStreamsTools('mistralai/mistral-large')).toBe(false);
  });
});
