import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPlannerPrompt, plan, type PlannerPromptCtx } from '../src/agent/planner';
import { __setTestFetch, __setTestSpans, __setTestBackoffOptions, costMeter } from '../src/llm/client';
import { openSpans, type Spans } from '../src/events/trace';

function baseCtx(): PlannerPromptCtx {
  return {
    workingStateBlock: 'WORKING_STATE: {"frame":null,"entities":{},"handles":[]}',
    maskedTurns: 'TURN 1 (user): hello',
    cards: 'contacts.create_contact — Create contact: Create a new contact record. [name, email]',
    rewrittenRequest: 'Create a contact for Jane Doe',
    rawRequest: 'Create a contact for Jane Doe',
    nowIso: '2026-11-04T10:00:00.000Z',
  };
}

describe('buildPlannerPrompt — SYSTEM is byte-stable', () => {
  it('matches the snapshot (fails loudly if someone makes it dynamic)', () => {
    const { system } = buildPlannerPrompt(baseCtx());
    expect(system).toMatchSnapshot();
  });

  it('is byte-identical across two calls with entirely different ctx content', () => {
    const { system: systemA } = buildPlannerPrompt(baseCtx());
    const { system: systemB } = buildPlannerPrompt({
      ...baseCtx(),
      workingStateBlock: 'WORKING_STATE: totally different content',
      maskedTurns: 'TURN 9 (user): something else entirely',
      cards: 'invoices.list_overdue_invoices — List overdue invoices: ... [status]',
      rewrittenRequest: 'Show me overdue invoices',
      rawRequest: 'overdue invoices pls',
      nowIso: '2099-01-01T00:00:00.000Z',
    });
    expect(systemA).toBe(systemB);
  });

  it('teaches the ref grammar, $item, $r_t*, core.* signatures, and all 5 outcome kinds', () => {
    const { system } = buildPlannerPrompt(baseCtx());
    expect(system).toContain('$s<N>');
    expect(system).toContain('$r_t<T>_s<N>');
    expect(system).toContain('$item');
    expect(system).toContain('core.filter');
    expect(system).toContain('core.distribute');
    for (const kind of ['"plan"', '"search"', '"clarify"', '"unsupported"', '"respond"']) {
      expect(system).toContain(kind);
    }
  });

  it('hardens the id-resolution rule with a concrete name→search→$ref example', () => {
    const { system } = buildPlannerPrompt(baseCtx());
    expect(system).toContain('<prefix>_<number>');
    expect(system).toContain('coupons.search_coupons');
    expect(system).toMatch(/WRONG:[\s\S]*SPRING20/);
    expect(system).toMatch(/RIGHT:[\s\S]*\$s1\.items\[\*\]\.id/);
  });

  it('teaches the entity-match rule (act on the module that owns the record)', () => {
    const { system } = buildPlannerPrompt(baseCtx());
    expect(system).toContain('support_tickets');
    expect(system).toContain('conversations/tasks');
  });
});

describe('buildPlannerPrompt — USER layout (LLD §5.2)', () => {
  it('orders context, playbook, actions, request and includes nowIso', () => {
    const { prompt } = buildPlannerPrompt({ ...baseCtx(), playbookBody: 'PLAYBOOK: lead-follow-up-sweep' });
    const contextIdx = prompt.indexOf('<context>');
    const playbookIdx = prompt.indexOf('<playbook>');
    const actionsIdx = prompt.indexOf('<actions>');
    const requestIdx = prompt.indexOf('<request>');
    expect(contextIdx).toBeGreaterThanOrEqual(0);
    expect(contextIdx).toBeLessThan(playbookIdx);
    expect(playbookIdx).toBeLessThan(actionsIdx);
    expect(actionsIdx).toBeLessThan(requestIdx);
    expect(prompt).toContain('2026-11-04T10:00:00.000Z');
    expect(prompt).toContain('PLAYBOOK: lead-follow-up-sweep');
    expect(prompt).toContain('contacts.create_contact');
    expect(prompt).toContain('Create a contact for Jane Doe');
  });

  it('omits the <playbook> block entirely when no playbook matched', () => {
    const { prompt } = buildPlannerPrompt(baseCtx());
    expect(prompt).not.toContain('<playbook>');
  });

  it('renders the current_user context line when supplied (E9)', () => {
    const { prompt } = buildPlannerPrompt({ ...baseCtx(), currentUser: 'user_1 (Alice Admin)' });
    const contextBlock = prompt.slice(prompt.indexOf('<context>'), prompt.indexOf('</context>'));
    expect(contextBlock).toContain('current_user: user_1 (Alice Admin)');
  });
});

describe('buildPlannerPrompt — E9 behavioral rules in SYSTEM', () => {
  it('carries the multi-intent, identity, search-before-unsupported, substitution, and plain-reason rules', () => {
    const { system } = buildPlannerPrompt(baseCtx());
    expect(system).toContain('current_user');
    expect(system).toContain('sub-question');
    expect(system.toLowerCase()).toContain('search round first');
    expect(system.toLowerCase()).toContain('substitute');
    expect(system).toContain('end-user');
  });

  it('places the WorkingState block at the end of <context> (LLD §2.5 Writer rule)', () => {
    const { prompt } = buildPlannerPrompt(baseCtx());
    const contextBlock = prompt.slice(prompt.indexOf('<context>'), prompt.indexOf('</context>'));
    const workingStateIdx = contextBlock.indexOf('WORKING_STATE:');
    const maskedTurnsIdx = contextBlock.indexOf('TURN 1');
    expect(workingStateIdx).toBeGreaterThan(maskedTurnsIdx);
  });
});

describe('plan() — happy path (MockLLM via __setTestFetch)', () => {
  let spansPath: string;
  let spans: Spans;

  beforeEach(() => {
    costMeter.__resetForTest();
    delete process.env['EVAL_BUDGET_USD'];
    spansPath = join(tmpdir(), `ask-ai-planner-spans-${randomUUID()}.db`);
    spans = openSpans(spansPath);
    __setTestSpans(spans);
    __setTestBackoffOptions({ baseMs: 1 });
  });

  afterEach(() => {
    __setTestFetch(undefined);
    __setTestSpans(undefined);
    __setTestBackoffOptions(undefined);
    spans.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const p = spansPath + suffix;
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  it('calls llmCall with the schema and returns a parsed PlanOutcome + usage + spanId', async () => {
    const narrowOutcome = { kind: 'respond', text: 'Sure thing.' };
    // Wire content is the FLAT shape (`flatPlanOutcomeSchema` — every field
    // present; `plan`/`queries` sentinel, `question`/`reason`/`text`
    // nullable; docs/SPIKES.md §1b) a real provider's structured output
    // would actually return — `plan()` narrows it back to `narrowOutcome`
    // via `toPlanOutcome`.
    const wireOutcome = {
      kind: 'respond',
      plan: { goal: '', steps: [] },
      queries: [],
      question: null,
      reason: null,
      text: 'Sure thing.',
    };
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          id: `gen_${randomUUID()}`,
          model: 'anthropic/claude-haiku-4.5',
          choices: [
            { index: 0, message: { role: 'assistant', content: JSON.stringify(wireOutcome) }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, cost: 0.0002 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    __setTestFetch(fakeFetch);

    const result = await plan({ ...baseCtx(), turnId: `turn_${randomUUID()}` }, 'anthropic/claude-haiku-4.5');

    expect(result.outcome).toEqual(narrowOutcome);
    expect(result.usage.tokensIn).toBe(50);
    expect(typeof result.spanId).toBe('string');
  });
});
