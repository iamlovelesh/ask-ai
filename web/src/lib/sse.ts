/**
 * fetch-stream SSE parser (LLD §6 client note): the primary live channel is
 * `POST /api/sessions/:id/messages`, whose response is an SSE body — but a
 * POST response can never be consumed via `EventSource` (browsers only ever
 * open `EventSource` against a GET). This module reads the raw
 * `ReadableStream<Uint8Array>` body (works identically for the POST live
 * channel AND the GET `/stream` reconnect channel — both emit the exact
 * same wire format, see `server/src/api/sse.ts`) and yields parsed frames.
 *
 * Wire format per frame (server/src/api/sse.ts):
 *   id: <seq>\n
 *   event: <type>\n
 *   data: <json, already includes {seq, ...event}>\n
 *   \n
 * plus heartbeat COMMENT lines (`: heartbeat\n\n`) that must be ignored.
 *
 * Frames are separated by a blank line (`\n\n`); a chunk boundary can land
 * anywhere — including mid-frame, mid-line, or mid-UTF-8-byte-sequence — so
 * this parser buffers across `read()` calls and only emits once a full
 * `\n\n`-terminated frame has arrived.
 *
 * Deliberately NOT a full SSE-spec parser — two simplifications, both safe
 * because they match `server/src/api/sse.ts` exactly (the only producer
 * this client will ever talk to) and are documented here so nobody "fixes"
 * them into spec-completeness by accident:
 *   1. **LF-only framing.** The spec also treats bare `\r` and `\r\n` as
 *      line terminators; this parser only ever splits on `\n`. The server
 *      writer builds every frame with literal `\n` (never `\r`), so this is
 *      a non-issue in practice — but a hand-written mock stream using `\r\n`
 *      line endings would NOT parse correctly here.
 *   2. **Single `data:` line per frame.** The spec allows multiple `data:`
 *      lines in one frame, concatenated with `\n` between them. The server
 *      only ever emits exactly one `data:` line per frame (one JSON blob),
 *      so this parser just takes the LAST `data:` line it sees in a block
 *      rather than concatenating — correct for every real frame, but it
 *      would silently drop earlier `data:` lines if a multi-line frame ever
 *      showed up.
 */

export interface SseFrame {
  /** Monotonic sequence number from the `id:` line (also present inside
   * `data`, since the server embeds `seq` in the JSON payload too — kept
   * here as a separate, always-numeric field for convenience). */
  seq: number;
  /** The event type from the `event:` line (equal to `data.t`). */
  type: string;
  /** The parsed JSON payload — the full `Event` shape plus `seq`. */
  data: Record<string, unknown>;
}

/**
 * Parses one or more complete SSE frames out of an accumulated text buffer.
 * Returns the parsed frames (frames with no usable `data:` line — e.g. a
 * bare heartbeat comment, or a frame missing `data:` entirely — are
 * silently skipped) and whatever incomplete tail remains buffered for the
 * next chunk.
 */
function parseBufferedFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;

  // Frames (and heartbeat comments) are separated by a blank line. Keep
  // consuming complete `\n\n`-terminated blocks; whatever's left after the
  // last separator (no trailing `\n\n` yet) stays buffered.
  for (;;) {
    const sepIndex = rest.indexOf('\n\n');
    if (sepIndex === -1) break;

    const block = rest.slice(0, sepIndex);
    rest = rest.slice(sepIndex + 2);

    if (block.length === 0) continue; // stray blank block
    if (block.startsWith(':')) continue; // heartbeat/comment line(s) only

    let dataLine: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLine = line.slice('data:'.length).trimStart();
      }
    }
    if (dataLine === undefined) continue; // no data: line — nothing to yield

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataLine) as Record<string, unknown>;
    } catch {
      continue; // malformed JSON — skip rather than throw mid-stream
    }

    const seqValue = parsed['seq'];
    const seq = typeof seqValue === 'number' ? seqValue : Number(seqValue);
    const typeValue = parsed['t'];
    const type = typeof typeValue === 'string' ? typeValue : '';
    if (!Number.isFinite(seq) || type === '') continue;

    frames.push({ seq, type, data: parsed });
  }

  return { frames, rest };
}

/**
 * Reads an SSE response body and yields parsed frames as they arrive.
 * Handles frames split across chunk boundaries and ignores heartbeat
 * comment lines. Stops when the stream closes (server `close()`'d the
 * connection) or `signal` aborts.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const onAbort = (): void => {
    void reader.cancel().catch(() => {
      // Nothing to do — the stream is being torn down anyway.
    });
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a trailing partial multi-byte UTF-8 sequence
      // buffered inside the decoder itself until the next chunk completes it.
      buffer += decoder.decode(value, { stream: true });

      const { frames, rest } = parseBufferedFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        yield frame;
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Thrown by `fetchSse` when the HTTP response itself is not ok (e.g. 409
 * "turn already running", 404 session-not-found) — distinct from a network
 * failure/drop mid-stream, which rejects with a plain error from the
 * `fetch`/reader machinery instead. Callers use `status` to branch. */
export class SseHttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string, body: string) {
    super(`SSE request failed: ${status} ${statusText} ${body}`.trim());
    this.status = status;
  }
}

/**
 * Convenience wrapper: POST (or GET) a URL and yield parsed SSE frames from
 * the response body. Throws `SseHttpError` for a non-ok response, or a
 * plain error for "no body"/network failures.
 */
export async function fetchSse(
  url: string,
  init: RequestInit,
): Promise<AsyncGenerator<SseFrame, void, void>> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new SseHttpError(res.status, res.statusText, text);
  }
  if (!res.body) {
    throw new Error('SSE response has no body');
  }
  return readSseStream(res.body, init.signal as AbortSignal | undefined);
}
