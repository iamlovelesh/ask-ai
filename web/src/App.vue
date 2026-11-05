<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useSessionStore } from './stores/session.js';
import Sidebar from './components/Sidebar.vue';
import ChatView from './components/ChatView.vue';

const store = useSessionStore();

/** On narrow screens the rail becomes a slide-over; this tracks its state.
 * Opening a session closes it so the transcript is immediately visible. */
const navOpen = ref(false);

onMounted(async () => {
  await store.loadSessions();
});

async function onOpen(id: string): Promise<void> {
  navOpen.value = false;
  await store.openSession(id);
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
      <Sidebar :active-id="store.activeId" @open="onOpen" />
      <div v-if="navOpen" class="nav-scrim" @click="navOpen = false"></div>
      <main class="app-main">
        <ChatView
          v-if="store.activeId"
          :session-id="store.activeId"
          @toggle-nav="navOpen = !navOpen"
        />
        <template v-else>
          <header class="transcript-head">
            <button class="nav-toggle" aria-label="Toggle sessions" @click="navOpen = !navOpen">
              ☰
            </button>
            <div class="transcript-title">Ask AI</div>
          </header>
          <div class="chat-empty">Select a session or start a new chat.</div>
        </template>
      </main>
    </template>

    <div class="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast">{{ t.text }}</div>
    </div>
  </div>
</template>
