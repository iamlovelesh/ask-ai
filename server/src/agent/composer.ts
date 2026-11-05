/**
 * Composer (LLD §5, brief interfaces list): turns a finished turn's
 * plan + step results into the final `answer.final` text. PURE TEMPLATES —
 * no LLM call, ever. Every number/name in the rendered text is read
 * straight out of `stepStates` (grounded — no invention).
 *
 * GROUNDING CONTRACT (human-test triage RC2/RC7/RC9 — see
 * .superpowers/sdd/2026-11-04-ask-ai-implementation/humantest-TRIAGE.md):
 *   1. Numbers/claims only come from the step(s) that actually answer the
 *      user's question — see `leafStepIds` below. A plan's INTERMEDIATE
 *      (non-leaf) read steps are plumbing; echoing their raw totals instead
 *      of the terminal filter/compute step's result is exactly how "192
 *      deals this month and 192 last month" got fabricated (sales F9: both
 *      filter steps actually returned 0, but the unfiltered upstream total
 *      leaked through instead). A leaf step with 0 results renders "I
 *      didn't find any …" — it never falls back to an ancestor's count.
 *   2. When the answering data is already in the step result, this module
 *      surfaces it — top rows with names/amounts/dates, an actual message
 *      body, a sum computed from plucked numbers — instead of narrating
 *      "I retrieved N records" (marketing F1, billing F2, support F8).
 *      Null-pluck results (every item null — usually a wrong field name
 *      upstream) render an honest "I couldn't compute that", never a vague
 *      non-answer like "...is computed." (billing F1).
 *   3. Write confirmations are built ONLY from `ComposeStepState.result`
 *      (the actual written values) — this module never reads
 *      `Step.params` for display purposes (only for the narrow "what was
 *      this filtered against" disclosure on a zero-result leaf), so an
 *      invented/incorrect planner-intended value can never leak into a
 *      "done" sentence the way the coupon's intended-vs-actual expiry date
 *      did (marketing F4).
 *   4. No internal vocabulary ever reaches `answer.final`: no step ids, no
 *      validator repair codes (REF_GRAMMAR, UNKNOWN_SLUG, …), no ref syntax
 *      ($s1, $r_t3_s2, $item[0]), no tool slugs (`leads.assign_lead_owner`
 *      is rendered "assign lead owner"), no "candidate actions"/"working
 *      state" developer language. `reason` strings handed in from
 *      `pipeline.ts` are pattern-classified (`classifyFailureReason`,
 *      `looksInternal`) rather than ever echoed verbatim when they carry
 *      any of that — see the section below for why a wholesale swap (not a
 *      surgical edit) is the only reliable move against arbitrary planner
 *      monologue (support F3, marketing F3/F10/F11).
 *   5. Never self-contradicts: `composeFailedOrHalted` checks whether every
 *      recorded step actually succeeded before it will use failure framing
 *      — a turn that aborted on the wall-clock deadline AFTER its one step
 *      wrote successfully is reported as a success, not as "canceled
 *      partway through... completed successfully" in the same sentence
 *      (support F6).
 */

import type { Plan, Step } from './plan-schema.js';

export type ComposeOutcome = 'done' | 'cancelled' | 'failed' | 'halted' | 'clarify' | 'refused';

export type StepLifecycle = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface ComposeStepState {
  state: StepLifecycle;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ComposeInput {
  outcome: ComposeOutcome;
  plan?: Plan;
  stepStates?: Record<string, ComposeStepState>;
  /** Verbatim for `'clarify'`. */
  question?: string;
  /** Verbatim-ish for `'cancelled'`/`'failed'`/`'halted'`/`'refused'`. Any
   * "nearest capability" hint for `'refused'` is expected to already be
   * folded into this string by the caller (composer has no registry
   * access to compute one itself). NOT echoed verbatim when it carries
   * internal vocabulary or reads as the system failing to understand the
   * user — see `classifyFailureReason`/`looksInternal`/`isGibberishReason`. */
  reason?: string;
}

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isCoreSlug(action: string): boolean {
  return action.startsWith('core.');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

// --- plan-shape helpers: which steps actually answer the question ----------

/** A plan step is a "leaf" when no other step consumes its output (neither
 * via `dependsOn` nor as a `forEach` source). Leaves are exactly the steps
 * whose result is worth reporting to the user: an intermediate read whose
 * only job was to feed a later filter/write is plumbing, and echoing ITS
 * raw count instead of the terminal step's is the root cause of sales F9's
 * fabricated "192/192" comparison (both real filter steps returned 0; the
 * unfiltered upstream total was the only thing left standing if plumbing
 * steps are reported too). */
function leafStepIds(plan: Plan): Set<string> {
  const consumed = new Set<string>();
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) consumed.add(dep);
    if (step.forEach !== undefined) {
      const m = /^\$([a-zA-Z0-9_]+)/.exec(step.forEach);
      if (m?.[1] !== undefined) consumed.add(m[1]);
    }
  }
  return new Set(plan.steps.map((s) => s.id).filter((id) => !consumed.has(id)));
}

