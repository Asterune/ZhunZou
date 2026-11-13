<script setup lang="ts">
import {
  Check,
  Copy,
  FolderOpen,
  GitBranch,
  Inbox,
  Loader2,
  Monitor,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Wrench,
} from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';

import type { SupervisorInboxItem } from '@zhunzou/shared';

import { relativeTime, TASK_STATUS_CLASSES, taskStatusLabel } from '../lib/format';
import { blockedCount, deviceForTask, mergeInfoFor, sortInbox } from '../lib/inbox';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';
import TaskLogViewer from './TaskLogViewer.vue';

const store = useHubStore();
const { t } = useI18n();

const items = computed(() => sortInbox(store.inbox));
const stuckCount = computed(() => blockedCount(items.value));

const openLogs = ref('');
const copiedKey = ref('');
const releasing = ref('');

onMounted(() => {
  void store.loadInbox();
});

function machineName(item: SupervisorInboxItem): string {
  const device = deviceForTask(item.task, store.devices);
  return device?.host?.trim() || item.task.env;
}

async function copy(text: string, key: string): Promise<void> {
  if (typeof navigator === 'undefined') return;
  try {
    await navigator.clipboard.writeText(text);
    copiedKey.value = key;
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = '';
    }, 2_000);
  } catch {
    copiedKey.value = '';
  }
}

/** Override the breaker: the task goes back to the queue by hand. */
async function release(item: SupervisorInboxItem): Promise<void> {
  if (releasing.value) return;
  releasing.value = item.task.id;
  try {
    await store.retryTask(item.task.id, t('inbox.retryReason'));
  } finally {
    releasing.value = '';
  }
}

