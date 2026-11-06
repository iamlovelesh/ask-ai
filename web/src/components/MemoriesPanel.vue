<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useMemoryStore, type MemoryItem, type MemoryCategory } from '../stores/memory.js';

const emit = defineEmits<{ 'toggle-nav': [] }>();
const store = useMemoryStore();

onMounted(() => {
  void store.fetchMemories();
  void store.fetchSettings();
});

const CATEGORY_ORDER: MemoryCategory[] = ['preference', 'goal', 'fact', 'context'];
const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  preference: 'Preferences',
  goal: 'Goals',
  fact: 'Facts',
  context: 'Context',
};

const groups = computed(() => {
  const byCat = new Map<MemoryCategory, MemoryItem[]>();
  for (const m of store.memories) {
    const bucket = byCat.get(m.category);
    if (bucket) bucket.push(m);
    else byCat.set(m.category, [m]);
  }
  return CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => ({ category: c, label: CATEGORY_LABEL[c], items: byCat.get(c) as MemoryItem[] }));
});

const total = computed(() => store.memories.length);

/** Where a memory came from, in plain language. */
function sourceLabel(m: MemoryItem): string {
  return m.source === 'extract' ? 'learned' : 'pinned';
}

function onToggleEnabled(e: Event): void {
  void store.setEnabled((e.target as HTMLInputElement).checked);
}

function onDelete(id: string): void {
  void store.deleteMemory(id);
}
</script>

<template>
  <div class="memories-view">
    <header class="transcript-head">
      <button class="nav-toggle" aria-label="Toggle sessions" @click="emit('toggle-nav')">☰</button>
      <div class="transcript-title">Memories</div>
      <label class="mem-switch" :title="store.enabled ? 'On — new facts are remembered and recalled' : 'Off — nothing is recalled or remembered'">
        <input type="checkbox" class="mem-switch-input" :checked="store.enabled" @change="onToggleEnabled" />
        <span class="mem-switch-track" aria-hidden="true"><span class="mem-switch-thumb"></span></span>
        <span class="mem-switch-text">{{ store.enabled ? 'On' : 'Off' }}</span>
      </label>
    </header>

    <div class="memories-body">
      <p class="mem-intro">
        Durable preferences, goals, and context the assistant has learned about you — recalled
        automatically in future chats.
      </p>

      <p v-if="store.error" class="mem-error">{{ store.error }}</p>
      <div v-else-if="total === 0" class="mem-empty">
        <div class="mem-empty-mark" aria-hidden="true">◇</div>
        <p class="mem-empty-title">Nothing remembered yet</p>
        <p class="mem-empty-sub">As you chat, lasting details are saved here and recalled next time.</p>
      </div>

      <section v-for="g in groups" :key="g.category" class="mem-group">
        <div class="mem-group-head">
          <h3 class="mem-group-title">{{ g.label }}</h3>
          <span class="mem-group-count">{{ g.items.length }}</span>
        </div>
        <ul class="mem-list">
          <li v-for="m in g.items" :key="m.id" class="mem-item">
            <div class="mem-item-main">
              <p class="mem-body">
                <span v-if="m.key" class="mem-key">{{ m.key }}</span>
                {{ m.body }}
              </p>
              <span class="mem-source">{{ sourceLabel(m) }}</span>
            </div>
            <button class="mem-delete" aria-label="Forget this" title="Forget this" @click="onDelete(m.id)">Forget</button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.memories-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--paper);
}

/* On/off switch — petrol track, matching the product's single accent. */
.mem-switch {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--slate);
  cursor: pointer;
  user-select: none;
}
.mem-switch-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.mem-switch-track {
  position: relative;
  width: 34px;
  height: 18px;
  border-radius: 999px;
  background: var(--hair-strong);
  transition: background var(--tick-ease);
}
.mem-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--raised);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform var(--tick-ease);
}
.mem-switch-input:checked + .mem-switch-track {
  background: var(--petrol);
}
.mem-switch-input:checked + .mem-switch-track .mem-switch-thumb {
  transform: translateX(16px);
}
.mem-switch-input:focus-visible + .mem-switch-track {
  outline: 2px solid var(--petrol);
  outline-offset: 2px;
}
.mem-switch-text {
  font-variant-numeric: tabular-nums;
  min-width: 1.6rem;
}

.memories-body {
  overflow-y: auto;
  padding: 1.5rem 1.5rem 3rem;
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
}
.mem-intro {
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--slate);
  margin: 0 0 1.75rem;
}
.mem-error {
  color: var(--red);
  font-size: 0.9rem;
  padding: 0.75rem 0.9rem;
  background: var(--red-wash);
  border-radius: 10px;
}

/* Empty state */
.mem-empty {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--slate);
}
.mem-empty-mark {
  font-size: 2rem;
  color: var(--petrol);
  opacity: 0.5;
  margin-bottom: 0.5rem;
}
.mem-empty-title {
  font-weight: 600;
  color: var(--ink);
  margin: 0 0 0.25rem;
}
.mem-empty-sub {
  font-size: 0.85rem;
  margin: 0;
}

/* Groups */
.mem-group {
  margin-bottom: 1.75rem;
}
.mem-group-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.6rem;
}
.mem-group-title {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--slate);
  margin: 0;
}
.mem-group-count {
  font-family: var(--mono);
  font-size: 0.68rem;
  color: var(--slate-soft);
  background: var(--sunken);
  border-radius: 999px;
  padding: 0.05rem 0.45rem;
}

/* Memory cards */
.mem-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.mem-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.85rem;
  background: var(--raised);
  border: 1px solid var(--hair);
  border-radius: 10px;
  transition: border-color var(--tick-ease);
}
.mem-item:hover {
  border-color: var(--hair-strong);
}
.mem-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}
.mem-body {
  flex: 1;
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--ink);
  margin: 0;
}
.mem-key {
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--petrol-ink);
  background: var(--petrol-wash);
  border-radius: 5px;
  padding: 0.05rem 0.35rem;
  margin-right: 0.4rem;
}
.mem-source {
  flex: 0 0 auto;
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--slate-soft);
}
.mem-delete {
  flex: 0 0 auto;
  background: none;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 0.25rem 0.6rem;
  font-size: 0.78rem;
  color: var(--slate-soft);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--tick-ease), color var(--tick-ease), border-color var(--tick-ease);
}
.mem-item:hover .mem-delete,
.mem-delete:focus-visible {
  opacity: 1;
}
.mem-delete:hover {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 40%, transparent);
}
</style>
