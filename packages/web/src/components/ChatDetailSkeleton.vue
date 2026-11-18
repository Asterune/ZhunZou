<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Render the title/chips row; the phone page draws its own back button. */
    showHeader?: boolean;
  }>(),
  { showHeader: true },
);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div
      v-if="showHeader"
      class="flex shrink-0 items-center gap-2 border-b border-outline-variant/30 px-3.5 py-3"
    >
      <div class="h-4 w-36 animate-pulse rounded bg-surface-container-high" />
      <div class="h-3 w-24 animate-pulse rounded bg-surface-container" />
      <div class="ml-auto h-6 w-16 animate-pulse rounded bg-surface-container" />
    </div>

    <div class="min-h-0 flex-1 space-y-3 overflow-hidden p-3.5">
      <div class="h-14 w-3/5 animate-pulse rounded-2xl bg-surface-container" />
      <div
        class="ml-auto h-10 w-2/5 animate-pulse rounded-2xl bg-surface-container-high"
      />
      <div class="h-24 w-4/5 animate-pulse rounded-2xl bg-surface-container" />
      <div
        class="ml-auto h-10 w-1/3 animate-pulse rounded-2xl bg-surface-container-high"
      />
      <div class="h-16 w-2/3 animate-pulse rounded-2xl bg-surface-container" />
    </div>

    <div class="shrink-0 border-t border-outline-variant/30 p-3">
      <div class="h-10 w-full animate-pulse rounded-xl bg-surface-container" />
    </div>
  </div>
</template>
