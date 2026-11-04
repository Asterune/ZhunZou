<script setup lang="ts">
import type { LogEntry } from '../lib/log';

import { hubApi } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';
import LogViewer from './LogViewer.vue';

const props = defineProps<{
  taskId: string;
  active: boolean;
}>();

const store = useHubStore();
const { t } = useI18n();

async function fetchPage(after: number): Promise<{
  entries: LogEntry[];
  nextAfter: number;
  truncated: boolean;
}> {
  const page = await hubApi.getTaskLogs(store.token, props.taskId, after);
  return {
    entries: page.logs.map((log) => ({
      id: log.id,
      stream: log.stream,
      chunk: log.chunk,
    })),
    nextAfter: page.nextAfter,
    truncated: page.truncated,
  };
}
</script>

<template>
  <LogViewer
    :active="active"
    :fetch-page="fetchPage"
    :empty-text="t('log.noTaskOutput')"
  />
</template>
