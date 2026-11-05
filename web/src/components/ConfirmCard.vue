<script setup lang="ts">
import { computed, onMounted } from 'vue';
import type { PendingConfirm } from '../lib/fold.js';
import { deriveGateReason } from '../lib/gate-reason.js';
import { useCatalogStore } from '../stores/catalog.js';

const props = defineProps<{ confirm: PendingConfirm }>();
const emit = defineEmits<{ resolve: [confirmId: string, approved: boolean] }>();

const catalog = useCatalogStore();
onMounted(() => void catalog.load());

const reason = computed(() => deriveGateReason(props.confirm.scope));

/** The scope description from the server leads with the action slug
 * (`invoices.send_invoice_reminder affecting 20 record(s).`). Swap that
 * leading slug for its human name so the gate's headline reads in plain
 * language; the rest of the sentence is kept verbatim. */
const humanDescription = computed(() => {
  const desc = props.confirm.scope.description;
  const match = desc.match(/^([a-z0-9]+(?:[._][a-z0-9]+)+)\b/i);
  if (!match) return desc;
  return `${catalog.actionName(match[1] as string)}${desc.slice(match[1]!.length)}`;
});

/** The gate's actions, shown by human name (the raw slugs stay internal to
 * `gate-reason`'s heuristic). The target sample below keeps its ids — those
 * are genuinely useful for knowing exactly what's affected. */
const actionNames = computed(() =>
  props.confirm.scope.actions.map((slug) => catalog.actionName(slug)).join(', '),
);

function approve(): void {
  emit('resolve', props.confirm.confirmId, true);
}
function deny(): void {
  emit('resolve', props.confirm.confirmId, false);
}
</script>

<template>
  <div class="confirm-card agent-section">
    <div class="confirm-desc">{{ humanDescription }}</div>
    <div class="confirm-reason">{{ reason }}</div>
    <div class="confirm-meta">
      Affects
      <span class="confirm-count">{{ confirm.scope.affectedCount }}</span>
      item{{ confirm.scope.affectedCount === 1 ? '' : 's' }}<span v-if="confirm.scope.actions.length">
        via {{ actionNames }}</span
      >
    </div>
    <ul v-if="confirm.scope.targetSample.length" class="confirm-sample">
      <li v-for="(t, i) in confirm.scope.targetSample.slice(0, 5)" :key="i">{{ t }}</li>
      <li v-if="confirm.scope.targetSample.length > 5">
        and {{ confirm.scope.targetSample.length - 5 }} more
      </li>
    </ul>

    <div v-if="!confirm.resolved" class="confirm-actions">
      <button class="btn-approve" :disabled="confirm.resolved" @click="approve">Approve</button>
      <button class="btn-deny" :disabled="confirm.resolved" @click="deny">Deny</button>
    </div>
    <div v-else class="confirm-resolved">
      {{ confirm.approved ? 'Approved' : 'Denied' }}
    </div>
  </div>
</template>
