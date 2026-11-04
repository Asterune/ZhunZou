<script setup lang="ts">
import {
  Bot,
  CheckCircle2,
  Gavel,
  LogOut,
  MessageSquare,
  RefreshCw,
  ScrollText,
  Send,
  SlidersHorizontal,
  WifiOff,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import AgentPanel from './components/AgentPanel.vue';
import BatchApproveDialog from './components/BatchApproveDialog.vue';
import ChatPanel from './components/ChatPanel.vue';
import HistoryList from './components/HistoryList.vue';
import LoginGate from './components/LoginGate.vue';
import LocaleToggle from './components/LocaleToggle.vue';
import RulesEditor from './components/RulesEditor.vue';
import StatusBar from './components/StatusBar.vue';
import TaskBoard from './components/TaskBoard.vue';
import TicketCard from './components/TicketCard.vue';
import ToastStack from './components/ToastStack.vue';
import { relativeTime } from './lib/format';
import { useI18n } from './lib/i18n';
import { useHubStore } from './stores/hub';

type Tab = 'pending' | 'tasks' | 'chat' | 'agents' | 'history' | 'rules';

const store = useHubStore();
const { t } = useI18n();

function initialTab(): Tab {
  if (typeof window === 'undefined') return 'pending';
  const value = new URLSearchParams(window.location.search).get('tab');
  return value === 'tasks' ||
    value === 'chat' ||
    value === 'agents' ||
    value === 'history' ||
    value === 'rules'
    ? value
    : 'pending';
}

const activeTab = ref<Tab>(initialTab());
const batchOpen = ref(false);

const tabs = computed(() => [
  {
    key: 'pending' as const,
    label: t('app.tabs.pending'),
    icon: ScrollText,
    count: store.pendingTickets.length,
  },
  {
    key: 'tasks' as const,
    label: t('app.tabs.tasks'),
    icon: Send,
    count: store.activeTasks.length,
  },
  {
    key: 'chat' as const,
    label: t('app.tabs.chat'),
    icon: MessageSquare,
  },
  {
    key: 'agents' as const,
    label: t('app.tabs.agents'),
    icon: Bot,
    count: store.agents.length,
  },
  { key: 'history' as const, label: t('app.tabs.history'), icon: CheckCircle2 },
  { key: 'rules' as const, label: t('app.tabs.rules'), icon: SlidersHorizontal },
]);

const connectionLabel = computed(() => {
  if (store.connection === 'online') return t('app.connection.online');
  if (store.connection === 'offline') return t('app.connection.offline');
  return t('app.connection.connecting');
});

const connectionDotClass = computed(() => {
  if (store.connection === 'online') return 'bg-secondary';
  if (store.connection === 'offline') return 'bg-error';
  return 'bg-outline';
});

const connectionTextClass = computed(() => {
  if (store.connection === 'online') return 'text-secondary';
  if (store.connection === 'offline') return 'text-error';
  return 'text-on-surface-variant';
});

watch(activeTab, (tab) => {
  if (tab === 'rules') {
    void store.loadRules();
    void store.loadRuleCandidates();
  }
  if (tab === 'agents') {
    void store.loadAgents();
  }

  // Keep the new page at the top: switching while scrolled would otherwise
  // leave the viewport in the middle of a different page ("页面偏移").
  if (typeof window !== 'undefined') {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

    const url = new URL(window.location.href);
    if (tab === 'pending') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url);
  }
});

onMounted(() => {
  if (store.token) store.start();
});

onBeforeUnmount(() => {
  store.stop();
});
</script>

