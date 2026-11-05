import { describe, it, expect } from 'vitest';
import { buildLoopSystemPrompt, buildLoopUserPrompt } from '../src/loop/prompts';

describe('buildLoopSystemPrompt', () => {
  const system = buildLoopSystemPrompt();

  it('is static and byte-stable across calls', () => {
    expect(buildLoopSystemPrompt()).toBe(system);
  });

  it('bans epoch date math: dates as ISO-8601 or @-relative strings', () => {
    expect(system).toMatch(/ISO-8601/);
    expect(system).toMatch(/@/);
    expect(system).toMatch(/never .*epoch/i);
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

  it('names the catalog search escape hatch', () => {
    expect(system).toContain('catalog__search_actions');
  });

  it('bans internal ids and jargon in answers', () => {
    expect(system).toMatch(/internal id/i);
  });
});

describe('buildLoopUserPrompt', () => {
  const input = {
    userText: 'show me leads created today',
    nowIso: '2026-11-04T10:00:00.000Z',
    dateAnchors: 'today start = 2026-11-04T00:00:00.000Z',
    recentTurns: 'Turn 1: user said hello -> answered hi',
  };

  it('embeds all four inputs', () => {
    const prompt = buildLoopUserPrompt(input);
    expect(prompt).toContain(input.userText);
    expect(prompt).toContain(input.nowIso);
    expect(prompt).toContain(input.dateAnchors);
    expect(prompt).toContain(input.recentTurns);
  });

  it('marks an empty history as such rather than omitting the section', () => {
    const prompt = buildLoopUserPrompt({ ...input, recentTurns: '' });
    expect(prompt).toMatch(/no previous turns/i);
  });
});
