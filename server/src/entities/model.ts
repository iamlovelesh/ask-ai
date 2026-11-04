/**
 * ENTITY_MODEL — the canonical CRM data model for Ask AI (LLD §3.2).
 *
 * 50 product modules (M01–M50) collapse into 26 physical tables: 24 typed
 * business tables, one generic `structures` table for definition/config-shaped
 * entities (workflows, forms, pipelines, …) behind a `kind` discriminator, and
 * one typed `records` table for transactional sub-records (form submissions,
 * survey responses, coupon redemptions, lesson progress, team membership) that
 * are events/ledger rows rather than config. The four merges mandated by the LLD are present as
 * dedicated tables with explicit discriminator columns:
 *   - messages        channel     : 'sms' | 'email'
 *   - line_items      parent_type : 'quote' | 'invoice' | 'order'
 *   - content_items   kind        : 'website_page' | 'landing_page' | 'blog_post'
 *   - participations  kind        : 'event_registration' | 'enrollment'
 *                                  | 'membership' | 'community_member'
 *
 * Conventions (LLD §3.2):
 *   - TEXT ids `{prefix}_{n}` (prefix per table below)
 *   - INT epoch timestamps (virtual clock) — created_at / updated_at everywhere
 *   - `archived INT DEFAULT 0` soft-delete on every table; handlers must respect it
 *   - an index on every searchable column (`indexed: true`)
 *
 * The full module→table map lives at the bottom of this file (MODULE_MAP) and in
 * the task report.
 */

export type SqlType = 'TEXT' | 'INT' | 'REAL';

export interface ColumnDef {
  name: string;
  type: SqlType;
  primaryKey?: boolean;
  notNull?: boolean;
  indexed?: boolean;
  default?: string | number;
}

export interface IndexDef {
  /** suffix used in `idx_{table}_{name}` */
  name: string;
  columns: string[];
}

export interface TableDef {
  name: string;
  /** id prefix for `{prefix}_{n}` */
  prefix: string;
  columns: ColumnDef[];
  /** composite indexes beyond the per-column `indexed` flag */
  indexes?: IndexDef[];
}

// --- column helpers -------------------------------------------------------

function col(
  name: string,
  type: SqlType,
  flags: Partial<Omit<ColumnDef, 'name' | 'type'>> = {},
): ColumnDef {
  return { name, type, ...flags };
}

/** id (PK) + created_at(idx) + updated_at + archived(idx, default 0) */
function base(): ColumnDef[] {
  return [
    { name: 'id', type: 'TEXT', primaryKey: true },
    { name: 'created_at', type: 'INT', indexed: true },
    { name: 'updated_at', type: 'INT' },
    { name: 'archived', type: 'INT', default: 0, indexed: true },
  ];
}

function table(
  name: string,
  prefix: string,
  domain: ColumnDef[],
  indexes?: IndexDef[],
): TableDef {
  const def: TableDef = { name, prefix, columns: [...base(), ...domain] };
  if (indexes) def.indexes = indexes;
  return def;
}

// --- the 25 tables --------------------------------------------------------

