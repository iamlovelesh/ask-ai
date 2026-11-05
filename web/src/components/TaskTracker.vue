<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { StepView, TurnView } from '../lib/fold.js';

const props = defineProps<{ turn: TurnView }>();

const activityOpen = ref(false);
/** Which finished/failed step rows have their inline detail expanded —
 * keyed by stepId, local to this tracker instance. */
const openSteps = reactive(new Set<string>());

function orderedSteps() {
  return props.turn.stepOrder.map((id) => props.turn.steps[id]).filter((s) => s !== undefined);
}

/** Only a terminal, informative step (done or failed) has anything useful
 * to expand into — pending/running/skipped rows stay plain. */
function isExpandable(step: StepView): boolean {
  return step.status === 'done' || step.status === 'failed';
}

function toggleStep(stepId: string): void {
  if (openSteps.has(stepId)) openSteps.delete(stepId);
  else openSteps.add(stepId);
}

/** Renders nothing for an unknown OR genuinely-zero duration — a step's
 * `ms` comes straight off the server's `step.finished`/`step.failed` event;
 * never render a "0ms" placeholder for an unmeasured/zero value. */
function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1) return '<1ms'; // real sub-ms duration — never a misleading "0ms"
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function adjustmentsLabel(count: number): string {
  return `${count} adjustment${count === 1 ? '' : 's'} during planning`;
}
</script>

<template>
  <div class="agent-section">
    <div v-if="turn.goal" class="tracker-goal">{{ turn.goal }}</div>
    <ol class="tracker">
      <li
        v-for="step in orderedSteps()"
        :key="step.stepId"
        :class="['tracker-step', `status-${step.status}`, { 'is-expandable': isExpandable(step) }]"
      >
        <span class="tracker-node" aria-hidden="true"></span>

        <button
          v-if="isExpandable(step)"
          type="button"
          class="tracker-row-btn"
          :aria-expanded="openSteps.has(step.stepId)"
          :aria-controls="`step-detail-${step.stepId}`"
          @click="toggleStep(step.stepId)"
        >
          <span class="tracker-chevron" :class="{ open: openSteps.has(step.stepId) }" aria-hidden="true">›</span>
          <span class="tracker-label">{{ step.action }}</span>
          <span class="tracker-dur">{{ formatMs(step.ms) }}</span>
        </button>
        <template v-else>
          <span class="tracker-label">{{ step.action }}</span>
          <span class="tracker-dur">{{ formatMs(step.ms) }}</span>
        </template>

        <span
          v-if="step.itemCount !== undefined && step.status !== 'failed'"
          class="tracker-detail"
        >
          {{ step.itemCount }} item{{ step.itemCount === 1 ? '' : 's' }}<template
            v-if="step.status === 'done' && step.summary"
          >
            — {{ step.summary }}</template
          >
        </span>
        <span
          v-else-if="step.status === 'done' && step.summary"
          class="tracker-detail"
          >{{ step.summary }}</span
        >
        <span v-if="step.status === 'failed' && step.error" class="tracker-detail is-fail">{{
          step.error.message
        }}</span>

        <div
          v-if="isExpandable(step) && openSteps.has(step.stepId)"
          :id="`step-detail-${step.stepId}`"
          class="tracker-step-detail"
        >
          <div v-if="step.summary" class="tracker-step-detail-row">
            <span class="tracker-step-detail-key">Summary</span>
            <span class="tracker-step-detail-val">{{ step.summary }}</span>
          </div>
          <div v-if="step.resultRef" class="tracker-step-detail-row">
            <span class="tracker-step-detail-key">Result ref</span>
            <span class="tracker-step-detail-val mono">{{ step.resultRef }}</span>
          </div>
          <div v-if="step.itemCount !== undefined" class="tracker-step-detail-row">
            <span class="tracker-step-detail-key">Items</span>
            <span class="tracker-step-detail-val">{{ step.itemCount }}</span>
          </div>
          <div v-if="step.status === 'failed' && step.error" class="tracker-step-detail-row">
            <span class="tracker-step-detail-key">Error</span>
            <span class="tracker-step-detail-val is-fail">{{ step.error.message }}</span>
          </div>
        </div>
      </li>
    </ol>
    <div v-if="turn.activity.length > 0" class="tracker-activity-disclosure">
      <button
        type="button"
        class="tracker-activity-toggle"
        :aria-expanded="activityOpen"
        @click="activityOpen = !activityOpen"
      >
        <span class="tracker-activity-caret" :class="{ open: activityOpen }" aria-hidden="true">›</span>
        {{ adjustmentsLabel(turn.activity.length) }}
      </button>
      <div v-if="activityOpen" class="tracker-activity-raw">
        <div v-for="(line, i) in turn.activity" :key="i" class="tracker-activity-line">{{ line }}</div>
      </div>
    </div>
  </div>
</template>
