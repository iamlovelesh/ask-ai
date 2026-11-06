import { describe, it, expect } from 'vitest';
import { requestedIds, unreadRequestedIds } from '../src/loop/coverage-check';

describe('coverage check', () => {
  it('extracts distinct record ids the user named', () => {
    expect(requestedIds('compare con_1, con_2 and con_1').sort()).toEqual(['con_1', 'con_2']);
    expect(requestedIds('how many open leads')).toEqual([]);
  });

  it('flags a named-set member that was never read', () => {
    const outputs = ['search: {"items":[{"id":"con_1"},{"id":"con_2"}]}']; // con_3 never read
    expect(unreadRequestedIds('which of con_1, con_2, con_3 owes most?', outputs)).toEqual(['con_3']);
  });

  it('is silent when every named id was read', () => {
    const outputs = ['con_1 … con_2 … con_3'];
    expect(unreadRequestedIds('rank con_1 con_2 con_3', outputs)).toEqual([]);
  });

  it('does not fire for a single id (not a set) or for no ids', () => {
    expect(unreadRequestedIds('tell me about con_7', [])).toEqual([]);
    expect(unreadRequestedIds('how many invoices are overdue', [])).toEqual([]);
  });
});
