<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSessionStore } from '../stores/session.js';

const props = defineProps<{ disabled?: boolean }>();
const store = useSessionStore();

const advancedOpen = ref(false);
const search = ref('');

/** The tier whose model is currently selected, or undefined when the user has
 * picked a non-tier "other" model from the catalog. */
const currentTier = computed(() => store.models.find((m) => m.id === store.selectedModel));
const isCustom = computed(() => store.selectedModel !== '' && !currentTier.value);
const customEntry = computed(() =>
  store.catalog.find((m) => m.id === store.selectedModel) ?? { id: store.selectedModel, name: store.selectedModel },
);

/** Streaming capability of whatever is selected: tier flag, else inferred
 * from the provider prefix (OpenAI/Google stream). */
const streams = computed(() =>
  currentTier.value
    ? currentTier.value.streamsTools
    : store.selectedModel.startsWith('openai/') || store.selectedModel.startsWith('google/'),
);

const headerLabel = computed(() =>
  isCustom.value ? `Custom · ${customEntry.value.name}` : `${currentTier.value?.label ?? ''} · ${currentTier.value?.name ?? ''}`,
);

/** Slider position = tier index. In custom mode the thumb rests on the
 * recommended tier (visual only); moving it re-enters tier mode. */
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

function dots(score: number): string {
  return '●'.repeat(Math.max(0, Math.min(5, score))) + '○'.repeat(Math.max(0, 5 - score));
}

function toggleAdvanced(): void {
  advancedOpen.value = !advancedOpen.value;
  if (advancedOpen.value) void store.loadCatalog();
}

const filteredCatalog = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = q
    ? store.catalog.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    : store.catalog;
  return list.slice(0, 60);
});

function pickCatalog(id: string): void {
  store.selectedModel = id;
  advancedOpen.value = false;
  search.value = '';
}
</script>

<template>
  <div v-if="store.models.length > 0" class="model-picker">
    <div class="model-picker-head">
      <span class="model-picker-current">{{ headerLabel }}</span>
      <span v-if="currentTier?.recommended" class="model-picker-rec">recommended</span>
      <span v-if="streams" class="model-picker-badge" title="Streams the answer live, token by token">⚡ streams live</span>
    </div>

    <input
      class="model-picker-slider"
      type="range"
      min="0"
      :max="store.models.length - 1"
      step="1"
      v-model.number="index"
      :disabled="props.disabled"
      :aria-label="`Model tier: ${currentTier?.label ?? 'custom'}`"
    />
    <div class="model-picker-scale"><span>Faster</span><span>Smarter</span></div>

    <div class="model-picker-meta">
      <span class="model-picker-desc">
        {{ isCustom ? customEntry.id : currentTier?.description }}
      </span>
      <span v-if="currentTier" class="model-picker-scores">
        <span class="model-picker-score" :title="`Speed ${currentTier.speed}/5`">⚡&nbsp;{{ dots(currentTier.speed) }}</span>
        <span class="model-picker-score" :title="`Intelligence ${currentTier.intelligence}/5`">🧠&nbsp;{{ dots(currentTier.intelligence) }}</span>
      </span>
    </div>

    <button type="button" class="model-picker-advanced-toggle" :disabled="props.disabled" @click="toggleAdvanced">
      {{ advancedOpen ? 'Hide other models' : 'Other models…' }}
    </button>

    <div v-if="advancedOpen" class="model-picker-advanced">
      <input
        v-model="search"
        class="model-picker-search"
        type="text"
        placeholder="Search models (e.g. gpt, gemini, llama)…"
      />
      <div v-if="store.catalogLoading" class="model-picker-advanced-note">Loading catalog…</div>
      <div v-else-if="store.catalog.length === 0" class="model-picker-advanced-note">Catalog unavailable.</div>
      <ul v-else class="model-picker-list">
        <li
          v-for="m in filteredCatalog"
          :key="m.id"
          :class="['model-picker-list-item', { 'is-on': m.id === store.selectedModel }]"
          @click="pickCatalog(m.id)"
        >
          <span class="model-picker-list-name">{{ m.name }}</span>
          <span class="model-picker-list-id">{{ m.id }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