/** `module.verb_object_phrase` → `{verb: 'verb', objectPhrase: 'object phrase'}`.
 * Used for write-step sentences ("Created …", "Cancelled …") and for the
 * read/write split (`READ_VERBS`). */
function humanizeSlugVerb(action: string): { verb: string; objectPhrase: string } {
  const dot = action.indexOf('.');
  const rest = dot >= 0 ? action.slice(dot + 1) : action;
  const tokens = rest.split('_').filter((t) => t.length > 0);
  const verb = tokens[0] ?? rest;
  const objectPhrase = tokens.slice(1).join(' ');
  return { verb, objectPhrase };
}

/** Plain-English phrase for a step action, with NO dotted tool slug or
 * module prefix — used for failure/cancelled/pending lines, where we still
 * need to name which step but must not leak `catalog.module.verb_noun`
 * jargon into user-visible text (RC7). */
function humanizeActionPhrase(action: string): string {
  const dot = action.indexOf('.');
  const rest = dot >= 0 ? action.slice(dot + 1) : action;
  return rest.replace(/_/g, ' ');
}

/** Verbs that denote a read/inspection, never a mutation — same source as
 * `PAST_TENSE`'s header comment (grepped across the full catalog's action
 * slugs), plus a few generic synonyms no current action happens to use. A
 * step whose verb ISN'T here is rendered as a write (`describeWriteLeaf`);
 * the risk of a false negative here is cosmetic phrasing, never a
 * fabricated fact, since both renderers only ever read `result`. */
const READ_VERBS = new Set([
  'get',
  'search',
  'list',
  'view',
  'check',
  'preview',
  'find',
  'fetch',
  'count',
  'show',
  'test',
]);

/** Plural noun for a step's module, for phrases like "I found 3 invoices."
 * `core.*` ops have no natural noun (the module is internal plumbing
 * terminology, "core") — callers fall back to "matching records". */
function moduleNoun(action: string): string | undefined {
  const module = action.split('.')[0];
  if (module === undefined || module === 'core') return undefined;
  return module.replace(/_/g, ' ');
}

/** Purely algorithmic (no module-name lookup table): standard English
 * plural→singular suffix rules. Verified against every noun this module
 * can actually produce (every catalog module prefix, humanized) — e.g.
 * "opportunities"→"opportunity", "support tickets"→"support ticket",
 * "invoices"→"invoice" — but the rule itself is generic and will singularize
 * a module we never tested the same way, since it never inspects WHICH
 * noun it's given. */
function singularize(noun: string): string {
  if (noun.endsWith('ies')) return `${noun.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(noun)) return noun.slice(0, -2);
  if (noun.endsWith('s')) return noun.slice(0, -1);
  return noun;
}

/** Past-tense forms for every verb that currently prefixes a catalog
 * action slug (`grep -rhoE "slug: '[a-z_]+\.[a-z_]+'" src/catalog/*.ts`,
 * run against the FULL catalog, not any one module/finding) plus a few
 * generic English write-verbs that don't happen to be used yet — kept
 * because they cost nothing and make the map forward-compatible with a
 * new module using one of them. Any verb not listed (including one on a
 * module added after this map was written) still gets a readable, if
 * imperfect, `${verb}d` fallback — never an error, never an invented
 * fact. */
const PAST_TENSE: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  add: 'Added',
  assign: 'Assigned',
  publish: 'Published',
  unpublish: 'Unpublished',
  remove: 'Removed',
  archive: 'Archived',
  cancel: 'Cancelled',
  rename: 'Renamed',
  record: 'Recorded',
  mark: 'Marked',
  send: 'Sent',
  reorder: 'Reordered',
  link: 'Linked',
  unlink: 'Unlinked',
  delete: 'Deleted',
  validate: 'Validated',
  submit: 'Submitted',
  revoke: 'Revoked',
  resume: 'Resumed',
  reopen: 'Reopened',
  pause: 'Paused',
  move: 'Moved',
  merge: 'Merged',
  draft: 'Drafted',
  deactivate: 'Deactivated',
  activate: 'Activated',
  attach: 'Attached',
  apply: 'Applied',
  reply: 'Replied',
  receive: 'Received',
  pin: 'Pinned',
  unpin: 'Unpinned',
  issue: 'Issued',
  generate: 'Generated',
  export: 'Exported',
  duplicate: 'Duplicated',
  convert: 'Converted',
  close: 'Closed',
  void: 'Voided',
  upload: 'Uploaded',
  suspend: 'Suspended',
  summarize: 'Summarized',
  run: 'Ran',
  retire: 'Retired',
  restrict: 'Restricted',
  restore: 'Restored',
  set: 'Set',
  launch: 'Launched',
  schedule: 'Scheduled',
  reassign: 'Reassigned',
  tag: 'Tagged',
  remind: 'Reminded',
  notify: 'Notified',
  approve: 'Approved',
  reject: 'Rejected',
  complete: 'Completed',
  start: 'Started',
  stop: 'Stopped',
  resolve: 'Resolved',
  log: 'Logged',
};
function pastTense(verb: string): string {
  const known = PAST_TENSE[verb];
  if (known !== undefined) return known;
  return `${capitalize(verb)}d`;
}

