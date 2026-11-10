<script setup lang="ts">
import { Loader2, Zap } from 'lucide-vue-next';
import { computed } from 'vue';

import type { AgentTask } from '@zhunzou/shared';

import { relativeTime, TASK_STATUS_CLASSES, taskStatusLabel } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';

/**
 * One-shot runs share the chat sidebar slot: same env/project, no context.
 * This section exists so a dispatched run is visible without a separate tab.
 */
const props = defineProps<{ activeTaskId: string }>();

const emit = defineEmits<{ open: [id: string] }>();

const store = useHubStore();
const { t } = useI18n();

const tasks = computed<AgentTask[]>(() => store.activeTasks);
</script>

<template>
  <div class="flex min-h-0 flex-col gap-1.5">
    <div class="flex items-center justify-between px-0.5 text-[11px] text-on-surface-variant">
      <span class="flex items-center gap-1">
        <Zap :size="11" />
        {{ t('chat.singleTasks') }}
      </span>
      <span v-if="tasks.length" class="text-on-surface-variant/60">
        {{ t('chat.singleCount', { count: tasks.length }) }}
      </span>
    </div>

    <div class="max-h-40 min-h-0 space-y-1.5 overflow-y-auto overscroll-contain pr-0.5">
      <button
        v-for="task in tasks"
        :key="task.id"
        type="button"
        class="w-full rounded-lg border px-2.5 py-1.5 text-left transition"
        :class="
          task.id === props.activeTaskId
            ? 'border-primary/40 bg-primary/5'
            : 'border-outline-variant/35 bg-surface-container-low hover:bg-surface-container'
        "
        @click="emit('open', task.id)"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="truncate text-[12px] font-medium text-on-surface">
            {{ task.title }}
          </span>
          <Loader2
            v-if="task.status === 'CLAIMED'"
            :size="11"
            class="shrink-0 animate-spin text-primary"
          />
          <span
            v-else
            class="shrink-0 rounded px-1 py-0.5 text-[9px] font-medium"
            :class="TASK_STATUS_CLASSES[task.status]"
          >
            {{ taskStatusLabel(task.status) }}
          </span>
        </div>
        <div class="mt-0.5 flex items-center gap-1.5 text-[10px] text-on-surface-variant/70">
          <span class="font-mono">#{{ task.id }}</span>
          <span class="truncate">{{ task.env }}</span>
          <span class="ml-auto shrink-0">{{ relativeTime(task.createdAt) }}</span>
        </div>
      </button>

      <p
        v-if="!tasks.length"
        class="rounded-lg border border-dashed border-outline-variant bg-surface-container-low/60 px-2.5 py-4 text-center text-[11px] text-on-surface-variant"
      >
        {{ t('chat.singleEmpty') }}
      </p>
    </div>
  </div>
</template>
