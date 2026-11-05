import { describe, it, expect } from 'vitest';
import { compose, type ComposeStepState } from '../src/agent/composer';
import type { Plan } from '../src/agent/plan-schema';

// Every test here is traced to a specific human-test finding in
// .superpowers/sdd/2026-11-04-ask-ai-implementation/humantest-{persona}-findings.md
// (RC2 fabrication/non-answers, RC7 internal jargon, RC9 copy items owned by
// the composer wave). Comments cite the finding id.

describe('compose — done: grounded leaf reporting (RC2 contract #1/#2)', () => {
  it('reports every independent leaf with real names/counts, and a real failure, without any tool slug', () => {
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
      s3: { state: 'done', result: { id: 'task_1', name: 'Follow up with Jane' } },
      s4: { state: 'failed', error: { code: 'TRANSIENT', message: 'network blip' } },
    };

    const text = compose({ outcome: 'done', plan, stepStates });

    // s1 (leads.search_leads) only ever fed s2/s3 (it's not a leaf) — its
    // raw total is plumbing, not an answer, and is correctly suppressed
    // (this is the exact shape that produced sales F9's fabricated
    // "192/192": an unfiltered upstream total standing in for a terminal
    // result). s2 IS a leaf (nothing depends on it) and is reported.
    expect(text).toContain('Assigned 2 lead owners');
    expect(text).toContain('Created Follow up with Jane');
    expect(text).not.toContain('leads.search_leads');
    expect(text).not.toContain('leads.assign_lead_owner');
    expect(text).not.toContain('tasks.create_task');
    expect(text).toContain("didn't go through");
    expect(text).toContain('send invoice reminder — network blip');
    expect(text).not.toContain('invoices.send_invoice_reminder');
  });

  it('F9 (sales, CRITICAL): a 0-result filter never falls back to an earlier unfiltered total', () => {
    // "how many deals did we close won this month vs last month" — ground
    // truth is 1 vs 21; the real bug reported 192 (the pre-filter total)
    // for BOTH months because both filter steps actually returned 0 and
    // got ignored. s1 (192 unfiltered) must never appear in the output.
    const plan: Plan = {
      goal: 'compare closed-won deals this month vs last month',
      steps: [
        { id: 's1', action: 'opportunities.search_opportunities', params: {}, dependsOn: [] },
        {
          id: 's2',
          action: 'core.filter',
          params: { field: 'closed_won_date', op: 'contains', value: '2026-11' },
          dependsOn: ['s1'],
        },
        {
          id: 's3',
          action: 'core.filter',
          params: { field: 'closed_won_date', op: 'contains', value: '2026-10' },
          dependsOn: ['s1'],
        },
      ],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: { state: 'done', result: { items: new Array(5).fill({ id: 'o' }), total: 192 } },
      s2: { state: 'done', result: { items: [] } },
      s3: { state: 'done', result: { items: [] } },
    };

    const text = compose({ outcome: 'done', plan, stepStates });

    expect(text).not.toContain('192');
    expect(text).toContain('matching "2026-11"');
    expect(text).toContain('matching "2026-10"');
    expect(text.match(/didn't find any/g)?.length).toBe(2);
  });

  it('billing F1 (HIGH): a null-pluck ("total amount owed") is an honest "couldn\'t compute", never silent filler', () => {
    const plan: Plan = {
      goal: 'total amount owed on overdue invoices',
      steps: [
        { id: 's1', action: 'invoices.list_overdue_invoices', params: {}, dependsOn: [] },
        { id: 's2', action: 'core.pluck', params: { field: 'amount_cents' }, dependsOn: ['s1'] },
      ],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: { state: 'done', result: { items: new Array(3).fill({ id: 'i' }), total: 165 } },
      s2: { state: 'done', result: { items: [null, null, null] } },
    };

    const text = compose({ outcome: 'done', plan, stepStates });

    expect(text).toContain("couldn't compute that");
    expect(text).not.toMatch(/is computed\.?$/m);
  });

  it('billing F1b: when a sum IS plucked, composer surfaces the actual computed number (not a vague non-answer)', () => {
    const plan: Plan = {
      goal: 'total amount owed on overdue invoices',
      steps: [
        { id: 's1', action: 'invoices.list_overdue_invoices', params: {}, dependsOn: [] },
        { id: 's2', action: 'core.pluck', params: { field: 'total_cents' }, dependsOn: ['s1'] },
      ],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: { state: 'done', result: { items: new Array(2).fill({ id: 'i' }), total: 2 } },
      s2: { state: 'done', result: { items: [10000, 5000] } },
    };

    const text = compose({ outcome: 'done', plan, stepStates });

    expect(text).toContain('$150.00');
  });

  it('billing F2 (CRITICAL): "which invoice has the biggest amount" surfaces the actual record, not a content-free "I found it"', () => {
    const plan: Plan = {
      goal: 'the overdue invoice with the largest amount owed',
      steps: [{ id: 's1', action: 'invoices.get_invoice_details', params: {}, dependsOn: [] }],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: { state: 'done', result: { id: 'inv_688', name: 'INV-2687', total_cents: 1051142 } },
    };

    const text = compose({ outcome: 'done', plan, stepStates });

    expect(text).toContain('INV-2687');
    expect(text).toContain('$10511.42');
  });

  it('marketing F4 (CRITICAL): a write confirmation echoes the ACTUAL written dates from the result, never invented ones', () => {
    // Ground truth: the coupon was actually written with a 2024 expiry
    // despite the plan intending Nov 2026. Composer only ever reads
    // `result` (the real written row) — there is no path for it to
    // substitute the planner's intended value.
    const plan: Plan = {
      goal: 'create coupon VIPLOVE20',
      steps: [{ id: 's1', action: 'coupons.create_coupon', params: { valid_until: 1732992000000 }, dependsOn: [] }],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: {
        state: 'done',
        result: { id: 'struct_396', name: 'VIPLOVE20', valid_until: 1732992000000 /* 2024-11-30, real DB value */ },
      },
    };

    const text = compose({ outcome: 'done', plan, stepStates });

    expect(text).toContain('VIPLOVE20');
    expect(text).toContain('2024-11-30');
  });

  it('support F8 (HIGH): "what did we last tell them" quotes the actual last message body, not container counts', () => {
    const plan: Plan = {
      goal: 'what did we last tell contact con_7175',
      steps: [
        { id: 's1', action: 'email.search_emails', params: {}, dependsOn: [] },
        { id: 's2', action: 'sms.search_sms', params: {}, dependsOn: [] },
      ],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: {
        state: 'done',
        result: { items: [{ id: 'e1', body: 'Please review the invoice.', sent_at: 1788000000000 }], total: 2 },
      },
      s2: {
        state: 'done',
        result: {
          items: [{ id: 'm1', body: 'Happy to help — here are the details.', sent_at: 1788580267884 }],
          total: 5,
        },
      },
    };

    const text = compose({ outcome: 'done', plan, stepStates });

    expect(text).toContain('Happy to help — here are the details.');
    expect(text).not.toContain('I found 2 emails');
    expect(text).not.toMatch(/\b2\b.*email/i);
  });

  it('sales F12 (CRITICAL): a truncated result discloses the truncation instead of silently claiming completeness', () => {
    const plan: Plan = {
      goal: 'find new leads with score over 95',
      steps: [{ id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] }],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: { state: 'done', result: { __spill: true, total: 77, sample: [{ id: 'lead_1', name: 'lead_1' }] } },
    };

    const text = compose({ outcome: 'done', plan, stepStates });

    expect(text).toContain('77');
    expect(text).toContain('showing the first 1 of 77');
  });
});

