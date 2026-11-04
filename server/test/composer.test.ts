import { describe, it, expect } from 'vitest';
import { compose, type ComposeStepState } from '../src/agent/composer';
import type { Plan } from '../src/agent/plan-schema';

describe('compose — done (2 writes + 1 failure)', () => {
  const plan: Plan = {
    goal: 'assign leads and create follow-up tasks',
    steps: [
      { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
      { id: 's2', action: 'leads.assign_lead_owner', params: {}, dependsOn: ['s1'] },
      { id: 's3', action: 'tasks.create_task', params: {}, dependsOn: ['s1'] },
      { id: 's4', action: 'invoices.send_invoice_reminder', params: {}, dependsOn: [] },
    ],
  };
  const stepStates: Record<string, ComposeStepState> = {
    s1: { state: 'done', result: { items: [{ id: 'l1' }, { id: 'l2' }], total: 2 } },
    s2: { state: 'done', result: { items: [{ id: 'l1' }, { id: 'l2' }], total: 2 } },
    s3: { state: 'done', result: { id: 'task_1', title: 'Follow up with Jane' } },
    s4: { state: 'failed', error: { code: 'TRANSIENT', message: 'network blip' } },
  };

  it('renders the goal, real names/counts for the completed writes, and the failure', () => {
    const text = compose({ outcome: 'done', plan, stepStates });

    expect(text).toContain('assign leads and create follow-up tasks');
    // leads.search_leads is a READ (not reported as a "write" one-liner,
    // but included since composer reports every non-core completed step —
    // still grounded: its count comes straight from stepStates).
    expect(text).toContain('leads.search_leads: 2 record(s)');
    expect(text).toContain('leads.assign_lead_owner: 2 record(s)');
    // s3's result has a name/title and count<=1 -> rendered by name.
    expect(text).toContain('tasks.create_task: Follow up with Jane');
    expect(text).toContain('Failures:');
    expect(text).toContain('invoices.send_invoice_reminder failed: network blip');
  });
});

describe('compose — cancelled', () => {
  it('reports what was NOT done and why', () => {
    const plan: Plan = {
      goal: 'send reminders for overdue invoices',
      steps: [
        { id: 's1', action: 'invoices.list_overdue_invoices', params: {}, dependsOn: [] },
        { id: 's2', action: 'invoices.send_invoice_reminder', params: {}, dependsOn: ['s1'] },
      ],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: { state: 'done', result: { items: [{ id: 'i1' }], total: 12 } },
      s2: { state: 'cancelled' },
    };

    const text = compose({
      outcome: 'cancelled',
      plan,
      stepStates,
      reason: 'You denied the confirmation for sending 12 reminders.',
    });

    expect(text).toContain('was not completed');
    expect(text).toContain('You denied the confirmation');
    expect(text).toContain('invoices.send_invoice_reminder');
    expect(text).toContain('Already completed');
    expect(text).toContain('invoices.list_overdue_invoices: 12 record(s)');
  });
});

describe('compose — clarify', () => {
  it('returns the question verbatim, with no added prefix/suffix', () => {
    const text = compose({ outcome: 'clarify', question: 'Which pipeline do you mean: Sales or Renewals?' });
    expect(text).toBe('Which pipeline do you mean: Sales or Renewals?');
  });
});

describe('compose — refused', () => {
  it('renders the reason (nearest-capability hint, if any, is already folded into it)', () => {
    const text = compose({
      outcome: 'refused',
      reason: "I can't delete a whole pipeline. Did you mean to archive it instead?",
    });
    expect(text).toBe("I can't delete a whole pipeline. Did you mean to archive it instead?");
  });

  it('falls back to a generic message when no reason is given', () => {
    expect(compose({ outcome: 'refused' })).toBe("I can't help with that.");
  });
});

describe('compose — failed / halted', () => {
  it('gives an honest partial report with completed steps, failures, and pending steps', () => {
    const plan: Plan = {
      goal: 'review the pipeline',
      steps: [
        { id: 's1', action: 'pipelines.list_pipelines', params: {}, dependsOn: [] },
        { id: 's2', action: 'opportunities.search_opportunities', params: {}, dependsOn: ['s1'] },
        { id: 's3', action: 'tasks.create_task', params: {}, dependsOn: ['s2'] },
      ],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: { state: 'done', result: { items: [{ id: 'p1' }], total: 1 } },
      s2: { state: 'failed', error: { code: 'TRANSIENT', message: 'timed out' } },
      s3: { state: 'skipped' },
    };

    const text = compose({ outcome: 'failed', plan, stepStates, reason: 'Stopped after a repeated failure.' });

    expect(text).toContain('pipelines.list_pipelines: 1 record(s)');
    expect(text).toContain('opportunities.search_opportunities failed: timed out');
    expect(text).toContain('Not reached: tasks.create_task');
    expect(text).toContain('Stopped after a repeated failure.');
  });
});
