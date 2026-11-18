<script setup lang="ts">
import { ChevronRight, Gavel, RefreshCw, Trash2 } from 'lucide-vue-next';

import type { ChatSession, DecisionTicket } from '@zhunzou/shared';

import { ticketsForSession, contextUsagePercent } from '../lib/chat';
import { listTime } from '../lib/format';
import { useI18n } from '../lib/i18n';

const props = withDefaults(
  defineProps<{
    sessions: ChatSession[];
    activeId: string;
    loading: boolean;
    loaded: boolean;
    deletingId: string;
    /** Pending petitions, so a row can say it has one to decide. */
    tickets?: DecisionTicket[];
    /** Tokens the hub rotates at, so a row can show how full its session is. */
    contextBudget?: number;
    /**
     * `sidebar` is the desktop column; `page` is the phone's first-level
     * conversation list, styled as one WeChat-like card of rows.
     */
    variant?: 'sidebar' | 'page';
  }>(),
  { variant: 'sidebar' },
);

const emit = defineEmits<{
  open: [id: string];
  delete: [session: ChatSession];
  refresh: [];
}>();

const { t, locale } = useI18n();

const AVATAR_TONES = [
  'bg-primary/10 text-primary',
  'bg-secondary/10 text-secondary',
  'bg-tertiary/10 text-tertiary',
  'bg-primary-container/15 text-primary-container',
];

/** Stable avatar colour per environment, so the eye can scan by machine. */
function tone(env: string): string {
  let hash = 0;
  for (const char of env) hash = (hash + char.codePointAt(0)!) % 997;
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0]!;
}

/** First glyph, not first UTF-16 unit: Chinese titles would break otherwise. */
function initial(title: string): string {
  return Array.from(title.trim())[0] ?? '准';
}

function ticketCount(session: ChatSession): number {
  return ticketsForSession(session, props.tickets ?? []).length;
}

/** Context used by this conversation's native session, 0–100. */
function contextPercent(session: ChatSession): number {
  return contextUsagePercent(session.contextTokens, props.contextBudget);
}