describe('compose — genericity self-check: an UNTESTED, fictitious module', () => {
  // Per the standing rule: every grounding behavior above must come from
  // RESULT STRUCTURE (row shape, field-name SUFFIX CONVENTIONS verified
  // across the whole catalog, leaf/non-leaf position in the dependency
  // graph) — never from the specific module/action names the 4 human-test
  // personas happened to exercise. This proves it on a module ("widgets")
  // that appears nowhere in this catalog and nowhere in any finding.
  it('applies the same zero-result, amount-pluck, and write-confirmation rules to a brand-new module', () => {
    const emptyPlan: Plan = {
      goal: 'find discounted widgets',
      steps: [{ id: 's1', action: 'widgets.search_widgets', params: {}, dependsOn: [] }],
    };
    const empty = compose({
      outcome: 'done',
      plan: emptyPlan,
      stepStates: { s1: { state: 'done', result: { items: [], total: 0 } } },
    });
    expect(empty).toBe("I didn't find any widgets.");

    const sumPlan: Plan = {
      goal: 'total widget price',
      steps: [
        { id: 's1', action: 'widgets.search_widgets', params: {}, dependsOn: [] },
        { id: 's2', action: 'core.pluck', params: { field: 'price_cents' }, dependsOn: ['s1'] },
      ],
    };
    const summed = compose({
      outcome: 'done',
      plan: sumPlan,
      stepStates: {
        s1: { state: 'done', result: { items: [{ id: 'w1' }, { id: 'w2' }], total: 2 } },
        s2: { state: 'done', result: { items: [2500, 1500] } },
      },
    });
    expect(summed).toBe('That comes to $40.00, summing price across 2 records.');

    const writePlan: Plan = {
      goal: 'discontinue widget W-1',
      steps: [{ id: 's1', action: 'widgets.discontinue_widget', params: { id: 'w1', effective_at: 999 }, dependsOn: [] }],
    };
    const written = compose({
      outcome: 'done',
      plan: writePlan,
      // Actual DB-written value differs from the plan's intended param —
      // composer must echo the RESULT, never the plan's `effective_at`.
      stepStates: { s1: { state: 'done', result: { id: 'w1', name: 'W-1', effective_at: 12345 } } },
    });
    expect(written).toContain('W-1');
    expect(written).not.toContain('12345'); // raw epoch isn't echoed...
    expect(written).toContain(new Date(12345).toISOString().slice(0, 10)); // ...the ACTUAL written date is, formatted
  });
});

