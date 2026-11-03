<script setup lang="ts">
import {
  AlertTriangle,
  Check,
  Clock3,
  Gavel,
  Loader2,
  X,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import type { DecisionTicket } from '@zhunzou/shared';

import { useHubStore } from '../stores/hub';

const props = defineProps<{
  open: boolean;
  tickets: DecisionTicket[];
}>();
const emit = defineEmits<{ close: [] }>();

const store = useHubStore();
const confirmDestructive = ref(false);
const countdown = ref(0);

let timer: ReturnType<typeof setInterval> | null = null;

const destructiveTickets = computed(() =>
  props.tickets.filter(
    (ticket) =>
      ticket.options.find(
        (option) => option.key === ticket.recommendedOption,
      )?.risk === 'destructive',
  ),
);

function clearTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function reset(): void {
  clearTimer();
  countdown.value = 0;
  confirmDestructive.value = false;
}

watch(
  () => props.open,
  (open) => {
    if (open) reset();
    else clearTimer();
  },
);

function close(): void {
  if (store.batchResolving) return;
  emit('close');
}

function start(): void {
  if (store.batchResolving) return;

  // The same button is the undo action during the 3-second window.
  if (countdown.value > 0) {
    reset();
    return;
  }

  countdown.value = 3;
  timer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) {
      clearTimer();
      void submit();
    }
  }, 1000);
}

async function submit(): Promise<void> {
  const ok = await store.batchResolveTickets(
    props.tickets.map((ticket) => ticket.id),
    confirmDestructive.value,
  );
  if (ok) {
    reset();
    emit('close');
  }
}

onBeforeUnmount(clearTimer);
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4"
    role="dialog"
    aria-modal="true"
    aria-label="批量准奏"
    @click.self="close"
  >
    <div
      class="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-2xl sm:rounded-2xl"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-2.5">
          <span
            class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary text-on-primary shadow-sm"
          >
            <Gavel :size="19" />
          </span>
          <div>
            <h2
              class="text-lg font-semibold text-on-surface"
              style="font-family: var(--font-serif)"
            >
              批量准奏
            </h2>
            <p class="text-[11px] text-on-surface-variant">
              将按每封奏折的推荐方案分别批复。
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="关闭"
          class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface"
          @click="close"
        >
          <X :size="17" />
        </button>
      </div>

      <div
        class="mt-4 max-h-48 space-y-1.5 overflow-y-auto rounded-lg bg-surface-container-low p-2.5"
      >
        <div
          v-for="ticket in tickets"
          :key="ticket.id"
          class="flex items-center gap-2 rounded-md bg-surface-container-lowest px-2.5 py-1.5 text-xs"
        >
          <span class="font-mono font-semibold text-primary">#{{ ticket.id }}</span>
          <span class="min-w-0 flex-1 truncate text-on-surface">
            {{ ticket.projectName }}
          </span>
          <span class="shrink-0 font-mono text-[11px] text-on-surface-variant">
            {{ ticket.recommendedOption }}
          </span>
          <span
            v-if="
              ticket.options.find(
                (option) => option.key === ticket.recommendedOption,
              )?.risk === 'destructive'
            "
            class="shrink-0 rounded bg-error px-1.5 py-0.5 text-[9px] font-bold text-white"
          >
            高风险
          </span>
        </div>
      </div>

      <label
        v-if="destructiveTickets.length"
        class="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg bg-error-container/40 px-3 py-2.5 ring-1 ring-inset ring-error/15"
      >
        <input
          v-model="confirmDestructive"
          type="checkbox"
          class="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-error)]"
        />
        <span class="text-xs leading-5 text-on-error-container">
          同时批准 {{ destructiveTickets.length }} 封高风险方案。
          <span class="block text-[11px] opacity-80">
            不勾选时这些奏折会被跳过，保留人工确认。
          </span>
        </span>
      </label>

      <div
        v-else
        class="mt-3 flex items-start gap-2 rounded-lg bg-secondary-container/40 px-3 py-2.5 text-xs leading-5 text-on-secondary-container"
      >
        <AlertTriangle :size="15" class="mt-0.5 shrink-0" />
        本批次没有高风险方案，可直接准奏。
      </div>

      <div class="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          :disabled="store.batchResolving"
          class="h-10 rounded-lg px-4 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container disabled:opacity-50"
          @click="close"
        >
          取消
        </button>
        <button
          type="button"
          :disabled="store.batchResolving || tickets.length === 0"
          class="flex h-10 min-w-[140px] items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary shadow-sm transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50"
          @click="start"
        >
          <template v-if="store.batchResolving">
            <Loader2 :size="16" class="animate-spin" />
            提交中…
          </template>
          <template v-else-if="countdown > 0">
            <Clock3 :size="16" />
            {{ countdown }} 秒后提交 · 撤销
          </template>
          <template v-else>
            <Check :size="16" />
            准奏 {{ tickets.length }} 封
          </template>
        </button>
      </div>
    </div>
  </div>
</template>
