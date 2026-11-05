<script setup lang="ts">
import { computed } from 'vue';
import type { TurnMetrics } from '../lib/events.js';
import { formatCost, formatMs, formatTokens } from '../lib/format.js';

const props = defineProps<{ metrics: TurnMetrics }>();

/** Slim tabular strip — two-space gaps as separators, not middle dots. Any
 * part with nothing genuine to show (zero/unknown) is dropped rather than
 * rendered as a placeholder. */
const strip = computed(() => {
  const m = props.metrics;
  const parts = [
    formatMs(m.totalMs),
    formatTokens(m.tokensIn + m.tokensOut),
    formatCost(m.costUsd),
  ].filter((p): p is string => p !== null);
  if (m.llmCalls > 1) parts.push(`${m.llmCalls} llm calls`);
  return parts.join('  ');
});

const tokensTitle = computed(
  () => `in: ${props.metrics.tokensIn}  out: ${props.metrics.tokensOut}`,
);
</script>

<template>
  <span class="cost-badge" :title="tokensTitle">{{ strip }}</span>
</template>
