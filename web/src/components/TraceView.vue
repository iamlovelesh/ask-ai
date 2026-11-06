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
import { isLegacyTrace, layoutSpans } from '../lib/trace.js';

const props = defineProps<{ turnId: string }>();
const store = useSessionStore();

const traceState = computed(() => store.traces[props.turnId] ?? null);
const spans = computed(() => traceState.value?.spans ?? []);
/** Durable-memory ops the post-turn extractor performed for this turn — folded
 * onto the turn from `memory.op` events (surface on replay/reload, since
 * extraction runs after the live stream closes). */
const memoryOps = computed(() => store.activeChat?.turns.find((t) => t.turnId === props.turnId)?.memoryOps ?? []);
const OP_LABEL: Record<string, string> = { ADD: 'Added', UPDATE: 'Updated', DELETE: 'Forgot' };
const bars = computed(() => layoutSpans(spans.value));
/** A turn recorded before span-timing instrumentation — its bars are drawn
 * equal-width in recorded order (no real offsets exist) with a quiet note. */
const legacy = computed(() => isLegacyTrace(spans.value));

onMounted(() => void store.loadTrace(props.turnId));
watch(
  () => props.turnId,
  (id) => void store.loadTrace(id),
);

function formatMs(ms: number | undefined): string {
  // No "0ms" / "—" clutter: an unknown or non-positive duration renders as
  // nothing, and a real sub-millisecond duration as "<1ms" (not "0ms").
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1) return '<1ms';
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

/** Joins the present ms/tokens/cost metrics with a separating space, so a
 * span's meta never renders them jammed together ("tok$0.0002"). Empty
 * parts (unknown/zero) are dropped. */
function metricText(ms: number | undefined, tokensIn: number | undefined, tokensOut: number | undefined, costUsd: number | undefined): string {
  return [formatMs(ms), formatTokens(tokensIn, tokensOut), formatCost(costUsd)].filter(Boolean).join('  ');
}
</script>

<template>
  <div class="trace-view">
    <!-- Memory operations for this turn (what was remembered from this message) -->
    <section v-if="memoryOps.length > 0" class="trace-mem">
      <div class="trace-mem-title">Memory updated from this message</div>
      <ul class="trace-mem-list">
        <li v-for="(m, i) in memoryOps" :key="i" class="trace-mem-item">
          <span :class="['trace-mem-badge', `op-${m.op.toLowerCase()}`]">{{ OP_LABEL[m.op] ?? m.op }}</span>
          <span class="trace-mem-body">
            <span class="trace-mem-cat">{{ m.category }}</span>
            <span v-if="m.key" class="trace-mem-key">{{ m.key }}:</span>
            {{ m.body }}
          </span>
        </li>
      </ul>
    </section>

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
      <div v-if="legacy" class="trace-note trace-note-legacy">
        Recorded before timing instrumentation — durations approximate.
      </div>
      <div v-for="bar in bars" :key="bar.span.id" class="trace-row">
        <div class="trace-row-label">
          <span :class="['trace-dot', `kind-${bar.span.kind}`]"></span>
          <span class="trace-row-name">{{ bar.label }}</span>
          <span class="trace-row-meta">
            {{ metricText(bar.span.ms, bar.span.tokensIn, bar.span.tokensOut, bar.span.costUsd) }}
            <span v-if="bar.status === 'failed'" class="trace-row-failed">failed</span>
            <span v-else-if="bar.status === 'running'" class="trace-row-running">running</span>
          </span>
        </div>
        <div class="trace-track">
          <div
            :class="['trace-bar', `kind-${bar.span.kind}`, { 'trace-bar-failed': bar.status === 'failed' }]"
            :style="{ left: bar.leftPct + '%', width: bar.widthPct + '%' }"
            :title="formatMs(bar.span.ms) ? `${bar.label} — ${formatMs(bar.span.ms)}` : bar.label"
          ></div>
        </div>
      </div>
    </template>
  </div>
</template>
