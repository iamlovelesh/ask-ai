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
</script>

<template>
  <div class="cost-badge" title="Turn metrics (turn.completed)">
    <span>{{ formatMs(metrics.totalMs) }}</span>
    <span>{{ metrics.tokensIn + metrics.tokensOut }} tok</span>
    <span>{{ formatCost(metrics.costUsd) }}</span>
    <span v-if="metrics.llmCalls > 1">{{ metrics.llmCalls }} llm calls</span>
  </div>
</template>