// --- result normalization ---------------------------------------------------

type Norm =
  | { kind: 'empty' }
  | { kind: 'rows'; rows: Row[]; total: number }
  | { kind: 'record'; row: Row }
  | { kind: 'scalarList'; values: unknown[] }
  | { kind: 'number'; value: number }
  | { kind: 'opaque' };

/** Normalizes the heterogeneous result shapes `executor.ts`/`core-ops.ts`
 * produce (`{items,total}`, bare arrays, `{__spill:true,total,sample}`,
 * single records, plucked scalar arrays) into one of a few renderable
 * kinds. Nothing here invents a value — it only reshapes what is already
 * in `result`. */
function normalize(result: unknown): Norm {
  if (result === undefined || result === null) return { kind: 'empty' };
  if (typeof result === 'number') return { kind: 'number', value: result };
  if (Array.isArray(result)) {
    if (result.length === 0) return { kind: 'empty' };
    if (result.every(isRow)) return { kind: 'rows', rows: result as Row[], total: result.length };
    return { kind: 'scalarList', values: result };
  }
  if (isRow(result)) {
    const o = result;
    if (o['__spill'] === true && Array.isArray(o['sample']) && typeof o['total'] === 'number') {
      const sample = o['sample'] as unknown[];
      if (sample.length === 0) return { kind: 'empty' };
      if (sample.every(isRow)) return { kind: 'rows', rows: sample as Row[], total: o['total'] as number };
      return { kind: 'scalarList', values: sample };
    }
    if (Array.isArray(o['items'])) {
      const items = o['items'] as unknown[];
      if (items.length === 0) return { kind: 'empty' };
      const total = typeof o['total'] === 'number' ? (o['total'] as number) : items.length;
      if (items.every(isRow)) return { kind: 'rows', rows: items as Row[], total };
      return { kind: 'scalarList', values: items };
    }
    return { kind: 'record', row: o };
  }
  return { kind: 'opaque' };
}

// --- field pickers (read FROM results only — never from plan params) -------
//
// Every picker below keys off a NAMING CONVENTION verified across the
// FULL catalog schema (every `m*.ts`/`core-ops.ts` output type), not off
// the 4 human-test personas' specific field names — e.g. `_cents` is
// confirmed to be the ONLY monetary-value convention anywhere in the
// catalog (grep for `_cents$` across `src/catalog/*.ts`: every money field
// in every money-handling module uses it; plain `amount`/`total`/`value`
// fields that are NOT `_cents`-suffixed are genuinely non-monetary counts
// elsewhere in the catalog — e.g. `total_messages`, `discount_value` — so
// treating them as dollars would be WRONG, not just untested). Likewise
// `_at`/`_date`/`_until`/`_from` suffixes cover every timestamp field this
// catalog has (40+ distinct fields across every module). A module added
// after this file was written that follows the SAME conventions is picked
// up automatically; one that doesn't just renders without that particular
// extra (never a fabricated value — these pickers only ever return
// `undefined` on a miss).

