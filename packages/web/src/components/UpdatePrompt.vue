<script setup lang="ts">
import { Download, Loader2 } from 'lucide-vue-next';
import { nextTick, ref, watch } from 'vue';

import { useI18n } from '../lib/i18n';
import {
  applyUpdate,
  dismissUpdate,
  updateReady,
  updating,
} from '../lib/pwa';

const { t } = useI18n();
const updateButton = ref<HTMLButtonElement | null>(null);

// Focus the primary action so keyboard users can confirm with Enter and use
// Esc to defer, matching the two choices in the dialog.
watch(updateReady, async (open) => {
  if (!open) return;
  await nextTick();
  updateButton.value?.focus();
});
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0"
  >
    <div
      v-if="updateReady"
      class="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))] backdrop-blur-sm sm:items-center"
      role="alertdialog"
      aria-modal="true"
      :aria-label="t('update.aria')"
      @click.self="dismissUpdate"
      @keydown.esc="dismissUpdate"
    >
      <div
        class="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl ring-1 ring-outline-variant/40"
      >
        <div class="flex items-start gap-3">
          <span
            class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-fixed text-on-primary-fixed"
          >
            <Download :size="19" />
          </span>
          <div class="min-w-0">
            <h2
              class="text-lg font-semibold text-on-surface"
              style="font-family: var(--font-serif)"
            >
              {{ t('update.title') }}
            </h2>
            <p class="mt-1 text-xs leading-5 text-on-surface-variant">
              {{ t('update.desc') }}
            </p>
          </div>
        </div>

        <div class="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            :disabled="updating"
            class="h-10 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container disabled:opacity-50"
            @click="dismissUpdate"
          >
            {{ t('update.later') }}
          </button>
          <button
            ref="updateButton"
            type="button"
            :disabled="updating"
            class="flex h-10 min-w-[112px] items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary shadow-sm transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50"
            @click="applyUpdate"
          >
            <Loader2 v-if="updating" :size="16" class="animate-spin" />
            {{ updating ? t('update.applying') : t('update.now') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
