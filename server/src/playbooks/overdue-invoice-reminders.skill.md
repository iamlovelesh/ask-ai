---
name: overdue-invoice-reminders
title: Overdue invoice reminders
description: List invoices past their due date and send a reminder for each one. Use when the user asks to "chase", "remind", or "follow up on" overdue/unpaid/late invoices, or to collect on outstanding balances. Triggers: overdue invoices, unpaid invoices, send reminders, collections, late payment.
---

# Overdue invoice reminders

1. List overdue invoices. — slug: invoices.list_overdue_invoices
   `expects: {nonEmpty: true}` — if nothing is overdue, say so instead of
   running the fan-out below.
2. For each overdue invoice, send a reminder. — slug: invoices.send_invoice_reminder
   (forEach — `invoices.send_invoice_reminder` is risk `external`, so this
   ALWAYS gates regardless of count, once with the aggregate scope.)

## Decision points

- If step 1 is empty, stop — nothing is overdue, there is nothing to send.
- `invoices.send_invoice_reminder` is an external-communication action
  (it reaches the customer); it gates even for a single invoice, not just
  above the bulk threshold.
- If the user wants to filter (e.g. "only invoices over $500" or "only
  more than 14 days overdue"), apply `core.filter` on the step 1 result
  before the forEach, rather than sending reminders to everyone overdue.

## Confirmation notes

- The forEach gate's `targetSample` surfaces a few customer/invoice names
  so the user can sanity-check before reminders actually go out — always
  review that list for an unexpectedly large or oddly-scoped batch.
