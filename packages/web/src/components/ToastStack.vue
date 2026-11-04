<script setup lang="ts">
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-vue-next';

import { useToasts, type ToastKind } from '../lib/toast';

const { toasts, dismissToast } = useToasts();

const kindClasses: Record<ToastKind, string> = {
  success: 'border-secondary/20 bg-inverse-surface text-inverse-on-surface',
  error: 'border-error/25 bg-error-container text-on-error-container',
  info: 'border-outline-variant/40 bg-surface-container-lowest text-on-surface',
};

const iconClasses: Record<ToastKind, string> = {
  success: 'text-secondary-container',
  error: 'text-error',
  info: 'text-primary',
};
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-0 bottom-[calc(5rem_+_env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 sm:bottom-[calc(1.5rem_+_env(safe-area-inset-bottom))] sm:items-end sm:pr-6"
  >
    <TransitionGroup
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="translate-y-1 opacity-0"
    >
      <button
        v-for="toast in toasts"
        :key="toast.id"
        type="button"
        class="pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border px-3.5 py-3 text-left shadow-xl sm:w-auto"
        :class="kindClasses[toast.kind]"
        @click="dismissToast(toast.id)"
      >
        <CheckCircle2
          v-if="toast.kind === 'success'"
          :size="18"
          class="mt-0.5 shrink-0"
          :class="iconClasses[toast.kind]"
        />
        <AlertCircle
          v-else-if="toast.kind === 'error'"
          :size="18"
          class="mt-0.5 shrink-0"
          :class="iconClasses[toast.kind]"
        />
        <Info v-else :size="18" class="mt-0.5 shrink-0 text-primary" />
        <span class="min-w-0 flex-1 text-sm leading-5">{{ toast.message }}</span>
        <X :size="14" class="mt-0.5 shrink-0 opacity-50" />
      </button>
    </TransitionGroup>
  </div>
</template>
