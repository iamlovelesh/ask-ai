<script setup lang="ts">
import type { TurnView } from '../lib/fold.js';

const props = defineProps<{ turn: TurnView }>();

function orderedSteps() {
  return props.turn.stepOrder.map((id) => props.turn.steps[id]).filter((s) => s !== undefined);
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
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
    <div v-for="(line, i) in turn.activity" :key="i" class="tracker-activity">{{ line }}</div>
  </div>
</template>
