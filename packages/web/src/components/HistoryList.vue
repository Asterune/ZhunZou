<script setup lang="ts">
import {
  Ban,
  Bot,
  CheckCircle2,
  Clock,
  FileText,
  RotateCcw,
  Search,
  User,
  X,
} from 'lucide-vue-next';
import { computed, ref } from 'vue';

import type { DecisionTicket } from '@zhunzou/shared';

import {
  HISTORY_FILTERS,
  filterHistory,
  type HistoryFilter,
} from '../lib/history';
import {
  formatDateTime,
  optionLabel,
  relativeTime,
  TICKET_STATUS_CLASSES,
  TICKET_STATUS_LABELS,
} from '../lib/format';
import { useHubStore } from '../stores/hub';

const store = useHubStore();
const query = ref('');
const activeFilter = ref<HistoryFilter>('all');

const all = computed(() => store.historyTickets);
const items = computed(() =>
  filterHistory(all.value, query.value, activeFilter.value),
);

function countFor(filter: HistoryFilter): number {
  return filterHistory(all.value, '', filter).length;
}

function reset(): void {
  query.value = '';
  activeFilter.value = 'all';
}

function watermark(ticket: DecisionTicket): string {
  if (ticket.status === 'CANCELLED') return '已取消';
  if (ticket.resolvedBy === 'TIMEOUT') return '超时 · 默认';
  if (ticket.resolvedBy === 'META_AGENT') return '机断 · 例行';
  return '准奏 · 裁定';
}
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-on-surface-variant">
          <span>Archive Dossier</span>
          <span class="text-outline-variant">·</span>
          <span>文书御批宗卷</span>
        </div>
        <h2
          class="mt-0.5 flex items-center gap-2 text-xl font-semibold text-on-surface"
          style="font-family: var(--font-serif)"
        >
          历史决策
          <span
            class="rounded bg-surface-container px-1.5 py-0.5 text-[11px] font-medium tracking-normal text-on-surface-variant"
          >
            共 {{ all.length }} 条
          </span>
        </h2>
      </div>
      <span class="text-[11px] text-on-surface-variant">
        最近更新的排在前面
      </span>
    </div>

    <div class="mb-3 flex items-center gap-2 rounded-lg bg-surface-container-low px-3 shadow-sm">
      <Search :size="16" class="shrink-0 text-outline" />
      <input
        v-model="query"
        type="search"
        placeholder="检索编号、项目、卡点或批复意见…"
        class="h-10 w-full bg-transparent text-sm text-on-surface outline-none placeholder:text-on-surface-variant/50"
      />
      <button
        v-if="query"
        type="button"
        aria-label="清空搜索"
        class="grid h-7 w-7 shrink-0 place-items-center rounded text-outline transition hover:bg-surface-container hover:text-on-surface"
        @click="query = ''"
      >
        <X :size="15" />
      </button>
    </div>

    <div class="scrollbar-none -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <button
        v-for="filter in HISTORY_FILTERS"
        :key="filter.key"
        type="button"
        class="shrink-0 rounded px-3 py-1.5 text-[11px] font-medium transition"
        :class="
          activeFilter === filter.key
            ? 'bg-primary text-on-primary shadow-sm'
            : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
        "
        @click="activeFilter = filter.key"
      >
        {{ filter.label }} ({{ countFor(filter.key) }})
      </button>
    </div>

    <div
      v-if="!all.length"
      class="rounded-2xl border border-dashed border-outline-variant bg-surface-container-low/60 px-6 py-12 text-center"
    >
      <div
        class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-surface-container text-primary"
      >
        <FileText :size="26" />
      </div>
      <p
        class="mt-3 text-base font-semibold text-on-surface"
        style="font-family: var(--font-serif)"
      >
        宗卷空寂 · 暂无记录
      </p>
      <p class="mt-1 text-sm text-on-surface-variant">
        审批或取消工单后，记录会出现在这里。
      </p>
    </div>

    <div
      v-else-if="!items.length"
      class="rounded-2xl border border-dashed border-outline-variant bg-surface-container-low/60 px-6 py-10 text-center"
    >
      <div
        class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-container text-outline"
      >
        <Search :size="22" />
      </div>
      <p class="mt-3 text-sm font-medium text-on-surface">没有匹配的宗卷</p>
      <p class="mt-1 text-xs text-on-surface-variant">换个关键词或筛选条件试试。</p>
      <button
        type="button"
        class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-surface-container px-3 py-2 text-xs font-medium text-on-surface transition hover:bg-surface-container-high"
        @click="reset"
      >
        <RotateCcw :size="14" />
        重置筛选
      </button>
    </div>

    <div v-else class="space-y-3">
      <article
        v-for="ticket in items"
        :key="ticket.id"
        class="relative overflow-hidden rounded-xl border border-outline-variant/35 bg-surface-container-lowest p-4 shadow-sm"
      >
        <div class="pointer-events-none absolute right-3 top-3 rotate-[-2deg] select-none">
          <div
            class="rounded border px-2 py-0.5 text-[10px] font-bold tracking-widest"
            :class="
              ticket.status === 'CANCELLED'
                ? 'border-outline-variant bg-surface-container text-on-surface-variant'
                : 'border-secondary bg-secondary-container/30 text-secondary'
            "
            style="font-family: var(--font-serif)"
          >
            {{ watermark(ticket) }}
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 pr-24 text-[11px] text-on-surface-variant">
          <span class="rounded bg-surface-container px-1.5 py-0.5 font-mono font-semibold text-on-surface">
            #{{ ticket.id }}
          </span>
          <span class="font-mono font-medium text-on-surface">{{ ticket.projectName }}</span>
          <span class="text-outline-variant">·</span>
          <span class="font-mono">{{ ticket.env }}</span>
          <span class="text-outline-variant">·</span>
          <span :title="formatDateTime(ticket.updatedAt)">
            {{ relativeTime(ticket.updatedAt) }}
          </span>
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-2">
          <span
            class="rounded px-2 py-0.5 text-[11px] font-semibold"
            :class="TICKET_STATUS_CLASSES[ticket.status]"
          >
            {{ TICKET_STATUS_LABELS[ticket.status] }}
          </span>
          <span
            v-if="ticket.resolvedBy"
            class="flex items-center gap-1 text-[11px] text-on-surface-variant"
          >
            <Bot v-if="ticket.resolvedBy === 'META_AGENT'" :size="12" class="text-secondary" />
            <Clock v-else-if="ticket.resolvedBy === 'TIMEOUT'" :size="12" class="text-tertiary" />
            <User v-else :size="12" class="text-primary" />
            {{
              ticket.resolvedBy === 'META_AGENT'
                ? '总管自动'
                : ticket.resolvedBy === 'TIMEOUT'
                  ? '超时默认'
                  : '人工审批'
            }}
          </span>
          <span
            v-if="ticket.status === 'CANCELLED'"
            class="flex items-center gap-1 text-[11px] text-on-surface-variant"
          >
            <Ban :size="12" />
            端侧取消
          </span>
        </div>

        <div class="mt-2.5 rounded-lg bg-surface-container-low px-3 py-2">
          <p class="text-[11px] text-on-surface-variant">奏请决议点</p>
          <p class="mt-0.5 break-words text-sm leading-6 text-on-surface">
            {{ ticket.blockerQuestion }}
          </p>
        </div>

        <div v-if="ticket.selectedOption" class="mt-2.5 flex items-start gap-2">
          <CheckCircle2 :size="17" class="mt-0.5 shrink-0 text-secondary" />
          <p class="text-sm font-medium text-on-surface">
            方案 {{ ticket.selectedOption }} · {{ optionLabel(ticket, ticket.selectedOption) }}
          </p>
        </div>

        <div
          v-if="ticket.status !== 'CANCELLED' && (ticket.customInstruction || ticket.resolutionReason)"
          class="mt-2.5 flex items-start gap-2 rounded-lg bg-surface-container-lowest px-2.5 py-2 ring-1 ring-inset ring-outline-variant/40"
        >
          <span
            class="shrink-0 text-sm font-bold text-primary"
            style="font-family: var(--font-serif)"
          >
            批
          </span>
          <p class="text-xs leading-5 text-on-surface-variant">
            {{ ticket.customInstruction || ticket.resolutionReason }}
          </p>
        </div>
      </article>
    </div>
  </section>
</template>
