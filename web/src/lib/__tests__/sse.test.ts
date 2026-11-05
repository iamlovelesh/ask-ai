import { describe, expect, it } from 'vitest';
import { readSseStream } from '../sse.js';

/** Builds a ReadableStream<Uint8Array> that yields each string chunk in
 * `chunks` as a separate `read()` result — used to simulate network
 * boundaries landing anywhere, including mid-frame. */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: { seq: number; type: string }[] = [];
  for await (const frame of readSseStream(stream)) {
    out.push({ seq: frame.seq, type: frame.type });
  }
  return out;
}

describe('readSseStream', () => {
  it('parses a single whole frame', async () => {
    const frame = 'id: 1\nevent: turn.started\ndata: {"seq":1,"t":"turn.started","turnId":"t1"}\n\n';
    const out = await collect(streamFromChunks([frame]));
    expect(out).toEqual([{ seq: 1, type: 'turn.started' }]);
  });

  it('parses multiple frames delivered in one chunk', async () => {
    const chunk =
      'id: 1\nevent: turn.started\ndata: {"seq":1,"t":"turn.started"}\n\n' +
      'id: 2\nevent: retrieval.done\ndata: {"seq":2,"t":"retrieval.done"}\n\n';
    const out = await collect(streamFromChunks([chunk]));
    expect(out).toEqual([
      { seq: 1, type: 'turn.started' },
      { seq: 2, type: 'retrieval.done' },
    ]);
  });

  it('reassembles a frame split across chunk boundaries (split mid-line and mid-separator)', async () => {
    const full = 'id: 1\nevent: answer.delta\ndata: {"seq":1,"t":"answer.delta","text":"hi"}\n\n';
    // Split at an arbitrary byte offset, including splitting the closing \n\n.
    const splitPoint = full.indexOf('"text"');
    const chunks = [full.slice(0, splitPoint), full.slice(splitPoint, full.length - 1), full.slice(full.length - 1)];
    const out: { seq: number; type: string; data: Record<string, unknown> }[] = [];
    for await (const frame of readSseStream(streamFromChunks(chunks))) {
      out.push(frame);
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ seq: 1, type: 'answer.delta' });
    expect(out[0].data['text']).toBe('hi');
  });

  it('splits a frame one byte at a time and still reassembles it', async () => {
    const full = 'id: 7\nevent: step.finished\ndata: {"seq":7,"t":"step.finished","stepId":"s1"}\n\n';
    const chunks = full.split('').map((ch) => ch);
    const out = await collect(streamFromChunks(chunks));
    expect(out).toEqual([{ seq: 7, type: 'step.finished' }]);
  });

  it('ignores heartbeat comment lines interleaved with frames', async () => {
    const chunk =
      ': heartbeat\n\n' +
      'id: 3\nevent: step.started\ndata: {"seq":3,"t":"step.started"}\n\n' +
      ': heartbeat\n\n';
    const out = await collect(streamFromChunks([chunk]));
    expect(out).toEqual([{ seq: 3, type: 'step.started' }]);
  });

  it('supports a resume scenario: frames after a given seq continue a prior sequence', async () => {
    // Simulates a reconnect: the server replays everything after afterSeq,
    // so the client should simply see a contiguous run of seqs resuming
    // where the dropped connection left off.
    const chunk =
      'id: 5\nevent: step.finished\ndata: {"seq":5,"t":"step.finished"}\n\n' +
      'id: 6\nevent: answer.final\ndata: {"seq":6,"t":"answer.final","text":"done"}\n\n' +
      'id: 7\nevent: turn.completed\ndata: {"seq":7,"t":"turn.completed","status":"done"}\n\n' +
      'id: 8\nevent: memory.snapshot\ndata: {"seq":8,"t":"memory.snapshot"}\n\n';
    const out = await collect(streamFromChunks([chunk]));
    expect(out.map((f) => f.seq)).toEqual([5, 6, 7, 8]);
    expect(out[out.length - 1].type).toBe('memory.snapshot');
  });

  it('skips malformed data lines without throwing', async () => {
    const chunk =
      'id: 1\nevent: broken\ndata: {not json}\n\n' +
      'id: 2\nevent: turn.started\ndata: {"seq":2,"t":"turn.started"}\n\n';
    const out = await collect(streamFromChunks([chunk]));
    expect(out).toEqual([{ seq: 2, type: 'turn.started' }]);
  });

  it('skips a frame with an id:/event: pair but no data: line at all', async () => {
    // Distinct from the heartbeat case (a `:`-prefixed comment-only block)
    // and from the malformed-JSON case above — this is a well-formed block
    // that simply never had a `data:` line, which real frames always do;
    // still must not throw or desync the buffer for the frame after it.
    const chunk =
      'id: 1\nevent: ping\n\n' + 'id: 2\nevent: turn.started\ndata: {"seq":2,"t":"turn.started"}\n\n';
    const out = await collect(streamFromChunks([chunk]));
    expect(out).toEqual([{ seq: 2, type: 'turn.started' }]);
  });

  it('stops yielding once the stream closes', async () => {
    const chunk = 'id: 1\nevent: turn.started\ndata: {"seq":1,"t":"turn.started"}\n\n';
    const stream = streamFromChunks([chunk]);
    const out = await collect(stream);
    expect(out).toHaveLength(1);
  });
});
