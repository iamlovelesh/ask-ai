import { describe, it, expect } from 'vitest';
import {
  SKILLS,
  listSkills,
  getSkill,
  loadSkills,
  buildSkillCatalogSection,
} from '../src/loop/skills/registry';

describe('skills registry', () => {
  it('ships the five seed CRM skills, each with the required shape', () => {
    const names = listSkills().map((s) => s.name).sort();
    expect(names).toEqual(
      ['crm-hygiene', 'lead-follow-up', 'meeting-prep', 'overdue-invoice-reminders', 'pipeline-review'],
    );
    for (const s of listSkills()) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.content.length).toBeGreaterThan(80); // a real playbook, not a stub
    }
  });

  it('getSkill resolves by name and returns undefined for unknown', () => {
    expect(getSkill('overdue-invoice-reminders')?.label).toBeTruthy();
    expect(getSkill('nope')).toBeUndefined();
  });

  it('loadSkills returns content for known names and skips unknown ones', () => {
    const loaded = loadSkills(['pipeline-review', 'does-not-exist']);
    expect(loaded.map((s) => s.name)).toEqual(['pipeline-review']);
    expect(loaded[0]?.content).toContain('data__group_by_ref'); // names our ref-tools
  });

  it('catalog section lists every skill name+description but NOT the full content', () => {
    const section = buildSkillCatalogSection();
    for (const s of Object.values(SKILLS)) {
      expect(section).toContain(s.name);
      expect(section).toContain(s.description);
    }
    // full playbook bodies must stay out of the always-on prompt (load on demand)
    expect(section).not.toContain(getSkill('crm-hygiene')!.content);
  });
});
