<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next';
import { onBeforeUnmount, ref, watch } from 'vue';

import type { ChatAttachment } from '@zhunzou/shared';

import { chatAttachmentUrl, releaseChatAttachmentUrl } from '../lib/chat-images';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';

const props = withDefaults(
  defineProps<{
    sessionId: string;
    messageId: string;
    attachments: ChatAttachment[];
    tone?: 'user' | 'muted';
  }>(),
  { tone: 'user' },
);

const store = useHubStore();
const { t } = useI18n();

const sources = ref<Record<string, string>>({});
const failed = ref<Record<string, boolean>>({});
let disposed = false;

function signature(): string {
  return `${props.sessionId}:${props.messageId}:${props.attachments
    .map((item) => item.id)
    .join(',')}`;
}

async function load(): Promise<void> {
  for (const attachment of props.attachments) {
    if (attachment.expired) {
      releaseChatAttachmentUrl(
        props.sessionId,
        props.messageId,
        attachment.id,
      );
      continue;
    }
    if (sources.value[attachment.id] || failed.value[attachment.id]) continue;
    try {
      const url = await chatAttachmentUrl(
        store.token,
        props.sessionId,
        props.messageId,
        attachment,
      );
      if (disposed) return;
      sources.value = { ...sources.value, [attachment.id]: url };
    } catch {
      if (disposed) return;
      failed.value = { ...failed.value, [attachment.id]: true };
    }
  }
}

watch(signature, () => void load(), { immediate: true });

onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <div
    class="mt-1.5 grid gap-1.5"
    :class="attachments.length > 1 ? 'grid-cols-2' : 'grid-cols-1'"
  >
    <template v-for="attachment in attachments" :key="attachment.id">
      <a
        v-if="!attachment.expired && sources[attachment.id]"
        :href="sources[attachment.id]"
        target="_blank"
        rel="noopener noreferrer"
        :download="attachment.name"
        class="block overflow-hidden rounded-lg border bg-black/10"
        :class="tone === 'user' ? 'border-white/25' : 'border-outline-variant/40'"
        :title="attachment.name"
      >
        <img
          :src="sources[attachment.id]"
          :alt="attachment.name"
          loading="lazy"
          class="w-full object-cover"
          :class="attachments.length > 1 ? 'h-28' : 'max-h-64'"
        />
      </a>
      <div
        v-else-if="attachment.expired"
        class="grid h-24 place-items-center rounded-lg border border-dashed px-2 text-center text-[10px]"
        :class="
          tone === 'user'
            ? 'border-white/25 text-on-primary/70'
            : 'border-outline-variant/40 text-on-surface-variant'
        "
      >
        {{ t('chat.imageExpired') }}
      </div>
      <div
        v-else
        class="grid h-24 place-items-center rounded-lg border bg-black/10 text-[10px]"
        :class="
          tone === 'user'
            ? 'border-white/20 text-on-primary/70'
            : 'border-outline-variant/40 text-on-surface-variant'
        "
      >
        <Loader2 v-if="!failed[attachment.id]" :size="16" class="animate-spin" />
        <span v-else class="px-2 text-center">{{ t('chat.imageLoadFailed') }}</span>
      </div>
    </template>
  </div>
</template>
