import { describe, it, expect } from 'vitest';
import {
  SELECTABLE_MODELS,
  listModels,
  isSelectableModel,
  modelStreamsTools,
  defaultModelId,
  resolveModelId,
} from '../src/llm/models';

const TIERS = ['extra-fast', 'fast', 'balanced', 'smart', 'extra-smart'] as const;

describe('model tier registry', () => {
  it('exposes the five capability tiers, each with the required metadata', () => {
    expect(listModels().map((m) => m.tier)).toEqual([...TIERS]);
    for (const m of listModels()) {
      expect(m.id).toMatch(/\//); // provider/model slug
      expect(m.label.length).toBeGreaterThan(0);
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
});
