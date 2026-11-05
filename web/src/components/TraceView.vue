<script setup lang="ts">
/**
 * Per-turn span waterfall (LLD §6/§2.4, Task 19). Rendered inside the
 * inspector drawer (`embedded`): no toggle of its own — it loads the trace
 * for `turnId` on mount and whenever `turnId` changes (`store.loadTrace`,
 * cached by `turnId`). Pure CSS bars, no chart library.
 *
 * Honesty note rendered inline (see template): the server's span recorder
 * writes every `SpanKind` but still with no parent linkage — so the list is
 * flat rather than nested.
 */
import { computed, onMounted, watch } from 'vue';
import { useSessionStore } from '../stores/session.js';
import { layoutSpans } from '../lib/trace.js';

const props = defineProps<{ turnId: string }>();
const store = useSessionStore();

const traceState = computed(() => store.traces[props.turnId] ?? null);
const bars = computed(() => layoutSpans(traceState.value?.spans ?? []));

onMounted(() => void store.loadTrace(props.turnId));
watch(
  () => props.turnId,
  (id) => void store.loadTrace(id),
);

function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '';
  return `$${usd.toFixed(4)}`;
}

function formatTokens(tokensIn: number | undefined, tokensOut: number | undefined): string {
  if (tokensIn === undefined && tokensOut === undefined) return '';
  return `${tokensIn ?? 0}→${tokensOut ?? 0} tok`;
}
</script>

<template>
  <div class="trace-view">
    <div v-if="traceState?.loading" class="trace-status">Loading spans…</div>
    <div v-else-if="traceState?.error" class="trace-status trace-status-error">
      {{ traceState.error }}
    </div>
    <div v-else-if="bars.length === 0" class="trace-status">No spans recorded for this turn.</div>
    <template v-else>
      <div class="trace-note">
        Spans cover the full pipeline (llm, retrieval, step, joiner, compose). No parent links are
        persisted, so this list is flat rather than nested.
      </div>
      <div v-for="bar in bars" :key="bar.span.id" class="trace-row">
        <div class="trace-row-label">
          <span :class="['trace-dot', `kind-${bar.span.kind}`]"></span>
          <span class="trace-row-name">{{ bar.label }}</span>
          <span class="trace-row-meta">
            {{ formatMs(bar.span.ms) }}
            <template v-if="formatTokens(bar.span.tokensIn, bar.span.tokensOut)">
              {{ formatTokens(bar.span.tokensIn, bar.span.tokensOut) }}
            </template>
            <template v-if="formatCost(bar.span.costUsd)">{{ formatCost(bar.span.costUsd) }}</template>
            <span v-if="bar.status === 'failed'" class="trace-row-failed">failed</span>
            <span v-else-if="bar.status === 'running'" class="trace-row-running">running</span>
          </span>
        </div>
        <div class="trace-track">
          <div
            :class="['trace-bar', `kind-${bar.span.kind}`, { 'trace-bar-failed': bar.status === 'failed' }]"
            :style="{ left: bar.leftPct + '%', width: bar.widthPct + '%' }"
            :title="`${bar.label} — ${formatMs(bar.span.ms)}`"
          ></div>
        </div>
      </div>
    </template>
  </div>
</template>
