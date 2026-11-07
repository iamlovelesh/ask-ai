import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openSessions } from '../src/store/sessions-db';
import { openUploads, type UploadStore } from '../src/store/uploads';

describe('UploadStore', () => {
  let store: UploadStore;

  beforeEach(() => {
    store = openUploads(openSessions(`/tmp/uploads-${randomUUID()}.db`));
  });

  it('stores a file and returns an id, url, and size', () => {
    const bytes = Buffer.from('hello world', 'utf-8');
    const rec = store.put({ sessionId: 'sess_1', filename: 'note.txt', mime: 'text/plain', bytes });
    expect(rec.id).toMatch(/^up_/);
    expect(rec.url).toBe(`/api/uploads/${rec.id}`);
    expect(rec.size).toBe(bytes.length);
    expect(rec.filename).toBe('note.txt');
  });

  it('reads the stored bytes and metadata back', () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const { id } = store.put({ sessionId: 'sess_1', filename: 'blob.bin', mime: 'application/octet-stream', bytes });
    const got = store.get(id);
    expect(got?.filename).toBe('blob.bin');
    expect(got?.mime).toBe('application/octet-stream');
    expect(Buffer.from(got!.bytes).equals(bytes)).toBe(true);
  });

  it('returns undefined for an unknown id', () => {
    expect(store.get('up_missing')).toBeUndefined();
  });
});
