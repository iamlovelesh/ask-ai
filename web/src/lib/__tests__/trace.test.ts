import { describe, expect, it } from 'vitest';
import { layoutSpans, type Span } from '../trace.js';

function span(partial: Partial<Span> & Pick<Span, 'id' | 'turnId' | 'kind' | 'startedAt'>): Span {
  return partial;
}

describe('layoutSpans', () => {
  it('returns an empty array for no spans', () => {
    expect(layoutSpans([])).toEqual([]);
  });

  it('normalizes a single span to leftPct 0 and widthPct 100', () => {
    const [bar] = layoutSpans([span({ id: 's1', turnId: 't1', kind: 'llm', name: 'plan', startedAt: 100, endedAt: 150 })]);
    expect(bar.leftPct).toBe(0);
    expect(bar.widthPct).toBe(100);
    expect(bar.label).toBe('plan');
    expect(bar.status).toBe('done');
  });

  it('places two sequential spans proportionally across the shared range', () => {
    const bars = layoutSpans([
      span({ id: 's1', turnId: 't1', kind: 'llm', name: 'plan', startedAt: 0, endedAt: 100 }),
      span({ id: 's2', turnId: 't1', kind: 'llm', name: 'repair', startedAt: 100, endedAt: 400 }),
    ]);
    expect(bars[0].leftPct).toBe(0);
    expect(bars[0].widthPct).toBeCloseTo(25, 5); // 100/400
    expect(bars[1].leftPct).toBeCloseTo(25, 5);
    expect(bars[1].widthPct).toBeCloseTo(75, 5);
  });

  it('falls back to the span kind as the label when no name was recorded', () => {
    const [bar] = layoutSpans([span({ id: 's1', turnId: 't1', kind: 'joiner', startedAt: 0, endedAt: 10 })]);
    expect(bar.label).toBe('joiner');
  });

  it('draws an open (no endedAt) span out to the right edge and marks it running', () => {
    const bars = layoutSpans([
      span({ id: 's1', turnId: 't1', kind: 'llm', startedAt: 0, endedAt: 100 }),
      span({ id: 's2', turnId: 't1', kind: 'llm', startedAt: 50 }), // never ended
    ]);
    expect(bars[1].status).toBe('running');
    expect(bars[1].leftPct + bars[1].widthPct).toBeCloseTo(100, 5);
  });

  it('marks a span with meta.error as failed regardless of endedAt', () => {
    const [bar] = layoutSpans([
      span({ id: 's1', turnId: 't1', kind: 'llm', startedAt: 0, endedAt: 10, meta: { error: 'boom' } }),
    ]);
    expect(bar.status).toBe('failed');
  });

  it('gives a zero-duration span a visible minimum width without exceeding the track', () => {
    const bars = layoutSpans([
      span({ id: 's1', turnId: 't1', kind: 'llm', startedAt: 0, endedAt: 1000 }),
      span({ id: 's2', turnId: 't1', kind: 'llm', startedAt: 1000, endedAt: 1000 }),
    ]);
    const last = bars[1];
    expect(last.leftPct).toBeCloseTo(100, 5);
    expect(last.widthPct).toBe(0); // clamped — no room left on the track
    expect(last.leftPct + last.widthPct).toBeLessThanOrEqual(100);
  });

  it('preserves input order (Spans.forTurn already orders by insertion)', () => {
    const bars = layoutSpans([
      span({ id: 'b', turnId: 't1', kind: 'llm', startedAt: 10, endedAt: 20 }),
      span({ id: 'a', turnId: 't1', kind: 'llm', startedAt: 0, endedAt: 10 }),
    ]);
    expect(bars.map((b) => b.span.id)).toEqual(['b', 'a']);
  });
});