function toggleLogs(taskId: string): void {
  openLogs.value = openLogs.value === taskId ? '' : taskId;
}
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-2 px-0.5">
      <div class="flex items-center gap-2">
        <span class="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-primary-container" />
        <h2
          class="text-xl font-semibold text-on-surface"
          style="font-family: var(--font-serif)"
        >
          {{ t('inbox.title') }}
        </h2>
        <span
          v-if="items.length"
          class="rounded bg-surface-container px-2 py-0.5 text-[11px] font-medium text-on-surface-variant"
        >
          {{ t('inbox.count', { blocked: stuckCount, total: items.length }) }}
        </span>
      </div>
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container"
        :disabled="store.inboxLoading"
        @click="store.loadInbox()"
      >
        <RefreshCw :size="14" :class="{ 'animate-spin': store.inboxLoading }" />
        {{ t('inbox.refresh') }}
      </button>
    </div>

    <p class="mb-4 px-0.5 text-[12px] leading-5 text-on-surface-variant">
      {{ t('inbox.desc') }}
    </p>

    <div
      v-if="!items.length && !store.inboxLoading"
      class="rounded-xl border border-outline-variant/35 bg-surface-container-low px-6 py-12 text-center shadow-inner"
    >
      <div class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-surface-container text-primary">
        <Inbox :size="27" />
      </div>
      <h3
        class="mt-3 text-lg font-semibold text-on-surface"
        style="font-family: var(--font-serif)"
      >
        {{ t('inbox.emptyTitle') }}
      </h3>
      <p class="mx-auto mt-1 max-w-md text-sm leading-6 text-on-surface-variant">
        {{ t('inbox.emptyDesc') }}
      </p>
    </div>

    <div v-else class="space-y-3">
      <article
        v-for="item in items"
        :key="item.task.id"
        class="rounded-xl border border-outline-variant/35 bg-surface-container-lowest p-4 shadow-sm"
      >
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-sm font-bold text-primary">#{{ item.task.id }}</span>
              <h4 class="truncate text-base font-semibold text-on-surface">
                {{ item.task.title }}
              </h4>
              <span
                class="rounded px-2 py-0.5 text-[11px] font-semibold"
                :class="TASK_STATUS_CLASSES[item.task.status]"
              >
                {{ taskStatusLabel(item.task.status) }}
              </span>
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
              <span class="flex items-center gap-1">
                <Monitor :size="11" />
                <span class="font-mono">{{ machineName(item) }}</span>
              </span>
              <span class="font-mono rounded bg-surface-container-high px-1.5 py-0.5">
                env: {{ item.task.env }}
              </span>
              <span>{{ relativeTime(item.task.updatedAt) }}</span>
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface"
              @click="toggleLogs(item.task.id)"
            >
              <ScrollText :size="13" />
              {{ openLogs === item.task.id ? t('inbox.hideOutput') : t('inbox.output') }}
            </button>
            <button
              v-if="item.task.status === 'BLOCKED'"
              type="button"
              :disabled="!!store.inboxActionId"
              class="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-medium text-on-primary transition hover:bg-primary-container disabled:opacity-50"
              :title="t('inbox.retryHint')"
              @click="release(item)"
            >
              <Loader2
                v-if="releasing === item.task.id"
                :size="13"
                class="animate-spin"
              />
              <Wrench v-else :size="13" />
              {{ t('inbox.retry') }}
            </button>
          </div>
        </div>

        <!-- What the supervisor said last time it touched this task. -->
        <div
          v-if="item.diagnosis"
          class="mt-2.5 rounded-lg border-l-2 border-primary/40 bg-surface-container-low px-3 py-2"
        >
          <div class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">
            <ShieldCheck :size="12" class="text-primary" />
            {{ t('inbox.diagnosis') }}
            <span v-if="item.diagnosisAt" class="font-normal normal-case">
              · {{ relativeTime(item.diagnosisAt) }}
            </span>
          </div>
          <p class="mt-1 text-sm leading-6 text-on-surface">{{ item.diagnosis }}</p>
          <p
            v-if="item.errorSignature"
            class="mt-1 break-all font-mono text-[11px] text-on-surface-variant"
          >
            {{ t('inbox.fault') }} · {{ item.errorSignature }}
          </p>
        </div>

        <p
          v-else-if="item.task.result"
          class="mt-2.5 whitespace-pre-wrap break-words rounded-lg bg-surface-container-low px-3 py-2 text-sm leading-6 text-on-surface"
        >
          {{ item.task.result }}
        </p>

        <!-- Merge info only: the hub never runs git on someone else's checkout. -->
        <div
          v-if="mergeInfoFor(item)"
          class="mt-2.5 rounded-lg border border-outline-variant/30 bg-surface-container-low/60 px-3 py-2"
        >
          <p class="text-[11px] font-medium text-on-surface-variant">
            {{ t('inbox.mergeTitle') }}
          </p>
          <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span class="flex items-center gap-1.5 font-mono text-on-surface">
              <GitBranch :size="12" class="text-on-surface-variant" />
              {{ mergeInfoFor(item)!.branch }}
            </span>
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface"
              @click="copy(mergeInfoFor(item)!.branch, `${item.task.id}-branch`)"
            >
              <component :is="copiedKey === `${item.task.id}-branch` ? Check : Copy" :size="11" />
              {{ copiedKey === `${item.task.id}-branch` ? t('inbox.copied') : t('inbox.copyBranch') }}
            </button>
            <span class="flex min-w-0 items-center gap-1.5 font-mono text-on-surface-variant">
              <FolderOpen :size="12" />
              <span class="truncate" :title="mergeInfoFor(item)!.path">
                {{ mergeInfoFor(item)!.path }}
              </span>
            </span>
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface"
              @click="copy(mergeInfoFor(item)!.path, `${item.task.id}-path`)"
            >
              <component :is="copiedKey === `${item.task.id}-path` ? Check : Copy" :size="11" />
              {{ copiedKey === `${item.task.id}-path` ? t('inbox.copied') : t('inbox.copyPath') }}
            </button>
          </div>
          <p class="mt-1 text-[11px] leading-5 text-on-surface-variant/70">
            {{ t('inbox.mergeHint') }}
          </p>
        </div>

        <TaskLogViewer
          v-if="openLogs === item.task.id"
          :task-id="item.task.id"
          :active="false"
        />
      </article>
    </div>
  </section>
</template>
