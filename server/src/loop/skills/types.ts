/**
 * Skills = loaded-on-demand task playbooks (second agent layer, per
 * docs/research/2026-11-07-oss-crm-output-and-skills.md §4/§7).
 *
 * SKILLS are KNOWLEDGE (how to do a multi-step task); TOOLS/actions are
 * CAPABILITY (what can be done). The model sees every skill's name +
 * description always (catalog section), and pulls a skill's full content on
 * demand via session__load_skills — exactly the catalog-in-prompt pattern we
 * already use for the 500-action tool catalog, so the prompt prefix stays
 * provider-cacheable.
 */
export interface Skill {
  /** kebab-case slug, the load key. */
  name: string;
  /** Short human label. */
  label: string;
  /** One line: WHEN to use this skill — the only thing in the always-on
   * catalog section, so the model can decide to load it. */
  description: string;
  /** The full playbook (markdown): Gather → Signals/Checks → Produce →
   * Rules, naming our specific catalog actions and ref-tools. Loaded on
   * demand, never in the always-on prompt. */
  content: string;
}
