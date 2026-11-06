<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { PendingConfirm } from '../lib/fold.js';
import { deriveGateReason } from '../lib/gate-reason.js';
import { useCatalogStore } from '../stores/catalog.js';

const props = defineProps<{ confirm: PendingConfirm }>();
const emit = defineEmits<{ resolve: [confirmId: string, approved: boolean, editedParams?: Record<string, unknown>] }>();

const catalog = useCatalogStore();
onMounted(() => void catalog.load());

// Approval-arg editing (#6): render scalar params as editable fields. Complex
// values (arrays/objects) are shown read-only — only scalars can be edited.
function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}
const editableKeys = computed(() =>
  Object.entries(props.confirm.scope.params ?? {})
    .filter(([, v]) => isScalar(v))
    .map(([k]) => k),
);
const hasEditable = computed(() => editableKeys.value.length > 0);
const editing = ref(false);
// String-backed drafts (inputs are text); coerced back to the original type on submit.
const drafts = reactive<Record<string, string>>({});
function resetDrafts(): void {
  const params = props.confirm.scope.params ?? {};
  for (const k of editableKeys.value) drafts[k] = String(params[k]);
}
function toggleEdit(): void {
  editing.value = !editing.value;
  if (editing.value) resetDrafts();
}

/** Drafts that differ from the original, coerced back to the original type. */
function collectEdits(): Record<string, unknown> {
  const params = props.confirm.scope.params ?? {};
  const edits: Record<string, unknown> = {};
  for (const k of editableKeys.value) {
    const orig = params[k];
    const raw = drafts[k] ?? '';
    let next: unknown = raw;
    if (typeof orig === 'number') next = Number(raw);
    else if (typeof orig === 'boolean') next = raw === 'true';
    if (next !== orig && !(typeof orig === 'number' && Number.isNaN(next as number))) edits[k] = next;
  }
  return edits;
}

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
  const edits = editing.value ? collectEdits() : {};
  emit('resolve', props.confirm.confirmId, true, Object.keys(edits).length > 0 ? edits : undefined);
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

    <!-- Approval-arg editing (#6): edit the proposed values before approving -->
    <div v-if="editing && hasEditable" class="confirm-edit">
      <div v-for="k in editableKeys" :key="k" class="confirm-edit-row">
        <label :for="`edit-${confirm.confirmId}-${k}`">{{ k }}</label>
        <input :id="`edit-${confirm.confirmId}-${k}`" v-model="drafts[k]" type="text" />
      </div>
    </div>

    <div v-if="!confirm.resolved" class="confirm-actions">
      <button class="btn-approve" :disabled="confirm.resolved" @click="approve">
        {{ editing ? 'Approve with edits' : 'Approve' }}
      </button>
      <button class="btn-deny" :disabled="confirm.resolved" @click="deny">Deny</button>
      <button v-if="hasEditable" class="btn-edit" :disabled="confirm.resolved" @click="toggleEdit">
        {{ editing ? 'Cancel edit' : 'Edit values' }}
      </button>
    </div>
    <div v-else class="confirm-resolved">
      {{ confirm.approved ? 'Approved' : 'Denied' }}
    </div>
  </div>
</template>
