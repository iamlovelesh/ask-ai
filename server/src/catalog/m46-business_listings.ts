/**
 * M46 Business Listings — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'business_listing'`. `config` is
 * `{ address: string|null, phone: string|null, hours: Record<day,{open,
 * close}|null>, categories: string[], sync: {status, synced_at}|null }`.
 * Seeded rows carry the generic `{seeded:true,kind:'business_listing'}`
 * placeholder, so `readConfig` falls back to sane defaults.
 *
 * `publish_listing_to_simulated_directory` requires a real address AND
 * phone (a genuine business rule — can't publish an incomplete listing)
 * and records a `sync` marker `get_listing_sync_status` reads back.
 *
 * KIND-BLINDNESS NOTE: `entities[0]` is `'structures'` — the bare `id`
 * field needs an action-scoped synthHint.
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
import { parseJsonObject } from './json.js';

const MODULE = 'business_listings';
const KIND = 'business_listing';

function slugify(name: string, id: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'listing'}-${id}`;
}

interface BusinessHours {
  open: string;
  close: string;
}

interface SyncStatus {
  status: string;
  synced_at: number;
}

interface ListingConfig {
  address: string | null;
  phone: string | null;
  hours: Record<string, BusinessHours | null>;
  categories: string[];
  sync: SyncStatus | null;
}

function readConfig(row: Row): ListingConfig {
  const config = parseJsonObject(row['config']);
  return {
    address: (config['address'] as string | null | undefined) ?? null,
    phone: (config['phone'] as string | null | undefined) ?? null,
    hours: config['hours'] && typeof config['hours'] === 'object' ? (config['hours'] as Record<string, BusinessHours | null>) : {},
    categories: Array.isArray(config['categories']) ? (config['categories'] as string[]) : [],
    sync: config['sync'] && typeof config['sync'] === 'object' ? (config['sync'] as SyncStatus) : null,
  };
}

function writeConfig(db: StoreTx, id: string, config: ListingConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

function getListingRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Business listing '${id}' does not exist.`);
  return row;
}

interface ListingView {
  id: string;
  name: string;
  status: string;
  address: string | null;
  phone: string | null;
  hours: Record<string, BusinessHours | null>;
  categories: string[];
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: Row): ListingView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    address: config.address,
    phone: config.phone,
    hours: config.hours,
    categories: config.categories,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const hoursEntrySchema = z.object({ open: z.string(), close: z.string() }).nullable();

const listingView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  hours: z.record(z.string(), hoursEntrySchema),
  categories: z.array(z.string()),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- A01 create_business_listing -----------------------------------------------------

const createBusinessListingInput = z.strictObject({ name: z.string().min(1) });

const createBusinessListing: ActionDef<z.infer<typeof createBusinessListingInput>, ListingView> = {
  id: 'M46.A01',
  slug: 'business_listings.create_business_listing',
  module: MODULE,
  name: 'Create business listing',
  description: 'Create a new business listing.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createBusinessListingInput,
  outputSchema: listingView,
  searchCard: { synonyms: ['add business listing', 'new listing'], examplePhrasings: ['Create a listing for our downtown store'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: ListingConfig = { address: null, phone: null, hours: {}, categories: [], sync: null };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(getListingRow(ctx.db, id));
  }),
};

// --- A02 get_listing_details -----------------------------------------------------

const getListingDetailsInput = z.strictObject({ id: z.string() });

const getListingDetails: ActionDef<z.infer<typeof getListingDetailsInput>, ListingView> = {
  id: 'M46.A02',
  slug: 'business_listings.get_listing_details',
  module: MODULE,
  name: 'Get listing details',
  description: 'Fetch a single business listing by id.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getListingDetailsInput,
  outputSchema: listingView,
  searchCard: { synonyms: ['listing details', 'look up business listing'], examplePhrasings: ['Show me this business listing'] },
  handler: async (input, ctx) => toView(getListingRow(ctx.db, input.id)),
};

// --- A03 search_business_listings -----------------------------------------------------

const searchBusinessListingsInput = z.strictObject({
  status: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchBusinessListingsInput = z.infer<typeof searchBusinessListingsInput>;
const searchBusinessListingsOutput = listOutputSchema(listingView);
type SearchBusinessListingsOutput = ListOrSpill<ListingView>;

const searchBusinessListings: ActionDef<SearchBusinessListingsInput, SearchBusinessListingsOutput> = {
  id: 'M46.A03',
  slug: 'business_listings.search_business_listings',
  module: MODULE,
  name: 'Search business listings',
  description: 'Search non-archived business listings by status and name.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: searchBusinessListingsInput,
  outputSchema: searchBusinessListingsOutput,
  searchCard: { synonyms: ['find business listings', 'list business listings'], examplePhrasings: ['Show me our published listings'] },
  jit: 'Results cap at 50 inline rows; beyond that you get {__spill:true,total,sample}.',
  handler: async (input, ctx) => {
    const where: string[] = ['archived = 0', 'kind = ?'];
    const params: unknown[] = [KIND];
    if (input.status) {
      where.push('status = ? COLLATE NOCASE');
      params.push(input.status);
    }
    if (input.query) {
      where.push('name LIKE ?');
      params.push(`%${input.query}%`);
    }
    const limit = input.limit ?? 50;
    const whereSql = where.join(' AND ');
    const countRow = ctx.db.get(`SELECT COUNT(*) AS n FROM structures WHERE ${whereSql}`, params);
    const total = (countRow?.['n'] as number) ?? 0;
    const rows = ctx.db.all(`SELECT * FROM structures WHERE ${whereSql} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    return toListOrSpill(rows.map(toView), total, {
      idCapture: { db: ctx.db, table: 'structures', whereSql, params },
    });
  },
};

// --- A04 update_listing_name -----------------------------------------------------

const updateListingNameInput = z.strictObject({ id: z.string(), name: z.string().min(1) });

const updateListingName: ActionDef<z.infer<typeof updateListingNameInput>, ListingView> = {
  id: 'M46.A04',
  slug: 'business_listings.update_listing_name',
  module: MODULE,
  name: 'Update listing name',
  description: 'Rename a business listing.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateListingNameInput,
  outputSchema: listingView,
  searchCard: { synonyms: ['rename listing'], examplePhrasings: ['Rename this business listing'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getListingRow(ctx.db, input.id);
    ctx.db.run(`UPDATE structures SET name = ?, updated_at = ? WHERE id = ?`, [input.name, ctx.clock.now(), input.id]);
    return toView(getListingRow(ctx.db, input.id));
  }),
};

// --- A05 update_listing_address -----------------------------------------------------

const updateListingAddressInput = z.strictObject({ id: z.string(), address: z.string().min(1) });

const updateListingAddress: ActionDef<z.infer<typeof updateListingAddressInput>, ListingView> = {
  id: 'M46.A05',
  slug: 'business_listings.update_listing_address',
  module: MODULE,
  name: 'Update listing address',
  description: "Update a business listing's address.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateListingAddressInput,
  outputSchema: listingView,
  searchCard: { synonyms: ['change address'], examplePhrasings: ["Update this listing's address"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getListingRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, address: input.address }, ctx.clock.now());
    return toView(getListingRow(ctx.db, input.id));
  }),
};

// --- A06 update_listing_phone -----------------------------------------------------

const updateListingPhoneInput = z.strictObject({ id: z.string(), phone: z.string().min(1) });

const updateListingPhone: ActionDef<z.infer<typeof updateListingPhoneInput>, ListingView> = {
  id: 'M46.A06',
  slug: 'business_listings.update_listing_phone',
  module: MODULE,
  name: 'Update listing phone',
  description: "Update a business listing's phone number.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateListingPhoneInput,
  outputSchema: listingView,
  searchCard: { synonyms: ['change phone number'], examplePhrasings: ["Update this listing's phone number"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getListingRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, phone: input.phone }, ctx.clock.now());
    return toView(getListingRow(ctx.db, input.id));
  }),
};

// --- A07 set_listing_business_hours -----------------------------------------------------

const setListingBusinessHoursInput = z.strictObject({ id: z.string(), hours: z.record(z.string(), hoursEntrySchema) });

const setListingBusinessHours: ActionDef<z.infer<typeof setListingBusinessHoursInput>, ListingView> = {
  id: 'M46.A07',
  slug: 'business_listings.set_listing_business_hours',
  module: MODULE,
  name: 'Set listing business hours',
  description: 'Replace the weekly business-hours map for a listing (a day mapped to null = closed that day).',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setListingBusinessHoursInput,
  outputSchema: listingView,
  searchCard: { synonyms: ['set business hours', 'opening hours'], examplePhrasings: ['Set this listing to close at 6pm on weekdays'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getListingRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, hours: input.hours }, ctx.clock.now());
    return toView(getListingRow(ctx.db, input.id));
  }),
};

// --- A08 set_listing_categories -----------------------------------------------------

const setListingCategoriesInput = z.strictObject({ id: z.string(), categories: z.array(z.string().min(1)) });

const setListingCategories: ActionDef<z.infer<typeof setListingCategoriesInput>, ListingView> = {
  id: 'M46.A08',
  slug: 'business_listings.set_listing_categories',
  module: MODULE,
  name: 'Set listing categories',
  description: 'Replace the category tags for a business listing.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: setListingCategoriesInput,
  outputSchema: listingView,
  searchCard: { synonyms: ['tag listing', 'set listing categories'], examplePhrasings: ['Tag this listing as a coffee shop'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getListingRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, categories: input.categories }, ctx.clock.now());
    return toView(getListingRow(ctx.db, input.id));
  }),
};

// --- A09 publish_listing_to_simulated_directory -----------------------------------------------------

const publishListingToSimulatedDirectoryInput = z.strictObject({ id: z.string() });

const publishListingToSimulatedDirectory: ActionDef<z.infer<typeof publishListingToSimulatedDirectoryInput>, ListingView> = {
  id: 'M46.A09',
  slug: 'business_listings.publish_listing_to_simulated_directory',
  module: MODULE,
  name: 'Publish listing to simulated directory',
  description: 'Publish a business listing to the (simulated) public directory — requires address and phone to be set.',
  risk: 'external',
  entities: ['structures'],
  inputSchema: publishListingToSimulatedDirectoryInput,
  outputSchema: listingView,
  searchCard: { synonyms: ['publish listing', 'sync to directory'], examplePhrasings: ['Publish this listing to the directory'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getListingRow(ctx.db, input.id);
    const config = readConfig(row);
    if (!config.address || !config.phone) {
      throw new ActionError('VALIDATION', `Business listing '${input.id}' needs an address and phone before it can be published.`);
    }
    const now = ctx.clock.now();
    const next: ListingConfig = { ...config, sync: { status: 'synced', synced_at: now } };
    writeConfig(ctx.db, input.id, next, now);
    ctx.db.run(`UPDATE structures SET status = 'published', updated_at = ? WHERE id = ?`, [now, input.id]);
    return toView(getListingRow(ctx.db, input.id));
  }),
};

// --- A10 get_listing_sync_status -----------------------------------------------------

const getListingSyncStatusInput = z.strictObject({ id: z.string() });
const syncStatusOutput = z.object({ id: z.string(), name: z.string(), status: z.string(), synced_at: z.number().nullable() });

const getListingSyncStatus: ActionDef<z.infer<typeof getListingSyncStatusInput>, z.infer<typeof syncStatusOutput>> = {
  id: 'M46.A10',
  slug: 'business_listings.get_listing_sync_status',
  module: MODULE,
  name: 'Get listing sync status',
  description: 'Fetch the (simulated) directory sync status for a listing.',
  risk: 'read',
  entities: ['structures'],
  inputSchema: getListingSyncStatusInput,
  outputSchema: syncStatusOutput,
  searchCard: { synonyms: ['sync status', 'is listing published'], examplePhrasings: ['Is this listing synced to the directory?'] },
  handler: async (input, ctx) => {
    const row = getListingRow(ctx.db, input.id);
    const config = readConfig(row);
    return { id: input.id, name: row['name'] as string, status: config.sync?.status ?? 'never_synced', synced_at: config.sync?.synced_at ?? null };
  },
};

export const m46BusinessListings: ActionDef[] = [
  createBusinessListing as ActionDef,
  getListingDetails as ActionDef,
  searchBusinessListings as ActionDef,
  updateListingName as ActionDef,
  updateListingAddress as ActionDef,
  updateListingPhone as ActionDef,
  setListingBusinessHours as ActionDef,
  setListingCategories as ActionDef,
  publishListingToSimulatedDirectory as ActionDef,
  getListingSyncStatus as ActionDef,
];

/**
 * Tier-A discrimination: `status` counts against the standard template
 * (verified live, full-suite run: 'published' → 15, 'pending' → 16 out
 * of 30 seeded business listings — thin universe, flagged).
 */
export const m46DiscriminationChecks: DiscriminationCheck[] = [
  {
    action: 'business_listings.search_business_listings',
    paramsA: { status: 'published' },
    paramsB: { status: 'pending' },
    expectDifferentCounts: true,
  },
];

export const m46SynthHints: SynthHints = {
  'business_listings.get_listing_details:id': { table: 'structures', kind: KIND },
  'business_listings.update_listing_name:id': { table: 'structures', kind: KIND },
  'business_listings.update_listing_address:id': { table: 'structures', kind: KIND },
  'business_listings.update_listing_phone:id': { table: 'structures', kind: KIND },
  'business_listings.set_listing_business_hours:id': { table: 'structures', kind: KIND },
  'business_listings.set_listing_categories:id': { table: 'structures', kind: KIND },
  'business_listings.publish_listing_to_simulated_directory:id': { table: 'structures', kind: KIND },
  'business_listings.get_listing_sync_status:id': { table: 'structures', kind: KIND },
};