describe('compose — derived-metric honesty (P3)', () => {
  it('billing N3: a money sum names the field basis so gross is never presented as "owed"', () => {
    const plan: Plan = {
      goal: 'total amount owed',
      steps: [
        { id: 's1', action: 'invoices.search_invoices', params: {}, dependsOn: [] },
        { id: 's2', action: 'core.pluck', params: { field: 'total_cents' }, dependsOn: ['s1'] },
      ],
    };
    const text = compose({
      outcome: 'done',
      plan,
      stepStates: {
        s1: { state: 'done', result: { items: [{ id: 'inv_1' }, { id: 'inv_2' }], total: 2 } },
        s2: { state: 'done', result: { items: [100000, 50000] } },
      },
    });
    expect(text).toContain('$1500.00');
    expect(text).toContain('total'); // names WHAT was summed (the field basis)
    expect(text).toContain('across 2 records');
  });

  it('a derived owed field (computed upstream) is summed and labeled by its name', () => {
    const plan: Plan = {
      goal: 'total owed',
      steps: [
        { id: 's1', action: 'invoices.search_invoices', params: {}, dependsOn: [] },
        { id: 's2', action: 'core.compute', params: { in: '$s1.items[*]', left: 'total_cents', op: 'subtract', right: 'amount_paid_cents', as: 'owed_cents' }, dependsOn: ['s1'] },
        { id: 's3', action: 'core.pluck', params: { field: 'owed_cents' }, dependsOn: ['s2'] },
      ],
    };
    const text = compose({
      outcome: 'done',
      plan,
      stepStates: {
        s1: { state: 'done', result: { items: [{ id: 'inv_1' }], total: 1 } },
        s2: { state: 'done', result: { items: [{ id: 'inv_1', owed_cents: 41586349 }] } },
        s3: { state: 'done', result: { items: [41586349] } },
      },
    });
    expect(text).toContain('$415863.49');
    expect(text).toContain('owed');
  });
});

