<script setup lang="ts">
import type { PendingConfirm } from '../lib/fold.js';

const props = defineProps<{ confirm: PendingConfirm }>();
const emit = defineEmits<{ resolve: [confirmId: string, approved: boolean] }>();

function approve(): void {
  emit('resolve', props.confirm.confirmId, true);
}
function deny(): void {
  emit('resolve', props.confirm.confirmId, false);
}
</script>

<template>
  <div class="confirm-card">
    <div class="confirm-card-desc">{{ confirm.scope.description }}</div>
    <div class="confirm-card-meta">
      Affects {{ confirm.scope.affectedCount }} item{{ confirm.scope.affectedCount === 1 ? '' : 's' }}
      <span v-if="confirm.scope.actions.length"> · {{ confirm.scope.actions.join(', ') }}</span>
    </div>
    <div v-if="confirm.scope.targetSample.length" class="confirm-sample">
      e.g. {{ confirm.scope.targetSample.slice(0, 5).join(', ') }}
      <span v-if="confirm.scope.targetSample.length > 5">…</span>
    </div>

    <div v-if="!confirm.resolved" class="confirm-actions">
      <button class="btn btn-approve" :disabled="confirm.resolved" @click="approve">Approve</button>
      <button class="btn btn-deny" :disabled="confirm.resolved" @click="deny">Deny</button>
    </div>
    <div v-else class="confirm-resolved">
      {{ confirm.approved ? 'Approved' : 'Denied' }}
    </div>
  </div>
</template>
