import { describe, it, expect } from 'vitest';
import {
  SELECTABLE_MODELS,
  listModels,
  listPickerModels,
  isSelectableModel,
  modelStreamsTools,
  defaultModelId,
  resolveModelId,
  resolveAutoModel,
  AUTO_MODEL_ID,
} from '../src/llm/models';

const TIERS = ['extra-fast', 'fast', 'balanced', 'smart', 'extra-smart'] as const;

describe('model tier registry', () => {
  it('exposes the five capability tiers, each with the required metadata', () => {
    expect(listModels().map((m) => m.tier)).toEqual([...TIERS]);
    for (const m of listModels()) {
      expect(m.id).toMatch(/\//); // provider/model slug
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.name.length).toBeGreaterThan(0); // friendly model name shown in the picker
      expect(m.description.length).toBeGreaterThan(0);
      expect(['openai', 'anthropic', 'google']).toContain(m.provider);
      expect(typeof m.streamsTools).toBe('boolean');
      expect(m.speed).toBeGreaterThanOrEqual(1);
      expect(m.intelligence).toBeGreaterThanOrEqual(1);
    }
  });

  it('exactly one tier is marked recommended (the default)', () => {
    const rec = listModels().filter((m) => m.recommended);
    expect(rec).toHaveLength(1);
    expect(isSelectableModel(defaultModelId())).toBe(true);
    expect(rec[0]!.id).toBe(defaultModelId());
  });

  it('speed and intelligence trade off monotonically across the tiers', () => {
    const ms = listModels();
    for (let i = 1; i < ms.length; i += 1) {
      expect(ms[i]!.speed).toBeLessThanOrEqual(ms[i - 1]!.speed); // slower as we go up
      expect(ms[i]!.intelligence).toBeGreaterThanOrEqual(ms[i - 1]!.intelligence); // smarter
    }
  });

  it('only allowlisted ids are selectable (no arbitrary client strings)', () => {
    expect(isSelectableModel('openai/gpt-4o-mini')).toBe(true);
    expect(isSelectableModel('evil/expensive-model')).toBe(false);
    expect(isSelectableModel('')).toBe(false);
  });

  it('streamsTools reflects the live provider finding: OpenAI/Google yes, Anthropic no', () => {
    for (const m of listModels()) {
      if (m.provider === 'anthropic') expect(m.streamsTools).toBe(false);
      else expect(m.streamsTools).toBe(true);
    }
    expect(modelStreamsTools('evil/x')).toBe(false);
  });

  it('resolveModelId falls back to the default for unknown/empty input', () => {
    expect(resolveModelId('openai/gpt-4o-mini')).toBe('openai/gpt-4o-mini');
    expect(resolveModelId('evil/x')).toBe(defaultModelId());
    expect(resolveModelId(undefined)).toBe(defaultModelId());
  });

  it('ids are unique', () => {
    const ids = SELECTABLE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tiers are provider-balanced — no single provider dominates (>=2 providers, max 2 tiers each)', () => {
    const byProvider = new Map<string, number>();
    for (const m of listModels()) byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
    expect(byProvider.size).toBeGreaterThanOrEqual(3);
    for (const [, n] of byProvider) expect(n).toBeLessThanOrEqual(2);
  });
});

describe('Auto model mode', () => {
  const SMART = SELECTABLE_MODELS.find((m) => m.tier === 'smart')!.id;
  const BALANCED = SELECTABLE_MODELS.find((m) => m.tier === 'balanced')!.id;

  it('"auto" is honored as a selectable id (so it can be sent and persisted)', () => {
    expect(isSelectableModel(AUTO_MODEL_ID)).toBe(true);
    expect(resolveModelId(AUTO_MODEL_ID)).toBe(AUTO_MODEL_ID);
  });

  it('listPickerModels prepends Auto to the tier list; listModels is unchanged', () => {
    expect(listPickerModels()[0]!.id).toBe(AUTO_MODEL_ID);
    expect(listPickerModels()).toHaveLength(listModels().length + 1);
    expect(listModels().some((m) => m.id === AUTO_MODEL_ID)).toBe(false);
  });

  it('routes a simple lookup to the reliable balanced default', () => {
    expect(resolveAutoModel('how many open leads do I have?')).toBe(BALANCED);
    expect(resolveAutoModel('show my overdue invoices')).toBe(BALANCED);
    expect(resolveAutoModel('')).toBe(BALANCED);
  });

  it('escalates complex / analytical requests to the smart tier', () => {
    expect(resolveAutoModel('compare Q3 and Q4 revenue by region and explain the trend')).toBe(SMART);
    expect(resolveAutoModel('for each sales rep, break down win rate versus last quarter')).toBe(SMART);
    expect(resolveAutoModel('analyze why churn increased across the enterprise segment')).toBe(SMART);
  });

  it('never downgrades below balanced (avoids the weaker-model correctness risk)', () => {
    // whatever the heuristic picks, it is always one of the two safe tiers
    const picks = ['hi', 'count leads', 'a very '.repeat(60), 'compare x and y'].map(resolveAutoModel);
    for (const p of picks) expect([BALANCED, SMART]).toContain(p);
  });
});
