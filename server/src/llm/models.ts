/**
 * User-selectable model tiers (model-picker feature).
 *
 * Users don't want raw slugs — they want a capability choice: how fast vs how
 * smart. We expose five tiers (extra-fast → extra-smart), each mapped to a
 * concrete OpenRouter model. The client sends a model id, but we NEVER trust
 * it — only allowlisted ids are honored (an arbitrary string could route to an
 * unavailable or expensive model); anything else falls back to the default.
 *
 * `streamsTools`: whether this model's tool calls assemble correctly when the
 * run is driven in stream:true mode. Live A/B (2026-11-07): OpenAI AND Google
 * models over OpenRouter stream tool-call arguments correctly; Anthropic-via-
 * OpenRouter does NOT (tools stop executing). So answer-token streaming is
 * enabled per-model from this flag, never globally.
 *
 * `speed` / `intelligence` are 1–5 relative scores (UI badges, not SLAs) —
 * monotonic across the tier order so the picker can show the tradeoff.
 */
import { inferStreamsTools } from './model-catalog.js';

export type ModelTier = 'extra-fast' | 'fast' | 'balanced' | 'smart' | 'extra-smart';

export interface SelectableModel {
  id: string;
  tier: ModelTier;
  label: string;
  /** Friendly model name shown under the tier (e.g. 'Claude Haiku 4.5'). */
  name: string;
  description: string;
  provider: 'openai' | 'anthropic' | 'google';
  streamsTools: boolean;
  speed: number;
  intelligence: number;
  recommended?: boolean;
}

export const SELECTABLE_MODELS: readonly SelectableModel[] = [
  {
    id: 'google/gemini-2.5-flash-lite',
    tier: 'extra-fast',
    label: 'Extra fast',
    name: 'Gemini 2.5 Flash Lite',
    description: 'Quickest replies for simple lookups and counts. Streams live.',
    provider: 'google',
    streamsTools: true,
    speed: 5,
    intelligence: 2,
  },
  {
    id: 'openai/gpt-4o-mini',
    tier: 'fast',
    label: 'Fast',
    name: 'GPT-4o mini',
    description: 'Snappy and accurate for everyday CRM questions. Streams live.',
    provider: 'openai',
    streamsTools: true,
    speed: 4,
    intelligence: 3,
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    tier: 'balanced',
    label: 'Balanced',
    name: 'Claude Haiku 4.5',
    description: 'The tuned default — reliable multi-step tool use across the full catalog.',
    provider: 'anthropic',
    streamsTools: false,
    speed: 3,
    intelligence: 4,
    recommended: true,
  },
  {
    id: 'google/gemini-2.5-pro',
    tier: 'smart',
    label: 'Smart',
    name: 'Gemini 2.5 Pro',
    description: 'Stronger reasoning for complex, multi-step or ambiguous requests. Streams live.',
    provider: 'google',
    streamsTools: true,
    speed: 2,
    intelligence: 5,
  },
  {
    id: 'openai/gpt-5',
    tier: 'extra-smart',
    label: 'Extra smart',
    name: 'GPT-5',
    description: 'Maximum reasoning for the hardest analysis. Slowest and priciest. Streams live.',
    provider: 'openai',
    streamsTools: true,
    speed: 1,
    intelligence: 5,
  },
];

const BY_ID = new Map(SELECTABLE_MODELS.map((m) => [m.id, m]));

// --- Auto mode ("Auto" selection) ---------------------------------

/** Sentinel id the client sends when the user picks "Auto". It is honored and
 * persisted like a real model, but resolved per-turn to a concrete tier by
 * `resolveAutoModel` before the run — the turn record stores what Auto chose. */
export const AUTO_MODEL_ID = 'auto';

const AUTO_PICKER_ENTRY: SelectableModel = {
  id: AUTO_MODEL_ID,
  tier: 'balanced',
  label: 'Auto',
  name: 'Auto',
  description: 'Picks the model per question — the reliable default, stepping up to stronger reasoning for complex requests.',
  provider: 'anthropic',
  streamsTools: false,
  speed: 3,
  intelligence: 4,
};

// Complex/analytical requests get the smart tier; everything else stays on the
// reliable balanced default. Auto deliberately never routes DOWN to a weaker/
// cheaper tier — the eval showed non-Anthropic fast models miss core-
// correctness scenarios, so the floor is `balanced`.
const COMPLEX_RE =
  /\b(compare|compari|versus|vs\.?|analy[sz]e|analysis|break ?down|trend|forecast|correlat|segment|cohort|for each|per (rep|user|agent|month|quarter|region|owner)|across (all|the)|why\b|explain\b|rank(ed|ing)?|distribution|year[- ]over[- ]year|quarter[- ]over[- ]quarter)\b/i;

