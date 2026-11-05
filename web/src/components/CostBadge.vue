<script setup lang="ts">
import { computed } from 'vue';
import type { TurnMetrics } from '../lib/events.js';

const props = defineProps<{ metrics: TurnMetrics }>();

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  return `$${usd.toFixed(4)}`;
}

/** Slim tabular strip — two-space gaps as separators, not middle dots. */
const strip = computed(() => {
  const m = props.metrics;
  const parts = [formatMs(m.totalMs), formatTokens(m.tokensIn + m.tokensOut), formatCost(m.costUsd)];
  if (m.llmCalls > 1) parts.push(`${m.llmCalls} llm calls`);
  return parts.join('  ');
});

const tokensTitle = computed(
  () => `in: ${props.metrics.tokensIn}  out: ${props.metrics.tokensOut}`,
);
</script>

<template>
  <span class="cost-badge" :title="tokensTitle">{{ strip }}</span>
</template>