<template>
  <LoginGate v-if="!store.token" />

  <div v-else class="paper-grain min-h-screen bg-surface pb-24 md:pb-0">
    <header
      class="sticky top-0 z-40 border-b border-outline-variant/35 bg-surface shadow-[0_1px_8px_rgba(30,27,25,0.04)]"
    >
      <div class="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <div class="flex min-w-0 items-center gap-2.5">
          <span
            class="grid h-9 w-9 shrink-0 rotate-[-1deg] place-items-center rounded bg-primary text-[18px] font-bold text-on-primary shadow-[0_2px_8px_-2px_rgba(147,0,11,0.5)]"
            style="font-family: var(--font-serif)"
          >
            {{ t('app.mark') }}
          </span>
          <div class="min-w-0 leading-tight">
            <div class="flex items-center gap-1.5">
              <h1
                class="truncate text-lg font-semibold tracking-tight text-on-surface"
                style="font-family: var(--font-serif)"
              >
                {{ t('app.brand') }}
              </h1>
              <span class="hidden text-[10px] uppercase tracking-[0.16em] text-on-surface-variant/60 sm:inline">
                {{ t('app.wordmark') }}
              </span>
            </div>
            <div class="flex items-center gap-1.5 text-[11px]">
              <span class="relative flex h-2 w-2">
                <span
                  v-if="store.connection === 'online'"
                  class="absolute inline-flex h-full w-full animate-ping rounded-full bg-secondary opacity-60"
                />
                <span
                  class="relative inline-flex h-2 w-2 rounded-full"
                  :class="connectionDotClass"
                />
              </span>
              <span class="font-medium" :class="connectionTextClass">
                {{ connectionLabel }}
              </span>
              <span class="text-on-surface-variant/35">•</span>
              <span class="text-on-surface-variant">
                {{ store.lastSyncAt ? relativeTime(store.lastSyncAt) : t('app.syncing') }}
              </span>
            </div>
          </div>
        </div>

        <nav
          class="ml-4 hidden items-center gap-1 rounded-xl bg-surface-container/80 p-1 ring-1 ring-inset ring-outline-variant/40 md:flex"
          :aria-label="t('app.mainNav')"
        >
          <button
            v-for="tab in tabs"
            :key="tab.key"
            type="button"
            class="flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium"
            :aria-current="activeTab === tab.key ? 'page' : undefined"
            :class="
              activeTab === tab.key
                ? 'bg-primary text-on-primary shadow-sm'
                : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
            "
            @click="activeTab = tab.key"
          >
            <component :is="tab.icon" :size="16" />
            {{ tab.label }}
            <span
              class="grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold"
              :aria-hidden="!tab.count"
              :class="
                tab.count
                  ? activeTab === tab.key
                    ? 'bg-on-primary/20 text-on-primary'
                    : 'bg-primary text-on-primary'
                  : 'invisible'
              "
            >
              {{ tab.count || '' }}
            </span>
          </button>
        </nav>

        <div class="ml-auto flex shrink-0 items-center gap-1">
          <LocaleToggle />
          <button
            type="button"
            :aria-label="t('app.refresh')"
            :title="t('app.refresh')"
            class="grid h-9 w-9 place-items-center rounded-lg text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface disabled:opacity-50"
            :disabled="store.manualRefreshing"
            @click="store.refresh({ manual: true })"
          >
            <RefreshCw :size="18" :class="{ 'animate-spin': store.manualRefreshing }" />
          </button>
          <button
            type="button"
            :aria-label="t('app.logout')"
            :title="t('app.logout')"
            class="grid h-9 w-9 place-items-center rounded-lg text-on-surface-variant transition hover:bg-surface-container hover:text-error"
            @click="store.logout()"
          >
            <LogOut :size="18" />
          </button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      <div
        v-if="store.connection === 'offline'"
        class="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-tertiary-fixed px-3.5 py-2.5 text-xs text-on-tertiary-fixed shadow-sm"
      >
        <WifiOff :size="16" class="shrink-0" />
        <span class="min-w-0 flex-1 truncate">
          {{ t('app.syncInterrupted') }}{{ store.lastError || t('app.serverUnreachable') }}
        </span>
        <button
          type="button"
          class="shrink-0 rounded-md bg-tertiary px-2.5 py-1 text-[11px] font-medium text-on-tertiary-fixed transition hover:opacity-90"
          @click="store.refresh({ manual: true })"
        >
          {{ t('app.retry') }}
        </button>
      </div>

      <StatusBar />

      <section v-if="activeTab === 'pending'">
        <div class="mb-4 flex flex-wrap items-end justify-between gap-2 px-0.5">
          <div class="flex items-center gap-2">
            <span class="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-primary-container" />
            <h2
              class="text-xl font-semibold text-on-surface"
              style="font-family: var(--font-serif)"
            >
              {{ t('app.pendingTitle') }}
            </h2>
            <span
              v-if="store.pendingTickets.length"
              class="rounded bg-primary px-2 py-0.5 text-[11px] font-bold text-on-primary"
            >
              {{ t('app.pendingCount', { count: store.pendingTickets.length }) }}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <span class="hidden text-[11px] text-on-surface-variant sm:inline">
              {{ t('app.pendingHint') }}
            </span>
            <button
              v-if="store.pendingTickets.length > 1"
              type="button"
              class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary shadow-sm transition hover:bg-primary-container"
              @click="batchOpen = true"
            >
              <Gavel :size="14" />
              {{ t('app.batchApprove') }}
            </button>
          </div>
        </div>

        <div
          v-if="!store.pendingTickets.length"
          class="rounded-xl border border-outline-variant/35 bg-surface-container-low px-6 py-12 text-center shadow-inner"
        >
          <div
            class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-surface-container text-primary"
          >
            <CheckCircle2 :size="27" />
          </div>
          <h3
            class="mt-3 text-lg font-semibold text-on-surface"
            style="font-family: var(--font-serif)"
          >
            {{ t('app.emptyTitle') }}
          </h3>
          <p class="mx-auto mt-1 max-w-sm text-sm leading-6 text-on-surface-variant">
            {{ t('app.emptyDesc') }}
          </p>
          <span
            class="mt-4 inline-flex items-center gap-1.5 rounded-full bg-surface-container px-3 py-1 text-[11px] text-on-surface-variant"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-secondary" />
            {{ t('app.emptyDaemon') }}
          </span>
        </div>

        <div v-else class="grid gap-4 xl:grid-cols-[repeat(auto-fit,minmax(380px,1fr))]">
          <TicketCard
            v-for="ticket in store.pendingTickets"
            :key="ticket.id"
            :ticket="ticket"
          />
        </div>
      </section>

      <TaskBoard v-else-if="activeTab === 'tasks'" />

      <ChatPanel v-else-if="activeTab === 'chat'" />

      <AgentPanel v-else-if="activeTab === 'agents'" />

      <HistoryList v-else-if="activeTab === 'history'" />

      <RulesEditor v-else />
    </main>

    <BatchApproveDialog
      :open="batchOpen"
      :tickets="store.pendingTickets"
      @close="batchOpen = false"
    />

    <footer
      class="mx-auto hidden max-w-6xl px-6 pb-6 text-center text-[11px] text-on-surface-variant/60 md:block"
    >
      {{ t('app.footer') }}
    </footer>

    <nav
      class="fixed inset-x-0 bottom-0 z-40 border-t border-outline-variant/35 bg-surface/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_12px_rgba(30,27,25,0.05)] backdrop-blur-xl md:hidden"
    >
      <div class="flex h-16 items-stretch">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="relative flex flex-1 flex-col items-center justify-center gap-1 text-[11px]"
          :aria-current="activeTab === tab.key ? 'page' : undefined"
          :class="
            activeTab === tab.key
              ? 'font-semibold text-primary'
              : 'text-on-surface-variant'
          "
          @click="activeTab = tab.key"
        >
          <span class="relative">
            <component :is="tab.icon" :size="21" />
            <span
              v-if="tab.count"
              class="absolute -right-3 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-bold leading-none text-on-primary"
            >
              {{ tab.count }}
            </span>
          </span>
          <span>{{ tab.label }}</span>
        </button>
      </div>
    </nav>
  </div>

  <ToastStack />
</template>
