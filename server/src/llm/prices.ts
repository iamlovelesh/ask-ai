/**
 * Static $/M-token price table (fallback cost source — LLD §10, §5.5).
 * Used by `llm/client.ts` whenever OpenRouter does not report native cost
 * (`usage.cost` absent from the response). `priceFor` NEVER returns
 * `undefined` — unmapped/future models fall back to `DEFAULT_PRICE`, a
 * conservative (deliberately high) ceiling so budget tracking never
 * under-counts an unknown model's spend.
 */

export interface ModelPrice {
  inPerM: number;
  outPerM: number;
  cachedPerM: number;
}

const PRICE_TABLE: Record<string, ModelPrice> = {
  'anthropic/claude-haiku-4.5': { inPerM: 1.0, outPerM: 5.0, cachedPerM: 0.1 },
  'google/gemini-2.5-flash-lite': { inPerM: 0.1, outPerM: 0.4, cachedPerM: 0.025 },
  'openai/gpt-5-mini': { inPerM: 0.25, outPerM: 2.0, cachedPerM: 0.025 },
};

/** Conservative ceiling for models not in the table — never NaN, never free. */
const DEFAULT_PRICE: ModelPrice = { inPerM: 5.0, outPerM: 20.0, cachedPerM: 0.5 };

export function priceFor(model: string): ModelPrice {
  return PRICE_TABLE[model] ?? DEFAULT_PRICE;
}
