<script setup lang="ts">
import type { TurnMetrics } from '../lib/events.js';

defineProps<{ metrics: TurnMetrics }>();

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  return `$${usd.toFixed(4)}`;
}

/** Trivial Task 19 enhancement: a native tooltip breaking the single
 * combined token count down into in/out — `TurnMetrics` has no
 * `tokensCached` field (that only exists per-LLM-call on `LlmUsage`), so
 * this is the full breakdown actually available at the turn level. */
function tokensTitle(metrics: TurnMetrics): string {
  return `in: ${metrics.tokensIn} · out: ${metrics.tokensOut}`;
}
</script>

<template>
  <div class="cost-badge" title="Turn metrics (turn.completed)">
    <span>{{ formatMs(metrics.totalMs) }}</span>
    <span :title="tokensTitle(metrics)">{{ metrics.tokensIn + metrics.tokensOut }} tok</span>
    <span>{{ formatCost(metrics.costUsd) }}</span>
    <span v-if="metrics.llmCalls > 1">{{ metrics.llmCalls }} llm calls</span>
  </div>
</template>
