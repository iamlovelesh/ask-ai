<script setup lang="ts">
import { ref } from 'vue';
import type { TurnView } from '../lib/fold.js';

const props = defineProps<{ turn: TurnView }>();

const activityOpen = ref(false);

function orderedSteps() {
  return props.turn.stepOrder.map((id) => props.turn.steps[id]).filter((s) => s !== undefined);
}

/** Renders nothing for an unknown OR genuinely-zero duration — the backend's
 * per-step clock is currently pinned (see the redesign report's polish
 * section), so `ms: 0` on every step is real upstream data, not a replay
 * fold bug. Never render a "0ms" placeholder either way. */
function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '';
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
        :class="['tracker-step', `status-${step.status}`]"
      >
        <span class="tracker-node" aria-hidden="true"></span>
        <span class="tracker-label">{{ step.action }}</span>
        <span class="tracker-dur">{{ formatMs(step.ms) }}</span>
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
