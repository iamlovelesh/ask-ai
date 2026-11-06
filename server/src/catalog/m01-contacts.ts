/**
 * M01 Contacts — the Task-8 REFERENCE module. Every handler convention that
 * M02-M50 (later tasks) copy verbatim lives here:
 *   - idempotent writes: `withIdempotentWrite` (idempotency.ts) wraps every
 *     write/destructive handler; a retried call with the same
 *     `ctx.idempotencyKey` replays the stored result instead of re-mutating.
 *   - list outputs cap at 50 inline rows, spilling to the `{__spill:true,
 *     total, sample}` marker beyond that (list-output.ts).
 *   - `jit` guidance strings on `create_contact`/`search_contacts`.
 *   - every output carries `id` + a display name.
 *   - `ActionError('NOT_FOUND', …)` on missing ids; `ActionError('CONFLICT',
 *     …)` on self-referential inputs (merge/relate a contact with itself).
 *   - `discriminationChecks` export (discrimination.ts) for Tier-A
 *     filter-discrimination smoke coverage on `search_contacts`.
 *
 * ID generation: contacts use the `con_{n}` convention (entities/model.ts).
 * Runtime handlers (unlike the seed generators) don't have a shared counter,
 * so `nextContactId` derives the next number from the current max in-table —
 * correct under the single-writer-transaction invariant (`crm.tx`).
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { listOutputSchema, toListOrSpill, SPILL_CAP, type ListOrSpill } from './list-output.js';
import type { DiscriminationCheck } from './discrimination.js';
import { nextId } from './next-id.js';
import type { SynthHints } from './synth-hints.js';

const MODULE = 'contacts';

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface ContactView {
  id: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  company_id: string | null;
  owner_id: string | null;
  lifecycle_stage: string | null;
  source: string | null;
  city: string | null;
  country: string | null;
  address: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): ContactView {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    first_name: (row['first_name'] as string | null) ?? null,
    last_name: (row['last_name'] as string | null) ?? null,
    email: (row['email'] as string | null) ?? null,
    phone: (row['phone'] as string | null) ?? null,
    company_id: (row['company_id'] as string | null) ?? null,
    owner_id: (row['owner_id'] as string | null) ?? null,
    lifecycle_stage: (row['lifecycle_stage'] as string | null) ?? null,
    source: (row['source'] as string | null) ?? null,
    city: (row['city'] as string | null) ?? null,
    country: (row['country'] as string | null) ?? null,
    address: (row['address'] as string | null) ?? null,
    tags: parseJsonArray(row['tags']),
    custom_fields: parseJsonObject(row['custom_fields']),
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getContactRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM contacts WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Contact '${id}' does not exist.`);
  return row;
}

const contactView = z.object({
  id: z.string(),
  name: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company_id: z.string().nullable(),
  owner_id: z.string().nullable(),
  lifecycle_stage: z.string().nullable(),
  source: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  address: z.string().nullable(),
  tags: z.array(z.string()),
  custom_fields: z.record(z.string(), z.unknown()),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_contact -----------------------------------------------------

const createContactInput = z.strictObject({
  name: z.string().min(1).optional(),
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  company_id: z.string().optional(),
  owner_id: z.string().optional(),
  lifecycle_stage: z.string().optional(),
  source: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  address: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
type CreateContactInput = z.infer<typeof createContactInput>;
const createContactOutput = contactView;
type CreateContactOutput = z.infer<typeof createContactOutput>;

const createContact: ActionDef<CreateContactInput, CreateContactOutput> = {
  id: 'M01.A01',
  slug: 'contacts.create_contact',
  module: MODULE,
  name: 'Create contact',
  description: 'Create a new contact record.',
  risk: 'write',
  entities: ['contacts'],
  inputSchema: createContactInput,
  outputSchema: createContactOutput,
  searchCard: {
    synonyms: ['add contact', 'new contact'],
    examplePhrasings: ['Create a contact for Jane Doe', 'Add a new contact'],
  },
  jit: 'If you only have an email/phone and no confirmed new-person intent, try search_contacts first to avoid creating a duplicate.',
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const name = input.name ?? [input.first_name, input.last_name].filter(Boolean).join(' ');
    if (name.length === 0) {
      throw new ActionError('VALIDATION', 'A contact needs either `name` or `first_name`/`last_name`.');
    }
    const id = nextId(ctx.db, 'contacts', 'con');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO contacts (id, created_at, updated_at, archived, name, first_name, last_name,
        email, phone, company_id, owner_id, lifecycle_stage, source, city, country, address,
        tags, custom_fields)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        now,
        now,
        name,
        input.first_name ?? null,
        input.last_name ?? null,
        input.email ?? null,
        input.phone ?? null,
        input.company_id ?? null,
        input.owner_id ?? null,
        input.lifecycle_stage ?? null,
        input.source ?? null,
        input.city ?? null,
        input.country ?? null,
        input.address ?? null,
        JSON.stringify(input.tags ?? []),
        JSON.stringify({}),
      ],
    );
    return toView(getContactRow(ctx.db, id));
  }),
};

// --- A02 get_contact_details -------------------------------------------------

const getContactDetailsInput = z.strictObject({ id: z.string() });
type GetContactDetailsInput = z.infer<typeof getContactDetailsInput>;

const getContactDetails: ActionDef<GetContactDetailsInput, ContactView> = {
  id: 'M01.A02',
  slug: 'contacts.get_contact_details',
  module: MODULE,
  name: 'Get contact details',
  description: 'Fetch a single contact by id.',
  risk: 'read',
  entities: ['contacts'],
  inputSchema: getContactDetailsInput,
  outputSchema: contactView,
  searchCard: {
    synonyms: ['contact details', 'look up contact'],
    examplePhrasings: ['Show me contact con_42', "What's Jane's contact info?"],
  },
  handler: async (input, ctx) => toView(getContactRow(ctx.db, input.id)),
};

// --- A03 search_contacts -----------------------------------------------------

const searchContactsInput = z.strictObject({
  query: z.string().optional(),
  owner_id: z.string().optional(),
  company_id: z.string().optional(),
  lifecycle_stage: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchContactsInput = z.infer<typeof searchContactsInput>;
const searchContactsOutput = listOutputSchema(contactView);
type SearchContactsOutput = ListOrSpill<ContactView>;

const searchContacts: ActionDef<SearchContactsInput, SearchContactsOutput> = {
  id: 'M01.A03',
  slug: 'contacts.search_contacts',
  module: MODULE,
  name: 'Search contacts',
  description: 'Search non-archived contacts by name/email/phone and common filters.',
  risk: 'read',
  entities: ['contacts'],
  inputSchema: searchContactsInput,
  outputSchema: searchContactsOutput,
  searchCard: {
    synonyms: ['find contacts', 'list contacts'],
    examplePhrasings: ['Find contacts owned by Dana', 'Search contacts named Smith'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. Narrow with owner_id/company_id/lifecycle_stage before relying on the sample.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.query) {
      where.push('(name LIKE ? OR email LIKE ? OR phone LIKE ?)');
      const like = `%${input.query}%`;
      params.push(like, like, like);
    }
    if (input.owner_id) {
      where.push('owner_id = ?');
      params.push(input.owner_id);
    }
    if (input.company_id) {
      where.push('company_id = ?');
      params.push(input.company_id);
    }
    if (input.lifecycle_stage) {
      where.push('lifecycle_stage = ?');
      params.push(input.lifecycle_stage);
    }
    // Support 7e N14: name-only search over 12 same-named contacts forced
    // the model to fold the city into the name query (LIKE match failed) and
    // falsely deny an existing contact. City/country are first-class filters.
    // Case-insensitive (review MED-4): exact `city = ?` reintroduced the
    // very false-denial the city filter was added to fix, on a casing variant.
    if (input.city) {
      where.push('city = ? COLLATE NOCASE');
      params.push(input.city);
    }
    if (input.country) {
      where.push('country = ? COLLATE NOCASE');
      params.push(input.country);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM contacts WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'contacts', whereSql, params },
    });
  },
};

// --- A04 update_contact_details -----------------------------------------------

const updateContactDetailsInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({
      name: z.string().min(1).optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      company_id: z.string().optional(),
      lifecycle_stage: z.string().optional(),
      source: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional(),
      address: z.string().optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});
type UpdateContactDetailsInput = z.infer<typeof updateContactDetailsInput>;

const updateContactDetails: ActionDef<UpdateContactDetailsInput, ContactView> = {
  id: 'M01.A04',
  slug: 'contacts.update_contact_details',
  module: MODULE,
  name: 'Update contact details',
  description: 'Patch editable fields on a contact.',
  risk: 'write',
  entities: ['contacts'],
  inputSchema: updateContactDetailsInput,
  outputSchema: contactView,
  searchCard: {
    synonyms: ['edit contact', 'update contact'],
    examplePhrasings: ["Update Jane's email", "Change this contact's city"],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getContactRow(ctx.db, input.id); // existence check
    const fields = Object.entries(input.patch);
    const setSql = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([, v]) => v);
    ctx.db.run(`UPDATE contacts SET ${setSql}, updated_at = ? WHERE id = ?`, [
      ...values,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getContactRow(ctx.db, input.id));
  }),
};

// --- A05 archive_contact -------------------------------------------------------

const archiveContactInput = z.strictObject({ id: z.string() });
type ArchiveContactInput = z.infer<typeof archiveContactInput>;
const archiveContactOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });
type ArchiveContactOutput = z.infer<typeof archiveContactOutput>;

const archiveContact: ActionDef<ArchiveContactInput, ArchiveContactOutput> = {
  id: 'M01.A05',
  slug: 'contacts.archive_contact',
  module: MODULE,
  name: 'Archive contact',
  description: 'Soft-delete a contact (idempotent).',
  risk: 'destructive',
  entities: ['contacts'],
  inputSchema: archiveContactInput,
  outputSchema: archiveContactOutput,
  searchCard: {
    synonyms: ['delete contact', 'remove contact'],
    examplePhrasings: ['Archive this contact', 'Delete the duplicate contact'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getContactRow(ctx.db, input.id);
    ctx.db.run(`UPDATE contacts SET archived = 1, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name: row['name'] as string, archived: true };
  }),
};

// --- A06 merge_duplicate_contacts ----------------------------------------------

const mergeDuplicateContactsInput = z.strictObject({
  primary_contact_id: z.string(),
  duplicate_contact_id: z.string(),
});
type MergeDuplicateContactsInput = z.infer<typeof mergeDuplicateContactsInput>;
const mergeDuplicateContactsOutput = z.object({
  id: z.string(),
  name: z.string(),
  merged_from: z.string(),
  tags: z.array(z.string()),
});
type MergeDuplicateContactsOutput = z.infer<typeof mergeDuplicateContactsOutput>;

const mergeDuplicateContacts: ActionDef<
  MergeDuplicateContactsInput,
  MergeDuplicateContactsOutput
> = {
  id: 'M01.A06',
  slug: 'contacts.merge_duplicate_contacts',
  module: MODULE,
  name: 'Merge duplicate contacts',
  description:
    'Fold a duplicate contact into the primary: unions tags, repoints notes/tasks/messages, archives the duplicate.',
  risk: 'destructive',
  entities: ['contacts', 'notes', 'tasks', 'messages'],
  inputSchema: mergeDuplicateContactsInput,
  outputSchema: mergeDuplicateContactsOutput,
  searchCard: {
    synonyms: ['merge contacts', 'dedupe contacts'],
    examplePhrasings: ['Merge these two contacts', 'These are the same person, merge them'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    if (input.primary_contact_id === input.duplicate_contact_id) {
      throw new ActionError('CONFLICT', 'Cannot merge a contact into itself.');
    }
    const primary = toView(getContactRow(ctx.db, input.primary_contact_id));
    const duplicate = toView(getContactRow(ctx.db, input.duplicate_contact_id));
    const mergedTags = Array.from(new Set([...primary.tags, ...duplicate.tags]));

    for (const table of ['notes', 'tasks', 'messages'] as const) {
      ctx.db.run(`UPDATE ${table} SET contact_id = ? WHERE contact_id = ?`, [
        input.primary_contact_id,
        input.duplicate_contact_id,
      ]);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE contacts SET tags = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(mergedTags),
      now,
      input.primary_contact_id,
    ]);
    ctx.db.run(`UPDATE contacts SET archived = 1, updated_at = ? WHERE id = ?`, [
      now,
      input.duplicate_contact_id,
    ]);
    return {
      id: input.primary_contact_id,
      name: primary.name,
      merged_from: input.duplicate_contact_id,
      tags: mergedTags,
    };
  }),
};

// --- A07 assign_contact_owner ---------------------------------------------------

const assignContactOwnerInput = z.strictObject({ id: z.string(), owner_id: z.string() });
type AssignContactOwnerInput = z.infer<typeof assignContactOwnerInput>;

const assignContactOwner: ActionDef<AssignContactOwnerInput, ContactView> = {
  id: 'M01.A07',
  slug: 'contacts.assign_contact_owner',
  module: MODULE,
  name: 'Assign contact owner',
  description: 'Set the owning user for a contact.',
  risk: 'write',
  entities: ['contacts'],
  inputSchema: assignContactOwnerInput,
  outputSchema: contactView,
  searchCard: {
    synonyms: ['set contact owner', 'reassign contact'],
    examplePhrasings: ['Assign this contact to Dana', 'Make me the owner of this contact'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getContactRow(ctx.db, input.id);
    ctx.db.run(`UPDATE contacts SET owner_id = ?, updated_at = ? WHERE id = ?`, [
      input.owner_id,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getContactRow(ctx.db, input.id));
  }),
};

// --- A08 set_communication_preferences ------------------------------------------

const setCommunicationPreferencesInput = z.strictObject({
  id: z.string(),
  preferences: z.record(z.string(), z.unknown()),
});
type SetCommunicationPreferencesInput = z.infer<typeof setCommunicationPreferencesInput>;
const setCommunicationPreferencesOutput = z.object({
  id: z.string(),
  name: z.string(),
  communication_preferences: z.record(z.string(), z.unknown()),
});
type SetCommunicationPreferencesOutput = z.infer<typeof setCommunicationPreferencesOutput>;

const setCommunicationPreferences: ActionDef<
  SetCommunicationPreferencesInput,
  SetCommunicationPreferencesOutput
> = {
  id: 'M01.A08',
  slug: 'contacts.set_communication_preferences',
  module: MODULE,
  name: 'Set communication preferences',
  description: 'Merge communication preferences (e.g. channel opt-ins) into a contact.',
  risk: 'write',
  entities: ['contacts'],
  inputSchema: setCommunicationPreferencesInput,
  outputSchema: setCommunicationPreferencesOutput,
  searchCard: {
    synonyms: ['set opt-in', 'update contact preferences'],
    examplePhrasings: ['Opt this contact out of SMS', 'Set email as the preferred channel'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getContactRow(ctx.db, input.id);
    const customFields = parseJsonObject(row['custom_fields']);
    const existing = (customFields['communication_preferences'] as Record<string, unknown>) ?? {};
    const merged = { ...existing, ...input.preferences };
    const nextCustomFields = { ...customFields, communication_preferences: merged };
    ctx.db.run(`UPDATE contacts SET custom_fields = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(nextCustomFields),
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name: row['name'] as string, communication_preferences: merged };
  }),
};

// --- A09 add_contact_relationship ------------------------------------------------

const addContactRelationshipInput = z.strictObject({
  id: z.string(),
  related_contact_id: z.string(),
  relationship_type: z.string(),
});
type AddContactRelationshipInput = z.infer<typeof addContactRelationshipInput>;
const relationshipEntry = z.object({ contact_id: z.string(), type: z.string() });
const addContactRelationshipOutput = z.object({
  id: z.string(),
  name: z.string(),
  relationships: z.array(relationshipEntry),
});
type AddContactRelationshipOutput = z.infer<typeof addContactRelationshipOutput>;

const addContactRelationship: ActionDef<
  AddContactRelationshipInput,
  AddContactRelationshipOutput
> = {
  id: 'M01.A09',
  slug: 'contacts.add_contact_relationship',
  module: MODULE,
  name: 'Add contact relationship',
  description: 'Record a named relationship from this contact to another contact.',
  risk: 'write',
  entities: ['contacts'],
  inputSchema: addContactRelationshipInput,
  outputSchema: addContactRelationshipOutput,
  searchCard: {
    synonyms: ['link contacts', 'relate contacts'],
    examplePhrasings: ['Link this contact as the spouse of another contact'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    if (input.id === input.related_contact_id) {
      throw new ActionError('CONFLICT', 'A contact cannot have a relationship with itself.');
    }
    const row = getContactRow(ctx.db, input.id);
    getContactRow(ctx.db, input.related_contact_id); // existence check
    const customFields = parseJsonObject(row['custom_fields']);
    const existing = Array.isArray(customFields['relationships'])
      ? (customFields['relationships'] as Array<{ contact_id: string; type: string }>)
      : [];
    const entry = { contact_id: input.related_contact_id, type: input.relationship_type };
    const already = existing.some(
      (r) => r.contact_id === entry.contact_id && r.type === entry.type,
    );
    const relationships = already ? existing : [...existing, entry];
    ctx.db.run(`UPDATE contacts SET custom_fields = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify({ ...customFields, relationships }),
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name: row['name'] as string, relationships };
  }),
};

// --- A10 view_contact_activity_timeline --------------------------------------------

const viewContactActivityTimelineInput = z.strictObject({
  id: z.string(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ViewContactActivityTimelineInput = z.infer<typeof viewContactActivityTimelineInput>;
const timelineEntry = z.object({
  type: z.enum(['note', 'task', 'message']),
  id: z.string(),
  at: z.number(),
  summary: z.string(),
  // Support 7e N11: a draft (sent_at NULL) must be distinguishable from a
  // sent message — the model counted a draft as "most recent outreach".
  status: z.string().nullable().optional(),
  direction: z.string().nullable().optional(),
});
const viewContactActivityTimelineOutput = listOutputSchema(timelineEntry);
type ViewContactActivityTimelineOutput = ListOrSpill<z.infer<typeof timelineEntry>>;

const viewContactActivityTimeline: ActionDef<
  ViewContactActivityTimelineInput,
  ViewContactActivityTimelineOutput
> = {
  id: 'M01.A10',
  slug: 'contacts.view_contact_activity_timeline',
  module: MODULE,
  name: 'View contact activity timeline',
  description: 'Chronological feed of notes, tasks, and messages tied to a contact.',
  risk: 'read',
  entities: ['contacts', 'notes', 'tasks', 'messages'],
  inputSchema: viewContactActivityTimelineInput,
  outputSchema: viewContactActivityTimelineOutput,
  searchCard: {
    synonyms: ['contact history', 'activity feed'],
    examplePhrasings: ["Show this contact's activity", 'What has happened with this contact?'],
  },
  handler: async (input, ctx) => {
    getContactRow(ctx.db, input.id); // existence check
    const limit = input.limit ?? 20;

    // Each source is counted (for the TRUE total, independent of any LIMIT
    // below — list-output.ts's spill decision needs the real total) and
    // fetched with its OWN `ORDER BY ... DESC LIMIT` — list-output.ts's
    // contract is that rows arriving at `toListOrSpill` are ALREADY bounded
    // by SQL, not fetched unbounded and sliced in JS. `SOURCE_FETCH_LIMIT`
    // (> SPILL_CAP) guarantees the merged-and-sorted candidate pool still
    // contains the true newest `SPILL_CAP` items overall even though each
    // source is queried independently.
    const SOURCE_FETCH_LIMIT = 200;

    const countOf = (table: string, extra = ''): number => {
      const row = ctx.db.get(
        `SELECT COUNT(*) AS n FROM ${table} WHERE contact_id = ? AND archived = 0${extra}`,
        [input.id],
      );
      return typeof row?.['n'] === 'number' ? (row['n'] as number) : 0;
    };
    const total = countOf('notes') + countOf('tasks') + countOf('messages');

    const notes = ctx.db.all(
      `SELECT id, created_at, body FROM notes WHERE contact_id = ? AND archived = 0
       ORDER BY created_at DESC LIMIT ?`,
      [input.id, SOURCE_FETCH_LIMIT],
    );
    const tasks = ctx.db.all(
      `SELECT id, created_at, title FROM tasks WHERE contact_id = ? AND archived = 0
       ORDER BY created_at DESC LIMIT ?`,
      [input.id, SOURCE_FETCH_LIMIT],
    );
    const messages = ctx.db.all(
      `SELECT id, created_at, sent_at, status, direction, subject, body FROM messages
       WHERE contact_id = ? AND archived = 0
       ORDER BY COALESCE(sent_at, created_at) DESC LIMIT ?`,
      [input.id, SOURCE_FETCH_LIMIT],
    );

    const items = [
      ...notes.map((r) => ({
        type: 'note' as const,
        id: r['id'] as string,
        at: r['created_at'] as number,
        summary: String(r['body'] ?? '').slice(0, 80),
      })),
      ...tasks.map((r) => ({
        type: 'task' as const,
        id: r['id'] as string,
        at: r['created_at'] as number,
        summary: String(r['title'] ?? ''),
      })),
      ...messages.map((r) => ({
        type: 'message' as const,
        id: r['id'] as string,
        at: (r['sent_at'] as number | null) ?? (r['created_at'] as number),
        summary: String(r['subject'] ?? r['body'] ?? '').slice(0, 80),
        status: (r['status'] as string | null) ?? null,
        direction: (r['direction'] as string | null) ?? null,
      })),
    ].sort((a, b) => b.at - a.at);

    const capped = items.slice(0, Math.min(limit, SPILL_CAP));
    return toListOrSpill(capped, total);
  },
};

export const m01Contacts: ActionDef[] = [
  createContact as ActionDef,
  getContactDetails as ActionDef,
  searchContacts as ActionDef,
  updateContactDetails as ActionDef,
  archiveContact as ActionDef,
  mergeDuplicateContacts as ActionDef,
  assignContactOwner as ActionDef,
  setCommunicationPreferences as ActionDef,
  addContactRelationship as ActionDef,
  viewContactActivityTimeline as ActionDef,
];

/**
 * Tier-A filter-discrimination coverage (discrimination.ts) for
 * `search_contacts`: two `lifecycle_stage` values that MUST yield different
 * `total` counts against the standard template (verified: 'lead' → 1682,
 * 'customer' → 1757 — both independently > SPILL_CAP, so this also
 * exercises the spill branch on both sides). Catches the #1 codegen bug
 * (an accepted-but-silently-ignored filter param).
 */
