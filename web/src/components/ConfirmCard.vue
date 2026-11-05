<script setup lang="ts">
import { computed } from 'vue';
import type { PendingConfirm } from '../lib/fold.js';
import { deriveGateReason } from '../lib/gate-reason.js';

const props = defineProps<{ confirm: PendingConfirm }>();
const emit = defineEmits<{ resolve: [confirmId: string, approved: boolean] }>();

const reason = computed(() => deriveGateReason(props.confirm.scope));

function approve(): void {
  emit('resolve', props.confirm.confirmId, true);
}
function deny(): void {
  emit('resolve', props.confirm.confirmId, false);
}
</script>

<template>
  <div class="confirm-card agent-section">
    <div class="confirm-desc">{{ confirm.scope.description }}</div>
    <div class="confirm-reason">{{ reason }}</div>
    <div class="confirm-meta">
      Affects
      <span class="confirm-count">{{ confirm.scope.affectedCount }}</span>
      item{{ confirm.scope.affectedCount === 1 ? '' : 's' }}<span v-if="confirm.scope.actions.length">
        via {{ confirm.scope.actions.join(', ') }}</span
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
