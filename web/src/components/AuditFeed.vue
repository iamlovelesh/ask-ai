<script setup lang="ts">
/**
 * Session-level write/confirm audit panel (Task 19). Toggled from
 * `ChatView`; pure render component — all filtering logic lives in
 * `lib/audit.ts#buildAuditEntries` (kept there, not inline, so it's unit
 * testable without mounting Vue). See that file's header for exactly what
 * this panel does and does NOT claim to show.
 */
import { computed } from 'vue';
import type { TurnView } from '../lib/fold.js';
import { buildAuditEntries } from '../lib/audit.js';

const props = defineProps<{ turns: TurnView[] }>();

const entries = computed(() => buildAuditEntries(props.turns));

const KIND_LABEL: Record<string, string> = {
  'confirmation.required': 'confirm requested',
  'confirmation.resolved': 'confirm resolved',
  'step.finished': 'step finished',
  'step.failed': 'step failed',
};
</script>

<template>
  <div class="audit-feed">
    <div class="audit-feed-note">
      Showing confirmation checkpoints and completed/failed steps across this session's turns — not a full record
      of every event.
    </div>
    <div v-if="entries.length === 0" class="audit-feed-empty">Nothing to audit yet.</div>
    <div
      v-for="(entry, i) in entries"
      :key="i"
      :class="['audit-row', `audit-${entry.kind.replace('.', '-')}`]"
    >
      <span class="audit-kind">{{ KIND_LABEL[entry.kind] ?? entry.kind }}</span>
      <span class="audit-label">{{ entry.label }}</span>
      <span v-if="entry.detail" class="audit-detail">{{ entry.detail }}</span>
    </div>
  </div>
</template>
