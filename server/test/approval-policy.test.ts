import { describe, it, expect } from 'vitest';
import { approvalPolicy, AMOUNT_GATE_CENTS } from '../src/agent/approval-policy';

describe('approvalPolicy (value-based approval, #7)', () => {
  it('gates a financial action regardless of amount', () => {
    expect(approvalPolicy('invoices.issue_refund', { invoice_id: 'inv_1' })?.policy).toBe('financial-action');
    expect(approvalPolicy('payments.create_payout', {})?.policy).toBe('financial-action');
  });

  it('gates a write whose amount field meets the threshold (cents)', () => {
    expect(approvalPolicy('orders.update_order', { amount: AMOUNT_GATE_CENTS })?.policy).toBe('high-amount');
    expect(approvalPolicy('orders.update_order', { total_cents: 900_000 })?.policy).toBe('high-amount');
  });

  it('gates a high deal/opportunity value (value_cents), not only amount/total', () => {
    expect(approvalPolicy('opportunities.update_opportunity_value', { id: 'opp_1', value_cents: 200_000_000 })?.policy).toBe('high-amount');
    expect(approvalPolicy('opportunities.update_opportunity_value', { id: 'opp_1', value_cents: 4_999 })).toBeNull();
  });

  it('does NOT gate a small amount', () => {
    expect(approvalPolicy('orders.update_order', { amount: 4_999 })).toBeNull(); // $49.99
    expect(approvalPolicy('contacts.update_contact', { name: 'Sam' })).toBeNull();
  });

  it('gates a large discount (percent or fraction)', () => {
    expect(approvalPolicy('quotes.apply_discount', { discount_percent: 60 })?.policy).toBe('high-discount');
    expect(approvalPolicy('quotes.apply_discount', { discount: 0.75 })?.policy).toBe('high-discount');
    expect(approvalPolicy('quotes.apply_discount', { discount_percent: 10 })).toBeNull();
  });

  it('returns a human-readable reason for the confirm card', () => {
    expect(approvalPolicy('orders.update_order', { amount: 900_000 })?.reason).toMatch(/\$/);
  });

  it('ignores non-matching keys even with large values', () => {
    expect(approvalPolicy('contacts.update_contact', { user_count: 999_999 })).toBeNull();
  });
});
