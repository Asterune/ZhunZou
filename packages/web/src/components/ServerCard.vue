<script setup lang="ts">
import {
  Clock,
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  Network,
  Server,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted } from 'vue';

import { relativeTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';

/**
 * The machine the hub itself runs on. Everything here comes from
 * `/api/system`; rates need a previous sample, so the card keeps polling while
 * it is mounted and shows the last reading when a refresh fails.
 */
const store = useHubStore();
const { t } = useI18n();

const REFRESH_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void store.loadSystem();
  timer = setInterval(() => void store.loadSystem(), REFRESH_MS);
});

onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
});

const system = computed(() => store.system);

function size(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function perSec(bytes: number | undefined): string {
  return `${size(bytes)}/s`;
}

function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function percent(used: number | undefined, total: number | undefined): number {
  if (!used || !total) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

function barClass(value: number): string {
  if (value >= 85) return 'bg-error';
  if (value >= 70) return 'bg-tertiary';
  return 'bg-secondary';
}
</script>

<template>
  <section
    class="rounded-xl border border-outline-variant/35 bg-surface-container-low px-3.5 py-3 shadow-sm"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-1.5">
        <Server :size="14" class="shrink-0 text-on-surface-variant" />
        <span class="text-[12px] font-semibold text-on-surface">
          {{ t('server.title') }}
        </span>
        <span v-if="system" class="truncate font-mono text-[11px] text-on-surface-variant">
          {{ system.hostname }} · {{ system.platform }}/{{ system.arch }}
        </span>
      </div>
      <span
        v-if="system"
        class="flex shrink-0 items-center gap-1 text-[10.5px] text-on-surface-variant/70"
        :title="new Date(system.sampledAt).toLocaleString()"
      >
        <Clock :size="10" />
        {{ t('server.sampled', { time: relativeTime(system.sampledAt) }) }}
      </span>
    </div>

    <p v-if="!system" class="mt-2 text-[11px] text-on-surface-variant/70">
      {{ t('server.waiting') }}
    </p>

    <div
      v-else
      class="mt-2.5 grid gap-2 text-[11px] sm:grid-cols-2 xl:grid-cols-3"
    >
      <div class="rounded-lg bg-surface-container/70 px-2.5 py-2">
        <div class="flex items-center gap-1 text-on-surface-variant">
          <Cpu :size="11" />
          {{ t('server.cpu') }}
          <span class="ml-auto font-mono text-on-surface">
            {{ system.cpu.usagePercent === undefined ? '—' : `${system.cpu.usagePercent}%` }}
          </span>
        </div>
        <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-container-high">
          <div
            class="h-1 rounded-full"
            :class="barClass(system.cpu.usagePercent ?? 0)"
            :style="{ width: `${system.cpu.usagePercent ?? 0}%` }"
          />
        </div>
        <p class="mt-1 text-[10px] text-on-surface-variant/70">
          {{ t('server.cores', { count: system.cpu.count }) }}
          <template v-if="system.cpu.load1 !== undefined">
            · {{ t('server.load') }} {{ system.cpu.load1.toFixed(2) }} /
            {{ system.cpu.load5?.toFixed(2) ?? '—' }} /
            {{ system.cpu.load15?.toFixed(2) ?? '—' }}
          </template>
        </p>
        <p
          v-if="system.cpu.model"
          class="mt-0.5 truncate text-[10px] text-on-surface-variant/60"
          :title="system.cpu.model"
        >
          {{ system.cpu.model }}
        </p>
      </div>

      <div class="rounded-lg bg-surface-container/70 px-2.5 py-2">
        <div class="flex items-center gap-1 text-on-surface-variant">
          <MemoryStick :size="11" />
          {{ t('server.memory') }}
          <span class="ml-auto font-mono text-on-surface">
            {{ size(system.memory.usedBytes) }} / {{ size(system.memory.totalBytes) }}
          </span>
        </div>
        <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-container-high">
          <div
            class="h-1 rounded-full"
            :class="barClass(percent(system.memory.usedBytes, system.memory.totalBytes))"
            :style="{
              width: `${percent(system.memory.usedBytes, system.memory.totalBytes)}%`,
            }"
          />
        </div>
        <p class="mt-1 text-[10px] text-on-surface-variant/70">
          {{
            percent(system.memory.usedBytes, system.memory.totalBytes)
          }}%
          <template v-if="system.memory.swapTotalBytes">
            · Swap {{ size(system.memory.swapFreeBytes) }} /
            {{ size(system.memory.swapTotalBytes) }} {{ t('server.free') }}
          </template>
        </p>
      </div>

      <div class="rounded-lg bg-surface-container/70 px-2.5 py-2">
        <div class="flex items-center gap-1 text-on-surface-variant">
          <HardDrive :size="11" />
          {{ t('server.disk') }}
          <span class="ml-auto font-mono text-on-surface">
            <template v-if="system.disk">
              {{ size(system.disk.usedBytes) }} / {{ size(system.disk.totalBytes) }}
            </template>
            <template v-else>—</template>
          </span>
        </div>
        <div
          v-if="system.disk"
          class="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-container-high"
        >
          <div
            class="h-1 rounded-full"
            :class="barClass(percent(system.disk.usedBytes, system.disk.totalBytes))"
            :style="{
              width: `${percent(system.disk.usedBytes, system.disk.totalBytes)}%`,
            }"
          />
        </div>
        <p v-if="system.disk" class="mt-1 text-[10px] text-on-surface-variant/70">
          {{ percent(system.disk.usedBytes, system.disk.totalBytes) }}% ·
          {{ size(system.disk.freeBytes) }} {{ t('server.free') }}
        </p>
      </div>

      <div class="rounded-lg bg-surface-container/70 px-2.5 py-2">
        <div class="flex items-center gap-1 text-on-surface-variant">
          <Network :size="11" />
          {{ t('server.network') }}
          <span class="ml-auto font-mono text-on-surface">
            <template v-if="system.network">
              ↓ {{ perSec(system.network.rxBytesPerSec) }} ↑
              {{ perSec(system.network.txBytesPerSec) }}
            </template>
            <template v-else>—</template>
          </span>
        </div>
        <p v-if="system.network" class="mt-1 text-[10px] text-on-surface-variant/70">
          {{ t('server.total') }} ↓ {{ size(system.network.rxBytesTotal) }} ↑
          {{ size(system.network.txBytesTotal) }}
        </p>
      </div>

      <div class="rounded-lg bg-surface-container/70 px-2.5 py-2">
        <div class="flex items-center gap-1 text-on-surface-variant">
          <Server :size="11" />
          {{ t('server.process') }}
          <span class="ml-auto font-mono text-on-surface">{{ size(system.process.rssBytes) }}</span>
        </div>
        <p class="mt-1 text-[10px] text-on-surface-variant/70">
          {{ system.process.nodeVersion }} ·
          {{ t('server.uptime', { time: duration(system.process.uptimeSec) }) }}
        </p>
        <p class="mt-0.5 text-[10px] text-on-surface-variant/60">
          {{ t('server.hostUptime', { time: duration(system.uptimeSec) }) }}
        </p>
      </div>

      <div class="rounded-lg bg-surface-container/70 px-2.5 py-2">
        <div class="flex items-center gap-1 text-on-surface-variant">
          <Database :size="11" />
          {{ t('server.database') }}
          <span class="ml-auto font-mono text-on-surface">
            <template v-if="system.database">
              {{ size(system.database.bytes + (system.database.walBytes ?? 0)) }}
            </template>
            <template v-else>—</template>
          </span>
        </div>
        <p v-if="system.database" class="mt-1 text-[10px] text-on-surface-variant/70">
          {{ t('server.dbSplit', {
            main: size(system.database.bytes),
            wal: size(system.database.walBytes ?? 0),
          }) }}
        </p>
      </div>
    </div>
  </section>
</template>
