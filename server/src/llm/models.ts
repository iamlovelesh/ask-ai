/**
 * User-selectable model allowlist (model-picker feature).
 *
 * The chat UI lets a user pick which model runs their turn; the client sends
 * a model id, but we NEVER trust it — only ids in this allowlist are honored
 * (an arbitrary string could route to an unavailable or expensive model), and
 * anything else falls back to the default. All ids are OpenRouter slugs.
 *
 * `streamsTools`: whether this model's tool calls assemble correctly when the
 * run is driven in stream:true mode. Live A/B (2026-11-07): OpenAI models over
 * chat-completions stream tool-call arguments correctly; Anthropic-via-
 * OpenRouter does NOT (tools stop executing). So answer-token streaming is
 * enabled per-model from this flag, never globally.
 */
export interface SelectableModel {
  id: string;
  label: string;
  provider: 'openai' | 'anthropic' | 'google';
  streamsTools: boolean;
}

export const SELECTABLE_MODELS: readonly SelectableModel[] = [
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 (default)', provider: 'anthropic', streamsTools: false },
  { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', provider: 'anthropic', streamsTools: false },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini (streams)', provider: 'openai', streamsTools: true },
  { id: 'openai/gpt-4o', label: 'GPT-4o (streams)', provider: 'openai', streamsTools: true },
];

const BY_ID = new Map(SELECTABLE_MODELS.map((m) => [m.id, m]));

export function listModels(): readonly SelectableModel[] {
  return SELECTABLE_MODELS;
}

export function isSelectableModel(id: string): boolean {
  return BY_ID.has(id);
}

/** The default model id. Honors PLANNER_MODEL if it is itself allowlisted,
 * else the first entry — so the picker default tracks the deployed default. */
export function defaultModelId(): string {
  const envModel = process.env['PLANNER_MODEL'];
  if (envModel && BY_ID.has(envModel)) return envModel;
  return SELECTABLE_MODELS[0]!.id;
}

export function modelStreamsTools(id: string): boolean {
  return BY_ID.get(id)?.streamsTools ?? false;
}

/** Validate a client-supplied model id, falling back to the default. */
export function resolveModelId(id: string | undefined): string {
  return id !== undefined && BY_ID.has(id) ? id : defaultModelId();
}
