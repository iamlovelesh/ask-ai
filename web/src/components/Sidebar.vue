<script setup lang="ts">
import { computed } from 'vue';
import { useSessionStore } from '../stores/session.js';
import { relativeTime } from '../lib/relative-time.js';

const store = useSessionStore();

defineProps<{ activeId: string | null }>();
const emit = defineEmits<{ open: [id: string]; 'new-chat': []; 'open-memories': [] }>();

/** Groups the already-newest-first session list (API orders by updated_at
 * DESC) into calendar-date buckets. `updated_at` is REAL wall-clock time
 * (session bookkeeping is wall-clock; only the agent's CRM reasoning runs
 * on the pinned VirtualClock), so dates and ordering reflect actual
 * activity. Map insertion order preserves newest-first across buckets. */
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

/** New chat is a navigation to `/` (the new-chat state) — the session is
 * not created until the first message is sent. */
function onNewChat(): void {
  emit('new-chat');
}

function onOpen(id: string): void {
  emit('open', id);
}

function onOpenMemories(): void {
  emit('open-memories');
}

function titleOf(title: string | null): string {
  return title && title.length > 0 ? title : 'Untitled session';
}

function timeOf(updatedAt: number): string {
  return relativeTime(updatedAt);
}

async function onShowOlder(): Promise<void> {
  await store.loadMoreSessions();
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-brand">
        <span class="sidebar-brand-mark">Ask AI</span>
      </div>
      <button class="new-chat-btn" @click="onNewChat">New chat</button>
      <button class="memories-btn" @click="onOpenMemories">Memories</button>
    </div>

    <div class="sidebar-list">
      <div v-if="store.sessions.length === 0" class="sidebar-empty">No sessions yet.</div>

      <template v-for="[label, rows] in groups" :key="label">
        <div class="sidebar-group-label">{{ label }}</div>
        <button
          v-for="row in rows"
          :key="row.id"
          :class="['sidebar-item', { active: row.id === activeId }]"
          @click="onOpen(row.id)"
        >
          <span class="sidebar-item-title">{{ titleOf(row.title) }}</span>
          <span class="sidebar-item-time">{{ timeOf(row.updated_at) }}</span>
        </button>
      </template>

      <button
        v-if="store.sessionsHasMore"
        class="sidebar-more"
        :disabled="store.sessionsLoadingMore"
        @click="onShowOlder"
      >
        {{ store.sessionsLoadingMore ? 'Loading…' : 'Show older' }}
      </button>
    </div>
  </aside>
</template>
