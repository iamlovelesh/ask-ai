/**
 * M07 Notes — follows the M01 Contacts convention verbatim.
 *
 * Data home: `notes` table. `delete_note` is a soft-delete (`archived = 1`)
 * rather than a hard `DELETE`, consistent with every other table's
 * "archived respected" convention (LLD §9.3 checklist).
 *
 * `view_note_revision_history` (A10): the `notes` table has no dedicated
 * revision-history storage (no schema change was in scope for this task),
 * so this read action returns a degenerate history reconstructed from the
 * row's own `created_at`/`updated_at`/`body` — a single "created" entry,
 * plus an "edited" entry when `updated_at` has moved past `created_at`.
 * This is a documented scope limitation, not a silent stub: it still does
 * a real existence check and returns real timestamps/body off the actual
 * row, it just can't show intermediate edits that were never persisted.
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import { nextId } from './next-id.js';
import type { SynthHints } from './synth-hints.js';

const MODULE = 'notes';
const ATTACHABLE_TABLES: Record<string, string> = {
  contact: 'contacts',
  company: 'companies',
  lead: 'leads',
  opportunity: 'opportunities',
  task: 'tasks',
};

interface NoteView {
  id: string;
  name: string;
  body: string;
  contact_id: string | null;
  author_id: string | null;
  related_type: string | null;
  related_id: string | null;
  pinned: boolean;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function summarize(body: unknown): string {
  return String(body ?? '').slice(0, 60);
}

function toView(row: Row): NoteView {
  return {
    id: row['id'] as string,
    name: summarize(row['body']),
    body: (row['body'] as string | null) ?? '',
    contact_id: (row['contact_id'] as string | null) ?? null,
    author_id: (row['author_id'] as string | null) ?? null,
    related_type: (row['related_type'] as string | null) ?? null,
    related_id: (row['related_id'] as string | null) ?? null,
    pinned: row['pinned'] === 1,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getNoteRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM notes WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Note '${id}' does not exist.`);
  return row;
}

function assertRelatedExists(db: StoreTx, relatedType: string, relatedId: string): void {
  const table = ATTACHABLE_TABLES[relatedType];
  if (!table) {
    throw new ActionError(
      'VALIDATION',
      `Unsupported related_type '${relatedType}' (expected one of: ${Object.keys(ATTACHABLE_TABLES).join(', ')}).`,
    );
  }
  const row = db.get(`SELECT id FROM ${table} WHERE id = ?`, [relatedId]);
  if (!row) throw new ActionError('NOT_FOUND', `${relatedType} '${relatedId}' does not exist.`);
}

const noteView = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
  contact_id: z.string().nullable(),
  author_id: z.string().nullable(),
  related_type: z.string().nullable(),
  related_id: z.string().nullable(),
  pinned: z.boolean(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_note -------------------------------------------------------------

const createNoteInput = z.strictObject({
  body: z.string().min(1),
  contact_id: z.string().optional(),
  author_id: z.string().optional(),
  related_type: z.string().optional(),
  related_id: z.string().optional(),
});
type CreateNoteInput = z.infer<typeof createNoteInput>;

const createNote: ActionDef<CreateNoteInput, NoteView> = {
  id: 'M07.A01',
  slug: 'notes.create_note',
  module: MODULE,
  name: 'Create note',
  description: 'Create a new note, optionally attached to a contact or another record.',
  risk: 'write',
  entities: ['notes'],
  inputSchema: createNoteInput,
  outputSchema: noteView,
  searchCard: {
    synonyms: ['add note', 'new note'],
    examplePhrasings: ['Add a note about this call'],
  },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    if (input.contact_id) {
      const c = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
      if (!c) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    }
    if (input.related_type || input.related_id) {
      if (!input.related_type || !input.related_id) {
        throw new ActionError('VALIDATION', 'related_type and related_id must both be given together.');
      }
      assertRelatedExists(ctx.db, input.related_type, input.related_id);
    }
    const id = nextId(ctx.db, 'notes', 'note');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO notes (id, created_at, updated_at, archived, contact_id, author_id,
        related_type, related_id, pinned, body)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, 0, ?)`,
      [
        id,
        now,
        now,
        input.contact_id ?? null,
        input.author_id ?? null,
        input.related_type ?? null,
        input.related_id ?? null,
        input.body,
      ],
    );
    return toView(getNoteRow(ctx.db, id));
  }),
};

// --- A02 get_note -------------------------------------------------------------

const getNoteInput = z.strictObject({ id: z.string() });

const getNote: ActionDef<z.infer<typeof getNoteInput>, NoteView> = {
  id: 'M07.A02',
  slug: 'notes.get_note',
  module: MODULE,
  name: 'Get note',
  description: 'Fetch a single note by id.',
  risk: 'read',
  entities: ['notes'],
  inputSchema: getNoteInput,
  outputSchema: noteView,
  searchCard: {
    synonyms: ['note details', 'look up note'],
    examplePhrasings: ['Show me note note_8'],
  },
  handler: async (input, ctx) => toView(getNoteRow(ctx.db, input.id)),
};

// --- A03 search_notes --------------------------------------------------------

const searchNotesInput = z.strictObject({
  query: z.string().optional(),
  contact_id: z.string().optional(),
  author_id: z.string().optional(),
  pinned: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchNotesInput = z.infer<typeof searchNotesInput>;
const searchNotesOutput = listOutputSchema(noteView);
type SearchNotesOutput = ListOrSpill<NoteView>;

const searchNotes: ActionDef<SearchNotesInput, SearchNotesOutput> = {
  id: 'M07.A03',
  slug: 'notes.search_notes',
  module: MODULE,
  name: 'Search notes',
  description: 'Search non-archived notes by body and common filters.',
  risk: 'read',
  entities: ['notes'],
  inputSchema: searchNotesInput,
  outputSchema: searchNotesOutput,
  searchCard: {
    synonyms: ['find notes', 'list notes'],
    examplePhrasings: ['Find notes about the renewal', 'Pinned notes on this contact'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. Narrow with contact_id/author_id/pinned.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.query) {
      where.push('body LIKE ?');
      params.push(`%${input.query}%`);
    }
    if (input.contact_id) {
      where.push('contact_id = ?');
      params.push(input.contact_id);
    }
    if (input.author_id) {
      where.push('author_id = ?');
      params.push(input.author_id);
    }
    if (input.pinned !== undefined) {
      where.push('pinned = ?');
      params.push(input.pinned ? 1 : 0);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM notes WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM notes WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'notes', whereSql, params },
    });
  },
};

// --- A04 update_note -------------------------------------------------------------

const updateNoteInput = z.strictObject({ id: z.string(), body: z.string().min(1) });

const updateNote: ActionDef<z.infer<typeof updateNoteInput>, NoteView> = {
  id: 'M07.A04',
  slug: 'notes.update_note',
  module: MODULE,
  name: 'Update note',
  description: "Replace a note's body.",
  risk: 'write',
  entities: ['notes'],
  inputSchema: updateNoteInput,
  outputSchema: noteView,
  searchCard: {
    synonyms: ['edit note', 'update note body'],
    examplePhrasings: ['Fix the typo in this note'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getNoteRow(ctx.db, input.id);
    ctx.db.run(`UPDATE notes SET body = ?, updated_at = ? WHERE id = ?`, [
      input.body,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getNoteRow(ctx.db, input.id));
  }),
};

// --- A05 delete_note -------------------------------------------------------------

const deleteNoteInput = z.strictObject({ id: z.string() });
const deleteNoteOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const deleteNote: ActionDef<z.infer<typeof deleteNoteInput>, z.infer<typeof deleteNoteOutput>> = {
  id: 'M07.A05',
  slug: 'notes.delete_note',
  module: MODULE,
  name: 'Delete note',
  description: 'Soft-delete a note.',
  risk: 'destructive',
  entities: ['notes'],
  inputSchema: deleteNoteInput,
  outputSchema: deleteNoteOutput,
  searchCard: {
    synonyms: ['remove note', 'delete note'],
    examplePhrasings: ['Delete this note'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getNoteRow(ctx.db, input.id);
    ctx.db.run(`UPDATE notes SET archived = 1, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name: summarize(row['body']), archived: true as const };
  }),
};

// --- A06 attach_note_to_record ----------------------------------------------------

const attachNoteToRecordInput = z.strictObject({
  id: z.string(),
  related_type: z.string().min(1),
  related_id: z.string().min(1),
});

const attachNoteToRecord: ActionDef<z.infer<typeof attachNoteToRecordInput>, NoteView> = {
  id: 'M07.A06',
  slug: 'notes.attach_note_to_record',
  module: MODULE,
  name: 'Attach note to record',
  description: 'Point a note at a related record (contact/company/lead/opportunity/task).',
  risk: 'write',
  entities: ['notes'],
  inputSchema: attachNoteToRecordInput,
  outputSchema: noteView,
  searchCard: {
    synonyms: ['link note to record', 'relate note'],
    examplePhrasings: ['Attach this note to the Acme Inc opportunity'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getNoteRow(ctx.db, input.id);
    assertRelatedExists(ctx.db, input.related_type, input.related_id);
    ctx.db.run(`UPDATE notes SET related_type = ?, related_id = ?, updated_at = ? WHERE id = ?`, [
      input.related_type,
      input.related_id,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getNoteRow(ctx.db, input.id));
  }),
};

// --- A07 detach_note_from_record ----------------------------------------------------

const detachNoteFromRecordInput = z.strictObject({ id: z.string() });

const detachNoteFromRecord: ActionDef<z.infer<typeof detachNoteFromRecordInput>, NoteView> = {
  id: 'M07.A07',
  slug: 'notes.detach_note_from_record',
  module: MODULE,
  name: 'Detach note from record',
  description: 'Clear a note\'s related-record link.',
  risk: 'write',
  entities: ['notes'],
  inputSchema: detachNoteFromRecordInput,
  outputSchema: noteView,
  searchCard: {
    synonyms: ['unlink note', 'remove note relation'],
    examplePhrasings: ['Detach this note from the opportunity'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getNoteRow(ctx.db, input.id); // existence check
    // Always stamp `updated_at` even when the note was already detached —
    // idempotent in EFFECT (related_type/related_id end up NULL either
    // way) without special-casing the already-detached case, and it keeps
    // the write observably a write (smoke's state-delta check looks for a
    // row touched at the exact pinned `now`).
    ctx.db.run(`UPDATE notes SET related_type = NULL, related_id = NULL, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getNoteRow(ctx.db, input.id));
  }),
};

// --- A08 pin_note -------------------------------------------------------------

const pinNoteInput = z.strictObject({ id: z.string() });

const pinNote: ActionDef<z.infer<typeof pinNoteInput>, NoteView> = {
  id: 'M07.A08',
  slug: 'notes.pin_note',
  module: MODULE,
  name: 'Pin note',
  description: 'Pin a note.',
  risk: 'write',
  entities: ['notes'],
  inputSchema: pinNoteInput,
  outputSchema: noteView,
  searchCard: {
    synonyms: ['star note', 'pin to top'],
    examplePhrasings: ['Pin this note'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getNoteRow(ctx.db, input.id);
    ctx.db.run(`UPDATE notes SET pinned = 1, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getNoteRow(ctx.db, input.id));
  }),
};

// --- A09 unpin_note -------------------------------------------------------------

const unpinNoteInput = z.strictObject({ id: z.string() });

const unpinNote: ActionDef<z.infer<typeof unpinNoteInput>, NoteView> = {
  id: 'M07.A09',
  slug: 'notes.unpin_note',
  module: MODULE,
  name: 'Unpin note',
  description: 'Unpin a note.',
  risk: 'write',
  entities: ['notes'],
  inputSchema: unpinNoteInput,
  outputSchema: noteView,
  searchCard: {
    synonyms: ['remove pin', 'unstar note'],
    examplePhrasings: ['Unpin this note'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getNoteRow(ctx.db, input.id);
    ctx.db.run(`UPDATE notes SET pinned = 0, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getNoteRow(ctx.db, input.id));
  }),
};

// --- A10 view_note_revision_history --------------------------------------------

const viewNoteRevisionHistoryInput = z.strictObject({ id: z.string() });
const revisionEntry = z.object({ id: z.string(), version: z.number(), at: z.number(), summary: z.string() });
const viewNoteRevisionHistoryOutput = listOutputSchema(revisionEntry);
type ViewNoteRevisionHistoryOutput = ListOrSpill<z.infer<typeof revisionEntry>>;

const viewNoteRevisionHistory: ActionDef<
  z.infer<typeof viewNoteRevisionHistoryInput>,
  ViewNoteRevisionHistoryOutput
> = {
  id: 'M07.A10',
  slug: 'notes.view_note_revision_history',
  module: MODULE,
  name: 'View note revision history',
  description: 'Reconstruct a minimal revision history (created + last edit) for a note.',
  risk: 'read',
  entities: ['notes'],
  inputSchema: viewNoteRevisionHistoryInput,
  outputSchema: viewNoteRevisionHistoryOutput,
  searchCard: {
    synonyms: ['note history', 'who edited this note'],
    examplePhrasings: ['Show the edit history for this note'],
  },
  handler: async (input, ctx) => {
    const row = getNoteRow(ctx.db, input.id);
    const createdAt = row['created_at'] as number;
    const updatedAt = row['updated_at'] as number;
    const items = [
      { id: input.id, version: 1, at: createdAt, summary: `Created: ${summarize(row['body'])}` },
    ];
    if (updatedAt !== createdAt) {
      items.push({ id: input.id, version: 2, at: updatedAt, summary: `Edited: ${summarize(row['body'])}` });
    }
    return toListOrSpill(items, items.length);
  },
};

export const m07Notes: ActionDef[] = [
  createNote as ActionDef,
  getNote as ActionDef,
  searchNotes as ActionDef,
  updateNote as ActionDef,
  deleteNote as ActionDef,
  attachNoteToRecord as ActionDef,
  detachNoteFromRecord as ActionDef,
  pinNote as ActionDef,
  unpinNote as ActionDef,
  viewNoteRevisionHistory as ActionDef,
];

/** Tier-A discrimination: `pinned` counts (verified: false → 991, true → 109). */
export const m07DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'notes.search_notes',
    paramsA: { pinned: false },
    paramsB: { pinned: true },
    expectDifferentCounts: true,
  },
];

/** All M07 id fields resolve against plain tables — no module-specific hints needed. */
export const m07SynthHints: SynthHints = {};
