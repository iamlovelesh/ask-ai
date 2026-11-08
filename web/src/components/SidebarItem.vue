<script setup lang="ts">
import { ref } from 'vue';
import type { SessionSummary } from '../stores/session.js';
import { relativeTime } from '../lib/relative-time.js';

const props = defineProps<{ row: SessionSummary; active: boolean }>();
const emit = defineEmits<{ open: [id: string]; delete: [id: string] }>();

/** When true the row swaps its label for an inline "Delete? ✓ ✕" confirm
 * (chosen UX — no modal, no browser dialog). Local to each row so only the
 * row being acted on is in the confirming state. */
const confirming = ref(false);

function titleOf(title: string | null): string {
  return title && title.length > 0 ? title : 'Untitled session';
}

function onOpen(): void {
  if (confirming.value) return;
  emit('open', props.row.id);
}

function askDelete(): void {
  confirming.value = true;
}

function cancelDelete(): void {
  confirming.value = false;
}

function confirmDelete(): void {
  confirming.value = false;
  emit('delete', props.row.id);
}
</script>

<template>
  <div :class="['sidebar-item', { active, confirming }]">
    <template v-if="confirming">
      <span class="sidebar-item-confirm-label">Delete this chat?</span>
      <div class="sidebar-item-confirm-actions">
        <button class="sidebar-confirm-btn delete" title="Delete" aria-label="Confirm delete" @click.stop="confirmDelete">✓</button>
        <button class="sidebar-confirm-btn" title="Cancel" aria-label="Cancel delete" @click.stop="cancelDelete">✕</button>
      </div>
    </template>
    <template v-else>
      <button class="sidebar-item-main" @click="onOpen">
        <span class="sidebar-item-title">{{ titleOf(row.title) }}</span>
        <span class="sidebar-item-time">{{ relativeTime(row.updated_at) }}</span>
      </button>
      <button
        class="sidebar-item-delete"
        title="Delete chat"
        aria-label="Delete chat"
        @click.stop="askDelete"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2.5 4h11" />
          <path d="M5.5 4V2.8c0-.4.3-.8.8-.8h3.4c.5 0 .8.4.8.8V4" />
          <path d="M12.5 4l-.5 8.4c0 .5-.4.9-.9.9H4.9c-.5 0-.9-.4-.9-.9L3.5 4" />
          <path d="M6.5 7v4M9.5 7v4" />
        </svg>
      </button>
    </template>
  </div>
</template>
