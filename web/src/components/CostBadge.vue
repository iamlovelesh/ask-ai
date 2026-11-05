<script setup lang="ts">
import { computed } from 'vue';
import type { TurnMetrics } from '../lib/events.js';

const props = defineProps<{ metrics: TurnMetrics }>();

/** A genuinely-zero/unknown value renders NOTHING — never a "0ms"/"$0.0000"
 * placeholder. Some real turns legitimately have no cost (e.g. a
 * cached/free model call) or no measured duration, and those are omitted
 * from the strip entirely rather than padded out with a zero. */
function formatMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatTokens(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

function formatCost(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return `$${usd.toFixed(4)}`;
}

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
