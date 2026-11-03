<script setup lang="ts">
import type { LogEntry } from '../lib/log';

import { hubApi } from '../lib/api';
import { useHubStore } from '../stores/hub';
import LogViewer from './LogViewer.vue';

const props = defineProps<{
  sessionId: string;
  messageId: string;
  active: boolean;
}>();

const store = useHubStore();

async function fetchPage(after: number): Promise<{
  entries: LogEntry[];
  nextAfter: number;
  truncated: boolean;
}> {
  const page = await hubApi.getChatEvents(
    store.token,
    props.sessionId,
    after,
    props.messageId,
  );
  return {
    entries: page.events.map((event) => ({
      id: event.id,
      stream: event.stream,
      chunk: event.chunk,
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
    empty-text="该消息没有输出。"
  />
</template>