// Write/action intent. The smart tier (slow, streaming) cannot complete a
// multi-round bulk write within the turn deadline — a CSV import phrased
// "create a contact for each row" matched COMPLEX_RE, routed to smart, and
// timed out at 90s before reaching the write. Balanced is the tier tuned for
// reliable multi-step tool use, so any clear write/action stays on balanced
// even when COMPLEX_RE fires. Deliberately omits ambiguous verbs (change,
// set, move) that commonly appear in read/analysis prose.
const WRITE_INTENT_RE =
  /\b(create|add|update|delete|remove|archive|import|upload|assign|merge|draft|register|enroll|insert)\b/i;

// Workflow/automation AUTHORING — building an automation, especially an
// event-triggered one ("when a lead is created, create a task"). The balanced
// tier (haiku) intermittently refuses these as impossible ("workflows can't
// create tasks") despite the capability existing; the smart tier builds them
// reliably. Plain workflow reads/runs ("show my workflows", "run workflow X")
// are NOT authoring and stay on balanced.
const WORKFLOW_AUTHOR_RE =
  /\bautomat\w*\b|\b(?:creat|make|build|set ?up|design)\w*\b[^.?!]*\bworkflow\b|\bworkflow\b[^.?!]*\b(?:when|trigger|automatically)\b|\bwhen (?:a|an|the)\b[^.?!]*\b(?:is|are|gets?)\s+(?:created|updated|added|changed|won|lost|closed|paid)\b/i;

/** Resolve the Auto sentinel to a concrete tier id from the request text. */
export function resolveAutoModel(userText: string): string {
  const smart = SELECTABLE_MODELS.find((m) => m.tier === 'smart')!.id;
  const balanced = (SELECTABLE_MODELS.find((m) => m.recommended) ?? SELECTABLE_MODELS.find((m) => m.tier === 'balanced'))!.id;
  // Workflow authoring takes precedence over the write-downgrade below — it is
  // a write, but it needs the smart tier's reliability, not balanced's speed.
  if (WORKFLOW_AUTHOR_RE.test(userText)) return smart;
  const complex = COMPLEX_RE.test(userText) || userText.length > 280;
  // Writes never escalate to smart — balanced is both faster and tuned for
  // tool use, and smart can't finish a multi-round write in time.
  if (complex && WRITE_INTENT_RE.test(userText)) return balanced;
  return complex ? smart : balanced;
}

export function listModels(): readonly SelectableModel[] {
  return SELECTABLE_MODELS;
}

/** A "slow" tier (smart / extra-smart, speed ≤ 2): strong reasoning but high
 * per-call latency. Multi-step work on these needs a longer turn deadline than
 * the fast-tier default, or it is cut off mid-build (observed: workflow
 * authoring on gemini-2.5-pro timed out at 90s). Unknown ids default to false
 * (treated as fast). */
export function isSlowModel(id: string): boolean {
  const m = BY_ID.get(id);
  return m !== undefined && m.speed <= 2;
}

/** The picker's option list: Auto first, then the five tiers. Kept separate
 * from `listModels` so the internal tier registry (and its tests) is unchanged. */
export function listPickerModels(): readonly SelectableModel[] {
  return [AUTO_PICKER_ENTRY, ...SELECTABLE_MODELS];
}

export function isSelectableModel(id: string): boolean {
  return id === AUTO_MODEL_ID || BY_ID.has(id);
}

/** The default model id: the PLANNER_MODEL env if it is itself allowlisted,
 * else the tier marked `recommended`. Keeps the picker default in sync with
 * the deployed default. */
export function defaultModelId(): string {
  const envModel = process.env['PLANNER_MODEL'];
  if (envModel && BY_ID.has(envModel)) return envModel;
  return (SELECTABLE_MODELS.find((m) => m.recommended) ?? SELECTABLE_MODELS[0]!).id;
}

/** Whether a model streams tool calls: the curated tier flag if it is a tier
 * model, else inferred from the provider prefix (OpenAI/Google yes) for
 * arbitrary catalog models chosen via the advanced picker. */
export function modelStreamsTools(id: string): boolean {
  const tier = BY_ID.get(id);
  return tier ? tier.streamsTools : inferStreamsTools(id);
}

/** Validate a client-supplied model id against the curated tiers, falling
 * back to the default. For arbitrary catalog models, callers additionally
 * accept ids that `catalogHas` (see the message handler). */
export function resolveModelId(id: string | undefined): string {
  if (id === AUTO_MODEL_ID) return AUTO_MODEL_ID;
  return id !== undefined && BY_ID.has(id) ? id : defaultModelId();
}
