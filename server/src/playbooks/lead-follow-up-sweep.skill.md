---
name: Lead follow-up sweep
description: Find leads created in a recent window who have not replied and have no booked appointment, distribute the remainder across available sales reps, and create a follow-up task for each. Use when the user asks to "follow up with", "sweep", "chase", or "assign" unreplied/unbooked/stale leads from a time window (e.g. "last week's leads who haven't replied"). Triggers: follow up, sweep leads, chase leads, unreplied leads, assign leads to reps.
---

# Lead follow-up sweep

1. Search leads created in the requested window. — slug: leads.search_leads
   `expects: {nonEmpty: true}` — an empty result here means the window has
   no leads at all; stop and report that instead of proceeding.
2. Search conversations for those leads' contacts to find anyone who has
   already replied. — slug: conversations.search_conversations
3. Anti-join: keep only leads whose contact has NOT replied. — slug: core.anti_join
4. Search appointments for the remaining contacts, status `booked`. — slug: appointments.search_appointments
5. Anti-join again: drop anyone who already has a booked appointment. — slug: core.anti_join
6. List active sales reps. — slug: users.list_users
   `expects: {nonEmpty: true}` — no reps to assign to means the sweep
   cannot proceed; clarify or abort rather than silently skipping the
   assignment.
7. Distribute the remaining leads round-robin across the reps. — slug: core.distribute
8. For each distributed `(lead, rep)` pair: assign the lead owner. — slug: leads.assign_lead_owner
   (forEach — gates ONCE with the aggregate fan-out size, never per lead.)
9. For each distributed pair: create a follow-up task for the rep,
   mentioning the lead by name. — slug: tasks.create_task

## Decision points

- If step 1 returns zero leads, stop and report an empty window — do not
  continue to conversations/appointments/distribution.
- If step 6 returns zero active reps, this is a hard blocker: the sweep
  cannot assign anything. Clarify (are inactive reps acceptable?) or abort.
- The fan-out in steps 8–9 is sized by however many leads survive BOTH
  anti-joins; if that number exceeds the `forEachHardCap` (500), the step
  is refused rather than silently chunked — narrow the time window first.

## Confirmation notes

- Step 8 (`leads.assign_lead_owner`) is a `write` action; its forEach gate
  fires ONCE with the full reassignment count, never per lead.
- Step 9 (`tasks.create_task`) similarly gates once for the whole batch of
  new tasks.
