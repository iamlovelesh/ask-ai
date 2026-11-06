/**
 * Tensed, narrated labels for a tool-loop step (getToolDisplayMessage
 * pattern): while a step runs we say "Searching leads…"; the UI narrates the
 * action rather than showing a static catalog slug. Pure view-layer.
 */

/** verb prefix → present-participle label. */
const VERBS: Record<string, string> = {
  search: 'Searching',
  list: 'Listing',
  find: 'Finding',
  get: 'Fetching',
  view: 'Fetching',
  read: 'Reading',
  create: 'Creating',
  add: 'Adding',
  update: 'Updating',
  set: 'Updating',
  change: 'Updating',
  edit: 'Editing',
  send: 'Sending',
  draft: 'Drafting',
  schedule: 'Scheduling',
  assign: 'Assigning',
  reassign: 'Reassigning',
  merge: 'Merging',
  archive: 'Archiving',
  delete: 'Deleting',
  remove: 'Removing',
  cancel: 'Cancelling',
  close: 'Closing',
  convert: 'Converting',
  move: 'Moving',
  apply: 'Applying',
  issue: 'Issuing',
  record: 'Recording',
  approve: 'Approving',
  publish: 'Publishing',
  mark: 'Updating',
  sort: 'Sorting',
  filter: 'Filtering',
  aggregate: 'Calculating',
  group: 'Grouping',
};

/** Humanize the object part of a slug: "lead_owner" → "lead owner". */
function humanizeNoun(parts: string[]): string {
  return parts.join(' ').replace(/_/g, ' ').trim();
}

/** The present-tense "working now" label for a running step — e.g.
 * `leads.search_leads` → "Searching leads…". Falls back to a readable form of
 * the slug when the verb is unknown. The data-tool slugs map to friendlier
 * phrasings. */
export function loadingLabel(action: string, fallbackName?: string): string {
  // data ref-tools: friendlier than their slug
  if (action === 'data.sort_ref' || action === 'data__sort_ref') return 'Ranking the results…';
  if (action === 'data.filter_ref' || action === 'data__filter_ref') return 'Filtering the results…';
  if (action === 'data.aggregate_ref' || action === 'data__aggregate_ref') return 'Calculating totals…';
  if (action === 'data.group_by_ref' || action === 'data__group_by_ref') return 'Grouping the results…';
  if (action.includes('search_actions')) return 'Looking for the right action…';
  if (action.includes('load_skills')) return 'Loading a playbook…';

  const slug = action.includes('.') ? action.slice(action.indexOf('.') + 1) : action;
  const segs = slug.split('_');
  const verb = segs[0] ?? '';
  const participle = VERBS[verb];
  if (participle) {
    const noun = humanizeNoun(segs.slice(1));
    return noun ? `${participle} ${noun}…` : `${participle}…`;
  }
  if (fallbackName) return `${fallbackName}…`;
  return `${humanizeNoun(segs) || slug}…`;
}
