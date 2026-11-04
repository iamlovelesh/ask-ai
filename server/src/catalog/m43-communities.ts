/**
 * M43 Communities — follows the M01 Contacts convention verbatim.
 *
 * Data home: `structures` table, `kind = 'community'` (the community
 * container — guidelines/channels/posts config) PLUS `participations`
 * table, `kind = 'community_member'` (`parent_type='community'`,
 * `parent_id` = the community id — matches
 * `entities/seed-content.ts#generateParticipations`'s own seeded shape).
 *
 * DISCUSSION CHANNELS/POSTS JSON SIDECAR (same "no dedicated table — reuse
 * the generic `structures.config` JSON column" pattern as M05 pipelines'
 * stages / M18 forms' fields): `entities/model.ts` has no table for either
 * concept, so both live in `config`: `{ guidelines: string|null, channels:
 * ChannelEntry[], posts: PostEntry[] }`. A post's `parent_post_id` (null
 * for a top-level post) makes `reply_to_community_post` a thin wrapper
 * around the same append logic as `create_community_post`.
 *
 * STRUCTURAL SMOKE COVERAGE GAP (documented, same category as M26/M41):
 * seeded community rows carry the generic `{seeded:true,kind:'community'}`
 * placeholder config — zero channels/posts. `create_community_post`/
 * `reply_to_community_post`/`pin_community_post`/`remove_reported_post`
 * legitimately NOT_FOUND/CONFLICT under smoke against a freshly-seeded
 * community (no channel to post into, or the synthesized contact isn't an
 * active member) — real, non-masked checks either way.
 *
 * KIND-BLINDNESS NOTE: `structures`/`participations` are both shared
 * tables — every action needs an action-scoped synthHint.
 */

import { z } from 'zod';
import type { ActionDef, ActionContext } from './types.js';
import { ActionError } from './types.js';
import type { StoreTx, Row } from '../store/db.js';
import { withIdempotentWrite } from './idempotency.js';
import { nextId } from './next-id.js';
import type { DiscriminationCheck } from './discrimination.js';
import type { SynthHints } from './synth-hints.js';
import { parseJsonObject } from './json.js';

const MODULE = 'communities';
const KIND = 'community';
const MEMBER_KIND = 'community_member';

function slugify(name: string, id: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'community'}-${id}`;
}

interface ChannelEntry {
  id: string;
  name: string;
}

interface PostEntry {
  id: string;
  channel_id: string;
  contact_id: string;
  body: string;
  parent_post_id: string | null;
  pinned: boolean;
  removed: boolean;
  created_at: number;
}

interface CommunityConfig {
  guidelines: string | null;
  channels: ChannelEntry[];
  posts: PostEntry[];
}

function readConfig(row: Row): CommunityConfig {
  const config = parseJsonObject(row['config']);
  return {
    guidelines: (config['guidelines'] as string | null | undefined) ?? null,
    channels: Array.isArray(config['channels']) ? (config['channels'] as ChannelEntry[]) : [],
    posts: Array.isArray(config['posts']) ? (config['posts'] as PostEntry[]) : [],
  };
}

function writeConfig(db: StoreTx, id: string, config: CommunityConfig, now: number): void {
  db.run(`UPDATE structures SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now, id]);
}

function getCommunityRow(db: StoreTx, id: string): Row {
  const row = db.get(`SELECT * FROM structures WHERE id = ? AND kind = ?`, [id, KIND]);
  if (!row) throw new ActionError('NOT_FOUND', `Community '${id}' does not exist.`);
  return row;
}

function countActiveMembers(db: StoreTx, communityId: string): number {
  const row = db.get(`SELECT COUNT(*) AS n FROM participations WHERE kind = ? AND parent_id = ? AND status = 'active'`, [
    MEMBER_KIND,
    communityId,
  ]);
  return (row?.['n'] as number) ?? 0;
}

function getActiveMembership(db: StoreTx, communityId: string, contactId: string): Row | undefined {
  return db.get(`SELECT * FROM participations WHERE kind = ? AND parent_id = ? AND contact_id = ? AND status = 'active'`, [
    MEMBER_KIND,
    communityId,
    contactId,
  ]);
}

function nextSidecarId(ids: readonly string[], communityId: string, suffix: string): string {
  const re = new RegExp(`^${communityId}_${suffix}_(\\d+)$`);
  let maxN = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return `${communityId}_${suffix}_${maxN + 1}`;
}

