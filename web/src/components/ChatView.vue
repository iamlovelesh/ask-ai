<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useSessionStore } from '../stores/session.js';
import TaskTracker from './TaskTracker.vue';
import ConfirmCard from './ConfirmCard.vue';
import ClarifyCard from './ClarifyCard.vue';
import CostBadge from './CostBadge.vue';

const props = defineProps<{ sessionId: string }>();
const store = useSessionStore();

const chat = computed(() => store.chats[props.sessionId] ?? null);
const draft = ref('');
const scrollEl = ref<HTMLElement | null>(null);

function statusLabel(status: string | undefined): string {
  if (!status) return '';
  return status;
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
}

watch(
  () => chat.value?.turns.length,
  () => {
    void scrollToBottom();
  },
);
watch(
  () => chat.value?.turns.at(-1)?.deltaText,
  () => {
    void scrollToBottom();
  },
);

async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text || chat.value?.running) return;
  draft.value = '';
  await store.send(text);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void onSend();
  }
}

async function onCancel(): Promise<void> {
  await store.cancel();
}

async function onResolveConfirm(confirmId: string, approved: boolean): Promise<void> {
  await store.confirm(confirmId, approved);
}

async function onRetryConnection(): Promise<void> {
  await store.reconnect(props.sessionId);
}

async function onRetrySend(): Promise<void> {
  await store.retrySend();
}
</script>

<template>
  <div class="chat-view" v-if="chat">
    <!-- The message never reached the server (no turn was ever started) —
         retrying means re-sending, not reconnecting to a stream. -->
    <div v-if="chat.sendError" class="banner banner-error">
      <span>{{ chat.sendError }}</span>
      <button class="btn" @click="onRetrySend">Retry send</button>
    </div>
    <!-- A turn DID start server-side and then the connection dropped —
         auto-reconnect already ran; this banner means every attempt failed. -->
    <div v-if="chat.error" class="banner banner-error">
      <span>{{ chat.error }}</span>
      <button class="btn" @click="onRetryConnection">Retry now</button>
    </div>

    <div class="chat-scroll" ref="scrollEl">
      <div v-if="chat.turns.length === 0" class="chat-empty">
        Say something to start — e.g. "Find leads created in the last week".
      </div>

      <div v-for="turn in chat.turns" :key="turn.turnId" class="turn-block">
        <div class="bubble bubble-user">{{ turn.userText }}</div>

        <div :class="['agent-block']">
          <div v-if="turn.status" :class="['status-pill', turn.status]">{{ statusLabel(turn.status) }}</div>

          <TaskTracker v-if="turn.kind === 'plan'" :turn="turn" />

          <ClarifyCard v-if="turn.clarifyQuestion" :question="turn.clarifyQuestion" />

          <ConfirmCard
            v-if="turn.pendingConfirm"
            :confirm="turn.pendingConfirm"
            @resolve="onResolveConfirm"
          />

          <div
            v-if="turn.finalText || turn.deltaText || turn.unsupportedReason"
            :class="['bubble', 'bubble-agent', turn.status ? `status-${turn.status}` : '']"
          >
            {{ turn.finalText || turn.deltaText || turn.unsupportedReason }}
          </div>

          <CostBadge v-if="turn.metrics" :metrics="turn.metrics" />
        </div>
      </div>
    </div>

    <div class="composer">
      <textarea
        v-model="draft"
        :disabled="chat.running"
        placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
        @keydown="onKeydown"
      ></textarea>
      <button v-if="chat.running" class="btn" @click="onCancel">Cancel</button>
      <button v-else class="btn btn-send" :disabled="!draft.trim()" @click="onSend">Send</button>
    </div>
  </div>
</template>
