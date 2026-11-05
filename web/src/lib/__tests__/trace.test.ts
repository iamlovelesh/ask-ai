import { describe, expect, it } from 'vitest';
import { isLegacyTrace, layoutSpans, type Span } from '../trace.js';

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

describe('isLegacyTrace', () => {
  it('is false for an empty or single-span trace', () => {
    expect(isLegacyTrace([])).toBe(false);
    expect(isLegacyTrace([span({ id: 's1', turnId: 't1', kind: 'llm', startedAt: 1000, endedAt: 1000 })])).toBe(false);
  });

  it('detects a real pre-instrumentation trace: every span at the same instant, only retrieval sub-ms', () => {
    // Shape taken verbatim from a recorded historical turn: step/llm/joiner/
    // compose spans all `ms:0` with startedAt===endedAt, and the retrieval
    // span carrying only a fraction-of-a-millisecond extent.
    const base = 1793786400000;
    expect(
      isLegacyTrace([
        span({ id: 'r', turnId: 't1', kind: 'retrieval', startedAt: base, endedAt: base + 0.8965, ms: 0.8965 }),
        span({ id: 'p', turnId: 't1', kind: 'llm', name: 'plan', startedAt: base, endedAt: base, ms: 0 }),
        span({ id: 's', turnId: 't1', kind: 'step', startedAt: base, endedAt: base, ms: 0 }),
        span({ id: 'c', turnId: 't1', kind: 'compose', startedAt: base, endedAt: base, ms: 0 }),
      ]),
    ).toBe(true);
  });

  it('is false for an instrumented trace whose total range is ≥1ms', () => {
    expect(
      isLegacyTrace([
        span({ id: 's1', turnId: 't1', kind: 'llm', startedAt: 0, endedAt: 120, ms: 120 }),
        span({ id: 's2', turnId: 't1', kind: 'step', startedAt: 120, endedAt: 130, ms: 10 }),
      ]),
    ).toBe(false);
  });
});

describe('layoutSpans — legacy (pre-instrumentation) mode', () => {
  const base = 1793786400000;
  const legacySpans: Span[] = [
    span({ id: 'r', turnId: 't1', kind: 'retrieval', startedAt: base, endedAt: base + 0.5, ms: 0.5 }),
    span({ id: 'p', turnId: 't1', kind: 'llm', name: 'plan', startedAt: base, endedAt: base, ms: 0 }),
    span({ id: 's', turnId: 't1', kind: 'step', startedAt: base, endedAt: base, ms: 0 }),
    span({ id: 'c', turnId: 't1', kind: 'compose', startedAt: base, endedAt: base, ms: 0 }),
  ];

  it('falls back to equal-width sequential bars in recorded order', () => {
    const bars = layoutSpans(legacySpans);
    expect(bars.map((b) => b.span.id)).toEqual(['r', 'p', 's', 'c']);
    for (const b of bars) expect(b.widthPct).toBeCloseTo(25, 5);
    expect(bars.map((b) => b.leftPct)).toEqual([0, 25, 50, 75]);
    // Never overflows the track.
    const lastBar = bars.at(-1)!;
    expect(lastBar.leftPct + lastBar.widthPct).toBeCloseTo(100, 5);
  });

  it('still labels and statuses each legacy bar correctly', () => {
    const bars = layoutSpans(legacySpans);
    expect(bars[1].label).toBe('plan'); // name wins over kind
    expect(bars[2].label).toBe('step'); // kind fallback when unnamed
    expect(bars.every((b) => b.status === 'done')).toBe(true);
  });
});
