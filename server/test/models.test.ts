import { describe, it, expect } from 'vitest';
import {
  SELECTABLE_MODELS,
  listModels,
  isSelectableModel,
  modelStreamsTools,
  defaultModelId,
  resolveModelId,
} from '../src/llm/models';

describe('model registry', () => {
  it('exposes a non-empty allowlist with id/label/provider/streamsTools', () => {
    expect(listModels().length).toBeGreaterThanOrEqual(2);
    for (const m of listModels()) {
      expect(m.id).toMatch(/\//); // provider/model form
      expect(m.label.length).toBeGreaterThan(0);
      expect(typeof m.streamsTools).toBe('boolean');
    }
  });

  it('default model is selectable', () => {
    expect(isSelectableModel(defaultModelId())).toBe(true);
  });

  it('only allowlisted ids are selectable (no arbitrary client strings)', () => {
    expect(isSelectableModel('openai/gpt-4o-mini')).toBe(true);
    expect(isSelectableModel('evil/expensive-model')).toBe(false);
    expect(isSelectableModel('')).toBe(false);
  });

  it('OpenAI models stream tool calls; Anthropic-via-OpenRouter do not (live 2026-11-07)', () => {
    expect(modelStreamsTools('openai/gpt-4o-mini')).toBe(true);
    expect(modelStreamsTools('anthropic/claude-haiku-4.5')).toBe(false);
    // unknown id never claims streaming capability
    expect(modelStreamsTools('evil/x')).toBe(false);
  });

  it('resolveModelId falls back to the default for unknown/empty input', () => {
    expect(resolveModelId('openai/gpt-4o-mini')).toBe('openai/gpt-4o-mini');
    expect(resolveModelId('evil/x')).toBe(defaultModelId());
    expect(resolveModelId(undefined)).toBe(defaultModelId());
  });
});

describe('SELECTABLE_MODELS shape', () => {
  it('ids are unique', () => {
    const ids = SELECTABLE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
