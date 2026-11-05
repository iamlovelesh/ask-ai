<script setup lang="ts">
import { onMounted } from 'vue';
import { useSessionStore } from './stores/session.js';
import Sidebar from './components/Sidebar.vue';
import ChatView from './components/ChatView.vue';

const store = useSessionStore();

onMounted(async () => {
  await store.loadSessions();
});

async function onOpen(id: string): Promise<void> {
  await store.openSession(id);
}

async function onRetry(): Promise<void> {
  await store.retryServer();
}
</script>

<template>
  <div class="app-layout">
    <template v-if="store.serverUnreachable">
      <div class="retry-screen">
        <p>Can't reach the Ask AI server.</p>
        <button class="btn" @click="onRetry">Retry</button>
      </div>
    </template>
    <template v-else>
      <Sidebar :active-id="store.activeId" @open="onOpen" />
      <main class="app-main">
        <ChatView v-if="store.activeId" :session-id="store.activeId" />
        <div v-else class="chat-empty">Select a session or start a new chat.</div>
      </main>
    </template>

    <div class="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast">{{ t.text }}</div>
    </div>
  </div>
</template>