interface CommunityView {
  id: string;
  name: string;
  status: string;
  guidelines: string | null;
  channels: ChannelEntry[];
  member_count: number;
  post_count: number;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

function toView(db: StoreTx, row: Row): CommunityView {
  const config = readConfig(row);
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    guidelines: config.guidelines,
    channels: config.channels,
    member_count: countActiveMembers(db, row['id'] as string),
    post_count: config.posts.filter((p) => !p.removed).length,
    archived: row['archived'] === 1,
    created_at: row['created_at'] as number,
    updated_at: row['updated_at'] as number,
  };
}

const channelSchema = z.object({ id: z.string(), name: z.string() });
const postSchema = z.object({
  id: z.string(),
  name: z.string(),
  channel_id: z.string(),
  contact_id: z.string(),
  body: z.string(),
  parent_post_id: z.string().nullable(),
  pinned: z.boolean(),
  removed: z.boolean(),
  created_at: z.number(),
});
type PostView = z.infer<typeof postSchema>;

function toPostView(entry: PostEntry): PostView {
  return { ...entry, name: `Post by contact '${entry.contact_id}'` };
}

const communityView = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  guidelines: z.string().nullable(),
  channels: z.array(channelSchema),
  member_count: z.number(),
  post_count: z.number(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});

const membershipView = z.object({
  id: z.string(),
  name: z.string(),
  community_id: z.string(),
  contact_id: z.string(),
  status: z.string(),
  role: z.string().nullable(),
  joined_at: z.number(),
});
type MembershipView = z.infer<typeof membershipView>;

function toMembershipView(db: StoreTx, row: Row): MembershipView {
  const contact = db.get(`SELECT name FROM contacts WHERE id = ?`, [row['contact_id']]);
  const contactName = (contact?.['name'] as string | undefined) ?? (row['contact_id'] as string);
  return {
    id: row['id'] as string,
    name: `${contactName}'s membership`,
    community_id: row['parent_id'] as string,
    contact_id: row['contact_id'] as string,
    status: row['status'] as string,
    role: (row['role'] as string | null) ?? null,
    joined_at: row['joined_at'] as number,
  };
}

// --- A01 create_community -----------------------------------------------------

const createCommunityInput = z.strictObject({ name: z.string().min(1) });

