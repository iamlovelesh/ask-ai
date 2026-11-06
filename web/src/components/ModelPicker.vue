<script setup lang="ts">
import { computed } from 'vue';
import { useSessionStore } from '../stores/session.js';

const props = defineProps<{ disabled?: boolean }>();
const store = useSessionStore();

/** Slider position = index into the ordered tier list (extra-fast … extra-smart).
 * model picker is a 5-stop slider over the speed↔intelligence axis. */
const index = computed<number>({
  get() {
    const i = store.models.findIndex((m) => m.id === store.selectedModel);
    return i >= 0 ? i : store.models.findIndex((m) => m.recommended);
  },
  set(i: number) {
    const m = store.models[i];
    if (m) store.selectedModel = m.id;
  },
});

const selected = computed(() => store.models[index.value]);

function dots(score: number): string {
  return '●'.repeat(Math.max(0, Math.min(5, score))) + '○'.repeat(Math.max(0, 5 - score));
}
</script>

<template>
  <div v-if="store.models.length > 0" class="model-picker">
    <div class="model-picker-head">
      <span class="model-picker-current">
        {{ selected?.label }}<span v-if="selected?.recommended" class="model-picker-rec"> · recommended</span>
      </span>
      <span v-if="selected?.streamsTools" class="model-picker-badge" title="Streams the answer live, token by token">⚡ streams live</span>
    </div>

    <input
      class="model-picker-slider"
      type="range"
      min="0"
      :max="store.models.length - 1"
      step="1"
      v-model.number="index"
      :disabled="props.disabled"
      :aria-label="`Model: ${selected?.label}`"
    />
    <div class="model-picker-scale">
      <span>Faster</span>
      <span>Smarter</span>
    </div>

    <div v-if="selected" class="model-picker-meta">
      <span class="model-picker-desc">{{ selected.description }}</span>
      <span class="model-picker-scores">
        <span class="model-picker-score" :title="`Speed ${selected.speed}/5`">⚡&nbsp;{{ dots(selected.speed) }}</span>
        <span class="model-picker-score" :title="`Intelligence ${selected.intelligence}/5`">🧠&nbsp;{{ dots(selected.intelligence) }}</span>
      </span>
    </div>
  </div>
</template>
