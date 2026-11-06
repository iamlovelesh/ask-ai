<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSessionStore } from '../stores/session.js';

const props = defineProps<{ disabled?: boolean }>();
const store = useSessionStore();

const open = ref(false);
const infoOpen = ref(false);
const advancedOpen = ref(false);
const search = ref('');

const isAuto = computed(() => store.selectedModel === 'auto');
const currentTier = computed(() => store.models.find((m) => m.id === store.selectedModel));
const isCustom = computed(() => store.selectedModel !== '' && !isAuto.value && !currentTier.value);
const customEntry = computed(() =>
  store.catalog.find((m) => m.id === store.selectedModel) ?? { id: store.selectedModel, name: store.selectedModel },
);
const currentName = computed(() =>
  isAuto.value ? 'adaptive' : isCustom.value ? customEntry.value.name : (currentTier.value?.name ?? ''),
);
const currentLabel = computed(() =>
  isAuto.value ? 'Auto' : isCustom.value ? 'Custom' : (currentTier.value?.label ?? ''),
);

const streams = computed(() =>
  currentTier.value
    ? currentTier.value.streamsTools
    : store.selectedModel.startsWith('openai/') || store.selectedModel.startsWith('google/'),
);

/** Slider position = tier index; custom rests on the recommended tier. */
const index = computed<number>({
  get() {
    const i = store.models.findIndex((m) => m.id === store.selectedModel);
    return i >= 0 ? i : store.models.findIndex((m) => m.recommended);
  },
  set(i: number) {
    const m = store.models[i];
    if (m) store.selectModel(m.id);
  },
});

/** 0–1 fill fraction for the custom track. */
const fillPct = computed(() =>
  store.models.length > 1 ? (index.value / (store.models.length - 1)) * 100 : 0,
);

/** Signal-bar level for the trigger glyph (1 = fastest … N = smartest). */
const barLevel = computed(() => (isCustom.value ? 3 : index.value + 1));
const BARS = [1, 2, 3, 4, 5];

function toggle(): void {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) void store.loadModels();
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
  store.selectModel(id);
  advancedOpen.value = false;
  search.value = '';
}
</script>

<template>
  <div v-if="store.models.length > 0" class="mp">
    <!-- Compact trigger (M1): signal-bars glyph + current tier · model -->
    <button
      type="button"
      class="mp-trigger"
      :class="{ 'is-open': open }"
      :disabled="props.disabled"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="mp-bars" aria-hidden="true">
        <span
          v-for="b in BARS"
          :key="b"
          class="mp-bar"
          :class="{ on: b <= barLevel }"
          :style="{ height: 4 + b * 2 + 'px' }"
        ></span>
      </span>
      <span class="mp-trigger-label">{{ currentLabel }} · {{ currentName }}</span>
      <span v-if="streams" class="mp-trigger-stream" title="Streams the answer live">⚡</span>
      <span class="mp-trigger-caret" :class="{ open }" aria-hidden="true">›</span>
    </button>

    <template v-if="open">
      <div class="mp-backdrop" @click="open = false"></div>
      <div class="mp-popover" role="dialog" aria-label="Choose a model">
        <div class="mp-head">
          <span class="mp-head-title">{{ currentLabel }} · {{ currentName }}</span>
          <button
            type="button"
            class="mp-info-btn"
            :aria-expanded="infoOpen"
            aria-label="Model details"
            @click="infoOpen = !infoOpen"
          >
            ⓘ
          </button>
          <span v-if="currentTier?.recommended" class="mp-rec">recommended</span>
          <span v-if="streams" class="model-picker-badge mp-stream-badge">⚡ streams live</span>
        </div>

        <!-- ⓘ hovercard (M3): speed / intelligence -->
        <div v-if="infoOpen && currentTier" class="mp-info-card">
          <div class="mp-info-row">
            <span>Speed</span><span class="mp-info-dots">{{ '●'.repeat(currentTier.speed) }}{{ '○'.repeat(5 - currentTier.speed) }}</span>
          </div>
          <div class="mp-info-row">
            <span>Intelligence</span><span class="mp-info-dots">{{ '●'.repeat(currentTier.intelligence) }}{{ '○'.repeat(5 - currentTier.intelligence) }}</span>
          </div>
          <div class="mp-info-row">
            <span>Streaming</span><span>{{ currentTier.streamsTools ? 'Live' : 'After verification' }}</span>
          </div>
        </div>

        <!-- Auto meta-option (#13): server picks the tier per question -->
        <button
          v-if="store.autoModel"
          type="button"
          class="mp-auto"
          :class="{ 'is-on': isAuto }"
          @click="store.selectModel('auto')"
        >
          <span class="mp-auto-spark" aria-hidden="true">✨</span>
          <span class="mp-auto-text">
            <span class="mp-auto-title">Auto</span>
            <span class="mp-auto-sub">Picks the right model for each question</span>
          </span>
          <span v-if="isAuto" class="mp-auto-check" aria-hidden="true">✓</span>
        </button>

        <!-- Custom tier slider (M2): styled track + invisible real range -->
        <div class="mp-slider" :class="{ 'is-muted': isAuto }">
          <div class="mp-track"><div class="mp-fill" :style="{ width: fillPct + '%' }"></div></div>
          <div class="mp-dots">
            <span v-for="(m, i) in store.models" :key="m.id" class="mp-dot" :class="{ on: i <= index }"></span>
          </div>
          <div class="mp-handle" :style="{ left: fillPct + '%' }"></div>
          <input
            class="mp-range"
            type="range"
            min="0"
            :max="store.models.length - 1"
            step="1"
            v-model.number="index"
            :aria-valuetext="`${currentLabel}: ${currentName}`"
            aria-label="Model tier"
          />
        </div>
        <div class="mp-scale"><span>Faster</span><span>Smarter</span></div>

        <p class="mp-desc">{{ isCustom ? customEntry.id : currentTier?.description }}</p>

        <button type="button" class="mp-advanced-toggle" @click="toggleAdvanced">
          {{ advancedOpen ? 'Hide other models' : 'Other models…' }}
        </button>
        <div v-if="advancedOpen" class="mp-advanced">
          <input v-model="search" class="mp-search" type="text" placeholder="Search models (gpt, gemini, llama)…" />
          <div v-if="store.catalogLoading" class="mp-advanced-note">Loading catalog…</div>
          <div v-else-if="store.catalog.length === 0" class="mp-advanced-note">Catalog unavailable.</div>
          <ul v-else class="mp-list">
            <li
              v-for="m in filteredCatalog"
              :key="m.id"
              :class="['mp-list-item', { 'is-on': m.id === store.selectedModel }]"
              @click="pickCatalog(m.id)"
            >
              <span class="mp-list-name">{{ m.name }}</span>
              <span class="mp-list-id">{{ m.id }}</span>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </div>
</template>
