<script setup lang="ts">
/**
 * Per-turn span waterfall (LLD §6/§2.4, Task 19). Collapsed by default —
 * fetches `GET /api/traces/:turnId` only the first time it's expanded
 * (`store.loadTrace`, cached by `turnId`). Pure CSS bars, no chart library.
 *
 * Honesty note rendered inline (see template): the server's current span
 * recorder only ever writes `kind:'llm'` spans with no parent linkage (see
 * `lib/trace.ts`'s header) — so there is no indentation to draw. If a
 * future recorder starts tagging `meta.parentId`, this component can grow
 * indentation without changing its data contract.
 */
import { computed, ref } from 'vue';
import { useSessionStore } from '../stores/session.js';
import { layoutSpans } from '../lib/trace.js';

const props = defineProps<{ turnId: string }>();
const store = useSessionStore();
const open = ref(false);

const traceState = computed(() => store.traces[props.turnId] ?? null);
const bars = computed(() => layoutSpans(traceState.value?.spans ?? []));

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (open.value) await store.loadTrace(props.turnId);
}

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
    <button class="trace-toggle" @click="toggle">{{ open ? '▾' : '▸' }} Trace</button>

    <div v-if="open" class="trace-panel">
      <div v-if="traceState?.loading" class="trace-status">Loading spans…</div>
      <div v-else-if="traceState?.error" class="trace-status trace-status-error">{{ traceState.error }}</div>
      <div v-else-if="bars.length === 0" class="trace-status">No spans recorded for this turn.</div>
      <template v-else>
        <div class="trace-note">
          Spans today are LLM calls only (planner/repair/replan/search/joiner) — no retrieval/step/joiner/compose
          spans or parent links are persisted yet, so this list is flat.
        </div>
        <div v-for="bar in bars" :key="bar.span.id" class="trace-row">
          <div class="trace-row-label">
            <span :class="['trace-dot', `kind-${bar.span.kind}`]"></span>
            <span class="trace-row-name">{{ bar.label }}</span>
            <span class="trace-row-meta">
              {{ formatMs(bar.span.ms) }}
              <template v-if="formatTokens(bar.span.tokensIn, bar.span.tokensOut)">
                · {{ formatTokens(bar.span.tokensIn, bar.span.tokensOut) }}
              </template>
              <template v-if="formatCost(bar.span.costUsd)"> · {{ formatCost(bar.span.costUsd) }}</template>
              <span v-if="bar.status === 'failed'" class="trace-row-failed"> · failed</span>
              <span v-else-if="bar.status === 'running'" class="trace-row-running"> · running</span>
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
  </div>
</template>
