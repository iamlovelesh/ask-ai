<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session.js';
import ModelPicker from './ModelPicker.vue';
import RolePicker from './RolePicker.vue';

defineEmits<{ 'toggle-nav': [] }>();
const store = useSessionStore();
const router = useRouter();

onMounted(() => void store.loadModels());

const draft = ref('');
const textareaEl = ref<HTMLTextAreaElement | null>(null);
/** Guards against a double-submit while the session is being created. */
const starting = ref(false);
const TEXTAREA_MAX_LINES = 4;

// Attachments (#6): on the first message there is no session yet, so hold the
// raw files and upload them once the session is created in onSend.
const fileInput = ref<HTMLInputElement | null>(null);
const pendingFiles = ref<File[]>([]);
function openFilePicker(): void {
  fileInput.value?.click();
}
function onFilesSelected(e: Event): void {
  const input = e.target as HTMLInputElement;
  pendingFiles.value.push(...Array.from(input.files ?? []).slice(0, 5 - pendingFiles.value.length));
  input.value = '';
}
function removeFile(i: number): void {
  pendingFiles.value.splice(i, 1);
}

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
    // Upload any attached files for the new session, then send with their ids.
    const attachmentIds: string[] = [];
    for (const f of pendingFiles.value) {
      const rec = await store.uploadFile(f, id);
      if (rec) attachmentIds.push(rec.id);
    }
    pendingFiles.value = [];
    await router.push({ name: 'session', params: { sessionId: id } });
    await store.send(text, attachmentIds.length > 0 ? attachmentIds : undefined);
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
      <div v-if="pendingFiles.length" class="composer-attachments">
        <span v-for="(f, i) in pendingFiles" :key="i" class="attach-chip">
          <svg class="attach-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
          {{ f.name }}
          <button class="attach-remove" type="button" title="Remove" @click="removeFile(i)">×</button>
        </span>
      </div>
      <div class="composer-inner">
        <input ref="fileInput" type="file" multiple class="sr-only" @change="onFilesSelected" />
        <button
          class="btn-attach"
          type="button"
          :disabled="starting"
          title="Attach a file"
          aria-label="Attach a file"
          @click="openFilePicker"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
        </button>
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
      <div class="composer-controls">
        <ModelPicker :disabled="starting" />
        <RolePicker :disabled="starting" />
      </div>
    </div>
  </div>
</template>
