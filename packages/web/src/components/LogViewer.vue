<script setup lang="ts">
import { Terminal } from 'lucide-vue-next';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { LogEntry } from '../lib/log';
import { useI18n } from '../lib/i18n';

const props = defineProps<{
  active: boolean;
  fetchPage: (after: number) => Promise<{
    entries: LogEntry[];
    nextAfter: number;
    truncated: boolean;
  }>;
  /** Chunks pushed over the socket; merged without waiting for a poll. */
  liveEntries?: LogEntry[];
  /** How often the HTTP pager still runs as a recovery net. */
  pollMs?: number;
  emptyText?: string;
}>();

const logs = ref<LogEntry[]>([]);
const { t } = useI18n();
const after = ref(0);
const loading = ref(false);
const error = ref('');
const scroller = ref<HTMLElement | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer(): void {
  stopTimer();
  if (!props.active) return;
  timer = setInterval(() => {
    void load();
  }, props.pollMs ?? 1_200);
}

/** Merge entries (live or fetched), keeping the cursor monotonic. */
function appendEntries(entries: LogEntry[]): void {
  const fresh = entries.filter((entry) => entry.id > after.value);
  if (fresh.length === 0) return;

  logs.value = [...logs.value, ...fresh].slice(-2_000);
  after.value = fresh[fresh.length - 1]!.id;
  void scrollToEnd();
}

async function scrollToEnd(): Promise<void> {
  await nextTick();
  const element = scroller.value;
  if (element) element.scrollTop = element.scrollHeight;
}

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const page = await props.fetchPage(after.value);
    error.value = '';

    appendEntries(page.entries);
    // A live frame may have advanced the cursor past this page while the
    // request was in flight; never move it backwards.
    if (page.nextAfter > after.value) after.value = page.nextAfter;

    if (page.truncated) {
      setTimeout(() => void load(), 50);
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('log.loadFailed');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  startTimer();
});

onBeforeUnmount(stopTimer);

watch(
  () => props.liveEntries,
  (entries) => {
    if (entries && entries.length > 0) appendEntries(entries);
  },
);

watch(
  () => props.pollMs,
  () => {
    if (props.active) startTimer();
  },
);

watch(
  () => props.active,
  (active) => {
    if (active) {
      startTimer();
      void load();
    } else {
      stopTimer();
      void load();
    }
  },
);
</script>

<template>
  <div
    class="mt-3 overflow-hidden rounded-lg border border-outline-variant/40 bg-surface-container-lowest"
  >
    <div
      class="flex items-center justify-between gap-2 border-b border-outline-variant/30 bg-surface-container px-2.5 py-1.5 text-[11px] text-on-surface-variant"
    >
      <span class="flex items-center gap-1.5 font-medium">
        <Terminal :size="12" />
        {{ t('log.title') }}
      </span>
      <span class="flex items-center gap-2">
        <span v-if="active" class="flex items-center gap-1 text-secondary">
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-secondary" />
          {{ t('log.live') }}
        </span>
        <span v-else-if="loading" class="text-on-surface-variant/60">{{ t('log.loading') }}</span>
        <span v-else-if="logs.length === 0" class="text-on-surface-variant/60">
          {{ emptyText || t('log.noOutput') }}
        </span>
      </span>
    </div>

    <pre
      ref="scroller"
      class="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-[#211d1a] px-3 py-2 font-mono text-[11px] leading-5 text-[#e9e2d6]"
    ><span
      v-for="log in logs"
      :key="log.id"
      :class="
        log.stream === 'stderr'
          ? 'text-[#f3a6a0]'
          : log.stream === 'system'
            ? 'text-[#d8c48f]'
            : ''
      "
    >{{ log.chunk }}</span><span v-if="!logs.length && !loading" class="text-[#8d8478]">{{ active ? t('log.waiting') : (emptyText || t('log.noTaskOutput')) }}</span></pre>

    <p
      v-if="error"
      class="border-t border-outline-variant/30 bg-error-container/40 px-2.5 py-1.5 text-[11px] text-on-error-container"
    >
      {{ error }}
    </p>
  </div>
</template>