function isPage(): boolean {
  return props.variant === 'page';
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div
      class="flex items-center justify-between gap-2 px-0.5 text-[11px] text-on-surface-variant"
      :class="isPage() ? 'pb-2' : 'pb-1.5'"
    >
      <span class="flex items-center gap-1.5">
        {{ t('chat.all') }}
        <span v-if="sessions.length" class="text-on-surface-variant/50">
          {{ sessions.length }}
        </span>
      </span>
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
      </div>
    </div>

    <div
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      :class="isPage() ? '' : 'pr-0.5'"
    >
      <div
        :class="
          isPage()
            ? 'divide-y divide-outline-variant/25 overflow-hidden rounded-xl border border-outline-variant/35 bg-surface-container-lowest shadow-sm'
            : 'space-y-1.5'
        "
      >
        <template v-if="loading && !sessions.length">
          <div
            v-for="index in 5"
            :key="`skeleton-${index}`"
            class="flex items-center gap-2.5"
            :class="
              isPage()
                ? 'px-3 py-3'
                : 'rounded-xl border border-outline-variant/25 px-2 py-2'
            "
          >
            <div
              class="h-7 w-7 shrink-0 animate-pulse rounded-full bg-surface-container-high"
            />
            <div class="min-w-0 flex-1 space-y-1.5">
              <div class="h-3 w-2/3 animate-pulse rounded bg-surface-container-high" />
              <div class="h-2.5 w-2/5 animate-pulse rounded bg-surface-container" />
            </div>
          </div>
        </template>

        <div
          v-for="item in sessions"
          :key="item.id"
          class="group relative flex items-center gap-2.5 transition"
          :class="[
            isPage() ? 'px-3 py-3' : 'rounded-xl border px-2 py-2',
            !isPage() && item.id === activeId
              ? 'border-primary/40 bg-primary/5'
              : !isPage()
                ? 'border-outline-variant/35 bg-surface-container-low hover:bg-surface-container'
                : item.id === activeId
                  ? 'bg-primary/[0.04]'
                  : 'hover:bg-surface-container-low',
          ]"
        >
          <span
            class="grid shrink-0 place-items-center rounded-xl font-semibold"
            :class="[tone(item.env), isPage() ? 'h-10 w-10 text-[15px]' : 'h-9 w-9 text-[14px]']"
            aria-hidden="true"
          >
            {{ initial(item.title) }}
          </span>

          <button
            type="button"
            class="min-w-0 flex-1 text-left"
            :aria-label="item.title"
            @click="emit('open', item.id)"
          >
            <span class="flex min-w-0 items-center gap-1.5">
              <span
                v-if="item.pendingCount"
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                role="img"
                :aria-label="t('chat.pendingItems', { count: item.pendingCount })"
              />
              <span
                class="truncate text-[13px] font-semibold"
                :class="item.id === activeId ? 'text-primary' : 'text-on-surface'"
              >
                {{ item.title }}
              </span>
              <span
                v-if="ticketCount(item)"
                class="ml-auto flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1 py-0.5 text-[9px] font-bold leading-none text-primary"
                :title="t('chat.pendingTicketsTitle')"
              >
                <Gavel :size="9" />
                {{ ticketCount(item) }}
              </span>
            </span>

            <span
              class="mt-0.5 flex min-w-0 items-center gap-1 text-[10.5px] text-on-surface-variant"
            >
              <span class="shrink-0 rounded bg-surface-container-high px-1 py-0.5 font-mono text-[9.5px]">
                {{ item.env }}
              </span>
              <span v-if="item.projectName" class="truncate">
                {{ item.projectName }}
              </span>
            </span>

            <span class="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-on-surface-variant/60">
              {{ t('chat.messagesCount', { count: item.messageCount ?? 0 }) }}
              <span
                v-if="contextPercent(item) > 0"
                class="ml-auto flex shrink-0 items-center gap-1"
                :class="contextPercent(item) >= 80 ? 'text-error' : ''"
                :title="
                  t('chat.contextTitle', {
                    percent: contextPercent(item),
                    count: item.contextRotations ?? 0,
                  })
                "
              >
                <span
                  class="h-1 w-6 overflow-hidden rounded-full bg-surface-container-high"
                  aria-hidden="true"
                >
                  <span
                    class="block h-full rounded-full bg-current"
                    :style="{ width: `${contextPercent(item)}%` }"
                  />
                </span>
                <span class="font-mono">{{ contextPercent(item) }}%</span>
              </span>
            </span>
          </button>

          <div class="flex w-14 shrink-0 flex-col items-end gap-1">
            <span class="whitespace-nowrap text-[9.5px] text-on-surface-variant/60">
              {{
                item.lastMessageAt
                  ? listTime(item.lastMessageAt, locale)
                  : t('chat.justCreated')
              }}
            </span>
            <span
              v-if="item.pendingCount"
              class="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-bold leading-none text-on-primary"
            >
              {{ item.pendingCount }}
            </span>
            <span
              v-else-if="item.status === 'CLOSED'"
              class="rounded bg-surface-container-high px-1.5 py-0.5 text-[9px] text-on-surface-variant"
            >
              {{ t('chat.closedBadge') }}
            </span>
            <button
              type="button"
              class="mt-auto grid h-6 w-6 place-items-center rounded-md text-on-surface-variant/60 transition hover:bg-error-container hover:text-on-error-container focus-visible:opacity-100 disabled:opacity-40"
              :class="
                isPage()
                  ? 'opacity-100'
                  : 'sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'
              "
              :aria-label="t('chat.delete')"
              :title="t('chat.delete')"
              :disabled="deletingId === item.id"
              @click.stop="emit('delete', item)"
            >
              <RefreshCw v-if="deletingId === item.id" :size="12" class="animate-spin" />
              <Trash2 v-else :size="12" />
            </button>
          </div>

          <ChevronRight
            v-if="isPage()"
            :size="14"
            class="shrink-0 text-on-surface-variant/30"
            aria-hidden="true"
          />
        </div>
      </div>

      <p
        v-if="loaded && !loading && !sessions.length"
        class="rounded-xl border border-dashed border-outline-variant bg-surface-container-low/60 px-3 py-8 text-center text-[12px] text-on-surface-variant"
      >
        {{ t('chat.emptyList') }}
      </p>
    </div>
  </div>
</template>