const createCommunity: ActionDef<z.infer<typeof createCommunityInput>, CommunityView> = {
  id: 'M43.A01',
  slug: 'communities.create_community',
  module: MODULE,
  name: 'Create community',
  description: 'Create a new community.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createCommunityInput,
  outputSchema: communityView,
  searchCard: { synonyms: ['add community', 'new community'], examplePhrasings: ['Create a customer community'] },
  handler: withIdempotentWrite(async (input, ctx: ActionContext) => {
    const id = nextId(ctx.db, 'structures', 'struct');
    const now = ctx.clock.now();
    const config: CommunityConfig = { guidelines: null, channels: [], posts: [] };
    ctx.db.run(
      `INSERT INTO structures (id, created_at, updated_at, archived, kind, name, slug, status,
        owner_id, parent_id, category, config, description)
       VALUES (?, ?, ?, 0, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
      [id, now, now, KIND, input.name, slugify(input.name, id), KIND, JSON.stringify(config)],
    );
    return toView(ctx.db, getCommunityRow(ctx.db, id));
  }),
};

// --- A02 get_community_details -----------------------------------------------------

const getCommunityDetailsInput = z.strictObject({ id: z.string() });

const getCommunityDetails: ActionDef<z.infer<typeof getCommunityDetailsInput>, CommunityView> = {
  id: 'M43.A02',
  slug: 'communities.get_community_details',
  module: MODULE,
  name: 'Get community details',
  description: 'Fetch a community, its channels, and live member/post counts.',
  risk: 'read',
  entities: ['structures', 'participations'],
  inputSchema: getCommunityDetailsInput,
  outputSchema: communityView,
  searchCard: { synonyms: ['community details', 'look up community'], examplePhrasings: ['Show me this community'] },
  handler: async (input, ctx) => toView(ctx.db, getCommunityRow(ctx.db, input.id)),
};

// --- A03 update_community_guidelines -----------------------------------------------------

const updateCommunityGuidelinesInput = z.strictObject({ id: z.string(), guidelines: z.string() });

const updateCommunityGuidelines: ActionDef<z.infer<typeof updateCommunityGuidelinesInput>, CommunityView> = {
  id: 'M43.A03',
  slug: 'communities.update_community_guidelines',
  module: MODULE,
  name: 'Update community guidelines',
  description: "Set a community's posting guidelines.",
  risk: 'write',
  entities: ['structures'],
  inputSchema: updateCommunityGuidelinesInput,
  outputSchema: communityView,
  searchCard: { synonyms: ['edit guidelines', 'set community rules'], examplePhrasings: ["Update this community's guidelines"] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCommunityRow(ctx.db, input.id);
    const config = readConfig(row);
    writeConfig(ctx.db, input.id, { ...config, guidelines: input.guidelines }, ctx.clock.now());
    return toView(ctx.db, getCommunityRow(ctx.db, input.id));
  }),
};

// --- A04 create_discussion_channel -----------------------------------------------------

const createDiscussionChannelInput = z.strictObject({ id: z.string(), name: z.string().min(1) });

const createDiscussionChannel: ActionDef<z.infer<typeof createDiscussionChannelInput>, CommunityView> = {
  id: 'M43.A04',
  slug: 'communities.create_discussion_channel',
  module: MODULE,
  name: 'Create discussion channel',
  description: 'Add a new discussion channel to a community.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: createDiscussionChannelInput,
  outputSchema: communityView,
  searchCard: { synonyms: ['add channel', 'new discussion channel'], examplePhrasings: ['Add a #general channel to this community'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCommunityRow(ctx.db, input.id);
    const config = readConfig(row);
    if (config.channels.some((c) => c.name === input.name)) {
      throw new ActionError('CONFLICT', `Community '${input.id}' already has a channel named '${input.name}'.`);
    }
    const channel: ChannelEntry = { id: nextSidecarId(config.channels.map((c) => c.id), input.id, 'ch'), name: input.name };
    writeConfig(ctx.db, input.id, { ...config, channels: [...config.channels, channel] }, ctx.clock.now());
    return toView(ctx.db, getCommunityRow(ctx.db, input.id));
  }),
};

// --- A05 join_community -----------------------------------------------------

const joinCommunityInput = z.strictObject({ id: z.string(), contact_id: z.string() });

const joinCommunity: ActionDef<z.infer<typeof joinCommunityInput>, MembershipView> = {
  id: 'M43.A05',
  slug: 'communities.join_community',
  module: MODULE,
  name: 'Join community',
  description: 'Add a contact as an active member of a community (CONFLICT if already an active member).',
  risk: 'write',
  entities: ['participations', 'structures'],
  inputSchema: joinCommunityInput,
  outputSchema: membershipView,
  searchCard: { synonyms: ['add member', 'join community'], examplePhrasings: ['Add this contact to the community'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    getCommunityRow(ctx.db, input.id);
    const contact = ctx.db.get(`SELECT id FROM contacts WHERE id = ?`, [input.contact_id]);
    if (!contact) throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' does not exist.`);
    if (getActiveMembership(ctx.db, input.id, input.contact_id)) {
      throw new ActionError('CONFLICT', `Contact '${input.contact_id}' is already an active member of community '${input.id}'.`);
    }
    const id = nextId(ctx.db, 'participations', 'part');
    const now = ctx.clock.now();
    ctx.db.run(
      `INSERT INTO participations (id, created_at, updated_at, archived, kind, contact_id, parent_type, parent_id,
        status, waitlisted, role, joined_at, progress, completed_at)
       VALUES (?, ?, ?, 0, ?, ?, 'community', ?, 'active', 0, 'member', ?, NULL, NULL)`,
      [id, now, now, MEMBER_KIND, input.contact_id, input.id, now],
    );
    return toMembershipView(ctx.db, ctx.db.get(`SELECT * FROM participations WHERE id = ?`, [id]) as Row);
  }),
};

// --- A06 leave_community -----------------------------------------------------

const leaveCommunityInput = z.strictObject({ id: z.string(), contact_id: z.string() });

