/**
 * Task 6, Step 1 — schema go/no-go spike (LLD §10 Spike B).
 *
 * Sends the REAL `PlanOutcome` Zod schema (`server/src/agent/plan-schema.ts`)
 * through `llmCall` (`stage:'spike'`) using the REAL byte-stable planner
 * system prompt (`buildPlannerPrompt` from `server/src/agent/planner.ts`)
 * against a small hand-built context (~8 real action cards from the live
 * catalog) and the LLD §2.2 conformance-style request, once each against:
 *   - anthropic/claude-haiku-4.5
 *   - google/gemini-2.5-flash-lite
 *   - openai/gpt-5-mini
 *
 * ONE retry max per model on parse failure (so ≤2 attempts/model, ≤6 calls
 * total). Prints a JSON summary to stdout — this script does NOT write
 * docs/SPIKES.md itself; that's assembled by hand from this run's real
 * output so the numbers in the doc are never fabricated.
 *
 * Run: `npx tsx scripts/spike-schema.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlannerPrompt, type PlannerPromptCtx } from '../server/src/agent/planner.js';
import { planOutcomeSchema, type PlanOutcome } from '../server/src/agent/plan-schema.js';
import { llmCall } from '../server/src/llm/client.js';
import { emptyWorkingState, renderWorkingState } from '../server/src/agent/memory.js';

// --- minimal .env loader (no dotenv dep; never logs the value) ------------

function loadDotEnv(): void {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return; // no .env file — assume vars are already in the environment
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key !== '' && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

// --- ~8 real action cards (real slugs/names/descriptions pulled live from
// the registry via scripts/_tmp-probe.ts during authoring; hand-pasted here
// so this spike has zero dependency on retrieval.ts) ------------------------

const CARDS = [
  'leads.search_leads — Search leads: Search non-archived leads by name and common filters. [query, status, source, owner_id, created_after, created_before, limit]',
  'leads.assign_lead_owner — Assign lead owner: Set the owning user for a lead. [id, owner_id]',
  'leads.update_lead_score — Update lead score: Set the numeric qualification score (0-100) for a lead. [id, score]',
  'appointments.search_appointments — Search appointments: Search appointments by contact(s), calendar, host, status, and start-time range. [contact_ids, calendar_id, host_user_id, status, start_after, start_before, limit]',
  'tasks.create_task — Create task: Create a new task, optionally due/owned/linked to a contact. [title, description, due_date, owner_id, contact_id, priority]',
  'tasks.assign_task_owner — Assign task owner: Set the owning user for a task. [id, owner_id]',
  'conversations.search_conversations — Search conversations: Search non-archived conversation threads by contact/channel/status/reply-state. [contact_ids, channel, status, has_inbound_reply, unread, limit]',
  'contacts.search_contacts — Search contacts: Search non-archived contacts by name/email/phone and common filters. [query, owner_id, company_id, lifecycle_stage, limit]',
].join('\n');

const RAW_REQUEST =
  'Find leads created last week who have not replied, exclude anyone with a booked appointment, ' +
  'assign them to sales reps and create follow-up tasks';

const NOW_ISO = process.env['VIRTUAL_NOW'] || '2026-11-04T10:00:00Z';

const promptCtx: PlannerPromptCtx = {
  workingStateBlock: renderWorkingState(emptyWorkingState()),
  maskedTurns: '', // first turn, nothing to mask
  cards: CARDS,
  rewrittenRequest: RAW_REQUEST, // no anaphora signal — unchanged
  rawRequest: RAW_REQUEST,
  nowIso: NOW_ISO,
};

const { system, prompt } = buildPlannerPrompt(promptCtx);

// --- models under test -------------------------------------------------

const MODELS = ['anthropic/claude-haiku-4.5', 'google/gemini-2.5-flash-lite', 'openai/gpt-5-mini'] as const;

interface AttemptResult {
  attempt: number;
  ok: boolean;
  kind?: PlanOutcome['kind'];
  stepCount?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  costUsd?: number;
  latencyMs?: number;
  error?: string;
}

interface ModelResult {
  model: string;
  attempts: AttemptResult[];
  finalOk: boolean;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeStr = cause instanceof Error ? ` | cause: ${cause.message}` : '';
    return `${err.name}: ${err.message}${causeStr}`.slice(0, 500);
  }
  return String(err).slice(0, 500);
}

async function spikeOneModel(model: string): Promise<ModelResult> {
  const attempts: AttemptResult[] = [];
  const MAX_ATTEMPTS = 2; // "ONE retry max on parse failure"

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await llmCall<PlanOutcome>({
        stage: 'spike',
        model,
        schema: planOutcomeSchema,
        system,
        prompt,
        turnId: `spike-schema-${model.replace(/[^a-z0-9]/gi, '_')}-${attempt}`,
      });
      const outcome = result.value as PlanOutcome;
      attempts.push({
        attempt,
        ok: true,
        kind: outcome.kind,
        stepCount: outcome.kind === 'plan' ? outcome.plan.steps.length : 0,
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        tokensCached: result.usage.tokensCached,
        costUsd: result.usage.costUsd,
        latencyMs: Math.round(result.usage.latencyMs),
      });
      return { model, attempts, finalOk: true };
    } catch (err) {
      attempts.push({ attempt, ok: false, error: describeError(err) });
      // loop continues for one retry, then falls through to finalOk:false
    }
  }
  return { model, attempts, finalOk: false };
}

async function main(): Promise<void> {
  if (!process.env['OPENROUTER_API_KEY']) {
    console.error('OPENROUTER_API_KEY not set (checked process.env and .env) — aborting.');
    process.exit(1);
  }

  const results: ModelResult[] = [];
  for (const model of MODELS) {
    console.error(`[spike-schema] running ${model} ...`);
    const r = await spikeOneModel(model);
    results.push(r);
  }

  console.log(JSON.stringify({ request: RAW_REQUEST, cardCount: CARDS.split('\n').length, results }, null, 2));
}

main().catch((err) => {
  console.error('[spike-schema] fatal:', err);
  process.exit(1);
});
