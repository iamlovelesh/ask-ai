<script setup lang="ts">
import { computed } from 'vue';

export interface RecordPopoverState {
  x: number;
  y: number;
  entity: string;
  id: string;
  loading: boolean;
  error?: string;
  fields?: Record<string, unknown>;
}

const props = defineProps<{ state: RecordPopoverState }>();
defineEmits<{ close: [] }>();

/** Epoch-ms timestamps → ISO date; everything else shown as-is. A number in
 * the 2000–2100 range is treated as a date (mirrors the server's renderer). */
function display(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number' && value >= 946_684_800_000 && value < 4_102_444_800_000) {
    return new Date(value).toISOString().slice(0, 10);
  }
  return String(value);
}

const rows = computed(() =>
  Object.entries(props.state.fields ?? {}).map(([k, v]) => ({ k, v: display(v) })),
);
</script>

<template>
  <div class="rp-backdrop" @click="$emit('close')"></div>
  <div class="rp-card" :style="{ left: state.x + 'px', top: state.y + 'px' }" role="dialog">
    <div class="rp-head">
      <span class="rp-entity">{{ state.entity }}</span>
      <span class="rp-id">{{ state.id }}</span>
      <button type="button" class="rp-close" aria-label="Close" @click="$emit('close')">×</button>
    </div>
    <div v-if="state.loading" class="rp-note">Loading…</div>
    <div v-else-if="state.error" class="rp-note">{{ state.error }}</div>
    <dl v-else class="rp-fields">
      <template v-for="row in rows" :key="row.k">
        <dt>{{ row.k }}</dt>
        <dd>{{ row.v }}</dd>
      </template>
    </dl>
  </div>
</template>