export const m01DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'contacts.search_contacts',
    paramsA: { lifecycle_stage: 'lead' },
    paramsB: { lifecycle_stage: 'customer' },
    expectDifferentCounts: true,
  },
];

/**
 * `synthesizeInput` kind-resolution hints (synth-hints.ts) for this
 * module's id-shaped fields. M01 needs NONE — every id field it declares
 * (`id`, `owner_id`, `company_id`, `*_contact_id`, `related_contact_id`)
 * resolves against a plain (non-kind-discriminated) table, already covered
 * by `testing.ts`'s built-in defaults. Exported as `{}` anyway: every
 * module file exports `synthHints` (required, not optional) so
 * `module-index.ts`'s import list stays uniform.
 *
 * WORKED EXAMPLE for a module that DOES need one (reference for Tasks
 * 9-11 — M01 has no `structures`-backed field, so this is illustrative,
 * not live code here): a hypothetical `coupons.get_coupon_details` action
 * with an `id` field meaning "the coupon's own id" would need NO hint
 * (`entities[0] === 'structures'` isn't kind-filterable via the bare `id`
 * path — see the note in testing.ts). But an action like
 * `orders.apply_coupon_to_order` taking a `coupon_id` field DOES need one,
 * because `coupon_id` must resolve to a `structures` row whose `kind`
 * is `'coupon'`, not an arbitrary `structures` row (which could just as
 * easily be a `tag` or `pipeline`):
 * ```ts
 * export const m32SynthHints: SynthHints = {
 *   coupon_id: { table: 'structures', kind: 'coupon' },
 * };
 * ```
 * `testing.ts` already ships this exact hint as a built-in default (since
 * `coupon_id` is unambiguous catalog-wide), so M32 wouldn't actually need
 * to redeclare it — but a field name that ISN'T already covered by
 * `testing.ts`'s `DEFAULT_HINTS` (e.g. a `membership_id` resolving to
 * `participations` with `kind: 'membership'`) WOULD need its module to
 * declare it here.
 */
export const m01SynthHints: SynthHints = {};
