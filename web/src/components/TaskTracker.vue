<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { StepView, TurnView } from '../lib/fold.js';
import { useCatalogStore } from '../stores/catalog.js';
import { parseStepSummary } from '../lib/step-summary.js';
import { loadingLabel } from '../lib/step-label.js';
import ShimmeringText from './ShimmeringText.vue';

const props = defineProps<{ turn: TurnView }>();

const catalog = useCatalogStore();
onMounted(() => void catalog.load());

/** The timeline is collapsed by default (ThinkingStepsDisplay) — a
 * finished turn shows a single "Worked for Ns" summary; expand for the steps. */
const expanded = ref(false);

/** The turn is still working until a terminal status lands. */
const working = computed(() => props.turn.status === undefined);

/** The step currently running (last one in 'running' state). */
const activeStep = computed(() =>
  orderedSteps()
    .filter((s) => s.status === 'running')
    .at(-1),
);

/** The "Worked for Ns" figure: the real turn duration (metrics.totalMs,
 * which includes LLM time) once the turn completes — NOT the sum of step
 * handler times, which is just DB latency and reads misleadingly small. */
const totalMs = computed(() => props.turn.metrics?.totalMs ?? 0);

/** Header text when working: the active step narrated, else "Thinking…". */
const workingLabel = computed(() =>
  activeStep.value ? loadingLabel(activeStep.value.action, actionName(activeStep.value)) : 'Thinking…',
);

/** Header text when done: "Worked for 1.4s" (or a step count if untimed). */
const doneLabel = computed(() => {
  const ms = formatMs(totalMs.value);
  if (ms) return `Worked for ${ms}`;
  const n = orderedSteps().length;
  return n > 0 ? `${n} step${n === 1 ? '' : 's'}` : 'Done';
});

/** The action's human name (catalog name, else prettified slug) — the
 * primary label of a step row. The raw slug moves into the expanded detail. */
function actionName(step: StepView): string {
  return catalog.actionName(step.action);
}

/** The human remainder of a step's summary — count + noun + any drift note,
 * with the leading slug and `[ref …]` fragment peeled off into the detail. */
function summaryPrimary(step: StepView): string {
  return parseStepSummary(step.summary).primary;
}

/** The result ref to surface in the detail — the explicit `resultRef` field
 * if present, else one parsed out of the summary's `[ref …]` fragment. */
function resultRefOf(step: StepView): string | undefined {
  return step.resultRef ?? parseStepSummary(step.summary).ref;
}

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

    <!-- Collapsible "thinking steps" summary (pattern). Collapsed by
         default; the header shimmers the active step while working and shows
         "Worked for Ns" once done. -->
    <button
      v-if="orderedSteps().length > 0 || working"
      type="button"
      class="tracker-summary"
      :class="{ 'is-working': working }"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span v-if="working" class="tracker-summary-spin" aria-hidden="true"></span>
      <span v-else class="tracker-summary-caret" :class="{ open: expanded }" aria-hidden="true">›</span>
      <ShimmeringText v-if="working" :text="workingLabel" class="tracker-summary-label" />
      <span v-else class="tracker-summary-label">{{ doneLabel }}</span>
      <span v-if="orderedSteps().length > 0" class="tracker-summary-count"
        >· {{ orderedSteps().length }} step{{ orderedSteps().length === 1 ? '' : 's' }}</span
      >
    </button>

    <ol v-show="expanded" class="tracker">
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
          <span class="tracker-label">{{ actionName(step) }}</span>
          <span class="tracker-dur">{{ formatMs(step.ms) }}</span>
        </button>
        <template v-else>
          <ShimmeringText
            v-if="step.status === 'running'"
            :text="loadingLabel(step.action, actionName(step))"
            class="tracker-label"
          />
          <span v-else class="tracker-label">{{ actionName(step) }}</span>
          <span class="tracker-dur">{{ formatMs(step.ms) }}</span>
        </template>

        <span
          v-if="step.status === 'done' && summaryPrimary(step)"
          class="tracker-detail"
          >{{ summaryPrimary(step) }}</span
        >
        <span
          v-else-if="step.itemCount !== undefined && step.status !== 'failed'"
          class="tracker-detail"
        >
          {{ step.itemCount }} item{{ step.itemCount === 1 ? '' : 's' }}</span
        >
        <span v-if="step.status === 'failed' && step.error" class="tracker-detail is-fail">{{
          step.error.message
        }}</span>

        <div
          v-if="isExpandable(step) && openSteps.has(step.stepId)"
          :id="`step-detail-${step.stepId}`"
          class="tracker-step-detail"
        >
          <div class="tracker-step-detail-row">
            <span class="tracker-step-detail-key">Action</span>
            <span class="tracker-step-detail-val mono">{{ step.action }}</span>
          </div>
          <div v-if="summaryPrimary(step)" class="tracker-step-detail-row">
            <span class="tracker-step-detail-key">Result</span>
            <span class="tracker-step-detail-val">{{ summaryPrimary(step) }}</span>
          </div>
          <div v-if="resultRefOf(step)" class="tracker-step-detail-row">
            <span class="tracker-step-detail-key">Result ref</span>
            <span class="tracker-step-detail-val mono">{{ resultRefOf(step) }}</span>
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
