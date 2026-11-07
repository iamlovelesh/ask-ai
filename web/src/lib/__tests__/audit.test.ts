import { describe, expect, it } from 'vitest';
import { buildAuditEntries } from '../audit.js';
import type { TurnView } from '../fold.js';

function turn(partial: Partial<TurnView> & Pick<TurnView, 'turnId' | 'userText'>): TurnView {
  return {
    stepOrder: [],
    steps: {},
    activity: [],
    deltaText: '',
    memoryOps: [],
    ...partial,
  };
}

describe('buildAuditEntries', () => {
  it('returns nothing for a turn with no confirmations and no finished/failed steps', () => {
    const t = turn({
      turnId: 't1',
      userText: 'hi',
      stepOrder: ['s1'],
      steps: { s1: { stepId: 's1', action: 'leads.search_leads', status: 'running' } },
    });
    expect(buildAuditEntries([t])).toEqual([]);
  });

  it('excludes pending/running/skipped steps, includes done/failed', () => {
    const t = turn({
      turnId: 't1',
      userText: 'hi',
      stepOrder: ['s1', 's2', 's3', 's4'],
      steps: {
        s1: { stepId: 's1', action: 'a1', status: 'pending' },
        s2: { stepId: 's2', action: 'a2', status: 'skipped' },
        s3: { stepId: 's3', action: 'a3', status: 'done', summary: 'did it', seq: 5 },
        s4: { stepId: 's4', action: 'a4', status: 'failed', error: { code: 'E', message: 'boom' }, seq: 6 },
      },
    });
    const entries = buildAuditEntries([t]);
    expect(entries.map((e) => e.kind)).toEqual(['step.finished', 'step.failed']);
    expect(entries[0]).toMatchObject({ label: 'a3', detail: 'did it', seq: 5 });
    expect(entries[1]).toMatchObject({ label: 'a4', detail: 'boom', seq: 6 });
  });

  it('emits both confirmation.required and confirmation.resolved entries, in seq order', () => {
    const t = turn({
      turnId: 't1',
      userText: 'archive it',
      pendingConfirm: {
        confirmId: 'c1',
        stepId: 's1',
        scope: { actions: ['contacts.archive_contact'], affectedCount: 2, targetSample: [], description: 'Archive 2 contacts' },
        resolved: true,
        approved: true,
        requiredSeq: 4,
        resolvedSeq: 5,
      },
    });
    const entries = buildAuditEntries([t]);
    expect(entries.map((e) => e.kind)).toEqual(['confirmation.required', 'confirmation.resolved']);
    expect(entries[0].seq).toBe(4);
    expect(entries[0].detail).toContain('Affects 2 items');
    expect(entries[1].seq).toBe(5);
    expect(entries[1].label).toBe('Confirmation approved');
  });

  it('omits the resolved entry while a confirmation is still pending', () => {
    const t = turn({
      turnId: 't1',
      userText: 'archive it',
      pendingConfirm: {
        confirmId: 'c1',
        stepId: 's1',
        scope: { actions: [], affectedCount: 1, targetSample: [], description: 'x' },
        resolved: false,
        requiredSeq: 4,
      },
    });
    const entries = buildAuditEntries([t]);
    expect(entries.map((e) => e.kind)).toEqual(['confirmation.required']);
  });

  it('sorts entries chronologically by seq ACROSS multiple turns, not grouped by turn', () => {
    const t1 = turn({
      turnId: 't1',
      userText: 'x',
      stepOrder: ['s1'],
      steps: { s1: { stepId: 's1', action: 'a1', status: 'done', seq: 10 } },
    });
    const t2 = turn({
      turnId: 't2',
      userText: 'y',
      stepOrder: ['s1'],
      steps: { s1: { stepId: 's1', action: 'a2', status: 'done', seq: 3 } },
    });
    const entries = buildAuditEntries([t1, t2]);
    expect(entries.map((e) => e.turnId)).toEqual(['t2', 't1']);
  });

  it('a label with a single affected item uses singular wording', () => {
    const t = turn({
      turnId: 't1',
      userText: 'x',
      pendingConfirm: {
        confirmId: 'c1',
        stepId: 's1',
        scope: { actions: [], affectedCount: 1, targetSample: [], description: 'x' },
        resolved: false,
        requiredSeq: 1,
      },
    });
    expect(buildAuditEntries([t])[0].detail).toBe('Affects 1 item');
  });
});
