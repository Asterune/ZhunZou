<script setup lang="ts">
import { Terminal } from 'lucide-vue-next';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { LogEntry } from '../lib/log';

const props = defineProps<{
  active: boolean;
  fetchPage: (after: number) => Promise<{
    entries: LogEntry[];
    nextAfter: number;
    truncated: boolean;
  }>;
  emptyText?: string;
}>();

const logs = ref<LogEntry[]>([]);
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
  }, 1_200);
}

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const page = await props.fetchPage(after.value);
    error.value = '';

    if (page.entries.length > 0) {
      logs.value = [...logs.value, ...page.entries].slice(-2_000);
      after.value = page.nextAfter;
      await nextTick();
      const element = scroller.value;
      if (element) element.scrollTop = element.scrollHeight;
    }

    if (page.truncated) {
      setTimeout(() => void load(), 50);
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '输出加载失败';
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
        执行输出
      </span>
      <span class="flex items-center gap-2">
        <span v-if="active" class="flex items-center gap-1 text-secondary">
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-secondary" />
          实时
        </span>
        <span v-else-if="loading" class="text-on-surface-variant/60">加载中…</span>
        <span v-else-if="logs.length === 0" class="text-on-surface-variant/60">
          {{ emptyText || '无输出' }}
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
    >{{ log.chunk }}</span><span v-if="!logs.length && !loading" class="text-[#8d8478]">{{ active ? '等待输出…' : (emptyText || '该任务没有输出。') }}</span></pre>

    <p
      v-if="error"
      class="border-t border-outline-variant/30 bg-error-container/40 px-2.5 py-1.5 text-[11px] text-on-error-container"
    >
      {{ error }}
    </p>
  </div>
</template>
