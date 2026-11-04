/**
 * SSE frame consumer for `eval/runner.ts` — reads a REAL `fetch` streaming
 * response body (web `ReadableStream`, not a Fastify `inject()` fake
 * socket) and yields parsed frames. Wire format is `server/src/api/sse.ts`:
 * `id: <seq>\nevent: <type>\ndata: <json incl. seq>\n\n`, with an
 * occasional `: heartbeat` comment line the parser skips.
 */

import type { Event } from '../server/src/events/types.js';

export interface SseFrame {
  seq: number;
  /** The raw decoded `data:` JSON — `{seq, ...event fields}` (sse.ts
   * spreads the event's own fields alongside `seq`, so `event.t` is
   * already present without needing the separate `event:` line). */
  data: Record<string, unknown>;
}

function parseFrame(raw: string): SseFrame | undefined {
  const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) return undefined;
  const data = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
  const seq = Number(data['seq']);
  return { seq, data };
}

/** Strips the SSE-only `seq` field back off a frame's `data`, returning
 * the plain `Event` it wraps. */
export function frameToEvent(frame: SseFrame): Event {
  const { seq: _seq, ...rest } = frame.data;
  return rest as unknown as Event;
}

export type FrameCallback = (frame: SseFrame) => 'continue' | 'stop' | Promise<'continue' | 'stop'>;

/**
 * Reads `response.body` to completion (or until `onFrame` returns
 * `'stop'`), decoding one SSE frame at a time. The server-side connection
 * closes itself once the turn's `memory.snapshot` passes through
 * (`sessions.ts`'s SSE subscriber) — this function's normal termination
 * path is simply the stream ending on its own; `onFrame` returning
 * `'stop'` is an escape hatch for callers that want to bail early (e.g.
 * once they've seen everything they need) without waiting for the socket
 * to actually close.
 */
export async function consumeSse(response: Response, onFrame: FrameCallback): Promise<void> {
  if (!response.body) throw new Error('consumeSse: response has no readable body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (raw.trim().length === 0 || raw.startsWith(':')) continue;
        const frame = parseFrame(raw);
        if (!frame) continue;
        const outcome = await onFrame(frame);
        if (outcome === 'stop') return;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed — nothing to do.
    }
  }
}

/** Convenience wrapper: collects every frame's `Event` for a single
 * `turnId` until that turn's `memory.snapshot` arrives, auto-approving or
 * denying any `confirmation.required` it sees via `onConfirmation`. Used
 * by `eval/runner.ts`'s per-turn drive loop. */
export async function runOneTurn(
  response: Response,
  opts: {
    onConfirmation: (confirmId: string) => Promise<void>;
  },
): Promise<Event[]> {
  const events: Event[] = [];
  await consumeSse(response, async (frame) => {
    const event = frameToEvent(frame);
    events.push(event);
    if (event.t === 'confirmation.required') {
      await opts.onConfirmation(event.confirmId);
    }
    if (event.t === 'memory.snapshot') return 'stop';
    return 'continue';
  });
  return events;
}
