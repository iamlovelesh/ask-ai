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
      <button class="memories-btn" @click="onOpenMemories">
        <svg class="memories-btn-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 2.5c-1.3-1-3.2-.8-4 .6-.7 1.2-.3 2.4.4 3.2-.9.5-1.5 1.5-1.2 2.7.3 1.4 1.7 2.1 3 1.9" />
          <path d="M8 2.5c1.3-1 3.2-.8 4 .6.7 1.2.3 2.4-.4 3.2.9.5 1.5 1.5 1.2 2.7-.3 1.4-1.7 2.1-3 1.9" />
          <path d="M8 2.5v11" />
        </svg>
        <span>Memories</span>
      </button>
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
