/**
 * Answer provenance — "How I got this". Turns a completed turn's tool steps
 * into a short, plain-language list of what the assistant actually did to reach
 * its answer (which data it read, what it computed). Built entirely from the
 * step events already in the store — deterministic, no model involvement — so
 * it reinforces the honesty rails: the user can see every source behind a figure.
 */

export interface ProvenanceRow {
  /** Plain-language action, e.g. "Calculated an exact total". */
  label: string;
  /** What that step returned, cleaned of internal ref tokens. */
  detail: string;
}

interface StepLike {
  action: string;
  status: string;
  summary?: string;
}
interface TurnLike {
  stepOrder: string[];
  steps: Record<string, StepLike | undefined>;
}

const ACTION_LABELS: Record<string, string> = {
  'data.aggregate_ref': 'Calculated an exact total/average',
  'data.group_by_ref': 'Grouped the records by category',
  'data.sort_ref': 'Ranked the records',
  'data.filter_ref': 'Filtered the records',
  'data.search_ref': 'Searched within the results',
  'data.related': 'Gathered related records',
  'data.batch': 'Wrote several records in one step',
  'data.apply_to_ref': 'Applied an action to every matching record',
  'web.search': 'Searched the web',
  'session.schedule_follow_up': 'Scheduled a reminder',
  'session.schedule_briefing': 'Scheduled a briefing',
};

/** Human-readable label for a step action (slug → prose). */
export function humanizeAction(action: string): string {
  const mapped = ACTION_LABELS[action];
  if (mapped !== undefined) return mapped;
  // e.g. "leads.search_leads" → "Search leads"; "contacts.create_contact" → "Create contact"
  const verb = action.includes('.') ? action.slice(action.indexOf('.') + 1) : action;
  const words = verb.replace(/_/g, ' ').trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}

/** Strip internal ref tokens ("[ref r_t1_s2]") the end user shouldn't see. */
function cleanDetail(summary: string): string {
  return summary
    .replace(/\[ref[^\]]*\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 160);
}

/** The ordered provenance rows for a turn — one per settled step. Empty when
 * the turn did no tool work (a pure conversational/recall answer). */
export function buildProvenance(turn: TurnLike): ProvenanceRow[] {
  return turn.stepOrder
    .map((id) => turn.steps[id])
    .filter((s): s is StepLike => s !== undefined && s.status !== 'pending' && s.status !== 'running')
    .map((s) => ({ label: humanizeAction(s.action), detail: cleanDetail(s.summary ?? '') }));
}
