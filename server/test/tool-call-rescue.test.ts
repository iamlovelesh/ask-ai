import { describe, it, expect } from 'vitest';
import { rescueToolCalls } from '../src/loop/tool-call-rescue';

const known = new Set(['leads__search_leads', 'catalog__search_actions', 'data__sort_ref']);

function call(name: string, args = '{}'): Record<string, unknown> {
  return { id: 'resp_1', type: 'function_call', name, arguments: args, callId: 'call_1', status: 'completed' };
}

describe('rescueToolCalls (round-7b N1: unknown tool names must not kill the turn)', () => {
  it('leaves known tool names untouched', () => {
    const output = [call('leads__search_leads', '{"query":"x"}')];
    const rescued = rescueToolCalls(output, known);
    expect(rescued).toBe(0);
    expect(output[0]).toMatchObject({ name: 'leads__search_leads', arguments: '{"query":"x"}' });
  });

  it('renames dot-form calls to their bound double-underscore twin', () => {
    const output = [call('leads.search_leads', '{"query":"x"}')];
    const rescued = rescueToolCalls(output, known);
    expect(rescued).toBe(1);
    expect(output[0]).toMatchObject({ name: 'leads__search_leads', arguments: '{"query":"x"}', callId: 'call_1' });
  });

  it('rewrites a completely unknown name into a catalog search for that capability', () => {
    const output = [call('contacts__get_contact_details', '{"contact_id":"con_7"}')];
    const rescued = rescueToolCalls(output, known);
    expect(rescued).toBe(1);
    const item = output[0] as { name: string; arguments: string; callId: string };
    expect(item.name).toBe('catalog__search_actions');
    expect(JSON.parse(item.arguments)).toEqual({ query: 'contacts get contact details' });
    expect(item.callId).toBe('call_1');
  });

  it('ignores non-function items and leaves text output alone', () => {
    const output: Record<string, unknown>[] = [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    ];
    expect(rescueToolCalls(output, known)).toBe(0);
    expect(output[0]?.['type']).toBe('message');
  });

  it('never rewrites the search tool into itself (no loops)', () => {
    const output = [call('catalog__search_actions', '{"query":"x"}')];
    expect(rescueToolCalls(output, known)).toBe(0);
  });
});
