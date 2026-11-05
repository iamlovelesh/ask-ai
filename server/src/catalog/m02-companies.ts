/**
 * M02 Companies — follows the M01 Contacts convention verbatim (see
 * `m01-contacts.ts` header + task-8-report.md "MODULE AUTHOR GUIDE"):
 * idempotent writes, list-output spill, `jit` on search/create, every
 * output carries `id` + display name, `ActionError` taxonomy,
 * `discriminationChecks` + `synthHints` exports, shared `nextId`.
 *
 * Data home: `companies` table (entities/model.ts). `tags` is a JSON
 * string[] column, same convention as `contacts.tags`.
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
import { parseJsonArray } from './json.js';

const MODULE = 'companies';

interface CompanyView {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  owner_id: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  address: string | null;
  tags: string[];
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): CompanyView {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    domain: (row['domain'] as string | null) ?? null,
    industry: (row['industry'] as string | null) ?? null,
    size: (row['size'] as string | null) ?? null,
    owner_id: (row['owner_id'] as string | null) ?? null,
    city: (row['city'] as string | null) ?? null,
    country: (row['country'] as string | null) ?? null,
    phone: (row['phone'] as string | null) ?? null,
    address: (row['address'] as string | null) ?? null,
    tags: parseJsonArray(row['tags']),
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

function getCompanyRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM companies WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Company '${id}' does not exist.`);
  return row;
}

function getContactRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM contacts WHERE id = ?`, [id]);
  if (!row) throw new ActionError('NOT_FOUND', `Contact '${id}' does not exist.`);
  return row;
}

const companyView = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  size: z.string().nullable(),
  owner_id: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  tags: z.array(z.string()),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_company ------------------------------------------------------

const createCompanyInput = z.strictObject({
  name: z.string().min(1),
  domain: z.string().optional(),
  industry: z.string().optional(),
  size: z.string().optional(),
  owner_id: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
type CreateCompanyInput = z.infer<typeof createCompanyInput>;

const createCompany: ActionDef<CreateCompanyInput, CompanyView> = {
  id: 'M02.A01',
  slug: 'companies.create_company',
  module: MODULE,
  name: 'Create company',
  description: 'Create a new company record.',
  risk: 'write',
  entities: ['companies'],
  inputSchema: createCompanyInput,
  outputSchema: companyView,
  searchCard: {
    synonyms: ['add company', 'new account'],
    examplePhrasings: ['Create a company called Acme Inc', 'Add a new account'],
  },
  jit: 'Search companies first (by name/domain) to avoid creating a duplicate account.',
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'companies', 'co');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO companies (id, created_at, updated_at, archived, name, domain, industry,
        size, owner_id, city, country, phone, address, tags)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        now,
        now,
        input.name,
        input.domain ?? null,
        input.industry ?? null,
        input.size ?? null,
        input.owner_id ?? null,
        input.city ?? null,
        input.country ?? null,
        input.phone ?? null,
        input.address ?? null,
        JSON.stringify(input.tags ?? []),
      ],
    );
    return toView(getCompanyRow(ctx.db, id));
  }),
};

// --- A02 get_company_details -------------------------------------------------

const getCompanyDetailsInput = z.strictObject({ id: z.string() });

const getCompanyDetails: ActionDef<z.infer<typeof getCompanyDetailsInput>, CompanyView> = {
  id: 'M02.A02',
  slug: 'companies.get_company_details',
  module: MODULE,
  name: 'Get company details',
  description: 'Fetch a single company by id.',
  risk: 'read',
  entities: ['companies'],
  inputSchema: getCompanyDetailsInput,
  outputSchema: companyView,
  searchCard: {
    synonyms: ['company details', 'look up account'],
    examplePhrasings: ['Show me company co_12', 'What do we know about Acme Inc?'],
  },
  handler: async (input, ctx) => toView(getCompanyRow(ctx.db, input.id)),
};

// --- A03 search_companies -----------------------------------------------------

const searchCompaniesInput = z.strictObject({
  query: z.string().optional(),
  owner_id: z.string().optional(),
  industry: z.string().optional(),
  size: z.string().optional(),
  country: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchCompaniesInput = z.infer<typeof searchCompaniesInput>;
const searchCompaniesOutput = listOutputSchema(companyView);
type SearchCompaniesOutput = ListOrSpill<CompanyView>;

const searchCompanies: ActionDef<SearchCompaniesInput, SearchCompaniesOutput> = {
  id: 'M02.A03',
  slug: 'companies.search_companies',
  module: MODULE,
  name: 'Search companies',
  description: 'Search non-archived companies by name/domain and common filters.',
  risk: 'read',
  entities: ['companies'],
  inputSchema: searchCompaniesInput,
  outputSchema: searchCompaniesOutput,
  searchCard: {
    synonyms: ['find companies', 'list accounts'],
    examplePhrasings: ['Find companies in the 1-10 size band', 'Search accounts named Acme'],
  },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}. Narrow with owner_id/industry/size/country before relying on the sample.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0'];
    const params: unknown[] = [];
    if (input.query) {
      where.push('(name LIKE ? OR domain LIKE ?)');
      const like = `%${input.query}%`;
      params.push(like, like);
    }
    if (input.owner_id) {
      where.push('owner_id = ?');
      params.push(input.owner_id);
    }
    if (input.industry) {
      where.push('industry = ?');
      params.push(input.industry);
    }
    if (input.size) {
      where.push('size = ?');
      params.push(input.size);
    }
    if (input.country) {
      where.push('country = ?');
      params.push(input.country);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM companies WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT * FROM companies WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'companies', whereSql, params },
    });
  },
};

// --- A04 update_company_details -----------------------------------------------

const updateCompanyDetailsInput = z.strictObject({
  id: z.string(),
  patch: z
    .strictObject({
      name: z.string().min(1).optional(),
      domain: z.string().optional(),
      industry: z.string().optional(),
      size: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must not be empty' }),
});

const updateCompanyDetails: ActionDef<z.infer<typeof updateCompanyDetailsInput>, CompanyView> = {
  id: 'M02.A04',
  slug: 'companies.update_company_details',
  module: MODULE,
  name: 'Update company details',
  description: 'Patch editable fields on a company.',
  risk: 'write',
  entities: ['companies'],
  inputSchema: updateCompanyDetailsInput,
  outputSchema: companyView,
  searchCard: {
    synonyms: ['edit company', 'update account'],
    examplePhrasings: ["Update Acme's domain", 'Change this company city'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getCompanyRow(ctx.db, input.id);
    const fields = Object.entries(input.patch);
    const setSql = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([, v]) => v);
    ctx.db.run(`UPDATE companies SET ${setSql}, updated_at = ? WHERE id = ?`, [
      ...values,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getCompanyRow(ctx.db, input.id));
  }),
};

// --- A05 archive_company -------------------------------------------------------

const archiveCompanyInput = z.strictObject({ id: z.string() });
const archiveCompanyOutput = z.object({ id: z.string(), name: z.string(), archived: z.literal(true) });

const archiveCompany: ActionDef<z.infer<typeof archiveCompanyInput>, z.infer<typeof archiveCompanyOutput>> = {
  id: 'M02.A05',
  slug: 'companies.archive_company',
  module: MODULE,
  name: 'Archive company',
  description: 'Soft-delete a company (idempotent).',
  risk: 'destructive',
  entities: ['companies'],
  inputSchema: archiveCompanyInput,
  outputSchema: archiveCompanyOutput,
  searchCard: {
    synonyms: ['delete company', 'remove account'],
    examplePhrasings: ['Archive this company', 'Delete the duplicate account'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCompanyRow(ctx.db, input.id);
    ctx.db.run(`UPDATE companies SET archived = 1, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.id,
    ]);
    return { id: input.id, name: row['name'] as string, archived: true as const };
  }),
};

// --- A06 link_contact_to_company -----------------------------------------------

const linkContactToCompanyInput = z.strictObject({ contact_id: z.string(), company_id: z.string() });
const linkContactToCompanyOutput = z.object({
  id: z.string(),
  name: z.string(),
  company_id: z.string(),
  company_name: z.string(),
});

const linkContactToCompany: ActionDef<
  z.infer<typeof linkContactToCompanyInput>,
  z.infer<typeof linkContactToCompanyOutput>
> = {
  id: 'M02.A06',
  slug: 'companies.link_contact_to_company',
  module: MODULE,
  name: 'Link contact to company',
  description: "Set a contact's company_id.",
  risk: 'write',
  entities: ['contacts', 'companies'],
  inputSchema: linkContactToCompanyInput,
  outputSchema: linkContactToCompanyOutput,
  searchCard: {
    synonyms: ['associate contact with company', 'add contact to account'],
    examplePhrasings: ['Link Jane Doe to Acme Inc'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const contact = getContactRow(ctx.db, input.contact_id);
    const company = getCompanyRow(ctx.db, input.company_id);
    ctx.db.run(`UPDATE contacts SET company_id = ?, updated_at = ? WHERE id = ?`, [
      input.company_id,
      ctx.clock.now(),
      input.contact_id,
    ]);
    return {
      id: input.contact_id,
      name: contact['name'] as string,
      company_id: input.company_id,
      company_name: company['name'] as string,
    };
  }),
};

// --- A07 unlink_contact_from_company -------------------------------------------

const unlinkContactFromCompanyInput = z.strictObject({ contact_id: z.string() });
const unlinkContactFromCompanyOutput = z.object({
  id: z.string(),
  name: z.string(),
  company_id: z.null(),
});

const unlinkContactFromCompany: ActionDef<
  z.infer<typeof unlinkContactFromCompanyInput>,
  z.infer<typeof unlinkContactFromCompanyOutput>
> = {
  id: 'M02.A07',
  slug: 'companies.unlink_contact_from_company',
  module: MODULE,
  name: 'Unlink contact from company',
  description: "Clear a contact's company_id.",
  risk: 'write',
  entities: ['contacts'],
  inputSchema: unlinkContactFromCompanyInput,
  outputSchema: unlinkContactFromCompanyOutput,
  searchCard: {
    synonyms: ['remove contact from account', 'disassociate contact'],
    examplePhrasings: ['Unlink Jane Doe from her company'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const contact = getContactRow(ctx.db, input.contact_id);
    ctx.db.run(`UPDATE contacts SET company_id = NULL, updated_at = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.contact_id,
    ]);
    return { id: input.contact_id, name: contact['name'] as string, company_id: null };
  }),
};

// --- A08 assign_account_manager -------------------------------------------------

const assignAccountManagerInput = z.strictObject({ id: z.string(), owner_id: z.string() });

const assignAccountManager: ActionDef<z.infer<typeof assignAccountManagerInput>, CompanyView> = {
  id: 'M02.A08',
  slug: 'companies.assign_account_manager',
  module: MODULE,
  name: 'Assign account manager',
  description: 'Set the owning user for a company.',
  risk: 'write',
  entities: ['companies'],
  inputSchema: assignAccountManagerInput,
  outputSchema: companyView,
  searchCard: {
    synonyms: ['set account owner', 'reassign company'],
    examplePhrasings: ['Assign Acme Inc to Dana'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    getCompanyRow(ctx.db, input.id);
    ctx.db.run(`UPDATE companies SET owner_id = ?, updated_at = ? WHERE id = ?`, [
      input.owner_id,
      ctx.clock.now(),
      input.id,
    ]);
    return toView(getCompanyRow(ctx.db, input.id));
  }),
};

// --- A09 merge_duplicate_companies ----------------------------------------------

const mergeDuplicateCompaniesInput = z.strictObject({
  primary_company_id: z.string(),
  duplicate_company_id: z.string(),
});
const mergeDuplicateCompaniesOutput = z.object({
  id: z.string(),
  name: z.string(),
  merged_from: z.string(),
  tags: z.array(z.string()),
});

const mergeDuplicateCompanies: ActionDef<
  z.infer<typeof mergeDuplicateCompaniesInput>,
  z.infer<typeof mergeDuplicateCompaniesOutput>
> = {
  id: 'M02.A09',
  slug: 'companies.merge_duplicate_companies',
  module: MODULE,
  name: 'Merge duplicate companies',
  description:
    'Fold a duplicate company into the primary: unions tags, repoints contacts/opportunities/quotes, archives the duplicate.',
  risk: 'destructive',
  entities: ['companies', 'contacts', 'opportunities', 'quotes'],
  inputSchema: mergeDuplicateCompaniesInput,
  outputSchema: mergeDuplicateCompaniesOutput,
  searchCard: {
    synonyms: ['merge companies', 'dedupe accounts'],
    examplePhrasings: ['Merge these two companies', 'These are the same account, merge them'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    if (input.primary_company_id === input.duplicate_company_id) {
      throw new ActionError('CONFLICT', 'Cannot merge a company into itself.');
    }
    const primary = toView(getCompanyRow(ctx.db, input.primary_company_id));
    const duplicate = toView(getCompanyRow(ctx.db, input.duplicate_company_id));
    const mergedTags = Array.from(new Set([...primary.tags, ...duplicate.tags]));

    for (const table of ['contacts', 'opportunities', 'quotes'] as const) {
      ctx.db.run(`UPDATE ${table} SET company_id = ? WHERE company_id = ?`, [
        input.primary_company_id,
        input.duplicate_company_id,
      ]);
    }
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE companies SET tags = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(mergedTags),
      now,
      input.primary_company_id,
    ]);
    ctx.db.run(`UPDATE companies SET archived = 1, updated_at = ? WHERE id = ?`, [
      now,
      input.duplicate_company_id,
    ]);
    return {
      id: input.primary_company_id,
      name: primary.name,
      merged_from: input.duplicate_company_id,
      tags: mergedTags,
    };
  }),
};

// --- A10 list_company_contacts --------------------------------------------------

const listCompanyContactsInput = z.strictObject({
  id: z.string(),
  limit: z.number().int().min(1).max(50).optional(),
});
const contactSummary = z.object({ id: z.string(), name: z.string() });
const listCompanyContactsOutput = listOutputSchema(contactSummary);
type ListCompanyContactsOutput = ListOrSpill<z.infer<typeof contactSummary>>;

const listCompanyContacts: ActionDef<
  z.infer<typeof listCompanyContactsInput>,
  ListCompanyContactsOutput
> = {
  id: 'M02.A10',
  slug: 'companies.list_company_contacts',
  module: MODULE,
  name: 'List company contacts',
  description: 'List non-archived contacts belonging to a company.',
  risk: 'read',
  entities: ['companies', 'contacts'],
  inputSchema: listCompanyContactsInput,
  outputSchema: listCompanyContactsOutput,
  searchCard: {
    synonyms: ["company's contacts", 'who works at this account'],
    examplePhrasings: ['Who are the contacts at Acme Inc?'],
  },
  handler: async (input, ctx) => {
    getCompanyRow(ctx.db, input.id);
    const limit = input.limit ?? 50;
    const countRow = ctx.db.get(
      `SELECT COUNT(*) AS n FROM contacts WHERE company_id = ? AND archived = 0`,
      [input.id],
    );
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(
      `SELECT id, name FROM contacts WHERE company_id = ? AND archived = 0
       ORDER BY created_at DESC LIMIT ?`,
      [input.id, limit],
    );
    return toListOrSpill(
      rows.map((r) => ({ id: r['id'] as string, name: r['name'] as string })),
      total,
      { idCapture: { db: ctx.db, table: 'contacts', whereSql: 'company_id = ? AND archived = 0', params: [input.id] } },
    );
  },
};

export const m02Companies: ActionDef[] = [
  createCompany as ActionDef,
  getCompanyDetails as ActionDef,
  searchCompanies as ActionDef,
  updateCompanyDetails as ActionDef,
  archiveCompany as ActionDef,
  linkContactToCompany as ActionDef,
  unlinkContactFromCompany as ActionDef,
  assignAccountManager as ActionDef,
  mergeDuplicateCompanies as ActionDef,
  listCompanyContacts as ActionDef,
];

/**
 * Tier-A discrimination: `size` bucket counts against the standard template
 * differ enough (verified: '1-10' → 225, '1000+' → 199) that a coincidental
 * tie is not a real risk. Live-run note: a full `--modules m02-m10`/`npm
 * run smoke` pass observes '1-10' → 224, not 225 — `archive_company`'s own
 * smoke check archives the lowest-id company (which happens to be a
 * '1-10' row), shifting this specific bucket by -1 within the same run.
 * Still ~25x the gap needed for the check to be non-coincidental.
 */
export const m02DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'companies.search_companies',
    paramsA: { size: '1-10' },
    paramsB: { size: '1000+' },
    expectDifferentCounts: true,
  },
];

/**
 * `primary_company_id`/`duplicate_company_id` need an explicit hint: the
 * generic `{noun}_id → {noun}s` guess in `testing.ts` would pluralize
 * `primary_company` → `primary_companies` (the "ends with y" rule), which
 * isn't a real table. `company_id` itself is already a `testing.ts`
 * built-in default, so it needs no entry here.
 */
export const m02SynthHints: SynthHints = {
  primary_company_id: { table: 'companies' },
  duplicate_company_id: { table: 'companies' },
};
