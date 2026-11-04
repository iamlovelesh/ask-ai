/**
 * SSE frame writer (LLD §6): every live/reconnect channel in this directory
 * hijacks the Fastify reply and writes raw `text/event-stream` frames —
 * `id: <seq>` + `event: <type>` + `data: <json incl. seq>` — plus a
 * heartbeat COMMENT line (`: heartbeat`) every 15s so intermediary
 * proxies/load balancers never time out an idle connection. The `id:` line
 * is what makes `Last-Event-ID`-based resumability real: a native browser
 * `EventSource` against `GET .../stream` auto-populates `Last-Event-ID` on
 * reconnect ONLY from a frame's `id:` line — without it, `stream.ts`'s
 * `afterSeq`/`Last-Event-ID` handling would never actually fire for a
 * plain `EventSource` client, only for a hand-rolled client that reads
 * `data.seq` itself.
 *
 * Deliberately dumb: this module knows nothing about sessions, turns, or
 * the EventLog — it only knows how to open the raw HTTP response and push
 * `SeqEvent`s onto it. `sessions.ts`/`stream.ts` own the subscribe/replay
 * logic and the "when do we close" policy.
 */

import type { FastifyReply } from 'fastify';
import type { SeqEvent } from '../events/log.js';

const HEARTBEAT_MS = 15_000;

export interface SseConnection {
  /** Write one event frame. No-op once `close()` has been called. */
  write(seqEv: SeqEvent): void;
  /** Idempotent: stops the heartbeat and ends the underlying response. */
  close(): void;
  /** True once `close()` has run (either explicitly or because the
   * underlying socket went away on its own). */
  isClosed(): boolean;
  /** Registers a callback for "the client went away" — used by callers
   * that need to stop subscribing to the EventLog without stopping the
   * turn itself (Task 13 note: SSE delivery and turn execution are fully
   * decoupled). Safe to call multiple times. */
  onClientGone(cb: () => void): void;
}

/**
 * Hijacks `reply` (Fastify will never touch it again — see each call
 * site's handler, which must call this BEFORE any `await`) and writes SSE
 * response headers immediately, so a `payloadAsStream`-mode test client's
 * `inject()` promise resolves right away with a live, readable stream
 * rather than waiting for the whole turn to finish.
 */
export function openSse(reply: FastifyReply): SseConnection {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const goneCallbacks: Array<() => void> = [];

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      // Connection already gone — `close()` below will catch up on the
      // next write attempt or via the 'close' listener.
    }
  }, HEARTBEAT_MS);

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      // Already ended/destroyed by the client side — nothing to do.
    }
  };

  res.on('close', () => {
    close();
    for (const cb of goneCallbacks) cb();
  });

  return {
    write(seqEv: SeqEvent): void {
      if (closed) return;
      try {
        const frame = `id: ${seqEv.seq}\nevent: ${seqEv.event.t}\ndata: ${JSON.stringify({ seq: seqEv.seq, ...seqEv.event })}\n\n`;
        res.write(frame);
      } catch {
        close();
      }
    },
    close,
    isClosed(): boolean {
      return closed;
    },
    onClientGone(cb: () => void): void {
      goneCallbacks.push(cb);
    },
  };
}
