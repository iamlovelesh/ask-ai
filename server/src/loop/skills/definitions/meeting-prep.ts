import type { Skill } from '../types.js';

export const meetingPrep: Skill = {
  name: 'meeting-prep',
  label: 'Meeting prep brief',
  description: 'Use before a call to brief the user on a person, company, or account.',
  content: `# Meeting prep brief
Produce a under-a-minute brief on an account before a call.

## Gather (read-only, in order)
- The person (contacts.get_contact_details) → their company → open
  opportunities on that company → recent activity (notes, SENT messages,
  meetings). Use the contact/company id from a prior result — never guess one.
- Only the last handful of activity items; filter by relation, don't scan.

## Produce — fixed order, each line short
1. Who: person + role + company (chips).
2. Deals: open opportunities with stage and amount (dollars).
3. Recent activity: last few SENT touches with dates (drafts are not activity).
4. Open commitments: tasks due/overdue.
5. "3 questions worth asking" — specific to what you found.
Keep the whole brief readable in under a minute.

## Rules
- Read-only. Reference every record as a [[record:...]] chip.
- If a section has no data, say so in one line; do not pad or invent.`,
};
