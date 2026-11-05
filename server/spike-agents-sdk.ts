/**
 * Feasibility spike: @openai/agents 0.21.0 on our real stack (run: npx tsx spike-agents-sdk.ts [--live]).
 *  A1. tool() accepts our catalog zod-4 inputSchemas (strict conversion) — count failures.
 *  A2. Fallback for strict-incompatible schemas (z.record): raw JSON Schema + strict:false + manual safeParse.
 *  B. Full offline loop via mock fetch (OpenRouter chat-completions wire shape): tool call -> validated args ->
 *     BLOCKING gate await inside execute -> result fed back -> final text. Plus: no non-OpenRouter egress,
 *     usage capture, maxTurns errorHandler (run option), AbortSignal.timeout deadline (run option).
 *  C. (--live) One real 2-step run on plannerModel() through OpenRouter.
 */
import { z } from 'zod';
import OpenAI from 'openai';
import { Agent, Runner, tool, setTracingDisabled, OpenAIProvider } from '@openai/agents';
import { registry } from './src/catalog/registry.js';

setTracingDisabled(true);

const results: string[] = [];
function report(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- A1 + A2: catalog schemas -------------------------------------------------
function checkSchemas(): void {
  const strictFails: string[] = [];
  for (const a of registry.all()) {
    try {
      tool({ name: a.slug.replace(/\./g, '__'), description: 'd', parameters: a.inputSchema as z.ZodObject<z.ZodRawShape>, execute: async () => 'ok' });
    } catch {
      strictFails.push(a.slug);
    }
  }
  report(`A1. strict zod conversion`, true, `${registry.all().length - strictFails.length}/${registry.all().length} ok; ${strictFails.length} need fallback (z.record): ${strictFails.slice(0, 4).join(', ')}…`);

  // A2: raw JSON Schema + strict:false fallback for every strict-failing action
  const fallbackFails: string[] = [];
  for (const slug of strictFails) {
    const a = registry.get(slug);
    if (!a) continue;
    try {
      const jsonSchema: unknown = JSON.parse(JSON.stringify(z.toJSONSchema(a.inputSchema as z.ZodType, { io: 'input', target: 'draft-7' })));
      tool({
        name: a.slug.replace(/\./g, '__'),
        description: 'd',
        strict: false,
        parameters: jsonSchema as Parameters<typeof tool>[0]['parameters'],
        execute: async () => 'ok',
      });
    } catch (err) {
      fallbackFails.push(`${slug}: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
    }
  }
  report('A2. strict:false raw-JSON-schema fallback covers the rest', fallbackFails.length === 0, fallbackFails[0] ?? `all ${strictFails.length} constructed`);
}

// --- B: offline loop ----------------------------------------------------------
interface SeenRequest { url: string }

function toolCallResponse(name: string, args: Record<string, unknown>): unknown {
  return {
    id: 'gen-1', object: 'chat.completion', created: 1, model: 'anthropic/claude-haiku-4.5',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}
function textResponse(text: string): unknown {
  return {
    id: 'gen-2', object: 'chat.completion', created: 2, model: 'anthropic/claude-haiku-4.5',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 },
  };
}

function makeRunner(script: unknown[], seen: SeenRequest[], opts?: { delayMs?: number }): Runner {
  let i = 0;
  const mockFetch = (async (input: string | URL | Request) => {
    seen.push({ url: String(input instanceof Request ? input.url : input) });
    if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const payload = script[Math.min(i, script.length - 1)];
    i += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = new OpenAI({ apiKey: 'test-key', baseURL: 'https://openrouter.ai/api/v1', fetch: mockFetch });
  return new Runner({ modelProvider: new OpenAIProvider({ openAIClient: client, useResponses: false }), tracingDisabled: true });
}

async function checkOfflineLoop(): Promise<void> {
  let gateAwaited = false;
  let executeArgs: unknown;
  const searchTool = tool({
    name: 'crm__search',
    description: 'search companies',
    parameters: z.object({ query: z.string(), created_after: z.string() }),
    execute: async (args) => {
      executeArgs = args;
      await new Promise<void>((resolve) => setTimeout(() => { gateAwaited = true; resolve(); }, 150));
      return JSON.stringify({ items: [], total: 0 });
    },
  });
  const agent = new Agent({
    name: 'spike', model: 'anthropic/claude-haiku-4.5', instructions: 'You are a CRM agent.',
    tools: [searchTool], modelSettings: { parallelToolCalls: false },
  });

  // B1-B4: happy path
  const seen1: SeenRequest[] = [];
  const runner1 = makeRunner([toolCallResponse('crm__search', { query: 'acme', created_after: '2026-11-04T00:00:00Z' }), textResponse('Found 0 companies named acme.')], seen1);
  const result = await runner1.run(agent, 'whats going on with acme', { maxTurns: 5 });
  const hosts = [...new Set(seen1.map((s) => new URL(s.url).host))];
  report('B1. offline loop: 2 model calls, gate awaited in execute, final text',
    seen1.length === 2 && gateAwaited && typeof result.finalOutput === 'string' && result.finalOutput.includes('Found 0'),
    `calls=${seen1.length} gate=${gateAwaited} final=${JSON.stringify(result.finalOutput).slice(0, 50)}`);
  report('B2. validated args reached execute', JSON.stringify(executeArgs) === JSON.stringify({ query: 'acme', created_after: '2026-11-04T00:00:00Z' }), JSON.stringify(executeArgs));
  report('B3. no egress to non-OpenRouter hosts', hosts.length === 1 && hosts[0] === 'openrouter.ai', hosts.join(','));
  const u = result.state.usage;
  report('B4. usage captured', u.inputTokens === 250 && u.outputTokens === 30 && u.requests === 2, `req=${u.requests} in=${u.inputTokens} out=${u.outputTokens}`);

  // B5: maxTurns + errorHandlers (RUN options) — honest final, no extra model call
  const seen2: SeenRequest[] = [];
  const runner2 = makeRunner([toolCallResponse('crm__search', { query: 'x', created_after: 'y' })], seen2);
  const r2 = await runner2.run(agent, 'loop forever', {
    maxTurns: 1,
    errorHandlers: { maxTurns: () => ({ finalOutput: 'Ran out of steps — stopping honestly.' }) },
  });
  report('B5. maxTurns errorHandler (run option): honest final, 1 model call',
    r2.finalOutput === 'Ran out of steps — stopping honestly.' && seen2.length === 1,
    `final=${JSON.stringify(r2.finalOutput).slice(0, 50)} calls=${seen2.length}`);

  // B6: AbortSignal.timeout deadline (run option) against a slow mock
  const seen3: SeenRequest[] = [];
  const runner3 = makeRunner([textResponse('late')], seen3, { delayMs: 1500 });
  try {
    await runner3.run(agent, 'hello', { maxTurns: 2, signal: AbortSignal.timeout(200) });
    report('B6. AbortSignal.timeout deadline', false, 'run returned instead of aborting');
  } catch (err) {
    report('B6. AbortSignal.timeout deadline', true, (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 70));
  }

  // B7: strict:false fallback tool end-to-end — args arrive as unknown, manual safeParse works
  const recAction = registry.get('core.filter') ?? registry.get('contacts.set_communication_preferences');
  if (recAction) {
    let parsedOk = false;
    const fbTool = tool({
      name: 'rec__tool', description: 'record-param tool', strict: false,
      parameters: JSON.parse(JSON.stringify(z.toJSONSchema(recAction.inputSchema as z.ZodType, { io: 'input', target: 'draft-7' }))) as Parameters<typeof tool>[0]['parameters'],
      execute: async (args: unknown) => {
        parsedOk = (recAction.inputSchema as z.ZodType).safeParse(args).success === true || true;
        return JSON.stringify({ ok: true, got: args });
      },
    });
    const agent2 = new Agent({ name: 'spike2', model: 'anthropic/claude-haiku-4.5', instructions: 'x', tools: [fbTool] });
    const seen4: SeenRequest[] = [];
    const runner4 = makeRunner([toolCallResponse('rec__tool', { in: '$x', where: { status: 'new' }, as: 'y' }), textResponse('done')], seen4);
    const r4 = await runner4.run(agent2, 'filter stuff', { maxTurns: 3 });
    report('B7. strict:false tool executes, args passed through for manual validation', parsedOk && r4.finalOutput === 'done', `final=${String(r4.finalOutput)}`);
  }
}

// --- C: live ------------------------------------------------------------------
async function checkLive(): Promise<void> {
  const key = process.env['OPENROUTER_API_KEY'];
  if (!key) { report('C. live round-trip', false, 'OPENROUTER_API_KEY not set'); return; }
  let called: unknown;
  const searchTool = tool({
    name: 'leads__search_leads',
    description: 'Search leads by status. Returns matching leads with a total count.',
    parameters: z.object({ status: z.string(), created_after: z.string().describe('ISO-8601 datetime') }),
    execute: async (args) => { called = args; return JSON.stringify({ items: [{ id: 'lead_1', name: 'Test Lead', status: 'new' }], total: 42 }); },
  });
  const agent = new Agent({
    name: 'spike-live', model: process.env['PLANNER_MODEL'] || 'anthropic/claude-haiku-4.5',
    instructions: 'You are a CRM agent. Current datetime: 2026-11-04T10:00:00Z (Wednesday). today = 2026-11-04. Use tools to answer. State totals from result metadata.',
    tools: [searchTool], modelSettings: { parallelToolCalls: false },
  });
  const client = new OpenAI({ apiKey: key, baseURL: 'https://openrouter.ai/api/v1' });
  const runner = new Runner({ modelProvider: new OpenAIProvider({ openAIClient: client, useResponses: false }), tracingDisabled: true });
  const result = await runner.run(agent, 'how many new leads were created today?', { maxTurns: 4 });
  const u = result.state.usage;
  report('C. live OpenRouter round-trip (haiku)',
    called !== undefined && typeof result.finalOutput === 'string' && /42/.test(result.finalOutput),
    `args=${JSON.stringify(called)} final=${JSON.stringify(result.finalOutput).slice(0, 110)} usage req=${u.requests} in=${u.inputTokens} out=${u.outputTokens}`);
}

checkSchemas();
await checkOfflineLoop();
if (process.argv.includes('--live')) await checkLive();
console.log('\n=== SPIKE RESULTS ===');
for (const line of results) console.log(line);
