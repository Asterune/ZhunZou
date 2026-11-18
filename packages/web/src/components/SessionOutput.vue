<script setup lang="ts">
import { computed } from 'vue';

import type { LogEntry } from '../lib/log';

import { hubApi } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';
import LogViewer from './LogViewer.vue';

const props = defineProps<{
  sessionId: string;
  messageId: string;
  active: boolean;
}>();

const store = useHubStore();
const { t } = useI18n();

/**
 * Chunks the dashboard socket already pushed for this turn. The HTTP pager in
 * LogViewer still runs as a recovery net, but normally the output arrives as
 * `chat.delta` frames and is appended without a request.
 */
const liveEntries = computed<LogEntry[]>(() =>
  store.chatDeltas
    .filter(
      (event) =>
        event.sessionId === props.sessionId &&
        event.messageId === props.messageId,
    )
    .map((event) => ({
      id: event.id,
      stream: event.stream,
      chunk: event.chunk,
    })),
);

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
    :live-entries="liveEntries"
    :poll-ms="store.realtimeState === 'online' ? 5_000 : 1_200"
    :empty-text="t('log.noMessageOutput')"
  />
</template>
