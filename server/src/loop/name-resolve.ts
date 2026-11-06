/**
 * Deterministic record-name resolution (improvement: the agent sometimes
 * surfaces a raw id — "Customer ID: con_4403" — instead of the person's name,
 * especially on non-Anthropic tiers that don't reliably do the extra lookup).
 *
 * After the answer is verified, we resolve record ids the model cited (bare
 * ids, and reference tokens whose display name is itself an id) to the real
 * display name from the CRM, and rewrite them as proper `[[record:...]]`
 * chips. This is safe: the id was already in the model's context (it came
 * from a tool result / the provenance firewall), so we are looking up a real
 * record's name, never inventing one.
 */

/** id prefix → entity + how to read its display name. Order matters: `con`
 * must be tried before `co` so a contact id is never read as a company. */
export const ID_ENTITY: ReadonlyArray<{ prefix: string; entity: string }> = [
  { prefix: 'con', entity: 'contacts' },
  { prefix: 'co', entity: 'companies' },
  { prefix: 'lead', entity: 'leads' },
  { prefix: 'opp', entity: 'opportunities' },
  { prefix: 'user', entity: 'users' },
  { prefix: 'ticket', entity: 'support_tickets' },
  { prefix: 'inv', entity: 'invoices' },
];

const PREFIX_ALT = ID_ENTITY.map((e) => e.prefix).join('|');
const BARE_ID_RE = new RegExp(`\\b(?:${PREFIX_ALT})_\\d+\\b`, 'g');
const TOKEN_RE = /\[\[record:([a-z_]+):([a-z]+_\d+):((?:(?!\]\])[^\n])+)\]\]/g;

/** entity → table + SQL expression yielding its display name. Used by the
 * caller to batch-resolve ids against the CRM. */
export const ENTITY_NAME_SQL: Readonly<Record<string, { table: string; expr: string }>> = {
  contacts: { table: 'contacts', expr: "COALESCE(NULLIF(name, ''), first_name || ' ' || last_name)" },
  companies: { table: 'companies', expr: 'name' },
  leads: { table: 'leads', expr: 'name' },
  opportunities: { table: 'opportunities', expr: 'name' },
  users: { table: 'users', expr: 'name' },
  support_tickets: { table: 'support_tickets', expr: 'subject' },
  invoices: { table: 'invoices', expr: 'number' },
};

export function entityForId(id: string): string | undefined {
  for (const { prefix, entity } of ID_ENTITY) {
    if (id.startsWith(`${prefix}_`)) return entity;
  }
  return undefined;
}

/** A display name that looks like a raw id (equal to the id, or itself an
 * id-shaped token) is "weak" — worth replacing with the real name. */
function isWeakName(name: string, id: string): boolean {
  const n = name.trim();
  return n === id || /^[a-z][a-z_]*_\d+$/.test(n);
}

/**
 * Rewrite record ids in `text` to named chips using `lookup(id) -> name`.
 * `lookup` returns undefined for ids with no resolvable name (left untouched).
 */
export function resolveRecordNames(text: string, lookup: (id: string) => string | undefined): string {
  // 1. Fix existing tokens whose display name is unhelpful (id-as-name).
  const fixed = text.replace(TOKEN_RE, (m, entity: string, id: string, name: string) => {
    if (!isWeakName(name, id)) return m;
    const nm = lookup(id);
    return nm ? `[[record:${entity}:${id}:${nm}]]` : m;
  });

  // 2. Wrap bare ids that sit OUTSIDE any token with a resolved-name chip.
  const out: string[] = [];
  let last = 0;
  for (const m of fixed.matchAll(TOKEN_RE)) {
    out.push(wrapBareIds(fixed.slice(last, m.index), lookup));
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  out.push(wrapBareIds(fixed.slice(last), lookup));
  return out.join('');
}

function wrapBareIds(segment: string, lookup: (id: string) => string | undefined): string {
  return segment.replace(BARE_ID_RE, (id) => {
    const entity = entityForId(id);
    if (!entity) return id;
    const nm = lookup(id);
    return nm ? `[[record:${entity}:${id}:${nm}]]` : id;
  });
}

/** Collect the distinct record ids that appear in `text` (bare or in tokens) —
 * the set the caller batch-resolves against the CRM. */
export function collectRecordIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(BARE_ID_RE)) ids.add(m[0]);
  for (const m of text.matchAll(TOKEN_RE)) ids.add(m[2] as string);
  return [...ids];
}
