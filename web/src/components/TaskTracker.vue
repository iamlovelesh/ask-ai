<script setup lang="ts">
import type { TurnView } from '../lib/fold.js';

const props = defineProps<{ turn: TurnView }>();

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  running: '●',
  done: '✓',
  failed: '✕',
  skipped: '–',
};

function orderedSteps() {
  return props.turn.stepOrder.map((id) => props.turn.steps[id]).filter((s) => s !== undefined);
}
</script>

<template>
  <div class="task-tracker">
    <div v-if="turn.goal" class="goal-line">Goal: {{ turn.goal }}</div>
    <div v-for="step in orderedSteps()" :key="step.stepId" :class="['step-row', `status-${step.status}`]">
      <span class="step-icon">{{ STATUS_ICON[step.status] ?? '?' }}</span>
      <span class="step-action">{{ step.action }}</span>
      <span v-if="step.itemCount !== undefined" class="step-summary">({{ step.itemCount }} items)</span>
      <span v-if="step.status === 'done' && step.summary" class="step-summary">{{ step.summary }}</span>
      <span v-if="step.status === 'failed' && step.error" class="step-error">{{ step.error.message }}</span>
    </div>
    <div v-for="(line, i) in turn.activity" :key="i" class="activity-log">{{ line }}</div>
  </div>
</template>
