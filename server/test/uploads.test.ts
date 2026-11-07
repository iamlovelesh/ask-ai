import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openSessions } from '../src/store/sessions-db';
import { openUploads, isTextualAttachment, attachmentTextContent, MAX_ATTACHMENT_CONTENT_CHARS, type UploadStore } from '../src/store/uploads';

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

describe('attachment text content (#6 complex work)', () => {
  it('detects textual files by mime or extension', () => {
    expect(isTextualAttachment('leads.csv', 'text/csv')).toBe(true);
    expect(isTextualAttachment('data.json', 'application/json')).toBe(true);
    expect(isTextualAttachment('notes.md', 'application/octet-stream')).toBe(true); // by extension
    expect(isTextualAttachment('photo.png', 'image/png')).toBe(false);
    expect(isTextualAttachment('doc.pdf', 'application/pdf')).toBe(false);
  });

  it('returns the UTF-8 content for a text file', () => {
    const bytes = Buffer.from('name,email\nAda,ada@x.com', 'utf-8');
    expect(attachmentTextContent('leads.csv', 'text/csv', bytes)).toBe('name,email\nAda,ada@x.com');
  });

  it('returns undefined for a binary file', () => {
    expect(attachmentTextContent('photo.png', 'image/png', Buffer.from([1, 2, 3]))).toBeUndefined();
  });

  it('caps long content and marks it truncated', () => {
    const big = Buffer.from('x'.repeat(MAX_ATTACHMENT_CONTENT_CHARS + 500), 'utf-8');
    const out = attachmentTextContent('big.txt', 'text/plain', big) ?? '';
    expect(out.length).toBeLessThan(MAX_ATTACHMENT_CONTENT_CHARS + 100);
    expect(out).toMatch(/truncated/);
  });
});
