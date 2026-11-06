import type { Skill } from '../types.js';

export const crmHygiene: Skill = {
  name: 'crm-hygiene',
  label: 'CRM hygiene cleanup',
  description:
    'Use to clean up data quality: duplicates, missing fields, or stale records.',
  content: `# CRM hygiene cleanup
Audit a set of records for data-quality problems, report, then fix on approval.

## Audit
- Search the target set (contacts, companies, leads…); keep the [ref].
- Check for: likely duplicates (same name/email), missing key fields
  (no email/owner/stage), and stale records (no activity in a long window).
- Use data__filter_ref / data__group_by_ref to size each problem exactly —
  never estimate from a sample.

## Report
- Lead with counts per problem ("12 contacts missing an owner; 4 likely
  duplicate pairs"). Then, for each group, a short table with chips.

## Fix (only on explicit request, one group at a time)
- Propose the fix for ONE group, let the gate confirm, then move on.
- A general "yes" approves only the group in front of the user — never carry
  one approval to a second batch. Merges/archives are gated automatically.

## Rules
- Read-only until the user asks to fix. Never confirm on the user's behalf.
- Reference every record; never invent an id or a duplicate you didn't find.`,
};
