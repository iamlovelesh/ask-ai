/**
 * Durable file uploads (#6). A user can attach a real file in the chat; it is
 * stored here (bytes + metadata) in the sessions DB so it survives a restart,
 * served back at /api/uploads/:id, and offered to the agent as context so it
 * can register the file as a media asset and attach it where relevant.
 *
 * Simulated CRM: there is no object store, so small files live inline as a
 * BLOB. The API caps size; this layer just persists what it is given.
 */

import { randomUUID } from 'node:crypto';
import { wallClockNow } from './clock.js';
import type { SessionsDb } from './sessions-db.js';

export interface UploadInput {
  sessionId: string;
  filename: string;
  mime: string;
  bytes: Buffer;
}

export interface UploadRecord {
  id: string;
  url: string;
  filename: string;
  mime: string;
  size: number;
}

export interface StoredUpload {
  id: string;
  filename: string;
  mime: string;
  size: number;
  bytes: Buffer;
}

export interface UploadStore {
  put(input: UploadInput): UploadRecord;
  get(id: string): StoredUpload | undefined;
}

const DDL = `CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  content BLOB NOT NULL,
  created_at INTEGER NOT NULL
)`;

export function uploadUrl(id: string): string {
  return `/api/uploads/${id}`;
}

export function openUploads(db: SessionsDb): UploadStore {
  db.run(DDL);
  return {
    put(input: UploadInput): UploadRecord {
      const id = `up_${randomUUID().slice(0, 12)}`;
      const size = input.bytes.length;
      db.run(
        `INSERT INTO uploads (id, session_id, filename, mime, size, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, input.sessionId, input.filename, input.mime, size, input.bytes, wallClockNow()],
      );
      return { id, url: uploadUrl(id), filename: input.filename, mime: input.mime, size };
    },

    get(id: string): StoredUpload | undefined {
      const row = db.get(`SELECT id, filename, mime, size, content FROM uploads WHERE id = ?`, [id]);
      if (!row) return undefined;
      const content = row['content'];
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content as Uint8Array);
      return { id: String(row['id']), filename: String(row['filename']), mime: String(row['mime']), size: Number(row['size']), bytes };
    },
  };
}
