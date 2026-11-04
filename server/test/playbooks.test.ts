import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaybooks, matchPlaybook } from '../src/playbooks/loader';
import { registry } from '../src/catalog/registry';

const tmpDirs: string[] = [];

function tmpPlaybookDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ask-ai-playbooks-'));
  tmpDirs.push(dir);
  return dir;
}

function writePlaybook(dir: string, filename: string, frontmatter: Record<string, string>, body: string): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(join(dir, filename), `---\n${fm}\n---\n\n${body}\n`, 'utf8');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadPlaybooks — the real production files', () => {
  it('load against the real registry with no startup throw, and carry real catalog slugs', () => {
    const playbooks = loadPlaybooks(registry);

    expect(playbooks.map((p) => p.name).sort()).toEqual(
      ['lead-follow-up-sweep', 'overdue-invoice-reminders', 'pipeline-review'].sort(),
    );
    expect(playbooks.map((p) => p.title).sort()).toEqual(
      ['Lead follow-up sweep', 'Overdue invoice reminders', 'Pipeline review'].sort(),
    );
    for (const pb of playbooks) {
      expect(pb.name).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(pb.description.length).toBeGreaterThan(0);
      expect(pb.description.length).toBeLessThanOrEqual(1024);
      expect(pb.actionSlugs.length).toBeGreaterThan(0);
      for (const slug of pb.actionSlugs) {
        expect(registry.get(slug)).toBeDefined();
      }
    }
  });
});

describe('loadPlaybooks — unknown slug fails boot', () => {
  it('throws synchronously when a playbook cites a slug the registry does not have', () => {
    const dir = tmpPlaybookDir();
    writePlaybook(
      dir,
      'bogus.skill.md',
      { name: 'bogus', title: 'Bogus playbook', description: 'A playbook that cites a made-up action.' },
      '1. Do a thing. — slug: not_a_real_module.not_a_real_action',
    );

    expect(() => loadPlaybooks(registry, dir)).toThrow(/unknown action slug/);
  });

  it('does not throw for a playbook whose only slugs are all real', () => {
    const dir = tmpPlaybookDir();
    writePlaybook(
      dir,
      'ok.skill.md',
      { name: 'ok', title: 'OK playbook', description: 'Searches leads then creates a task.' },
      '1. Search leads. — slug: leads.search_leads\n2. Create a task. — slug: tasks.create_task',
    );

    const playbooks = loadPlaybooks(registry, dir);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0]?.actionSlugs.sort()).toEqual(['leads.search_leads', 'tasks.create_task']);
  });

  it('throws when frontmatter is missing name/title/description', () => {
    const dir = tmpPlaybookDir();
    writeFileSync(join(dir, 'broken.skill.md'), '---\nname: broken\n---\n\nbody', 'utf8');
    expect(() => loadPlaybooks(registry, dir)).toThrow(/frontmatter must include/);
  });

  it('throws when "name" is not a lowercase-hyphen slug', () => {
    const dir = tmpPlaybookDir();
    writePlaybook(
      dir,
      'bad-name.skill.md',
      { name: 'Bad Name', title: 'Bad name', description: 'name has spaces/caps — not a valid slug.' },
      'no slugs here',
    );
    expect(() => loadPlaybooks(registry, dir)).toThrow(/lowercase-hyphen slug/);
  });

  it('throws when "name" does not match the filename stem', () => {
    const dir = tmpPlaybookDir();
    writePlaybook(
      dir,
      'mismatch.skill.md',
      { name: 'not-the-filename', title: 'Mismatch', description: 'name slug does not match the filename.' },
      'no slugs here',
    );
    expect(() => loadPlaybooks(registry, dir)).toThrow(/must match the filename stem/);
  });
});

describe('loadPlaybooks — empty directory fails fast', () => {
  it('throws when the directory has zero *.skill.md files', () => {
    const dir = tmpPlaybookDir();
    expect(() => loadPlaybooks(registry, dir)).toThrow(/no '\*\.skill\.md' files found/);
  });

  it('does not throw when {allowEmpty:true} is passed, and returns []', () => {
    const dir = tmpPlaybookDir();
    expect(loadPlaybooks(registry, dir, { allowEmpty: true })).toEqual([]);
  });
});

describe('matchPlaybook — lexical hit + miss', () => {
  it('hits the lead follow-up sweep playbook for an on-topic query', () => {
    const playbooks = loadPlaybooks(registry);
    const match = matchPlaybook('follow up with unreplied leads from last week', playbooks);
    expect(match?.name).toBe('lead-follow-up-sweep');
  });

  it('hits the overdue invoice reminders playbook for an on-topic query', () => {
    const playbooks = loadPlaybooks(registry);
    const match = matchPlaybook('send reminders for overdue invoices', playbooks);
    expect(match?.name).toBe('overdue-invoice-reminders');
  });

  it('misses (returns undefined) for a thoroughly unrelated query', () => {
    const playbooks = loadPlaybooks(registry);
    const match = matchPlaybook('what is the weather like today', playbooks);
    expect(match).toBeUndefined();
  });
});
