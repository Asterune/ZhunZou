<script setup lang="ts">
import { Gauge } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted } from 'vue';

import type { ProviderUsageMeter } from '@zhunzou/shared';

import { relativeTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';

/**
 * Remaining provider allowance (OpenCode Go exposes 5-hour, weekly and monthly
 * meters). The server derives the endpoint from the inference base URL and
 * caches it for a minute, so polling here stays cheap.
 */
const store = useHubStore();
const { t } = useI18n();

const REFRESH_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void store.loadProviderUsage();
  timer = setInterval(() => void store.loadProviderUsage(), REFRESH_MS);
});

onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
});

const usage = computed(() => store.providerUsage);
const meters = computed(() => usage.value?.usage ?? null);

const rows = computed(() => {
  const value = meters.value;
  if (!value) return [];
  return [
    { key: 'rolling', label: t('quota.rolling'), meter: value.rolling },
    { key: 'weekly', label: t('quota.weekly'), meter: value.weekly },
    { key: 'monthly', label: t('quota.monthly'), meter: value.monthly },
  ];
});

function barClass(meter: ProviderUsageMeter): string {
  if (meter.status !== 'ok' || meter.percent >= 100) return 'bg-error';
  if (meter.percent >= 80) return 'bg-tertiary';
  return 'bg-secondary';
}

function resetLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
</script>

<template>
  <section
    class="rounded-xl border border-outline-variant/35 bg-surface-container-low px-3.5 py-3 shadow-sm"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-1.5">
        <Gauge :size="14" class="shrink-0 text-on-surface-variant" />
        <span class="text-[12px] font-semibold text-on-surface">
          {{ t('quota.title') }}
        </span>
        <span
          v-if="usage"
          class="rounded bg-surface-container-high px-1.5 py-0.5 font-mono text-[10px] text-on-surface-variant"
        >
          {{ usage.provider }}
        </span>
      </div>
      <span
        v-if="usage"
        class="shrink-0 text-[10.5px] text-on-surface-variant/70"
        :title="new Date(usage.fetchedAt).toLocaleString()"
      >
        {{ t('quota.sampled', { time: relativeTime(usage.fetchedAt) }) }}
      </span>
    </div>

    <p v-if="!usage" class="mt-2 text-[11px] text-on-surface-variant/70">
      {{ t('quota.waiting') }}
    </p>

    <p
      v-else-if="!usage.supported || !usage.usage"
      class="mt-2 text-[11px] text-on-surface-variant/70"
    >
      {{ usage.error || t('quota.unsupported') }}
    </p>

    <div v-else class="mt-2.5 space-y-2">
      <div v-for="row in rows" :key="row.key">
        <div class="flex items-center justify-between gap-2 text-[11px]">
          <span class="text-on-surface-variant">{{ row.label }}</span>
          <span class="flex items-center gap-1.5">
            <span
              v-if="row.meter.status !== 'ok'"
              class="rounded bg-error-container px-1 text-[9.5px] font-medium text-on-error-container"
            >
              {{ t('quota.limited') }}
            </span>
            <span class="font-mono text-on-surface">{{ row.meter.percent }}%</span>
          </span>
        </div>
        <div class="mt-1 h-1 overflow-hidden rounded-full bg-surface-container-high">
          <div
            class="h-1 rounded-full"
            :class="barClass(row.meter)"
            :style="{ width: `${row.meter.percent}%` }"
          />
        </div>
        <p class="mt-0.5 text-[10px] text-on-surface-variant/60">
          {{ t('quota.resets', { time: resetLabel(row.meter.resetsAt) }) }}
        </p>
      </div>
    </div>
  </section>
</template>