const leaveCommunity: ActionDef<z.infer<typeof leaveCommunityInput>, MembershipView> = {
  id: 'M43.A06',
  slug: 'communities.leave_community',
  module: MODULE,
  name: 'Leave community',
  description: "Mark a contact's community membership as left.",
  risk: 'write',
  entities: ['participations'],
  inputSchema: leaveCommunityInput,
  outputSchema: membershipView,
  searchCard: { synonyms: ['remove member', 'leave community'], examplePhrasings: ['Remove this contact from the community'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const membership = getActiveMembership(ctx.db, input.id, input.contact_id);
    if (!membership) {
      throw new ActionError('NOT_FOUND', `Contact '${input.contact_id}' has no active membership in community '${input.id}'.`);
    }
    ctx.db.run(`UPDATE participations SET status = 'left', updated_at = ? WHERE id = ?`, [ctx.clock.now(), membership['id']]);
    return toMembershipView(ctx.db, ctx.db.get(`SELECT * FROM participations WHERE id = ?`, [membership['id']]) as Row);
  }),
};

// --- A07 create_community_post -----------------------------------------------------

const createCommunityPostInput = z.strictObject({ id: z.string(), channel_id: z.string(), contact_id: z.string(), body: z.string().min(1) });

const createCommunityPost: ActionDef<z.infer<typeof createCommunityPostInput>, PostView> = {
  id: 'M43.A07',
  slug: 'communities.create_community_post',
  module: MODULE,
  name: 'Create community post',
  description: 'Create a new top-level post in a community channel (requires an active membership).',
  risk: 'write',
  entities: ['structures', 'participations'],
  inputSchema: createCommunityPostInput,
  outputSchema: postSchema,
  searchCard: { synonyms: ['post to community', 'new community post'], examplePhrasings: ['Post an announcement in the general channel'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCommunityRow(ctx.db, input.id);
    if (!getActiveMembership(ctx.db, input.id, input.contact_id)) {
      throw new ActionError('CONFLICT', `Contact '${input.contact_id}' is not an active member of community '${input.id}'.`);
    }
    const config = readConfig(row);
    if (!config.channels.some((c) => c.id === input.channel_id)) {
      throw new ActionError('NOT_FOUND', `Community '${input.id}' has no channel '${input.channel_id}'.`);
    }
    const now = ctx.clock.now();
    const post: PostEntry = {
      id: nextSidecarId(config.posts.map((p) => p.id), input.id, 'post'),
      channel_id: input.channel_id,
      contact_id: input.contact_id,
      body: input.body,
      parent_post_id: null,
      pinned: false,
      removed: false,
      created_at: now,
    };
    writeConfig(ctx.db, input.id, { ...config, posts: [...config.posts, post] }, now);
    return toPostView(post);
  }),
};

// --- A08 reply_to_community_post -----------------------------------------------------

const replyToCommunityPostInput = z.strictObject({ id: z.string(), post_id: z.string(), contact_id: z.string(), body: z.string().min(1) });

const replyToCommunityPost: ActionDef<z.infer<typeof replyToCommunityPostInput>, PostView> = {
  id: 'M43.A08',
  slug: 'communities.reply_to_community_post',
  module: MODULE,
  name: 'Reply to community post',
  description: "Reply to an existing post (inherits the parent's channel; requires an active membership).",
  risk: 'write',
  entities: ['structures', 'participations'],
  inputSchema: replyToCommunityPostInput,
  outputSchema: postSchema,
  searchCard: { synonyms: ['reply to post', 'comment on post'], examplePhrasings: ['Reply to this community post'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCommunityRow(ctx.db, input.id);
    if (!getActiveMembership(ctx.db, input.id, input.contact_id)) {
      throw new ActionError('CONFLICT', `Contact '${input.contact_id}' is not an active member of community '${input.id}'.`);
    }
    const config = readConfig(row);
    const parent = config.posts.find((p) => p.id === input.post_id && !p.removed);
    if (!parent) throw new ActionError('NOT_FOUND', `Community '${input.id}' has no post '${input.post_id}'.`);
    const now = ctx.clock.now();
    const reply: PostEntry = {
      id: nextSidecarId(config.posts.map((p) => p.id), input.id, 'post'),
      channel_id: parent.channel_id,
      contact_id: input.contact_id,
      body: input.body,
      parent_post_id: input.post_id,
      pinned: false,
      removed: false,
      created_at: now,
    };
    writeConfig(ctx.db, input.id, { ...config, posts: [...config.posts, reply] }, now);
    return toPostView(reply);
  }),
};

// --- A09 pin_community_post -----------------------------------------------------

