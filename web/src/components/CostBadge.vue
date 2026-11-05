<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TurnMetrics } from '../lib/events.js';
import { formatCost, formatMs, formatTokens } from '../lib/format.js';

const props = defineProps<{ metrics: TurnMetrics }>();

const expanded = ref(false);

/** Plain-language turn latency — "Answered in 1.4s". Omitted entirely when
 * there's no genuine duration to report (never "Answered in 0ms"). */
const answered = computed(() => {
  const ms = formatMs(props.metrics.totalMs);
  return ms ? `Answered in ${ms}` : '';
});

/** The unobtrusive technical detail revealed on hover/click — tokens, cost,
 * and (when more than one) llm-call count. "2.9k tokens · $0.0002". */
const detail = computed(() => {
  const m = props.metrics;
  const tok = formatTokens(m.tokensIn + m.tokensOut);
  const parts = [tok ? tok.replace(/\btok\b/, 'tokens') : null, formatCost(m.costUsd)].filter(
    (p): p is string => p !== null,
  );
  if (m.llmCalls > 1) parts.push(`${m.llmCalls} llm calls`);
  return parts.join(' · ');
});

function toggle(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <span class="cost-badge" v-if="answered || detail">
    <span v-if="answered" class="cost-answered">{{ answered }}</span>
    <button
      v-if="detail"
      type="button"
      class="cost-info"
      :title="detail"
      :aria-expanded="expanded"
      aria-label="Show token and cost detail"
      @click="toggle"
    >
      ⓘ
    </button>
    <span v-if="detail && expanded" class="cost-detail">{{ detail }}</span>
  </span>
</template>
