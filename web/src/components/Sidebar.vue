<script setup lang="ts">
import { computed } from 'vue';
import { useSessionStore } from '../stores/session.js';

const store = useSessionStore();

defineProps<{ activeId: string | null }>();
const emit = defineEmits<{ open: [id: string] }>();

/** Groups the flat session list by calendar date (derived from each
 * session's own `updated_at`, not compared against wall-clock "now" — the
 * server runs on a pinned `VirtualClock`, so "Today"/"Yesterday" labels
 * would be meaningless here). */
const groups = computed(() => {
  const byDate = new Map<string, typeof store.sessions>();
  for (const s of store.sessions) {
    const label = new Date(s.updated_at).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const bucket = byDate.get(label);
    if (bucket) bucket.push(s);
    else byDate.set(label, [s]);
  }
  return Array.from(byDate.entries());
});

async function onNewChat(): Promise<void> {
  await store.newSession();
}

function onOpen(id: string): void {
  emit('open', id);
}

function titleOf(title: string | null): string {
  return title && title.length > 0 ? title : '(untitled)';
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <button class="new-chat-btn" @click="onNewChat">+ New chat</button>
    </div>

    <div v-if="store.sessions.length === 0" class="sidebar-empty">No sessions yet.</div>

    <template v-for="[label, rows] in groups" :key="label">
      <div class="sidebar-group-label">{{ label }}</div>
      <button
        v-for="row in rows"
        :key="row.id"
        :class="['sidebar-item', { active: row.id === activeId }]"
        @click="onOpen(row.id)"
      >
        {{ titleOf(row.title) }}
      </button>
    </template>
  </aside>
</template>
