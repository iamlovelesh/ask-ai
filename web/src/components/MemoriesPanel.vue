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
      <label class="mem-switch" title="When off, nothing is recalled or remembered">
        <input type="checkbox" :checked="store.enabled" @change="onToggleEnabled" />
        <span>Memory {{ store.enabled ? 'on' : 'off' }}</span>
      </label>
    </header>

    <div class="memories-body">
      <p v-if="store.error" class="mem-error">{{ store.error }}</p>
      <p v-else-if="store.memories.length === 0" class="mem-empty">
        Nothing remembered yet. As you chat, durable preferences, goals, and context are saved here.
      </p>

      <section v-for="g in groups" :key="g.category" class="mem-group">
        <h3 class="mem-group-title">{{ g.label }}</h3>
        <ul class="mem-list">
          <li v-for="m in g.items" :key="m.id" class="mem-item">
            <span class="mem-body">
              <span v-if="m.key" class="mem-key">{{ m.key }}:</span>
              {{ m.body }}
            </span>
            <button class="mem-delete" aria-label="Forget this" @click="onDelete(m.id)">Forget</button>
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
}
.mem-switch {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  cursor: pointer;
  user-select: none;
}
.memories-body {
  overflow-y: auto;
  padding: 1.25rem 1.5rem 3rem;
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
}
.mem-empty,
.mem-error {
  color: var(--muted, #888);
  font-size: 0.95rem;
  padding: 2rem 0;
}
.mem-error {
  color: #c0392b;
}
.mem-group {
  margin-bottom: 1.75rem;
}
.mem-group-title {
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted, #999);
  margin: 0 0 0.5rem;
}
.mem-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.mem-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border, #e2e2e2);
  border-radius: 8px;
}
.mem-body {
  flex: 1;
  font-size: 0.92rem;
  line-height: 1.4;
}
.mem-key {
  font-weight: 600;
  margin-right: 0.25rem;
}
.mem-delete {
  flex: 0 0 auto;
  background: none;
  border: 1px solid var(--border, #e2e2e2);
  border-radius: 6px;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
  cursor: pointer;
  color: var(--muted, #888);
}
.mem-delete:hover {
  color: #c0392b;
  border-color: #c0392b;
}
</style>
