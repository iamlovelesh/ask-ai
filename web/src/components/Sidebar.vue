<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useSessionStore } from '../stores/session.js';
import SidebarItem from './SidebarItem.vue';

const store = useSessionStore();

defineProps<{ activeId: string | null }>();
const emit = defineEmits<{ open: [id: string]; 'new-chat': []; 'open-memories': []; delete: [id: string]; collapse: [] }>();

/** Local, immediately-responsive copy of the search box text. The store's
 * `searchQuery` only updates once a (debounced) request fires, so the UI keys
 * its "searching" mode off this input value instead — typing switches to the
 * results view without waiting for the debounce. */
const queryInput = ref('');
const searching = computed(() => queryInput.value.trim().length > 0);

const SEARCH_DEBOUNCE_MS = 200;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function onSearchInput(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  const q = queryInput.value;
  if (q.trim().length === 0) {
    store.clearSearch();
    return;
  }
  debounceTimer = setTimeout(() => void store.runSearch(q), SEARCH_DEBOUNCE_MS);
}

function clearSearch(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  queryInput.value = '';
  store.clearSearch();
}

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

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

function onDelete(id: string): void {
  emit('delete', id);
}

function onOpenMemories(): void {
  emit('open-memories');
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
        <button class="sidebar-collapse-btn" aria-label="Hide sidebar" title="Hide sidebar" @click="emit('collapse')">«</button>
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
      <div class="sidebar-search">
        <svg class="sidebar-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </svg>
        <input
          v-model="queryInput"
          class="sidebar-search-input"
          type="search"
          placeholder="Search chats…"
          aria-label="Search chats"
          @input="onSearchInput"
          @keydown.escape="clearSearch"
        />
        <button v-if="searching" class="sidebar-search-clear" aria-label="Clear search" @click="clearSearch">✕</button>
      </div>
    </div>

    <div class="sidebar-list">
      <!-- Search results view -->
      <template v-if="searching">
        <div class="sidebar-group-label">
          <template v-if="store.searchLoading">Searching…</template>
          <template v-else-if="store.searchResults.length === 0">No matches</template>
          <template v-else>{{ store.searchResults.length }} result{{ store.searchResults.length === 1 ? '' : 's' }}</template>
        </div>
        <SidebarItem
          v-for="row in store.searchResults"
          :key="row.id"
          :row="row"
          :active="row.id === activeId"
          @open="onOpen"
          @delete="onDelete"
        />
      </template>

      <!-- Normal date-grouped view -->
      <template v-else>
        <div v-if="store.sessions.length === 0" class="sidebar-empty">No sessions yet.</div>

        <template v-for="[label, rows] in groups" :key="label">
          <div class="sidebar-group-label">{{ label }}</div>
          <SidebarItem
            v-for="row in rows"
            :key="row.id"
            :row="row"
            :active="row.id === activeId"
            @open="onOpen"
            @delete="onDelete"
          />
        </template>

        <button
          v-if="store.sessionsHasMore"
          class="sidebar-more"
          :disabled="store.sessionsLoadingMore"
          @click="onShowOlder"
        >
          {{ store.sessionsLoadingMore ? 'Loading…' : 'Show older' }}
        </button>
      </template>
    </div>
  </aside>
</template>
