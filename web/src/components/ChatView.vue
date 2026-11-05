<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useSessionStore } from '../stores/session.js';
import TaskTracker from './TaskTracker.vue';
import ConfirmCard from './ConfirmCard.vue';
import ClarifyCard from './ClarifyCard.vue';
import CostBadge from './CostBadge.vue';
import TraceView from './TraceView.vue';
import AuditFeed from './AuditFeed.vue';

const props = defineProps<{ sessionId: string }>();
defineEmits<{ 'toggle-nav': [] }>();
const store = useSessionStore();

const chat = computed(() => store.chats[props.sessionId] ?? null);
const draft = ref('');
const scrollEl = ref<HTMLElement | null>(null);

const EXAMPLE_PROMPTS = [
  'Find leads created in the last week',
  'Show me unpaid invoices that are overdue',
  'What open slots are there on the calendar?',
];

const sessionTitle = computed(() => {
  const s = store.sessions.find((row) => row.id === props.sessionId);
  return s?.title && s.title.length > 0 ? s.title : 'New chat';
});

/** Inspector drawer: audit ledger (session-wide) or a selected turn's trace
 * waterfall. Local state — reset when the session changes. */
type Inspector = { tab: 'audit' | 'trace'; turnId: string | null };
const inspector = ref<Inspector | null>(null);

watch(
  () => props.sessionId,
  () => {
    inspector.value = null;
  },
);

function openAudit(): void {
  if (inspector.value?.tab === 'audit') {
    inspector.value = null;
    return;
  }
  inspector.value = { tab: 'audit', turnId: inspector.value?.turnId ?? null };
}
function openTrace(turnId: string): void {
  inspector.value = { tab: 'trace', turnId };
}
function closeInspector(): void {
  inspector.value = null;
}

const FAIL_STATUSES = new Set(['failed', 'refused', 'cancelled']);
function statusToken(status: string | undefined): string | null {
  if (!status || status === 'done' || status === 'clarify') return null;
  return status;
}
function isFailStatus(status: string | undefined): boolean {
  return status !== undefined && FAIL_STATUSES.has(status);
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
}

watch(
  () => chat.value?.turns.length,
  () => void scrollToBottom(),
);
watch(
  () => chat.value?.turns.at(-1)?.deltaText,
  () => void scrollToBottom(),
);

async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text || chat.value?.running) return;
  draft.value = '';
  await store.send(text);
}

function useExample(text: string): void {
  draft.value = text;
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
    <header class="transcript-head">
      <button
        class="nav-toggle"
        aria-label="Toggle sessions"
        @click="$emit('toggle-nav')"
      >
        ☰
      </button>
      <div class="transcript-title">{{ sessionTitle }}</div>
      <button
        class="ghost-btn"
        :class="{ 'is-on': inspector?.tab === 'audit' }"
        @click="openAudit"
      >
        Audit
      </button>
    </header>

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

    <div class="transcript" ref="scrollEl">
      <div class="transcript-inner">
        <div v-if="chat.turns.length === 0" class="start">
          <div class="start-name">Ask AI</div>
          <p class="start-line">
            A legible agent for your CRM — ask in plain language and watch every step it takes.
          </p>
          <div class="start-chips">
            <button
              v-for="p in EXAMPLE_PROMPTS"
              :key="p"
              class="chip"
              @click="useExample(p)"
            >
              {{ p }}
            </button>
          </div>
        </div>

        <article v-for="turn in chat.turns" :key="turn.turnId" class="turn">
          <div class="speaker">
            <span class="speaker-name">You</span>
            <span class="speaker-rule"></span>
          </div>
          <div class="said said-user">{{ turn.userText }}</div>

          <div class="speaker" style="margin-top: 16px">
            <span class="speaker-name">Ask AI</span>
            <span class="speaker-rule"></span>
            <span
              v-if="statusToken(turn.status)"
              :class="['turn-status', { 'is-fail': isFailStatus(turn.status) }]"
              >{{ statusToken(turn.status) }}</span
            >
          </div>

          <div class="agent-body">
            <TaskTracker v-if="turn.kind === 'plan'" :turn="turn" />

            <ClarifyCard v-if="turn.clarifyQuestion" :question="turn.clarifyQuestion" />

            <ConfirmCard
              v-if="turn.pendingConfirm"
              :confirm="turn.pendingConfirm"
              @resolve="onResolveConfirm"
            />

            <div
              v-if="turn.finalText || turn.deltaText || turn.unsupportedReason"
              :class="['said', 'said-agent', 'agent-section', { 'is-fail': isFailStatus(turn.status) }]"
            >
              {{ turn.finalText || turn.deltaText || turn.unsupportedReason }}
            </div>
          </div>

          <div v-if="turn.status" class="turn-foot">
            <CostBadge v-if="turn.metrics" :metrics="turn.metrics" />
            <div class="foot-actions">
              <button class="foot-btn" @click="openTrace(turn.turnId)">Trace</button>
            </div>
          </div>
        </article>
      </div>
    </div>

    <div class="composer">
      <div class="composer-inner">
        <textarea
          v-model="draft"
          :disabled="chat.running"
          placeholder="Message Ask AI…"
          @keydown="onKeydown"
        ></textarea>
        <button v-if="chat.running" class="btn-cancel" @click="onCancel">Cancel</button>
        <button v-else class="btn-send" :disabled="!draft.trim()" @click="onSend">Send</button>
      </div>
    </div>

    <!-- inspector drawer: slides over the transcript -->
    <template v-if="inspector">
      <div class="inspector-scrim" @click="closeInspector"></div>
      <aside class="inspector" role="dialog" aria-label="Inspector">
        <div class="inspector-head">
          <span class="inspector-title">Inspector</span>
          <button class="inspector-close" aria-label="Close inspector" @click="closeInspector">
            ×
          </button>
        </div>
        <div class="inspector-tabs">
          <button
            class="inspector-tab"
            :class="{ 'is-on': inspector.tab === 'audit' }"
            @click="inspector = { tab: 'audit', turnId: inspector?.turnId ?? null }"
          >
            Audit ledger
          </button>
          <button
            class="inspector-tab"
            :class="{ 'is-on': inspector.tab === 'trace' }"
            :disabled="!inspector.turnId"
            @click="inspector.turnId && (inspector = { tab: 'trace', turnId: inspector.turnId })"
          >
            Trace
          </button>
        </div>
        <div class="inspector-body">
          <AuditFeed v-if="inspector.tab === 'audit'" :turns="chat.turns" />
          <TraceView
            v-else-if="inspector.tab === 'trace' && inspector.turnId"
            :key="inspector.turnId"
            :turn-id="inspector.turnId"
          />
          <div v-else class="inspector-hint">Open a turn's trace from its footer.</div>
        </div>
      </aside>
    </template>
  </div>
</template>