export const ENTITY_MODEL: readonly TableDef[] = [
  // M01 Contacts
  table('contacts', 'con', [
    col('name', 'TEXT', { indexed: true }),
    col('first_name', 'TEXT', { indexed: true }),
    col('last_name', 'TEXT', { indexed: true }),
    col('email', 'TEXT', { indexed: true }),
    col('phone', 'TEXT', { indexed: true }),
    col('company_id', 'TEXT', { indexed: true }),
    col('owner_id', 'TEXT', { indexed: true }),
    col('lifecycle_stage', 'TEXT', { indexed: true }),
    col('source', 'TEXT', { indexed: true }),
    col('city', 'TEXT', { indexed: true }),
    col('country', 'TEXT', { indexed: true }),
    col('address', 'TEXT'),
    col('tags', 'TEXT'), // JSON string[]
    col('custom_fields', 'TEXT'), // JSON object
  ]),

  // M02 Companies
  table('companies', 'co', [
    col('name', 'TEXT', { indexed: true }),
    col('domain', 'TEXT', { indexed: true }),
    col('industry', 'TEXT', { indexed: true }),
    col('size', 'TEXT', { indexed: true }),
    col('owner_id', 'TEXT', { indexed: true }),
    col('city', 'TEXT', { indexed: true }),
    col('country', 'TEXT', { indexed: true }),
    col('phone', 'TEXT'),
    col('address', 'TEXT'),
    col('tags', 'TEXT'),
  ]),

  // M03 Leads
  table('leads', 'lead', [
    col('name', 'TEXT', { indexed: true }),
    col('contact_id', 'TEXT', { indexed: true }),
    col('source', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // new|contacted|qualified|disqualified
    col('score', 'INT', { indexed: true }),
    col('owner_id', 'TEXT', { indexed: true }),
    col('campaign_id', 'TEXT', { indexed: true }),
    col('value_cents', 'INT'),
    col('notes', 'TEXT'),
  ], [{ name: 'status_created', columns: ['status', 'created_at'] }]),

  // M04 Opportunities
  table('opportunities', 'opp', [
    col('name', 'TEXT', { indexed: true }),
    col('contact_id', 'TEXT', { indexed: true }),
    col('company_id', 'TEXT', { indexed: true }),
    col('pipeline_id', 'TEXT', { indexed: true }),
    col('stage', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // open|won|lost
    col('value_cents', 'INT', { indexed: true }),
    col('owner_id', 'TEXT', { indexed: true }),
    col('expected_close_date', 'INT', { indexed: true }),
    col('probability', 'INT'),
  ]),

  // M06 Tasks
  table('tasks', 'task', [
    col('title', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // open|in_progress|completed|cancelled
    col('priority', 'TEXT', { indexed: true }), // low|medium|high
    col('due_date', 'INT', { indexed: true }),
    col('owner_id', 'TEXT', { indexed: true }),
    col('contact_id', 'TEXT', { indexed: true }),
    col('related_type', 'TEXT', { indexed: true }),
    col('related_id', 'TEXT', { indexed: true }),
    col('completed_at', 'INT'),
    col('description', 'TEXT'),
  ]),

  // M07 Notes
  table('notes', 'note', [
    col('contact_id', 'TEXT', { indexed: true }),
    col('author_id', 'TEXT', { indexed: true }),
    col('related_type', 'TEXT', { indexed: true }),
    col('related_id', 'TEXT', { indexed: true }),
    col('pinned', 'INT', { indexed: true }),
    col('body', 'TEXT'),
  ]),

  // M11 Conversations
  table('conversations', 'conv', [
    col('contact_id', 'TEXT', { indexed: true }),
    col('channel', 'TEXT', { indexed: true }), // sms|email|webchat
    col('status', 'TEXT', { indexed: true }), // open|closed|snoozed
    col('last_inbound_at', 'INT', { indexed: true }),
    col('last_outbound_at', 'INT', { indexed: true }),
    col('unread', 'INT', { indexed: true }),
    col('owner_id', 'TEXT', { indexed: true }),
    col('subject', 'TEXT'),
  ]),

  // M12 SMS + M13 Email
  table('messages', 'msg', [
    col('conversation_id', 'TEXT', { indexed: true }),
    col('contact_id', 'TEXT', { indexed: true }),
    col('channel', 'TEXT', { indexed: true }), // sms|email
    col('direction', 'TEXT', { indexed: true }), // inbound|outbound
    col('status', 'TEXT', { indexed: true }), // draft|scheduled|sent|delivered|failed|received
    col('scheduled_at', 'INT', { indexed: true }),
    col('sent_at', 'INT', { indexed: true }),
    col('from_addr', 'TEXT', { indexed: true }),
    col('to_addr', 'TEXT', { indexed: true }),
    col('template_id', 'TEXT', { indexed: true }),
    col('campaign_id', 'TEXT', { indexed: true }),
    col('subject', 'TEXT'),
    col('body', 'TEXT'),
  ], [{ name: 'conv_sent', columns: ['conversation_id', 'sent_at'] }]),

  // M21 Appointments
  table('appointments', 'appt', [
    col('title', 'TEXT', { indexed: true }),
    col('contact_id', 'TEXT', { indexed: true }),
    col('calendar_id', 'TEXT', { indexed: true }),
    col('host_user_id', 'TEXT', { indexed: true }),
    col('booking_page_id', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // booked|cancelled|completed|no_show
    col('start_at', 'INT', { indexed: true }),
    col('end_at', 'INT', { indexed: true }),
    col('location', 'TEXT'),
    col('notes', 'TEXT'),
  ]),

  // M24 Events (container; registrations live in participations)
  table('events', 'evt', [
    col('name', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // draft|published|cancelled|completed
    col('start_at', 'INT', { indexed: true }),
    col('end_at', 'INT', { indexed: true }),
    col('location', 'TEXT', { indexed: true }),
    col('host_user_id', 'TEXT', { indexed: true }),
    col('capacity', 'INT'),
    col('registered_count', 'INT'),
    col('price_cents', 'INT'),
    col('description', 'TEXT'),
  ]),

  // M25 Products (+ M26 Prices as JSON `prices` list)
  table('products', 'prod', [
    col('name', 'TEXT', { indexed: true }),
    col('sku', 'TEXT', { indexed: true }),
    col('type', 'TEXT', { indexed: true }), // physical|digital|service
    col('status', 'TEXT', { indexed: true }), // active|archived
    col('category', 'TEXT', { indexed: true }),
    col('default_price_cents', 'INT', { indexed: true }),
    col('currency', 'TEXT'),
    col('prices', 'TEXT'), // JSON [{id,amount_cents,currency,interval}]
    col('description', 'TEXT'),
  ]),

  // M27 Quotes
  table('quotes', 'quote', [
    col('number', 'TEXT', { indexed: true }),
    col('contact_id', 'TEXT', { indexed: true }),
    col('company_id', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // draft|sent|accepted|declined|expired
    col('total_cents', 'INT', { indexed: true }),
    col('owner_id', 'TEXT', { indexed: true }),
    col('valid_until', 'INT', { indexed: true }),
    col('currency', 'TEXT'),
    col('notes', 'TEXT'),
  ]),

  // M28 Invoices
  table('invoices', 'inv', [
    col('number', 'TEXT', { indexed: true }),
    col('contact_id', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // draft|issued|paid|void
    col('total_cents', 'INT', { indexed: true }),
    col('amount_paid_cents', 'INT'),
    col('due_date', 'INT', { indexed: true }),
    col('issued_at', 'INT', { indexed: true }),
    col('paid_at', 'INT', { indexed: true }),
    col('quote_id', 'TEXT', { indexed: true }),
    col('owner_id', 'TEXT', { indexed: true }),
    col('currency', 'TEXT'),
  ], [{ name: 'status_due', columns: ['status', 'due_date'] }]),

  // M32 Orders
  table('orders', 'ord', [
    col('number', 'TEXT', { indexed: true }),
    col('contact_id', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // pending|paid|fulfilled|cancelled|refunded
    col('total_cents', 'INT', { indexed: true }),
    col('placed_at', 'INT', { indexed: true }),
    col('coupon_id', 'TEXT', { indexed: true }),
    col('source', 'TEXT', { indexed: true }),
    col('fulfilled_at', 'INT'),
    col('currency', 'TEXT'),
  ]),

  // M27/M28/M32 line items (merged child)
  table('line_items', 'li', [
    col('parent_type', 'TEXT', { indexed: true }), // quote|invoice|order
    col('parent_id', 'TEXT', { indexed: true }),
    col('product_id', 'TEXT', { indexed: true }),
    col('quantity', 'INT'),
    col('unit_price_cents', 'INT'),
    col('amount_cents', 'INT'),
    col('tax_cents', 'INT'),
    col('position', 'INT'),
    col('description', 'TEXT'),
  ], [{ name: 'parent', columns: ['parent_type', 'parent_id'] }]),

  // M29 Payments (+ M33 Refunds via kind)
  table('payments', 'pay', [
    col('kind', 'TEXT', { indexed: true }), // payment|refund
    col('contact_id', 'TEXT', { indexed: true }),
    col('invoice_id', 'TEXT', { indexed: true }),
    col('order_id', 'TEXT', { indexed: true }),
    col('subscription_id', 'TEXT', { indexed: true }),
    col('parent_payment_id', 'TEXT', { indexed: true }), // refund → original payment
    col('status', 'TEXT', { indexed: true }), // pending|succeeded|failed|refunded
    col('method', 'TEXT', { indexed: true }), // card|bank|cash|other
    col('amount_cents', 'INT', { indexed: true }),
    col('processed_at', 'INT', { indexed: true }),
    col('reference', 'TEXT', { indexed: true }),
    col('currency', 'TEXT'),
  ]),

  // M30 Subscriptions
  table('subscriptions', 'sub', [
    col('contact_id', 'TEXT', { indexed: true }),
    col('product_id', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // trialing|active|past_due|cancelled|paused
    col('interval', 'TEXT', { indexed: true }), // day|week|month|year
    col('amount_cents', 'INT'),
    col('current_period_start', 'INT', { indexed: true }),
    col('current_period_end', 'INT', { indexed: true }),
    col('started_at', 'INT', { indexed: true }),
    col('coupon_id', 'TEXT', { indexed: true }),
    col('cancelled_at', 'INT'),
    col('currency', 'TEXT'),
  ]),

  // M35 website pages + M37 landing pages + M38 blog posts (merged)
  table('content_items', 'content', [
    col('kind', 'TEXT', { indexed: true }), // website_page|landing_page|blog_post
    col('title', 'TEXT', { indexed: true }),
    col('slug', 'TEXT', { indexed: true }),
    col('path', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // draft|published|archived
    col('parent_id', 'TEXT', { indexed: true }), // owning site/funnel (structures.id)
    col('author_id', 'TEXT', { indexed: true }),
    col('published_at', 'INT', { indexed: true }),
    col('views', 'INT'),
    col('seo_title', 'TEXT'),
    col('body', 'TEXT'),
  ]),

  // M40 Courses (+ M41 Lessons as JSON `lessons` list)
  table('courses', 'course', [
    col('title', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // draft|published|archived
    col('instructor_id', 'TEXT', { indexed: true }),
    col('category', 'TEXT', { indexed: true }),
    col('price_cents', 'INT'),
    col('lesson_count', 'INT'),
    col('enrolled_count', 'INT'),
    col('lessons', 'TEXT'), // JSON [{id,title,order,duration_min}]
    col('description', 'TEXT'),
  ]),

  // M24 reg + M42 enrollment + M44 membership + M43 community member (merged)
  table('participations', 'part', [
    col('kind', 'TEXT', { indexed: true }), // event_registration|enrollment|membership|community_member
    col('contact_id', 'TEXT', { indexed: true }),
    col('parent_type', 'TEXT', { indexed: true }), // event|course|community
    col('parent_id', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }),
    col('waitlisted', 'INT', { indexed: true }),
    col('role', 'TEXT', { indexed: true }),
    col('joined_at', 'INT', { indexed: true }),
    col('progress', 'INT'),
    col('completed_at', 'INT'),
  ], [{ name: 'parent', columns: ['parent_type', 'parent_id'] }]),

  // M45 Reviews
  table('reviews', 'rev', [
    col('contact_id', 'TEXT', { indexed: true }),
    col('target_type', 'TEXT', { indexed: true }), // product|business_listing|course|company
    col('target_id', 'TEXT', { indexed: true }),
    col('rating', 'INT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // pending|published|rejected
    col('source', 'TEXT', { indexed: true }),
    col('title', 'TEXT'),
    col('body', 'TEXT'),
    col('response', 'TEXT'),
  ], [{ name: 'target', columns: ['target_type', 'target_id'] }]),

  // M47 Support Tickets
  table('support_tickets', 'ticket', [
    col('subject', 'TEXT', { indexed: true }),
    col('contact_id', 'TEXT', { indexed: true }),
    col('status', 'TEXT', { indexed: true }), // open|pending|resolved|closed
    col('priority', 'TEXT', { indexed: true }), // low|medium|high|urgent
    col('assignee_id', 'TEXT', { indexed: true }),
    col('team_id', 'TEXT', { indexed: true }),
    col('channel', 'TEXT', { indexed: true }),
    col('first_response_at', 'INT'),
    col('resolved_at', 'INT'),
    col('description', 'TEXT'),
  ]),

  // M48 Users
  table('users', 'user', [
    col('name', 'TEXT', { indexed: true }),
    col('email', 'TEXT', { indexed: true }),
    col('role', 'TEXT', { indexed: true }), // admin|sales_rep|support
    col('active', 'INT', { indexed: true }),
    col('team_id', 'TEXT', { indexed: true }),
    col('title', 'TEXT'),
    col('phone', 'TEXT'),
    col('last_login_at', 'INT'),
  ]),

  // M49 Teams
  table('teams', 'team', [
    col('name', 'TEXT', { indexed: true }),
    col('lead_user_id', 'TEXT', { indexed: true }),
    col('member_count', 'INT'),
    col('description', 'TEXT'),
  ]),

  // Transactional sub-records that are NOT config: form submissions (M18),
  // survey responses (M19), coupon redemptions (M31), per-lesson progress
  // (M41), team membership M:N (M49). The `structures` ruling covers only
  // definition/config rows; these are events/ledger rows and live here.
  table('records', 'record', [
    col('kind', 'TEXT', { indexed: true }), // form_submission|survey_response|coupon_redemption|lesson_completion|team_membership
    col('parent_id', 'TEXT', { indexed: true }), // form/survey/coupon/lesson(course)/team id
    col('contact_id', 'TEXT', { indexed: true }), // nullable
    col('user_id', 'TEXT', { indexed: true }), // nullable (e.g. team membership)
    col('occurred_at', 'INT', { indexed: true }),
    col('data', 'TEXT'), // JSON — kind-specific payload
  ], [{ name: 'kind_parent', columns: ['kind', 'parent_id'] }]),

  // Generic definition/config table — one `kind` per module (see STRUCTURE_KINDS)
  table('structures', 'struct', [
    col('kind', 'TEXT', { indexed: true }),
    col('name', 'TEXT', { indexed: true }),
    col('slug', 'TEXT', { indexed: true }), // also carries coupon codes, page paths, etc.
    col('status', 'TEXT', { indexed: true }),
    col('owner_id', 'TEXT', { indexed: true }),
    col('parent_id', 'TEXT', { indexed: true }),
    col('category', 'TEXT', { indexed: true }),
    col('config', 'TEXT'), // JSON — kind-specific payload
    col('description', 'TEXT'),
  ], [{ name: 'kind_status', columns: ['kind', 'status'] }]),
] as const;

/** Discriminator values the transactional `records` table carries. */
export const RECORD_KINDS = [
  'form_submission', // M18
  'survey_response', // M19
  'coupon_redemption', // M31
  'lesson_completion', // M41
  'team_membership', // M49
] as const;

/** Discriminator values the generic `structures` table carries. */
export const STRUCTURE_KINDS = [
  'smart_list', // M09
  'custom_field', // M10
  'template', // M14
  'campaign', // M15
  'workflow', // M16
  'trigger', // M17
  'form', // M18
  'survey', // M19
  'pipeline', // M05
  'calendar', // M20 (+ M22 availability in config)
  'booking_page', // M23
  'coupon', // M31 (code in slug)
  'tax_rule', // M34
  'website', // M35 container
  'funnel', // M36
  'media_asset', // M39
  'community', // M43 container
  'business_listing', // M46
  'report', // M50
  'tag', // M08
] as const;

/** Full module → table map, for docs/handlers. */
export const MODULE_MAP: Record<string, string> = {
  M01: 'contacts',
  M02: 'companies',
  M03: 'leads',
  M04: 'opportunities',
  M05: 'structures(pipeline)',
  M06: 'tasks',
  M07: 'notes',
  M08: 'structures(tag)',
  M09: 'structures(smart_list)',
  M10: 'structures(custom_field)',
  M11: 'conversations',
  M12: 'messages(sms)',
  M13: 'messages(email)',
  M14: 'structures(template)',
  M15: 'structures(campaign)',
  M16: 'structures(workflow)',
  M17: 'structures(trigger)',
  M18: 'structures(form) + records(form_submission)',
  M19: 'structures(survey) + records(survey_response)',
  M20: 'structures(calendar)',
  M21: 'appointments',
  M22: 'structures(calendar).config.availability',
  M23: 'structures(booking_page)',
  M24: 'events (+participations.event_registration)',
  M25: 'products',
  M26: 'products.prices',
  M27: 'quotes (+line_items)',
  M28: 'invoices (+line_items)',
  M29: 'payments',
  M30: 'subscriptions',
  M31: 'structures(coupon) + records(coupon_redemption)',
  M32: 'orders (+line_items)',
  M33: 'payments(kind=refund)',
  M34: 'structures(tax_rule)',
  M35: 'content_items(website_page) + structures(website)',
  M36: 'structures(funnel)',
  M37: 'content_items(landing_page)',
  M38: 'content_items(blog_post)',
  M39: 'structures(media_asset)',
  M40: 'courses',
  M41: 'courses.lessons + records(lesson_completion)',
  M42: 'participations(enrollment)',
  M43: 'structures(community) + participations(community_member)',
  M44: 'participations(membership)',
  M45: 'reviews',
  M46: 'structures(business_listing)',
  M47: 'support_tickets',
  M48: 'users',
  M49: 'teams (+ records(team_membership) for M:N)',
  M50: 'structures(report)',
};

// --- DDL generation -------------------------------------------------------

function columnSql(c: ColumnDef): string {
  let s = `${c.name} ${c.type}`;
  if (c.primaryKey) s += ' PRIMARY KEY';
  if (c.notNull) s += ' NOT NULL';
  if (c.default !== undefined) {
    s += ` DEFAULT ${typeof c.default === 'string' ? `'${c.default}'` : c.default}`;
  }
  return s;
}

/**
 * All DDL statements (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS),
 * deterministic order. Idempotent — safe to run on every open.
 */
export function ddl(): string[] {
  const stmts: string[] = [];
  for (const t of ENTITY_MODEL) {
    const cols = t.columns.map(columnSql).join(', ');
    stmts.push(`CREATE TABLE IF NOT EXISTS ${t.name} (${cols})`);
  }
  for (const t of ENTITY_MODEL) {
    for (const c of t.columns) {
      if (c.indexed) {
        stmts.push(
          `CREATE INDEX IF NOT EXISTS idx_${t.name}_${c.name} ON ${t.name} (${c.name})`,
        );
      }
    }
    for (const idx of t.indexes ?? []) {
      stmts.push(
        `CREATE INDEX IF NOT EXISTS idx_${t.name}_${idx.name} ON ${t.name} (${idx.columns.join(', ')})`,
      );
    }
  }
  return stmts;
}