const pinCommunityPostInput = z.strictObject({ id: z.string(), post_id: z.string() });

const pinCommunityPost: ActionDef<z.infer<typeof pinCommunityPostInput>, PostView> = {
  id: 'M43.A09',
  slug: 'communities.pin_community_post',
  module: MODULE,
  name: 'Pin community post',
  description: 'Pin a post to the top of its channel.',
  risk: 'write',
  entities: ['structures'],
  inputSchema: pinCommunityPostInput,
  outputSchema: postSchema,
  searchCard: { synonyms: ['pin post', 'highlight post'], examplePhrasings: ['Pin this announcement'] },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCommunityRow(ctx.db, input.id);
    const config = readConfig(row);
    const idx = config.posts.findIndex((p) => p.id === input.post_id && !p.removed);
    if (idx === -1) throw new ActionError('NOT_FOUND', `Community '${input.id}' has no post '${input.post_id}'.`);
    const posts = config.posts.map((p, i) => (i === idx ? { ...p, pinned: true } : p));
    writeConfig(ctx.db, input.id, { ...config, posts }, ctx.clock.now());
    return toPostView(posts[idx] as PostEntry);
  }),
};

// --- A10 remove_reported_post -----------------------------------------------------

const removeReportedPostInput = z.strictObject({ id: z.string(), post_id: z.string() });

const removeReportedPost: ActionDef<z.infer<typeof removeReportedPostInput>, PostView> = {
  id: 'M43.A10',
  slug: 'communities.remove_reported_post',
  module: MODULE,
  name: 'Remove reported post',
  description: 'Soft-remove a reported post (CONFLICT if already removed).',
  risk: 'destructive',
  entities: ['structures'],
  inputSchema: removeReportedPostInput,
  outputSchema: postSchema,
  searchCard: {
    synonyms: ['delete post', 'remove reported content', 'someone flagged this comment'],
    examplePhrasings: ['Remove this reported post', 'Someone flagged this comment in our community, take it down'],
  },
  handler: withIdempotentWrite(async (input, ctx) => {
    const row = getCommunityRow(ctx.db, input.id);
    const config = readConfig(row);
    const idx = config.posts.findIndex((p) => p.id === input.post_id);
    if (idx === -1) throw new ActionError('NOT_FOUND', `Community '${input.id}' has no post '${input.post_id}'.`);
    const existing = config.posts[idx] as PostEntry;
    if (existing.removed) throw new ActionError('CONFLICT', `Post '${input.post_id}' is already removed.`);
    const posts = config.posts.map((p, i) => (i === idx ? { ...p, removed: true } : p));
    writeConfig(ctx.db, input.id, { ...config, posts }, ctx.clock.now());
    return toPostView(posts[idx] as PostEntry);
  }),
};

export const m43Communities: ActionDef[] = [
  createCommunity as ActionDef,
  getCommunityDetails as ActionDef,
  updateCommunityGuidelines as ActionDef,
  createDiscussionChannel as ActionDef,
  joinCommunity as ActionDef,
  leaveCommunity as ActionDef,
  createCommunityPost as ActionDef,
  replyToCommunityPost as ActionDef,
  pinCommunityPost as ActionDef,
  removeReportedPost as ActionDef,
];

/** No catalog-wide list/search action for communities in this module's 10
 * actions — same convention as M26 Prices (`discriminationChecks: []`). */
export const m43DiscriminationChecks: DiscriminationCheck[] = [];

/** `structures`/`participations` are both shared, kind-discriminated
 * tables — every action needs an action-scoped hint. `post_id`/`channel_id`
 * have no SQL table to resolve against (see module header). */
export const m43SynthHints: SynthHints = {
  'communities.get_community_details:id': { table: 'structures', kind: KIND },
  'communities.update_community_guidelines:id': { table: 'structures', kind: KIND },
  'communities.create_discussion_channel:id': { table: 'structures', kind: KIND },
  'communities.join_community:id': { table: 'structures', kind: KIND },
  'communities.leave_community:id': { table: 'structures', kind: KIND },
  'communities.create_community_post:id': { table: 'structures', kind: KIND },
  'communities.reply_to_community_post:id': { table: 'structures', kind: KIND },
  'communities.pin_community_post:id': { table: 'structures', kind: KIND },
  'communities.remove_reported_post:id': { table: 'structures', kind: KIND },
};
