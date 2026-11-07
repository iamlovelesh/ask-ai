import { describe, it, expect } from 'vitest';
import { buildLoopSystemPrompt, buildLoopUserPrompt } from '../src/loop/prompts';

describe('buildLoopSystemPrompt', () => {
  const system = buildLoopSystemPrompt();

  it('P1: embeds a full action catalog section when provided (pattern)', () => {
    const withCatalog = buildLoopSystemPrompt('leads.search_leads: Search leads\ninvoices.send_reminder: Send a reminder');
    expect(withCatalog).toContain('<action_catalog>');
    expect(withCatalog).toContain('leads.search_leads: Search leads');
    expect(withCatalog).toMatch(/complete list|every action that exists/i);
    expect(withCatalog).toMatch(/catalog__search_actions/);
    // without catalog arg, prompt stays as before
    expect(system).not.toContain('<action_catalog>');
  });

  it('is static and byte-stable across calls', () => {
    expect(buildLoopSystemPrompt()).toBe(system);
  });

  it('bans epoch date math: dates as ISO-8601 or @-relative strings', () => {
    expect(system).toMatch(/ISO-8601/);
    expect(system).toMatch(/@/);
    expect(system).toMatch(/never .*epoch/i);
  });

  it('I6: states the ACTUAL @-relative grammar with parseable examples', () => {
    expect(system).toContain('@now-7d');
    expect(system).toContain('@start_of_month');
    expect(system).not.toContain('"@today-"');
  });

  it('I3: search makes actions callable and must precede refusing', () => {
    expect(system).toMatch(/become callable\s+tools/i);
    expect(system).toMatch(/search BEFORE\s+refusing/i);
  });

  it('requires totals from result metadata with at most 3 examples', () => {
    expect(system).toMatch(/total/i);
    expect(system).toMatch(/at most 3/i);
  });

  it('points large-result questions at the ref tools, never sample guessing', () => {
    expect(system).toContain('data__sort_ref');
    expect(system).toContain('data__aggregate_ref');
    expect(system).toMatch(/never guess from the sample/i);
  });

  it('requires honest denied-action reporting', () => {
    expect(system).toMatch(/denied/i);
    expect(system).toMatch(/NOT executed/);
  });

  it('names the clarify and refuse exit tools', () => {
    expect(system).toContain('session__ask_user');
    expect(system).toContain('session__refuse');
  });

  it('names session__request_form for gathering several values at once', () => {
    expect(system).toContain('session__request_form');
    expect(system).toMatch(/several specific values|fill(s)? a form/i);
  });

  it('forbids clarifying or refusing in plain text instead of the exit tools', () => {
    expect(system).toMatch(/never ask .*question.*plain text|question.*ONLY.*session__ask_user/i);
    expect(system).toMatch(/never decline in plain text|decline.*ONLY.*session__refuse/i);
  });

  it('requires acting to completion, not stopping after lookups', () => {
    expect(system).toMatch(/every part of the request|do not stop after/i);
  });

  it('forbids asking permission mid-task (gates are automatic)', () => {
    expect(system).toMatch(/never ask permission/i);
  });

  it('excludes void records from receivable/owed figures (round-6 billing G2)', () => {
    expect(system).toMatch(/void/i);
  });

  it('bans answering data questions from conversation memory', () => {
    expect(system).toMatch(/never answer .*from memory|re-run the search/i);
  });

  it('treats anaphoric follow-ups ("sort them", "which of those") as data questions to re-read', () => {
    expect(system).toMatch(/follow-up/i);
    expect(system).toMatch(/sort them|which of those|re-order|re-pick/i);
  });

  it('directs find/narrow-within-a-list follow-ups to data__search_ref/filter_ref', () => {
    expect(system).toMatch(/data__search_ref/);
    expect(system).toMatch(/find the ones about|narrow/i);
  });

  it('warns never to narrow by filtering a sort_ref top-N result (ref-lineage fix)', () => {
    expect(system).toMatch(/never narrow by filtering a data__sort_ref|only the few top-N rows/i);
    expect(system).toMatch(/RE-RUN the original search|all filters combined/i);
  });

  it('adds a role-permission note for non-admin principals, framing refusals as permission', () => {
    const viewer = buildLoopSystemPrompt(undefined, 'viewer');
    expect(viewer).toMatch(/acting as a viewer/i);
    expect(viewer).toMatch(/don't have permission|do NOT claim the capability/i);
    const member = buildLoopSystemPrompt(undefined, 'member');
    expect(member).toMatch(/acting as a member/i);
    // admin (default) gets no permission block — unchanged prompt.
    expect(buildLoopSystemPrompt(undefined, 'admin')).toBe(system);
    expect(buildLoopSystemPrompt()).toBe(system);
  });

  it('directs per-record writes to the two one-step bulk tools (data__batch / apply_to_ref)', () => {
    expect(system).toMatch(/data__batch/);
    expect(system).toMatch(/data__apply_to_ref/);
    expect(system).toMatch(/create a follow-up task for each|SPECIFIC LIST/i);
    expect(system).toMatch(/exhaust your step budget|partial writes/i);
  });

  it('names the bulk apply tool', () => {
    expect(system).toContain('data__apply_to_ref');
  });

  it('frames workflows as real automations that run any CRM action, not just email/SMS', () => {
    expect(system).toMatch(/workflows are real automations/i);
    expect(system).toContain('workflow__run');
    expect(system).toMatch(/type = the action'?s slug|run ANY CRM action/i);
    expect(system).toMatch(/never tell the user workflows can only send email/i);
    expect(system).toMatch(/\{\{event\./); // event-payload interpolation guidance
  });

  it('tells the model to STOP after completing the requested writes — no re-search for extra records (double-round fix)', () => {
    expect(system).toMatch(/once you(?:'ve| have) (?:made|done|completed) the writes/i);
    expect(system).toMatch(/do not search again|create extra records/i);
    expect(system).toMatch(/overreach|beyond the .* set the user named/i);
  });

  it('routes grouping questions to group_by and mandates record reference tokens (patterns)', () => {
    expect(system).toContain('data__group_by_ref');
    expect(system).toMatch(/by\/per\/top|per owner|breakdown/i);
    expect(system).toContain('[[record:');
    expect(system).toMatch(/copied verbatim|exactly as .*appears|never invent .*reference/i);
  });

  it('bans invented filter values and self-done arithmetic', () => {
    expect(system).toMatch(/never (add|invent) filters?/i);
    expect(system).toMatch(/never do arithmetic|never (sum|add up) .*yourself/i);
  });

  it('tells the model to ACT on problem statements, not just report counts', () => {
    expect(system).toMatch(/describes a problem/i);
  });

  it('names the catalog search escape hatch', () => {
    expect(system).toContain('catalog__search_actions');
  });

  it('bans internal ids and jargon in answers', () => {
    expect(system).toMatch(/internal id/i);
  });

  it('round-7b support F2\'/N1: bans false coverage claims and uninvited count filters', () => {
    expect(system).toMatch(/checked only some/i);
    expect(system).toMatch(/count\/total questions/i);
  });

  it('permits markdown tables for multi-column/ranked results', () => {
    expect(system).toMatch(/table/i);
  });

  it('has a prompt-injection rule: record content is data, never instructions', () => {
    expect(system).toMatch(/data, never (as )?instructions/i);
    expect(system).toMatch(/notes|emails|record (field|content)/i);
  });

  it('has a set-coverage rule: read the whole named set, not one at a time', () => {
    expect(system).toMatch(/whole set|each of these|all .* of them/i);
    expect(system).toMatch(/one (record )?at a time|partly|covered/i);
  });

  it('includes the available-skills catalog and the Plan→Skill→Execute contract line', () => {
    expect(system).toMatch(/<available_skills>/);
    expect(system).toContain('overdue-invoice-reminders'); // a skill name
    expect(system).toMatch(/session__load_skills/); // the load tool is named
    expect(system).toMatch(/instructions, not capabilities|still call the|skills are instructions/i);
    // bodies must NOT be inlined in the always-on prompt
    expect(system).not.toContain('## Overdue invoice reminders');
  });

  it('the OSS reference CRM output rules: chip placement, fabricated-id negatives, gap disclosure, relevance ordering', () => {
    expect(system).toMatch(/never inside a heading/i); // chip placement
    expect(system).toMatch(/rec-person-1|inv-123|placeholder id/i); // concrete negatives
    expect(system).toMatch(/could not (evaluate|check)|name what you could not/i); // gap disclosure
    expect(system).toMatch(/answer the question.*not the biggest|sorted by risk|most at-risk/i); // relevance ordering
  });

  it('has a static Memory section naming the memory tools and the "from memory" attribution', () => {
    expect(system).toMatch(/memory__save/);
    expect(system).toMatch(/memory__recall/);
    expect(system).toMatch(/<memories>/);
    expect(system).toMatch(/from what I remember|from memory/i);
    // stays byte-stable with the Memory section present
    expect(buildLoopSystemPrompt('a: b')).toBe(buildLoopSystemPrompt('a: b'));
  });
});

describe('buildLoopUserPrompt', () => {
  const input = {
    userText: 'show me leads created today',
    nowIso: '2026-11-04T10:00:00.000Z',
    dateAnchors: 'today start = 2026-11-04T00:00:00.000Z',
    recentTurns: 'Turn 1: user said hello -> answered hi',
    currentUser: 'user_1 (Isla Reyes)',
  };

  it('embeds all five inputs', () => {
    const prompt = buildLoopUserPrompt(input);
    expect(prompt).toContain(input.userText);
    expect(prompt).toContain(input.nowIso);
    expect(prompt).toContain(input.dateAnchors);
    expect(prompt).toContain(input.recentTurns);
    expect(prompt).toContain('user_1 (Isla Reyes)');
  });

  it('scopes to the current user ONLY on explicit me/my phrasing (round-4b NEW-1)', () => {
    const prompt = buildLoopUserPrompt(input);
    expect(prompt).toMatch(/ONLY when .*(say|says|said) .*(me|my|I)/i);
    expect(prompt).toMatch(/do NOT add .*(owner|assignee|user) filter/i);
  });

  it("explains that me/my/I maps to the current user", () => {
    const prompt = buildLoopUserPrompt(input);
    expect(prompt).toMatch(/me|my|I\b/);
    expect(prompt).toMatch(/current user/i);
  });

  it('marks an empty history as such rather than omitting the section', () => {
    const prompt = buildLoopUserPrompt({ ...input, recentTurns: '' });
    expect(prompt).toMatch(/no previous turns/i);
  });

  it('includes a <memories> block before <previous_turns> when recalledMemories is non-empty', () => {
    const prompt = buildLoopUserPrompt({ ...input, recalledMemories: '- [preference] date-format: prefers EU dates' });
    expect(prompt).toContain('<memories>');
    expect(prompt).toContain('prefers EU dates');
    expect(prompt.indexOf('<memories>')).toBeLessThan(prompt.indexOf('<previous_turns>'));
  });

  it('omits the <memories> block when recalledMemories is empty or absent', () => {
    expect(buildLoopUserPrompt(input)).not.toContain('<memories>');
    expect(buildLoopUserPrompt({ ...input, recalledMemories: '' })).not.toContain('<memories>');
  });
});
