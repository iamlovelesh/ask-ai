<script setup lang="ts">
import { computed } from 'vue';
import { useSessionStore, type SelectableRole } from '../stores/session.js';

defineProps<{ disabled?: boolean }>();
const store = useSessionStore();

interface RoleOption {
  value: SelectableRole;
  label: string;
  icon: string;
  hint: string;
}
const ROLES: RoleOption[] = [
  { value: 'admin', label: 'Admin', icon: '🛡️', hint: 'All actions, including deletes & bulk' },
  { value: 'member', label: 'Member', icon: '✎', hint: 'Read and write; no deletes/bulk/external' },
  { value: 'viewer', label: 'Viewer', icon: '👁', hint: 'Read-only' },
];

// Empty persisted role = the server's admin default.
const current = computed<SelectableRole>(() => (store.selectedRole === '' ? 'admin' : (store.selectedRole as SelectableRole)));
const hint = computed(() => ROLES.find((r) => r.value === current.value)?.hint ?? '');

function pick(role: SelectableRole): void {
  store.selectRole(role);
}
</script>

<template>
  <div class="role-picker" :title="hint">
    <span class="role-picker-label">Role</span>
    <div class="role-seg" role="group" aria-label="Acting role">
      <button
        v-for="r in ROLES"
        :key="r.value"
        type="button"
        class="role-seg-btn"
        :class="{ 'is-on': current === r.value }"
        :disabled="disabled"
        :aria-pressed="current === r.value"
        :title="r.hint"
        @click="pick(r.value)"
      >
        <span class="role-seg-icon" aria-hidden="true">{{ r.icon }}</span>{{ r.label }}
      </button>
    </div>
  </div>
</template>
