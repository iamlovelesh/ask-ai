<script setup lang="ts">
/**
 * Renders a `kind:'clarify'` plan outcome's question. Per the LLD, the
 * clarifying answer is just the user's NEXT message in the same composer,
 * which starts a normal new turn (the planner's working-state fold picks up
 * the prior turn's frame) — there is no dedicated "answer" API. When the
 * question itself reads as a short enumerated choice (`lib/clarify.ts`),
 * this renders reply chips as a shortcut: picking one fills the composer
 * with that exact option and sends it immediately, rather than requiring
 * the user to retype it.
 */
import { computed } from 'vue';
import { parseClarifyOptions } from '../lib/clarify.js';

const props = defineProps<{ question: string }>();
const emit = defineEmits<{ reply: [text: string] }>();

const options = computed(() => parseClarifyOptions(props.question));

function pick(option: string): void {
  emit('reply', option);
}
</script>

<template>
  <div class="clarify-card agent-section">
    <span class="clarify-lead">Needs clarification</span>
    {{ question }}
    <div v-if="options" class="clarify-chips">
      <button
        v-for="opt in options"
        :key="opt"
        type="button"
        class="chip clarify-chip"
        @click="pick(opt)"
      >
        {{ opt }}
      </button>
    </div>
  </div>
</template>
