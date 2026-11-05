<script setup lang="ts">
/**
 * Renders a `kind:'clarify'` plan outcome's question. There is no special
 * "reply" control — per the LLD, the clarifying answer is just the user's
 * NEXT message in the same composer, which starts a normal new turn (the
 * planner's working-state fold picks up the prior turn's frame). This card
 * is purely informational.
 */
defineProps<{ question: string }>();
</script>

<template>
  <div class="clarify-card">
    <strong>Needs clarification:</strong> {{ question }}
  </div>
</template>
