import type { Skill } from '../types.js';

export const leadFollowUp: Skill = {
  name: 'lead-follow-up',
  label: 'Lead follow-up sweep',
  description:
    'Use when the user wants to follow up with leads that have gone quiet, or asks who needs chasing.',
  content: `# Lead follow-up sweep
Find leads/opportunities that have gone silent and propose the next touch.

## Gather
- Search open leads (leads.search_leads) and/or open opportunities; keep the result's [ref].
- "Gone quiet" = no SENT outbound message in N days (default 14). A draft or
  queued message is NOT outreach — check message status = sent, never count
  drafts. Use data__filter_ref on the conversation/message set.
- Do not scan every record: filter by relation (owner, stage) first.

## Produce
- A markdown table: Lead | Last sent | Days silent | Suggested next step,
  one row per lead, sorted by days silent (longest first). Cite each lead as
  a [[record:...]] chip in the first column.
- Lead with the count ("8 leads have had no contact in 14+ days"), then the table.

## Rules
- Read-only unless the user says "send"/"remind"/"chase".
- To act on the whole set, use data__apply_to_ref with the [ref] — ONE
  confirmation covers all; never loop a send action record-by-record.
- Never invent a last-contact date; if a lead has no messages, say "no
  outreach on record", do not guess.`,
};