describe('compose — write-echo names the CHANGED fields (P2: narrative fabrication)', () => {
  it('sales F13: "update lead score to 99" echoes the score, not an invented status/value/date', () => {
    const plan: Plan = {
      goal: 'update lead_88 score to 99',
      steps: [{ id: 's1', action: 'leads.update_lead', params: { id: 'lead_88', score: 99 }, dependsOn: [] }],
    };
    // The full DB record carries unrelated fields (status, value_cents,
    // created_at) that the OLD composer narrated as "new status, $361.06,
    // 2026-11-01" — none of which the request touched.
    const text = compose({
      outcome: 'done',
      plan,
      stepStates: {
        s1: { state: 'done', result: { id: 'lead_88', score: 99, status: 'new', value_cents: 36106, created_at: Date.parse('2026-11-01') } },
      },
    });
    expect(text).toContain('lead_88');
    expect(text).toContain('score'); // the field that actually changed, named
    expect(text).toContain('99');
    expect(text).not.toContain('$361.06'); // irrelevant monetary field not narrated
    expect(text).not.toContain('2026-11-01'); // irrelevant created_at not narrated
    expect(text).not.toContain('now new'); // status wasn't changed → not claimed
  });

  it('support NF1: reassignment names the new assignee (the changed param), from the result value', () => {
    const plan: Plan = {
      goal: 'reassign ticket to Hana',
      steps: [{ id: 's1', action: 'support_tickets.reassign_ticket', params: { id: 'ticket_362', assignee_id: '$s0.id' }, dependsOn: [] }],
    };
    const text = compose({
      outcome: 'done',
      plan,
      stepStates: { s1: { state: 'done', result: { id: 'ticket_362', assignee_id: 'user_25', status: 'open' } } },
    });
    expect(text).toContain('ticket_362');
    expect(text).toContain('assignee');
    expect(text).toContain('user_25');
    expect(text).not.toContain('now open'); // status unchanged by this write
  });

  it('a param-less write (cancel) still conveys its effect via the result status', () => {
    const plan: Plan = {
      goal: 'cancel task',
      steps: [{ id: 's1', action: 'tasks.cancel_task', params: {}, dependsOn: [] }],
    };
    const text = compose({
      outcome: 'done',
      plan,
      stepStates: { s1: { state: 'done', result: { id: 'task_9', status: 'cancelled' } } },
    });
    expect(text).toContain('Cancelled');
    expect(text).toContain('now cancelled');
  });
});

describe('compose — cancelled (RC9: calm rejection tone)', () => {
  it('billing F6 / marketing F9: a rejected confirmation reads as a calm "no changes", not an error', () => {
    const plan: Plan = {
      goal: 'cancel subscription sub_3',
      steps: [{ id: 's1', action: 'subscriptions.cancel_subscription', params: {}, dependsOn: [] }],
    };
    const stepStates: Record<string, ComposeStepState> = { s1: { state: 'cancelled' } };

    const text = compose({ outcome: 'cancelled', plan, stepStates, reason: 'A confirmation was denied.' });

    expect(text).toBe("Okay — I didn't make any changes.");
  });

  it('still reports what was already done and any real failure alongside the rejected step', () => {
    const plan: Plan = {
      goal: 'assign leads and notify finance',
      steps: [
        { id: 's1', action: 'leads.search_leads', params: {}, dependsOn: [] },
        { id: 's2', action: 'leads.assign_lead_owner', params: {}, dependsOn: ['s1'] },
        { id: 's3', action: 'invoices.send_invoice_reminder', params: {}, dependsOn: [] },
      ],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: { state: 'done', result: { items: [{ id: 'l1' }], total: 3 } },
      s2: { state: 'failed', error: { code: 'TRANSIENT', message: 'owner lookup timed out' } },
      s3: { state: 'cancelled' },
    };

    const text = compose({ outcome: 'cancelled', plan, stepStates, reason: 'A confirmation was denied.' });

    expect(text).toContain("Okay — I didn't make any changes.");
    expect(text).toContain("didn't go through");
    expect(text).toContain('assign lead owner — owner lookup timed out');
    expect(text).not.toContain('leads.assign_lead_owner');
  });
});

describe('compose — clarify', () => {
  it('returns the question verbatim, with no added prefix/suffix', () => {
    const text = compose({ outcome: 'clarify', question: 'Which pipeline do you mean: Sales or Renewals?' });
    expect(text).toBe('Which pipeline do you mean: Sales or Renewals?');
  });
});