function pickName(row: Row): string | undefined {
  for (const f of ['name', 'title', 'subject', 'label', 'summary', 'headline']) {
    const v = row[f];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

const CENTS_SUFFIX_RE = /_cents$/;

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The first `*_cents` key present on the row (catalog-wide money
 * convention — see this section's header), divided down to dollars. Order
 * among MULTIPLE `_cents` fields on the same row (e.g. `total_cents` AND
 * `amount_paid_cents`) is whatever order the result object's keys happen
 * to be in — composer has no business-logic basis to prefer one over the
 * other without a catalog-specific hint, which this file deliberately
 * does not hardcode. */
function pickAmount(row: Row): string | undefined {
  for (const key of Object.keys(row)) {
    if (!CENTS_SUFFIX_RE.test(key)) continue;
    const v = row[key];
    if (typeof v === 'number') return formatCents(v);
  }
  return undefined;
}

const DATE_SUFFIX_RE = /_(at|date|until|from)$/;

function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The first field whose KEY follows the catalog's timestamp-suffix
 * convention (`_at`/`_date`/`_until`/`_from`) AND whose VALUE actually
 * parses as a timestamp (epoch-ms number or ISO-8601 string) — same
 * "convention, not a specific list" reasoning as `pickAmount`. */
function pickDisplayDate(row: Row): string | undefined {
  for (const key of Object.keys(row)) {
    if (!DATE_SUFFIX_RE.test(key)) continue;
    const ms = parseTimestamp(row[key]);
    if (ms !== undefined) return formatDate(ms);
  }
  return undefined;
}

function pickBody(row: Row): string | undefined {
  for (const f of ['body', 'text', 'content', 'note']) {
    const v = row[f];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

function rowSummary(row: Row): string | undefined {
  const parts = [pickName(row), pickAmount(row), pickDisplayDate(row)].filter(
    (p): p is string => p !== undefined,
  );
  return parts.length > 0 ? parts.join(', ') : undefined;
}

// --- "what did we last tell them" (support F8's CLASS of bug: a result
// already contains a timestamped free-text body, so quote it instead of
// narrating container counts) — detection is structural (body field +
// date-suffixed field present on the SAME row), not keyed to any
// email/SMS-specific vocabulary, so it applies to any module whose rows
// happen to look like a message (a note, a comment, a logged call, …). ---

function rowsOf(result: unknown): Row[] {
  const norm = normalize(result);
  return norm.kind === 'rows' ? norm.rows : [];
}

/** A row's timestamp for recency-ranking, reusing the same date-suffix
 * convention `pickDisplayDate` does — kept separate only because this one
 * returns the raw `ms` (for comparison), not the formatted string. */
function pickTimestampMs(row: Row): number | undefined {
  for (const key of Object.keys(row)) {
    if (!DATE_SUFFIX_RE.test(key)) continue;
    const ms = parseTimestamp(row[key]);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

function hasMessageShapedRows(result: unknown): boolean {
  return rowsOf(result).some((row) => pickBody(row) !== undefined && pickTimestampMs(row) !== undefined);
}

function mostRecentMessage(results: readonly unknown[]): { body: string; when: string } | undefined {
  let best: { ts: number; body: string; when: string } | undefined;
  for (const result of results) {
    for (const row of rowsOf(result)) {
      const body = pickBody(row);
      const ts = pickTimestampMs(row);
      if (body === undefined || ts === undefined) continue;
      if (best === undefined || ts > best.ts) best = { ts, body, when: formatDate(ts) };
    }
  }
  return best === undefined ? undefined : { body: best.body, when: best.when };
}

// --- read-leaf rendering -----------------------------------------------------

/** For a zero-result `core.filter`/`core.exclude_by` leaf, disclose the
 * literal (non-ref) value it filtered against — composer has no catalog
 * access to say WHICH business field was wrong (that's RC3, validator
 * territory), but it can at least distinguish "no results for X" from
 * "no results for Y" instead of two identical, uninformative sentences. */
function filterCriterionSuffix(step: Step): string {
  if (!isCoreSlug(step.action)) return '';
  const value = (step.params as Record<string, unknown>)['value'];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return ` matching "${String(value)}"`;
  }
  return '';
}

/** Renders a `core.pluck`-shaped result (a flat array of scalars, one per
 * input row). Null-pluck (every value missing — almost always a field
 * name that doesn't exist on the producing step's rows) is an honest
 * "couldn't compute", never a vague filler sentence (billing F1's CLASS
 * of bug). When the plucked values ARE numbers, this sums them — the sum
 * is arithmetic on values already present in the step result, not an
 * invented figure. Whether to format that sum as money is decided by the
 * SAME structural `_cents` suffix convention `pickAmount` uses on the
 * literal `field` name the plan told `core.pluck` to extract — not a
 * guess from the field's English spelling (a non-`_cents` numeric field
 * is frequently a plain count elsewhere in this catalog, and formatting
 * it as dollars would be wrong, not just untested). */
function describeScalarList(step: Step, values: readonly unknown[]): string {
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  if (nonNull.length === 0) {
    return "I couldn't compute that — the field wasn't available on those records.";
  }
  if (nonNull.every((v) => typeof v === 'number')) {
    const sum = (nonNull as number[]).reduce((a, b) => a + b, 0);
    const field = typeof (step.params as Record<string, unknown>)['field'] === 'string'
      ? ((step.params as Record<string, unknown>)['field'] as string)
      : '';
    const isMoney = CENTS_SUFFIX_RE.test(field);
    const formatted = isMoney ? formatCents(sum) : String(sum);
    const partial =
      nonNull.length < values.length
        ? ` (based on ${nonNull.length} of ${values.length} — the rest didn't have that figure)`
        : '';
    return isMoney ? `That comes to ${formatted}${partial}.` : `That adds up to ${formatted}${partial}.`;
  }
  const shown = nonNull.slice(0, 5).map((v) => String(v));
  return `I found ${nonNull.length} value(s): ${shown.join(', ')}${nonNull.length > 5 ? ', …' : ''}.`;
}

function describeRows(step: Step, rows: readonly Row[], total: number, noun: string | undefined): string {
  const described = rows.map(rowSummary).filter((s): s is string => s !== undefined);
  const label = noun !== undefined ? (total === 1 ? singularize(noun) : noun) : total === 1 ? 'matching record' : 'matching records';
  let sentence = `I found ${total} ${label}`;
  const shown = described.slice(0, 3);
  if (shown.length > 0) sentence += `: ${shown.join('; ')}`;
  if (rows.length < total) sentence += ` (showing the first ${rows.length} of ${total})`;
  else if (described.length > shown.length) sentence += ` (showing ${shown.length} of ${total})`;
  return `${sentence}.`;
}

function describeSingleRecord(row: Row, noun: string | undefined): string {
  const body = pickBody(row);
  const name = pickName(row);
  if (body !== undefined) return `Here's what I found: "${body}"${name !== undefined ? ` (${name})` : ''}.`;
  const amount = pickAmount(row);
  const date = pickDisplayDate(row);
  const parts = [name, amount, date].filter((p): p is string => p !== undefined);
  if (parts.length > 0) return `Here's what I found: ${parts.join(', ')}.`;
  return `I found ${noun ?? 'a record'}, but there wasn't much detail to show.`;
}

function describeReadLeaf(step: Step, result: unknown): string {
  const norm = normalize(result);
  const noun = moduleNoun(step.action);
  switch (norm.kind) {
    case 'empty': {
      const label = noun ?? 'anything matching that';
      return `I didn't find any ${label}${filterCriterionSuffix(step)}.`;
    }
    case 'number':
      return `That comes to ${norm.value}.`;
    case 'scalarList':
      return describeScalarList(step, norm.values);
    case 'rows':
      return describeRows(step, norm.rows, norm.total, noun);
    case 'record':
      return describeSingleRecord(norm.row, noun);
    case 'opaque':
      return `${capitalize(noun ?? 'that')} came back, but I couldn't read the details.`;
  }
}

// --- write-leaf rendering (echoes ACTUAL result values, never plan params) --

function describeWriteLeaf(step: Step, result: unknown): string {
  const { verb, objectPhrase } = humanizeSlugVerb(step.action);
  const past = pastTense(verb);
  const subjectFallback = objectPhrase.length > 0 ? objectPhrase : 'that';
  const norm = normalize(result);
  switch (norm.kind) {
    case 'rows': {
      if (norm.rows.length === 1) {
        const name = pickName(norm.rows[0]!);
        if (name !== undefined) return `${past} ${name}.`;
      }
      const noun = objectPhrase.length > 0 ? objectPhrase : 'record';
      return `${past} ${norm.total} ${noun}${norm.total === 1 ? '' : 's'}.`;
    }
    case 'record': {
      const name = pickName(norm.row);
      const amount = pickAmount(norm.row);
      const date = pickDisplayDate(norm.row);
      const status = typeof norm.row['status'] === 'string' ? (norm.row['status'] as string) : undefined;
      const extras = [amount, date, status !== undefined ? `now ${status}` : undefined].filter(
        (p): p is string => p !== undefined,
      );
      const subject = name ?? subjectFallback;
      return extras.length > 0 ? `${past} ${subject} (${extras.join(', ')}).` : `${past} ${subject}.`;
    }
    case 'number':
      return `${past} ${subjectFallback} (${norm.value}).`;
    case 'empty':
      return `${past} ${subjectFallback}, but there's nothing further to show for it.`;
    case 'scalarList':
    case 'opaque':
      return `${past} ${subjectFallback}.`;
  }
}

function describeLeaf(step: Step, result: unknown): string {
  if (isCoreSlug(step.action)) return describeReadLeaf(step, result);
  const { verb } = humanizeSlugVerb(step.action);
  return READ_VERBS.has(verb) ? describeReadLeaf(step, result) : describeWriteLeaf(step, result);
}

// --- grouping: which lines get rendered at all ------------------------------

interface Classified {
  doneLines: string[];
  failedLines: string[];
  cancelledNames: string[];
  pendingNames: string[];
}

const EMPTY_CLASSIFIED: Classified = { doneLines: [], failedLines: [], cancelledNames: [], pendingNames: [] };

function renderDoneReportables(reportables: readonly { step: Step; result: unknown }[]): string[] {
  const messageResults: unknown[] = [];
  const otherLeaves: { step: Step; result: unknown }[] = [];
  for (const r of reportables) {
    if (hasMessageShapedRows(r.result)) messageResults.push(r.result);
    else otherLeaves.push(r);
  }
  const lines: string[] = [];
  if (messageResults.length > 0) {
    const best = mostRecentMessage(messageResults);
    if (best !== undefined) lines.push(`Last message (${best.when}): "${best.body}"`);
  }
  for (const r of otherLeaves) lines.push(describeLeaf(r.step, r.result));
  return lines;
}

/** Buckets every step by its final `StepLifecycle`, in plan order. Only
 * LEAF `done` steps are reported (see `leafStepIds`'s header) — failures,
 * cancellations, and pending/skipped steps are always reported regardless
 * of leaf status, because those ARE the information the user needs about
 * what went wrong or didn't run, even when they happened on an
 * intermediate step. */
function classify(plan: Plan | undefined, stepStates: Record<string, ComposeStepState> | undefined): Classified {
  if (!plan || !stepStates) return EMPTY_CLASSIFIED;
  const leaves = leafStepIds(plan);
  const doneReportables: { step: Step; result: unknown }[] = [];
  const failedLines: string[] = [];
  const cancelledNames: string[] = [];
  const pendingNames: string[] = [];

  for (const step of plan.steps) {
    const rec = stepStates[step.id];
    if (!rec) continue;
    switch (rec.state) {
      case 'done':
        if (leaves.has(step.id)) doneReportables.push({ step, result: rec.result });
        break;
      case 'failed':
        failedLines.push(`${humanizeActionPhrase(step.action)} — ${rec.error?.message ?? 'unknown error'}`);
        break;
      case 'cancelled':
        cancelledNames.push(humanizeActionPhrase(step.action));
        break;
      case 'pending':
      case 'running':
      case 'skipped':
        pendingNames.push(humanizeActionPhrase(step.action));
        break;
      default:
        break;
    }
  }
  return { doneLines: renderDoneReportables(doneReportables), failedLines, cancelledNames, pendingNames };
}

function renderFailuresSection(failedLines: readonly string[]): string[] {
  if (failedLines.length === 0) return [];
  return ['', "A few things didn't go through:", ...failedLines.map((l) => `- ${l}`)];
}

// --- reason-string classification (RC7: never leak internal vocabulary) ----
//
// `pipeline.ts` hands composer a mix of its OWN deterministic templates
// ("Plan repair exhausted after N attempt(s): [s2] REF_GRAMMAR, …", budget
// timeout/call-budget strings, "A confirmation was denied.") and raw,
// unconstrained LLM-generated text (the 'unsupported' outcome's `reason`,
// which has been observed to be full planner monologue — ref-grammar
// explanations, "candidate actions", literal step ids). Composer cannot
// safely edit arbitrary freeform text piece-by-piece (there's no reliable
// way to strip jargon from a sentence without risking a broken or
// misleading remainder) — so ANY reason that trips `looksInternal` is
// discarded WHOLESALE and replaced with a clean, generic fallback, rather
// than attempting a surgical rewrite. The deterministic pipeline strings
// ARE classified into plain English (`classifyFailureReason`) because
// their shape is stable and known.

const ERROR_CODE_RE =
  /\b(REF_GRAMMAR|REF_PATH_MISMATCH|UNKNOWN_SLUG|UNKNOWN_PARAM|PARAM_SCHEMA|ID_NOT_RESOLVED|UNKNOWN_DEP|UNKNOWN_HANDLE|UNKNOWN_STEP_REF|DUPLICATE_STEP_ID|FOREACH_NOT_REF|ITEM_OUTSIDE_FOREACH|MISSING_DEPENDENCY)\b/;
const STEP_ID_RE = /\[s\d+\]/;
const REF_SYNTAX_RE = /\$r_t[\w-]+_s\d+|\$s\d+(\.[\w[\]*]+)?|\$item(\.[\w[\]*]+)?/;
const TOOL_SLUG_RE = /\b[a-z][a-z]*\.[a-z]+_[a-z_]+\b/;
const JARGON_PHRASE_RE =
  /candidate action|action set|working state|cross-turn handle|ref grammar|plan repair|array indexing|UUID-style|current candidate/i;

function looksInternal(text: string): boolean {
  return (
    ERROR_CODE_RE.test(text) ||
    STEP_ID_RE.test(text) ||
    REF_SYNTAX_RE.test(text) ||
    TOOL_SLUG_RE.test(text) ||
    JARGON_PHRASE_RE.test(text)
  );
}

/** Support F10: a narrow retrieval candidate set led the model to tell the
 * user it can ONLY do one unrelated thing, framed as "I can't understand
 * your request" — misleading (the product supports far more) and not a
 * helpful response to genuine gibberish. Replace with an honest, generic
 * "I didn't catch that" rather than a false capability claim. */
function isGibberishReason(text: string): boolean {
  return /can.?t understand (your|the)? ?request/i.test(text);
}

const GENERIC_REFUSAL_FALLBACK =
  "I'm not able to do that directly. Tell me more about what you're trying to accomplish and I'll see what I can do instead.";
const GIBBERISH_FALLBACK = "I didn't catch that — could you rephrase your request?";

interface ReasonClassification {
  message: string;
  suggestion: string;
}

/** Classifies `pipeline.ts`'s deterministic failure/abort reason strings
 * into plain English. Falls back to a generic-but-honest message for
 * anything unrecognized (including any jargon-flagged freeform text —
 * see this section's header). */
function classifyFailureReason(reason: string | undefined): ReasonClassification {
  if (reason === undefined) {
    return { message: 'something went wrong while I was working on that', suggestion: 'Try again, or rephrase the request.' };
  }
  if (looksInternal(reason)) {
    return { message: 'I had trouble turning that into a reliable set of steps', suggestion: 'Try rephrasing it more simply, or breaking it into smaller requests.' };
  }
  if (/wall-clock|deadline|exceeded its/i.test(reason)) {
    return { message: 'it hit a timeout before finishing', suggestion: 'Try again — it may go through faster this time.' };
  }
  if (/call budget exceeded/i.test(reason)) {
    return { message: "the request needed more steps than I'm allowed to take at once", suggestion: 'Try breaking it into smaller requests.' };
  }
  if (/failed repeatedly with the same error/i.test(reason)) {
    return { message: 'the same step kept failing the same way', suggestion: 'Try a different approach, or double-check the details you gave me.' };
  }
  if (/could not find a matching action|no matching action found/i.test(reason)) {
    return { message: "I couldn't find a way to do that with what's available", suggestion: 'Tell me more about what you want and I can look again.' };
  }
  return { message: 'something went wrong while I was working on that', suggestion: 'Try again, or rephrase the request.' };
}

// --- per-outcome renderers ---------------------------------------------------

function composeDone(input: ComposeInput): string {
  const { doneLines, failedLines, pendingNames } = classify(input.plan, input.stepStates);
  if (doneLines.length === 0 && failedLines.length === 0 && pendingNames.length === 0) {
    return "Done — there's nothing further to report.";
  }
  const lines: string[] = [...doneLines];
  lines.push(...renderFailuresSection(failedLines));
  if (pendingNames.length > 0) lines.push('', `I didn't get to: ${pendingNames.join(', ')}.`);
  return lines.join('\n').trim();
}

function composeCancelled(input: ComposeInput): string {
  const { doneLines, failedLines } = classify(input.plan, input.stepStates);
  // Grounding contract #5 (never self-contradict) + the calm "rejected
  // confirmation" tone the triage calls for: lead with the plain fact that
  // nothing was changed by the gated action, then — separately — report
  // anything that genuinely happened (reads) or genuinely went wrong
  // (failures) elsewhere in the same turn, without re-litigating the
  // cancellation itself.
  const lines: string[] = ["Okay — I didn't make any changes."];
  if (doneLines.length > 0) {
    lines.push('', 'Before that, I did:');
    for (const l of doneLines) lines.push(`- ${l}`);
  }
  lines.push(...renderFailuresSection(failedLines));
  return lines.join('\n').trim();
}

function composeFailedOrHalted(input: ComposeInput): string {
  const { doneLines, failedLines, pendingNames } = classify(input.plan, input.stepStates);

  // Grounding contract #5: if nothing actually failed (no `failed` steps
  // recorded) and something did complete, this is NOT a failure from the
  // user's point of view — most commonly a turn that hit its wall-clock
  // deadline right after a single step's write already landed (support
  // F6). Reporting it as "failed partway through... completed
  // successfully" is a direct self-contradiction; report the real
  // success instead.
  if (failedLines.length === 0 && doneLines.length > 0) {
    const lines = [...doneLines];
    if (pendingNames.length > 0) lines.push('', `I didn't get to: ${pendingNames.join(', ')}.`);
    return lines.join('\n').trim();
  }

  const { message, suggestion } = classifyFailureReason(input.reason);
  const lines: string[] = [];
  if (doneLines.length > 0) {
    lines.push("Here's what went through before that:");
    for (const l of doneLines) lines.push(`- ${l}`);
    lines.push('');
  }
  lines.push(`I couldn't complete that — ${message}. ${suggestion}`);
  lines.push(...renderFailuresSection(failedLines));
  if (pendingNames.length > 0) lines.push('', `I didn't get to: ${pendingNames.join(', ')}.`);
  return lines.join('\n').trim();
}

function composeClarify(input: ComposeInput): string {
  // Verbatim — no added prefix/suffix (LLD: "exactly one focused question").
  // The CONTENT of the question (whether it's over-technical, asks for info
  // already in context, etc.) is a planner-prompt concern, not composer's —
  // composer has no registry/working-state access to second-guess it.
  return input.question ?? '';
}

function composeRefused(input: ComposeInput): string {
  const reason = input.reason;
  if (reason === undefined) return "I can't help with that.";
  if (isGibberishReason(reason)) return GIBBERISH_FALLBACK;
  if (looksInternal(reason)) return GENERIC_REFUSAL_FALLBACK;
  return reason;
}

// --- conversational reply polish (Feature C, flag-gated) --------------------
//
// OFF by default. When `COMPOSER_POLISH=1`, the pipeline makes ONE extra
// `FAST_MODEL` call that rewrites the template text (below) into a natural
// assistant reply under hard constraints — any failure/timeout/budget issue
// falls back to the template text silently. The compose step itself stays a
// pure template; polish is strictly a post-processing layer in the pipeline.

/** Operations-summary outcomes worth rewriting conversationally. Clarify
 * (a single focused question) and refused (a verbatim capability message)
 * are intentionally left exactly as composed. */
const POLISH_OUTCOMES: ReadonlySet<ComposeOutcome> = new Set(['done', 'cancelled', 'failed', 'halted']);

/** Whether the conversational-reply polish pass is enabled via env. Absent
 * or any value other than exactly `'1'` → disabled (the eval runner relies
 * on this default-off behavior). */
export function composerPolishEnabled(): boolean {
  return process.env['COMPOSER_POLISH'] === '1';
}

/** Whether a given composed outcome should be polished — the flag is on AND
 * the outcome is an operations summary (not clarify/refused). */
export function shouldPolish(outcome: ComposeOutcome): boolean {
  return composerPolishEnabled() && POLISH_OUTCOMES.has(outcome);
}

/** The hard-constrained system prompt for the polish call. Grounding is
 * enforced by instruction, not by the model's goodwill: the pipeline still
 * falls back to the template on any failure, and these rules forbid adding
 * or changing a single fact/number/name/status. */
export const POLISH_SYSTEM =
  'Rewrite the following operations summary as a brief, natural assistant reply. ' +
  'STRICT RULES: do not add, infer, or change ANY fact, number, name, or status; ' +
  'do not promise follow-ups; keep every number exactly; ' +
  '≤3 sentences unless listing failures. Output only the rewritten reply, nothing else.';

/** The polish call's user prompt — the template text, verbatim, as the input
 * to rewrite. */
export function polishPrompt(templateText: string): string {
  return templateText;
}

/**
 * Renders the final answer text for a finished turn (LLD §5 pipeline's
 * `compose` step). PURE: same `input` always renders the same string.
 */
export function compose(input: ComposeInput): string {
  switch (input.outcome) {
    case 'done':
      return composeDone(input);
    case 'cancelled':
      return composeCancelled(input);
    case 'failed':
    case 'halted':
      return composeFailedOrHalted(input);
    case 'clarify':
      return composeClarify(input);
    case 'refused':
      return composeRefused(input);
    default:
      return '';
  }
}
