<script setup lang="ts">
import { RefreshCw, Trash2, X } from 'lucide-vue-next';

import type { ChatSession } from '@zhunzou/shared';

import { relativeTime } from '../lib/format';
import { useI18n } from '../lib/i18n';

defineProps<{
  sessions: ChatSession[];
  activeId: string;
  loading: boolean;
  loaded: boolean;
  deletingId: string;
  dismissible?: boolean;
}>();

const emit = defineEmits<{
  open: [id: string];
  delete: [session: ChatSession];
  refresh: [];
  close: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-2">
    <div class="flex items-center justify-between px-0.5 text-[11px] text-on-surface-variant">
      <span>{{ t('chat.all') }}</span>
      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-container disabled:opacity-50"
          :aria-label="t('app.refresh')"
          :title="t('app.refresh')"
          :disabled="loading"
          @click="emit('refresh')"
        >
          <RefreshCw :size="12" :class="{ 'animate-spin': loading }" />
        </button>
        <button
          v-if="dismissible"
          type="button"
          class="grid h-7 w-7 place-items-center rounded-md hover:bg-surface-container"
          :aria-label="t('chat.closeList')"
          :title="t('chat.closeList')"
          @click="emit('close')"
        >
          <X :size="15" />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-0.5">
      <div v-for="item in sessions" :key="item.id" class="group relative">
        <button
          type="button"
          class="w-full rounded-xl border py-2.5 pl-3 pr-8 text-left transition"
          :class="
            item.id === activeId
              ? 'border-primary/40 bg-primary/5'
              : 'border-outline-variant/35 bg-surface-container-low hover:bg-surface-container'
          "
          @click="emit('open', item.id)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="flex min-w-0 items-center gap-1.5">
              <span
                v-if="item.pendingCount"
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                role="img"
                :aria-label="t('chat.pendingItems', { count: item.pendingCount })"
                :title="t('chat.pendingItems', { count: item.pendingCount })"
              />
              <span class="truncate text-[12px] font-semibold text-on-surface">
                {{ item.title }}
              </span>
            </span>
            <span
              v-if="item.pendingCount"
              class="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-bold leading-none text-on-primary"
            >
              {{ item.pendingCount }}
            </span>
            <span
              v-else-if="item.status === 'CLOSED'"
              class="shrink-0 rounded bg-surface-container-high px-1.5 py-0.5 text-[9px] text-on-surface-variant"
            >
              {{ t('chat.closedBadge') }}
            </span>
          </div>
          <div class="mt-1 flex items-center gap-1.5 text-[10px] text-on-surface-variant">
            <span class="rounded bg-surface-container-high px-1 py-0.5 font-mono">
              {{ item.env }}
            </span>
            <span v-if="item.projectName" class="truncate">{{ item.projectName }}</span>
          </div>
          <div class="mt-1 text-[10px] text-on-surface-variant/60">
            {{ t('chat.messagesCount', { count: item.messageCount ?? 0 }) }} ·
            {{ item.lastMessageAt ? relativeTime(item.lastMessageAt) : t('chat.justCreated') }}
          </div>
        </button>

        <button
          type="button"
          class="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md text-on-surface-variant/70 opacity-100 transition hover:bg-error-container hover:text-on-error-container focus-visible:opacity-100 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
          :aria-label="t('chat.delete')"
          :title="t('chat.delete')"
          :disabled="deletingId === item.id"
          @click.stop="emit('delete', item)"
        >
          <RefreshCw
            v-if="deletingId === item.id"
            :size="13"
            class="animate-spin"
          />
          <Trash2 v-else :size="13" />
        </button>
      </div>

      <p
        v-if="loaded && !sessions.length"
        class="rounded-xl border border-dashed border-outline-variant bg-surface-container-low/60 px-3 py-6 text-center text-[12px] text-on-surface-variant"
      >
        {{ t('chat.emptyList') }}
      </p>
    </div>
  </div>
</template>
