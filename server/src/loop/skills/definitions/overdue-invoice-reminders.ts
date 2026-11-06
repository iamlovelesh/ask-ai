import type { Skill } from '../types.js';

export const overdueInvoiceReminders: Skill = {
  name: 'overdue-invoice-reminders',
  label: 'Overdue invoice reminders',
  description: 'Use when the user wants to chase overdue or unpaid invoices.',
  content: `# Overdue invoice reminders
Find overdue receivables and (on request) send reminders across the set.

## Gather
- Search invoices past their due date; keep the [ref].
- Receivables EXCLUDE status "void" and "cancelled" — filter them out with
  data__filter_ref (status neq void, then neq cancelled) BEFORE any total.
- Amount owed per invoice = total_cents - amount_paid_cents.

## Produce
- Lead with the count and the total owed. Compute the total with
  data__aggregate_ref (field total_cents, subtract_field amount_paid_cents,
  op sum) — never add figures in your head.
- Then a markdown table: Invoice | Customer | Amount owed | Days overdue,
  sorted by days overdue (most overdue first), chips in the first column.

## Fix (only if the user asks to send/remind)
- Use data__apply_to_ref over the filtered [ref] with the reminder action —
  ONE confirmation for the whole set; never loop per invoice.
- If the user is asking "what would happen", pass dry_run=true first.

## Rules
- Confirm before sending (the gate does this automatically — just call the tool).
- Present cents as dollars. Never total or convert by hand.`,
};