describe('compose — refused (RC7: no internal vocabulary, honest capability framing)', () => {
  it('renders an already-clean reason verbatim (nearest-capability hint already folded in)', () => {
    const text = compose({
      outcome: 'refused',
      reason: "I can't delete a whole pipeline. Did you mean to archive it instead?",
    });
    expect(text).toBe("I can't delete a whole pipeline. Did you mean to archive it instead?");
  });

  it('falls back to a generic message when no reason is given', () => {
    expect(compose({ outcome: 'refused' })).toBe("I can't help with that.");
  });

  it('support F10 (MEDIUM): gibberish input gets an honest "I didn\'t catch that", never a false narrow-capability claim', () => {
    const text = compose({
      outcome: 'refused',
      reason: "I can only help with creating or searching for events. I can't understand your request.",
    });
    expect(text).toBe("I didn't catch that — could you rephrase your request?");
  });

  it('marketing F3 (HIGH): raw cross-turn ref-handle grammar text is replaced wholesale, never echoed', () => {
    const text = compose({
      outcome: 'refused',
      reason:
        "Cannot proceed: the cross-turn ref '$r_t3f40f010-de38-46ee-aad4-8eeabac978f5_s2' shown in the previous plan is malformed (UUID-style, not the required format $r_t<T>_s<N>). Please provide the working state with valid cross-turn handles in the format $r_t<N>_s<M> (e.g., $r_t3_s2) so the plan can be rebuilt correctly.",
    });
    expect(text).not.toContain('$r_t');
    expect(text).not.toContain('cross-turn');
    expect(text).not.toContain('working state');
    expect(text.length).toBeGreaterThan(0);
  });

  it('support F3 (HIGH): planner monologue naming fictitious tool slugs is replaced wholesale', () => {
    const text = compose({
      outcome: 'refused',
      reason:
        "The plan cannot be corrected because: (1) there is no available action to search for users by name (users.search_users does not exist in the candidate actions), and (2) the support_tickets.assign_ticket_owner action requires specific user IDs.",
    });
    expect(text).not.toContain('users.search_users');
    expect(text).not.toContain('support_tickets.assign_ticket_owner');
    expect(text).not.toContain('candidate actions');
  });

  it('sales F7 (CRITICAL): "plan repair exhausted" + step ids + repair codes never reach the user', () => {
    const text = compose({
      outcome: 'refused',
      reason: 'The request failed partway through. The plan repair was exhausted after 4 attempts due to an unknown slug in s3.',
    });
    expect(text).not.toMatch(/\[s\d+\]/);
    expect(text).not.toContain('UNKNOWN_SLUG');
    expect(text).not.toContain('s3');
  });
});

describe('compose — failed / halted (RC2/RC7)', () => {
  it('gives an honest partial report with completed steps, failures, and pending steps, with no tool slugs', () => {
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

    const text = compose({ outcome: 'failed', plan, stepStates, reason: 'This action failed repeatedly with the same error — a different approach is needed.' });

    expect(text).toContain("I couldn't complete that");
    expect(text).toContain('search opportunities — timed out');
    expect(text).toContain("I didn't get to: create task");
    expect(text).not.toContain('tasks.create_task');
    expect(text).not.toContain('opportunities.search_opportunities');
  });

  it('sales F3 / support F2 (HIGH): "plan repair exhausted" raw codes never reach answer.final', () => {
    const text = compose({
      outcome: 'failed',
      reason: 'Plan repair exhausted after 4 attempt(s): [s2] REF_GRAMMAR, [s3] REF_GRAMMAR',
    });

    expect(text).not.toContain('REF_GRAMMAR');
    expect(text).not.toContain('[s2]');
    expect(text).not.toContain('[s3]');
    expect(text).toContain("I couldn't complete that");
  });

  it('support F6 (HIGH): a step that actually succeeded before the turn deadline is reported as success, never self-contradicted', () => {
    const plan: Plan = {
      goal: 'cancel task_1290',
      steps: [{ id: 's1', action: 'tasks.cancel_task', params: {}, dependsOn: [] }],
    };
    const stepStates: Record<string, ComposeStepState> = {
      s1: { state: 'done', result: { id: 'task_1290', status: 'cancelled' } },
    };

    const text = compose({
      outcome: 'failed',
      plan,
      stepStates,
      reason: 'Turn exceeded its 130000ms wall-clock budget (turnTimeoutMs).',
    });

    expect(text).toContain('Cancelled');
    expect(text).toContain('now cancelled');
    expect(text).not.toContain('partway through');
    expect(text).not.toContain("I couldn't complete");
  });

  it('billing F7 (CRITICAL): "UNKNOWN_PARAM" repair-exhaustion text never reaches the user', () => {
    const text = compose({
      outcome: 'failed',
      reason: 'The request failed partway through. The plan repair was exhausted after 4 attempts, with failures on [s1] UNKNOWN_PARAM and [s1] UNKNOWN_PARAM.',
    });

    expect(text).not.toContain('UNKNOWN_PARAM');
    expect(text).not.toContain('[s1]');
    expect(text).toContain("I couldn't complete that");
  });
});
