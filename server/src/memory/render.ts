/**
 * Recall rendering (design §4.6). Turns a user's live memories into the inner
 * text of the `<memories>` block that rides in the per-turn USER prompt (never
 * the cacheable system prompt). For the expected v1 volume this is inject-all;
 * over the byte budget it degrades to a truncated summary plus a pointer to
 * the `memory__recall` tool.
 *
 * Every body is passed through `sanitizeForPrompt` so a memory's content can
 * never close the block or read as an instruction (Review Focus: injection).
 */

import type { Memory } from './types.js';

export interface RenderMemoriesOptions {
  budgetChars?: number;
}

const DEFAULT_BUDGET = 4000;
const TRUNCATE_BODY = 160;

/** Collapse whitespace and neutralize anything that could break out of the
 * `<memories>` block. The words survive as inert data; the markup does not. */
export function sanitizeForPrompt(body: string): string {
  return body
    .replace(/[\r\n]+/g, ' ')
    .replace(/<\s*\/?\s*memories\s*>/gi, '(memories)')
    .replace(/[<>]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function line(m: Memory): string {
  const label = `[${m.category}]`;
  const body = sanitizeForPrompt(m.body);
  return m.kind === 'profile' && m.key ? `- ${label} ${m.key}: ${body}` : `- ${label} ${body}`;
}

export function renderMemories(memories: readonly Memory[], opts: RenderMemoriesOptions = {}): string {
  if (memories.length === 0) return '';
  const budget = opts.budgetChars ?? DEFAULT_BUDGET;

  const full = memories.map(line).join('\n');
  if (full.length <= budget) return full;

  // Over budget: fit as many (truncated) lines as the budget allows, then
  // point the model at memory__recall for the rest.
  const kept: string[] = [];
  let size = 0;
  for (const m of memories) {
    const rendered = line(m);
    const l = rendered.length > TRUNCATE_BODY ? `${rendered.slice(0, TRUNCATE_BODY)}…` : rendered;
    if (size + l.length > budget && kept.length > 0) break;
    kept.push(l);
    size += l.length + 1;
  }
  const omitted = memories.length - kept.length;
  return `${kept.join('\n')}\n(… and ${omitted} more in memory — use memory__recall for details)`;
}
