<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session.js';

defineEmits<{ 'toggle-nav': [] }>();
const store = useSessionStore();
const router = useRouter();

const draft = ref('');
const textareaEl = ref<HTMLTextAreaElement | null>(null);
/** Guards against a double-submit while the session is being created. */
const starting = ref(false);
const TEXTAREA_MAX_LINES = 4;

const EXAMPLE_PROMPTS = [
  'Find leads created in the last week',
  'Show me unpaid invoices that are overdue',
  'What open slots are there on the calendar?',
];

/** First message of a brand-new chat: create the session, navigate to its
 * `/s/:id` (the route watcher opens it), then send. Keeping the send here —
 * after navigation — is what makes "new chat → first message → new session
 * URL" a single, resumable flow. */
async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text || starting.value) return;
  starting.value = true;
  try {
    const id = await store.newSession();
    if (!id) return; // creation failed — a toast was already surfaced.
    draft.value = '';
    await router.push({ name: 'session', params: { sessionId: id } });
    await store.send(text);
  } finally {
    starting.value = false;
  }
}

function useExample(text: string): void {
  draft.value = text;
  void nextTick(() => textareaEl.value?.focus());
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void onSend();
  }
}

function autosizeTextarea(): void {
  const el = textareaEl.value;
  if (!el) return;
  const style = getComputedStyle(el);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
  const verticalBorderPadding =
    parseFloat(style.borderTopWidth) +
    parseFloat(style.borderBottomWidth) +
    parseFloat(style.paddingTop) +
    parseFloat(style.paddingBottom);
  const maxPx = lineHeight * TEXTAREA_MAX_LINES + verticalBorderPadding;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
}

watch(draft, () => void nextTick(autosizeTextarea));
</script>

<template>
  <div class="chat-view">
    <header class="transcript-head">
      <button class="nav-toggle" aria-label="Toggle sessions" @click="$emit('toggle-nav')">☰</button>
      <div class="transcript-title">New chat</div>
    </header>

    <div class="transcript">
      <div class="transcript-inner">
        <div class="start">
          <div class="start-name">Ask AI</div>
          <p class="start-line">
            A legible agent for your CRM — ask in plain language and watch every step it takes.
          </p>
          <div class="start-chips">
            <button v-for="p in EXAMPLE_PROMPTS" :key="p" class="chip" @click="useExample(p)">
              {{ p }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="composer">
      <div class="composer-inner">
        <textarea
          ref="textareaEl"
          v-model="draft"
          :disabled="starting"
          placeholder="Message Ask AI…"
          @keydown="onKeydown"
          @input="autosizeTextarea"
        ></textarea>
        <button class="btn-send" :disabled="!draft.trim() || starting" @click="onSend">Send</button>
      </div>
    </div>
  </div>
</template>
