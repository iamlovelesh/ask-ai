/**
 * Static skill registry (pattern
 * research). Keyed by slug like our action catalog, so the always-on prompt
 * section is deterministic and provider-cacheable. Skill BODIES load on
 * demand via session__load_skills; only name+description are always visible.
 */
import type { Skill } from './types.js';
import { leadFollowUp } from './definitions/lead-follow-up.js';
import { overdueInvoiceReminders } from './definitions/overdue-invoice-reminders.js';
import { pipelineReview } from './definitions/pipeline-review.js';
import { crmHygiene } from './definitions/crm-hygiene.js';
import { meetingPrep } from './definitions/meeting-prep.js';

const ALL: readonly Skill[] = [
  leadFollowUp,
  overdueInvoiceReminders,
  pipelineReview,
  crmHygiene,
  meetingPrep,
];

export const SKILLS: Readonly<Record<string, Skill>> = Object.freeze(
  Object.fromEntries(ALL.map((s) => [s.name, s])),
);

export function listSkills(): readonly Skill[] {
  return ALL;
}

export function getSkill(name: string): Skill | undefined {
  return SKILLS[name];
}

/** Resolve a list of requested names to their skills, skipping unknown ones
 * (the model sometimes asks for a near-miss name — skip, don't throw). */
export function loadSkills(names: readonly string[]): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const n of names) {
    const s = SKILLS[n];
    if (s && !seen.has(s.name)) {
      seen.add(s.name);
      out.push(s);
    }
  }
  return out;
}

/** The always-on `<available_skills>` catalog: one `- \`name\`: description`
 * line per skill, bodies omitted (loaded on demand). */
export function buildSkillCatalogSection(): string {
  return listSkills()
    .map((s) => `- \`${s.name}\`: ${s.description}`)
    .join('\n');
}
