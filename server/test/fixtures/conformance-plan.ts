/**
 * The DSL conformance example from LLD §2.2 — "the brief's flagship" plan,
 * copied verbatim. Shared fixture (NOT a `.test.ts` file, so it is never
 * picked up by vitest's own test discovery and importing it never
 * double-registers suites) — used by both `plan-schema.test.ts` (parses)
 * and `validator.test.ts` (validates).
 */
export const CONFORMANCE_PLAN_OUTCOME = {
  kind: 'plan',
  plan: {
    goal: "Assign & create follow-up tasks for last week's unreplied, unbooked leads",
    steps: [
      {
        id: 's1',
        action: 'leads.search_leads',
        params: { created_after: '2026-10-26', created_before: '2026-11-02' },
        dependsOn: [],
        expects: { nonEmpty: true },
      },
      {
        id: 's2',
        action: 'conversations.search_conversations',
        params: { contact_ids: '$s1.items[*].contact_id', has_inbound_reply: true },
        dependsOn: ['s1'],
      },
      {
        id: 's3',
        action: 'core.anti_join',
        params: { in: '$s1.items', key: 'contact_id', exclude: '$s2.items', excludeKey: 'contact_id' },
        dependsOn: ['s1', 's2'],
      },
      {
        id: 's4',
        action: 'appointments.search_appointments',
        params: { contact_ids: '$s3.items[*].contact_id', status: 'booked' },
        dependsOn: ['s3'],
      },
      {
        id: 's5',
        action: 'core.anti_join',
        params: { in: '$s3.items', key: 'contact_id', exclude: '$s4.items', excludeKey: 'contact_id' },
        dependsOn: ['s3', 's4'],
      },
      {
        id: 's6',
        action: 'users.list_users',
        params: { role: 'sales_rep', active: true },
        dependsOn: [],
        expects: { nonEmpty: true },
      },
      {
        id: 's7',
        action: 'core.distribute',
        params: { items: '$s5.items', across: '$s6.items[*].id', strategy: 'round_robin' },
        dependsOn: ['s5', 's6'],
      },
      {
        id: 's8',
        action: 'leads.assign_lead_owner',
        params: { lead_id: '$item.item.id', owner_id: '$item.assignee' },
        forEach: '$s7.items',
        dependsOn: ['s7'],
      },
      {
        id: 's9',
        action: 'tasks.create_task',
        params: {
          title: 'Follow up with $item.item.name',
          contact_id: '$item.item.contact_id',
          owner_id: '$item.assignee',
          due_date: '2026-11-05',
        },
        forEach: '$s7.items',
        dependsOn: ['s7'],
      },
    ],
  },
} as const;
