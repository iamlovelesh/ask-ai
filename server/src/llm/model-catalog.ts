/**
 * OpenRouter model catalog (model-picker "other models" dropdown).
 *
 * The curated 5 tiers (models.ts) cover most users; power users can pick ANY
 * real OpenRouter model. We fetch the live catalog, cache it (1h), and use it
 * to (a) populate the advanced dropdown and (b) VALIDATE an arbitrary client
 * model id — a model must exist in the catalog to be honored, so a typo or
 * garbage string still falls back to the default rather than hitting a bogus
 * route.
 */
import { wallClockNow } from '../store/clock.js';

export interface CatalogModel {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: string;
}

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const TTL_MS = 60 * 60 * 1000;

let cache: { at: number; models: CatalogModel[] } | undefined;

/** Test-only: clear the module cache between cases. */
export function __resetCatalogForTest(): void {
  cache = undefined;
}

/** Streaming-capable providers (live A/B 2026-11-07): OpenAI and Google
 * stream tool-call arguments correctly over OpenRouter; Anthropic (and, by
 * default, anything unverified) does not. */
export function inferStreamsTools(id: string): boolean {
  return id.startsWith('openai/') || id.startsWith('google/');
}

export async function fetchModelCatalog(fetchImpl: typeof fetch = fetch): Promise<CatalogModel[]> {
  if (cache && wallClockNow() - cache.at < TTL_MS) return cache.models;
  try {
    const res = await fetchImpl(CATALOG_URL, {
      headers: { Authorization: `Bearer ${process.env['OPENROUTER_API_KEY'] ?? ''}` },
    });
    if (!res.ok) return cache?.models ?? [];
    const body = (await res.json()) as { data?: { id: string; name?: string; context_length?: number; pricing?: { prompt?: string } }[] };
    const models: CatalogModel[] = (body.data ?? [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        ...(typeof m.context_length === 'number' ? { contextLength: m.context_length } : {}),
        ...(m.pricing?.prompt !== undefined ? { promptPrice: m.pricing.prompt } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    cache = { at: wallClockNow(), models };
    return models;
  } catch {
    return cache?.models ?? [];
  }
}

/** Whether a model id is present in the currently-cached catalog. Validation
 * uses this synchronously; callers that need freshness await fetchModelCatalog
 * first (the message handler does). */
export function catalogHas(id: string): boolean {
  return cache?.models.some((m) => m.id === id) ?? false;
}
