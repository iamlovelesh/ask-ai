<script setup lang="ts">
/** A gradient sweep over text — the "it's working right now" signal ('s
 * ShimmeringText). Pure CSS; falls back to a static muted color under
 * prefers-reduced-motion. */
defineProps<{ text: string }>();
</script>

<template>
  <span class="shimmer" :aria-label="text">{{ text }}</span>
</template>

<style scoped>
.shimmer {
  background: linear-gradient(
    100deg,
    var(--ink-dim, #6b7280) 20%,
    var(--ink, #111827) 45%,
    var(--ink, #111827) 55%,
    var(--ink-dim, #6b7280) 80%
  );
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: shimmer-sweep 1.6s linear infinite;
}
@keyframes shimmer-sweep {
  0% {
    background-position: 180% 0;
  }
  100% {
    background-position: -80% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .shimmer {
    animation: none;
    background: none;
    color: var(--ink-dim, #6b7280);
  }
}
</style>
