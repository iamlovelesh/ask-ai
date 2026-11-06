import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSessions } from '../src/store/sessions-db';
import { createMemoryStore } from '../src/memory/store';
import type { NewMemory } from '../src/memory/types';

// Each test gets its own throwaway sessions.db file so nothing touches the
// runtime DB. A monotonic injected clock makes ordering deterministic.
function tmpDbPath(): string {
  return join(tmpdir(), `sessions-memtest-${randomUUID()}.db`);
}

const created: string[] = [];
function freshStore(nowStart = 1000): ReturnType<typeof createMemoryStore> {
  const path = tmpDbPath();
  created.push(path);
  let t = nowStart;
  const db = openSessions(path);
  return createMemoryStore(db, () => (t += 1));
}

afterAll(() => {
  for (const p of created) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (existsSync(p + suffix)) rmSync(p + suffix, { force: true });
    }
  }
});

const profilePref: NewMemory = {
  userId: 'user_1',
  category: 'preference',
  kind: 'profile',
  key: 'date-format',
  body: 'prefers EU date format',
  source: 'tool',
};

describe('MemoryStore CRUD', () => {
  it('add then listLive returns the row with clock-set timestamps', () => {
    const store = freshStore();
    const m = store.add(profilePref);
    expect(m.id).toBeTruthy();
    expect(m.createdAt).toBeGreaterThan(1000);
    expect(m.updatedAt).toBe(m.createdAt);
    const live = store.listLive('user_1');
    expect(live).toHaveLength(1);
    expect(live[0]!.body).toBe('prefers EU date format');
    expect(live[0]!.kind).toBe('profile');
    expect(live[0]!.key).toBe('date-format');
  });

  it('listLive returns newest-first and excludes invalidated rows', () => {
    const store = freshStore();
    const a = store.add({ ...profilePref, kind: 'collection', key: undefined, body: 'first' });
    const b = store.add({ ...profilePref, kind: 'collection', key: undefined, body: 'second' });
    store.invalidate(a.id);
    const live = store.listLive('user_1');
    expect(live.map((m) => m.body)).toEqual(['second']);
    expect(live[0]!.id).toBe(b.id);
  });

  it('rejects a second live profile with the same (user, category, key)', () => {
    const store = freshStore();
    store.add(profilePref);
    expect(() => store.add(profilePref)).toThrow();
  });

  it('supersede invalidates the old row and inserts the new one without a UNIQUE violation', () => {
    const store = freshStore();
    const old = store.add(profilePref);
    const next = store.supersede(old.id, { ...profilePref, body: 'prefers ISO dates' });
    const oldRow = store.get(old.id);
    expect(oldRow!.invalidAt).toBeGreaterThan(0);
    expect(oldRow!.supersededBy).toBe(next.id);
    const live = store.listLive('user_1');
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(next.id);
    expect(live[0]!.body).toBe('prefers ISO dates');
  });

  it('invalidate hides from listLive but get still returns it', () => {
    const store = freshStore();
    const m = store.add(profilePref);
    store.invalidate(m.id);
    expect(store.listLive('user_1')).toHaveLength(0);
    expect(store.get(m.id)!.invalidAt).toBeGreaterThan(0);
  });

  it('remove hard-deletes the row', () => {
    const store = freshStore();
    const m = store.add(profilePref);
    store.remove(m.id);
    expect(store.get(m.id)).toBeUndefined();
  });

  it('update changes body/category, bumps updatedAt, and returns the new row', () => {
    const store = freshStore();
    const m = store.add(profilePref);
    const before = store.get(m.id)!.updatedAt;
    const updated = store.update(m.id, { body: 'likes DD/MM/YYYY', category: 'fact' });
    expect(updated!.body).toBe('likes DD/MM/YYYY');
    expect(updated!.category).toBe('fact');
    expect(updated!.updatedAt).toBeGreaterThan(before);
    expect(store.update('nope_0', { body: 'x' })).toBeUndefined();
  });

  it('isolates memories by user_id', () => {
    const store = freshStore();
    store.add(profilePref);
    store.add({ ...profilePref, userId: 'user_2', body: 'other user fact' });
    expect(store.listLive('user_1')).toHaveLength(1);
    expect(store.listLive('user_2')).toHaveLength(1);
    expect(store.listLive('user_1')[0]!.body).toBe('prefers EU date format');
  });
});

describe('MemoryStore settings', () => {
  it('isEnabled defaults true and setEnabled persists', () => {
    const store = freshStore();
    expect(store.isEnabled('user_1')).toBe(true);
    store.setEnabled('user_1', false);
    expect(store.isEnabled('user_1')).toBe(false);
    store.setEnabled('user_1', true);
    expect(store.isEnabled('user_1')).toBe(true);
  });

  it('isIncognito defaults false and setIncognito persists', () => {
    const store = freshStore();
    expect(store.isIncognito('s_1')).toBe(false);
    store.setIncognito('s_1', true);
    expect(store.isIncognito('s_1')).toBe(true);
  });
});

describe('MemoryStore durability', () => {
  it('survives close and reopen of the same file', () => {
    const path = tmpDbPath();
    created.push(path);
    let t = 5000;
    const db1 = openSessions(path);
    const store1 = createMemoryStore(db1, () => (t += 1));
    store1.add(profilePref);
    store1.setEnabled('user_1', false);
    db1.close();

    const db2 = openSessions(path);
    const store2 = createMemoryStore(db2, () => (t += 1));
    expect(store2.listLive('user_1')).toHaveLength(1);
    expect(store2.isEnabled('user_1')).toBe(false);
    db2.close();
  });
});
