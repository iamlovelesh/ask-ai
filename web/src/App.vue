<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from './stores/session.js';
import Sidebar from './components/Sidebar.vue';
import ChatView from './components/ChatView.vue';
import NewChatView from './components/NewChatView.vue';

const store = useSessionStore();
const route = useRoute();
const router = useRouter();

/** On narrow screens the rail becomes a slide-over; this tracks its state.
 * Opening a session closes it so the transcript is immediately visible. */
const navOpen = ref(false);

/** The session id the URL currently addresses (`/s/:sessionId`), or `null`
 * on the new-chat route (`/`). The router owns the URL; the store stays the
 * source of truth for chat state — this watcher is the single bridge. */
const routeSessionId = computed(() => {
  const p = route.params.sessionId;
  return typeof p === 'string' && p.length > 0 ? p : null;
});

watch(
  routeSessionId,
  (id) => {
    navOpen.value = false;
    if (id) {
      void store.openSession(id);
    } else {
      // Home / new-chat state — no active session, clear any stale not-found.
      store.activeId = null;
      store.sessionNotFound = false;
    }
  },
  { immediate: true },
);

onMounted(async () => {
  await store.loadSessions();
});

function onOpen(id: string): void {
  void router.push({ name: 'session', params: { sessionId: id } });
}

function onNewChat(): void {
  void router.push({ name: 'home' });
}

function goHome(): void {
  void router.push({ name: 'home' });
}

async function onRetry(): Promise<void> {
  await store.retryServer();
}
</script>

<template>
  <div class="app-layout" :class="{ 'nav-open': navOpen }">
    <template v-if="store.serverUnreachable">
      <div class="retry-screen">
        <p>Can't reach the Ask AI server.</p>
        <button class="btn" @click="onRetry">Retry</button>
      </div>
    </template>
    <template v-else>
      <Sidebar :active-id="store.activeId" @open="onOpen" @new-chat="onNewChat" />
      <div v-if="navOpen" class="nav-scrim" @click="navOpen = false"></div>
      <main class="app-main">
        <template v-if="store.sessionNotFound">
          <header class="transcript-head">
            <button class="nav-toggle" aria-label="Toggle sessions" @click="navOpen = !navOpen">☰</button>
            <div class="transcript-title">Session not found</div>
          </header>
          <div class="retry-screen">
            <p>That session doesn't exist — it may have been removed or the link is wrong.</p>
            <button class="btn" @click="goHome">Back to new chat</button>
          </div>
        </template>
        <ChatView
          v-else-if="store.activeId"
          :key="store.activeId"
          :session-id="store.activeId"
          @toggle-nav="navOpen = !navOpen"
        />
        <NewChatView v-else @toggle-nav="navOpen = !navOpen" />
      </main>
    </template>

    <div class="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast">{{ t.text }}</div>
    </div>
  </div>
</template>
