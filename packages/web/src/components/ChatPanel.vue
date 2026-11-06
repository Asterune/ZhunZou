<script setup lang="ts">
import {
  ArrowUp,
  MessageSquarePlus,
  PanelLeft,
  Plus,
  RefreshCw,
  Sparkles,
  X,
  XCircle,
} from 'lucide-vue-next';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';

import type {
  ChatMessage,
  ChatSession,
  CreateChatSessionInput,
} from '@zhunzou/shared';

import { hubApi } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';
import { pushToast } from '../lib/toast';
import ChatSessionList from './ChatSessionList.vue';
import SessionOutput from './SessionOutput.vue';

const store = useHubStore();
const { t } = useI18n();

/** Remember the open chat so a PWA update reload lands back in it. */
const ACTIVE_SESSION_KEY = 'zhunzou.chat.active';

function loadActiveSessionId(): string {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_SESSION_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberActiveSession(id: string): void {
  try {
    if (id) globalThis.localStorage?.setItem(ACTIVE_SESSION_KEY, id);
    else globalThis.localStorage?.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    // Private browsing may deny storage; the session still works in memory.
  }
}

const sessions = ref<ChatSession[]>([]);
const activeId = ref(loadActiveSessionId());
const session = ref<ChatSession | null>(null);
const messages = ref<ChatMessage[]>([]);
const draft = ref('');
const loadingList = ref(false);
const listLoaded = ref(false);
const loadingSession = ref(false);
const creating = ref(false);
const sending = ref(false);
const closing = ref(false);
const deletingId = ref('');
const retrying = ref('');
const proposalBusy = ref('');
const editingProposal = ref('');
const proposalDraft = ref('');
const error = ref('');

const formOpen = ref(false);
const sessionListOpen = ref(false);
const sessionListButton = ref<HTMLButtonElement | null>(null);
const sessionDrawer = ref<HTMLElement | null>(null);
const form = reactive({
  env: '',
  projectName: '',
  title: '',
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
let slowTimer: ReturnType<typeof setInterval> | null = null;
let listInFlight = false;
/** Sequence number of the newest `refreshSession` request. */
let sessionRequest = 0;

const envOptions = computed(() => {
  const agents = store.agents.filter((agent) => agent.status === 'active');
  // Online agents first so the default choice is one that can actually pick
  // the message up; offline ones stay visible but disabled.
  return [...agents].sort((left, right) => {
    if (left.online !== right.online) return left.online ? -1 : 1;
    return left.env.localeCompare(right.env);
  });
});

/** Env of the first agent that can actually claim a message, if any. */
function preferredEnv(options = envOptions.value): string {
  return options.find((agent) => agent.online)?.env ?? '';
}

const formAgent = computed(() =>
  envOptions.value.find((agent) => agent.env === form.env),
);

const formEnvOnline = computed(() => Boolean(formAgent.value?.online));

const sessionAgent = computed(() =>
  store.agents.find((agent) => agent.env === session.value?.env),
);

const sessionOnline = computed(() => Boolean(sessionAgent.value?.online));

/**
 * Only projects that belong to the selected env. Mixing in `knownProjects`
 * leaked projects from other environments into the dialog, so switching the
 * target env appeared to have no effect on the project dropdown.
 */
const projectOptions = computed(() => {
  if (!form.env) return [];
  const names = new Set(
    store
      .projectsForEnv(form.env)
      .map((project) => project.projectName),
  );
  const active = store.envs.find((item) => item.env === form.env)?.projectName;
  if (active) names.add(active);
  return [...names].sort((left, right) => left.localeCompare(right));
});

const runningMessage = computed(() =>
  [...messages.value]
    .reverse()
    .find((message) => message.role === 'user' && message.status === 'RUNNING'),
);

const activeSession = computed(() => session.value);

/**
 * The transcript is a fixed-height scroll box, so new turns have to be pulled
 * into view. Follow the bottom only while the reader is already there; someone
 * scrolled up to read history should not get yanked down by a background poll.
 */
const messagesEl = ref<HTMLElement | null>(null);
let stickToBottom = true;

function updateStick(): void {
  const element = messagesEl.value;
  if (!element) return;
  stickToBottom =
    element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

function scrollToBottom(force = false): void {
  const element = messagesEl.value;
  if (!element || (!force && !stickToBottom)) return;
  element.scrollTop = element.scrollHeight;
}

watch(
  () => messages.value.map((message) => `${message.id}:${message.status}`).join('|'),
  () => {
    void nextTick(() => scrollToBottom());
  },
);

/** A turn is in flight, so short-interval polls are worth their cost. */
const busy = computed(
  () => Boolean(runningMessage.value) || sending.value || Boolean(retrying.value),
);

const canSend = computed(
  () =>
    Boolean(session.value) &&
    session.value?.status === 'ACTIVE' &&
    draft.value.trim().length > 0 &&
    !sending.value,
);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : t('chat.operationFailed');
}

/**
 * Refresh the sidebar. Background polling passes `silent: true` so it never
 * toggles `loadingList`; flipping that flag used to unmount the empty state
 * (and spin the refresh icon) every couple of seconds, which read as a flash.
 */
async function loadSessions(
  selectFirst = false,
  options: { silent?: boolean } = {},
): Promise<void> {
  if (listInFlight) return;
  listInFlight = true;
  if (!options.silent) loadingList.value = true;
  try {
    const response = await hubApi.listChatSessions(store.token, undefined, 50);
    sessions.value = response.sessions;
    listLoaded.value = true;
    error.value = '';

    if (
      activeId.value &&
      !response.sessions.some((item) => item.id === activeId.value)
    ) {
      activeId.value = '';
      session.value = null;
      messages.value = [];
      rememberActiveSession('');
    }

    if (!session.value) {
      // Reopen the chat that was on screen before the reload; fall back to the
      // newest one when it was deleted elsewhere. Also covers a first load
      // that failed while the hub was restarting.
      if (activeId.value) await refreshSession({ force: true });
      else if (selectFirst && response.sessions[0]) {
        await openSession(response.sessions[0].id);
      }
    }
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    listInFlight = false;
    if (!options.silent) loadingList.value = false;
  }
}

async function refreshSession(
  options: { force?: boolean } = {},
): Promise<void> {
  const id = activeId.value;
  if (!id) return;
  // Background polls must not pile up on the same session, but an explicit
  // switch has to go through: otherwise a poll already in flight makes the
  // tap a no-op and its response paints the *old* session back over the new
  // one. `request` lets the newest call win regardless of arrival order.
  if (loadingSession.value && !options.force) return;
  const request = ++sessionRequest;
  loadingSession.value = true;
  try {
    const response = await hubApi.getChatSession(store.token, id);
    if (request !== sessionRequest || activeId.value !== id) return;
    session.value = response.session;
    messages.value = response.messages ?? [];
    error.value = '';
  } catch (cause) {
    if (request !== sessionRequest || activeId.value !== id) return;
    error.value = describe(cause);
  } finally {
    if (request === sessionRequest) loadingSession.value = false;
  }
}

async function openSession(id: string): Promise<void> {
  sessionListOpen.value = false;
  activeId.value = id;
  rememberActiveSession(id);
  session.value = null;
  messages.value = [];
  cancelEditProposal();
  await refreshSession({ force: true });
  stickToBottom = true;
  void nextTick(() => scrollToBottom(true));
  if (typeof window !== 'undefined') {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

// The dashboard long poll tells us when sessions or messages changed. Only
// fall back to timers as a safety net, and poll faster while a turn runs.
watch(
  () => store.rev,
  () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void loadSessions(false, { silent: true });
    void refreshSession();
  },
);

function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (!busy.value) return;
    void loadSessions(false, { silent: true });
    void refreshSession();
  }, 2_000);
  // Recovery net in case a revision is missed (restart, dropped event).
  slowTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void loadSessions(false, { silent: true });
    void refreshSession();
  }, 20_000);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (slowTimer !== null) {
    clearInterval(slowTimer);
    slowTimer = null;
  }
}

async function createSession(): Promise<void> {
  if (creating.value) return;
  const env = form.env.trim();
  if (!env) {
    pushToast(t('chat.selectEnvError'), 'error');
    return;
  }
  if (!formEnvOnline.value) {
    pushToast(t('chat.envOfflineError'), 'error');
    return;
  }

  creating.value = true;
  try {
    const input: CreateChatSessionInput = {
      env,
      ...(form.projectName ? { projectName: form.projectName } : {}),
      ...(form.title.trim() ? { title: form.title.trim() } : {}),
    };
    const response = await hubApi.createChatSession(store.token, input);
    formOpen.value = false;
    form.title = '';
    await loadSessions();
    await openSession(response.session.id);
    pushToast(t('chat.created'), 'success');
  } catch (cause) {
    pushToast(describe(cause), 'error');
  } finally {
    creating.value = false;
  }
}

async function send(): Promise<void> {
  if (!canSend.value || !session.value) return;
  const content = draft.value.trim();
  if (!content) return;

  sending.value = true;
  try {
    await hubApi.sendChatMessage(store.token, session.value.id, content);
    draft.value = '';
    await refreshSession();
    await loadSessions();
    stickToBottom = true;
    void nextTick(() => scrollToBottom(true));
    // The runner long-polls and picks this up immediately.
    setTimeout(() => void refreshSession(), 800);
  } catch (cause) {
    pushToast(describe(cause), 'error');
  } finally {
    sending.value = false;
  }
}

async function retryMessage(message: ChatMessage): Promise<void> {
  if (!session.value || retrying.value || session.value.status !== 'ACTIVE') {
    return;
  }

  retrying.value = message.id;
  try {
    await hubApi.retryChatMessage(store.token, session.value.id, message.id);
    await refreshSession();
    await loadSessions();
    pushToast(t('chat.requeued'), 'success');
  } catch (cause) {
    pushToast(describe(cause), 'error');
  } finally {
    retrying.value = '';
  }
}

function startEditProposal(message: ChatMessage): void {
  editingProposal.value = message.id;
  proposalDraft.value = message.content;
}

function cancelEditProposal(): void {
  editingProposal.value = '';
  proposalDraft.value = '';
}

async function adoptProposal(
  message: ChatMessage,
  content?: string,
): Promise<void> {
  if (!session.value || proposalBusy.value) return;
  const edited = content?.trim();
  if (content !== undefined && !edited) return;

  proposalBusy.value = message.id;
  try {
    await hubApi.adoptChatProposal(
      store.token,
      session.value.id,
      message.id,
      edited || undefined,
    );
    cancelEditProposal();
    await refreshSession();
    await loadSessions();
    stickToBottom = true;
    void nextTick(() => scrollToBottom(true));
    pushToast(t('chat.proposalAdopted'), 'success');
    // The runner long-polls and picks the adopted reply up immediately.
    setTimeout(() => void refreshSession(), 800);
  } catch (cause) {
    pushToast(describe(cause), 'error');
  } finally {
    proposalBusy.value = '';
  }
}

async function discardProposal(message: ChatMessage): Promise<void> {
  if (!session.value || proposalBusy.value) return;

  proposalBusy.value = message.id;
  try {
    await hubApi.discardChatProposal(store.token, session.value.id, message.id);
    await refreshSession();
    await loadSessions();
    pushToast(t('chat.proposalDiscarded'), 'success');
  } catch (cause) {
    pushToast(describe(cause), 'error');
  } finally {
    proposalBusy.value = '';
  }
}

async function closeSession(): Promise<void> {
  if (!session.value || closing.value) return;
  if (!globalThis.confirm(t('chat.closeConfirm'))) return;

  closing.value = true;
  try {
    const response = await hubApi.closeChatSession(store.token, session.value.id);
    session.value = response.session;
    await loadSessions();
    pushToast(t('chat.closed'), 'success');
  } catch (cause) {
    pushToast(describe(cause), 'error');
  } finally {
    closing.value = false;
  }
}

async function deleteSession(item: ChatSession): Promise<void> {
  if (deletingId.value) return;
  if (!globalThis.confirm(t('chat.deleteConfirm', { title: item.title }))) {
    return;
  }

  deletingId.value = item.id;
  try {
    await hubApi.deleteChatSession(store.token, item.id);
    if (activeId.value === item.id) {
      activeId.value = '';
      session.value = null;
      messages.value = [];
      rememberActiveSession('');
    }
    sessions.value = sessions.value.filter((entry) => entry.id !== item.id);
    await loadSessions(true);
    pushToast(t('chat.deleted'), 'success');
  } catch (cause) {
    pushToast(describe(cause), 'error');
  } finally {
    deletingId.value = '';
  }
}

function openForm(): void {
  formOpen.value = true;
  const current = envOptions.value.find((agent) => agent.env === form.env);
  if (!current?.online) form.env = preferredEnv();
}

function openSessionList(): void {
  sessionListOpen.value = true;
}

function closeSessionList(): void {
  sessionListOpen.value = false;
}

function onSessionListKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeSessionList();
}

// The PWA keeps the transcript on screen and slides the session list in from
// the left, so switching chats never steals half the viewport.
watch(sessionListOpen, async (open) => {
  if (typeof document !== 'undefined') {
    document.body.style.overflow = open ? 'hidden' : '';
  }
  if (open) {
    document.addEventListener('keydown', onSessionListKeydown);
    await nextTick();
    sessionDrawer.value?.focus();
  } else {
    document.removeEventListener('keydown', onSessionListKeydown);
    sessionListButton.value?.focus();
  }
});

watch(envOptions, (options) => {
  const current = options.find((agent) => agent.env === form.env);
  if (!current?.online) {
    form.env = preferredEnv(options);
  }
}, { immediate: true });

watch(
  () => form.env,
  () => {
    if (
      form.projectName &&
      !projectOptions.value.includes(form.projectName)
    ) {
      form.projectName = '';
    }
  },
);

onMounted(() => {
  void loadSessions(true);
  startPolling();
});

onBeforeUnmount(() => {
  stopPolling();
  document.removeEventListener('keydown', onSessionListKeydown);
  document.body.style.overflow = '';
});
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
          {{ t('chat.title') }}
        </h2>
        <span class="text-[11px] text-on-surface-variant/70">
          {{ t('chat.subtitle') }}
        </span>
      </div>
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary shadow-sm transition hover:bg-primary-container"
        @click="openForm"
      >
        <MessageSquarePlus :size="14" />
        {{ t('chat.new') }}
      </button>
    </div>

    <p
      v-if="error"
      class="mb-3 rounded-lg bg-error-container/50 px-3 py-2 text-[12px] text-on-error-container"
    >
      {{ error }}
    </p>

    <!-- New session dialog -->
    <Teleport to="body">
      <div
        v-if="formOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
        role="dialog"
        aria-modal="true"
        @click.self="formOpen = false"
      >
        <form
          class="w-full max-w-md rounded-2xl border border-outline-variant/40 bg-surface p-5 shadow-xl"
          @submit.prevent="createSession"
        >
          <div class="mb-4 flex items-center justify-between">
            <h3
              class="text-lg font-semibold text-on-surface"
              style="font-family: var(--font-serif)"
            >
              {{ t('chat.dialogTitle') }}
            </h3>
            <button
              type="button"
              class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container"
              :aria-label="t('agents.close')"
              @click="formOpen = false"
            >
              <X :size="16" />
            </button>
          </div>

          <label class="mb-3 block text-[12px] text-on-surface-variant">
            {{ t('chat.dialogEnv') }}
            <select
              v-model="form.env"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary"
            >
              <option value="" disabled>
                {{ envOptions.some((agent) => agent.online) ? t('chat.selectOnline') : t('chat.noOnlineAgent') }}
              </option>
              <option
                v-for="agent in envOptions"
                :key="agent.env"
                :value="agent.env"
                :disabled="!agent.online"
              >
                {{ agent.env }} · {{ agent.kind }}{{ agent.online ? '' : t('chat.offlineSuffix') }}
              </option>
            </select>
            <span
              v-if="!envOptions.some((agent) => agent.online)"
              class="mt-1 block text-[11px] text-error"
            >
              {{ t('chat.noOnlineHint') }}
            </span>
          </label>

          <label class="mb-3 block text-[12px] text-on-surface-variant">
            {{ t('chat.dialogProject') }}
            <select
              v-model="form.projectName"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary"
            >
              <option value="">{{ t('chat.defaultDir') }}</option>
              <option v-for="project in projectOptions" :key="project" :value="project">
                {{ project }}
              </option>
            </select>
          </label>

          <label class="mb-4 block text-[12px] text-on-surface-variant">
            {{ t('chat.dialogTitleLabel') }}
            <input
              v-model="form.title"
              maxlength="120"
              :placeholder="t('chat.dialogTitlePlaceholder')"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 text-[13px] text-on-surface outline-none focus:border-primary"
            />
          </label>

          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-[12px] font-medium text-on-surface-variant hover:bg-surface-container"
              @click="formOpen = false"
            >
              {{ t('chat.cancel') }}
            </button>
            <button
              type="submit"
              class="h-9 rounded-lg bg-primary px-4 text-[12px] font-medium text-on-primary transition hover:bg-primary-container disabled:opacity-50"
              :disabled="creating || !form.env"
            >
              {{ creating ? t('chat.creating') : t('chat.create') }}
            </button>
          </div>
        </form>
      </div>
    </Teleport>

    <div class="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
      <!-- Desktop session list -->
      <aside
        class="hidden flex-col lg:flex lg:h-[clamp(420px,calc(100dvh_-_14rem),760px)]"
      >
        <ChatSessionList
          :sessions="sessions"
          :active-id="activeId"
          :loading="loadingList"
          :loaded="listLoaded"
          :deleting-id="deletingId"
          @open="openSession"
          @delete="deleteSession"
          @refresh="loadSessions(true)"
        />
      </aside>

      <!-- Mobile session drawer: the transcript stays on screen. -->
      <Teleport to="body">
        <Transition
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="opacity-0"
          leave-active-class="transition duration-150 ease-in"
          leave-to-class="opacity-0"
        >
          <div
            v-if="sessionListOpen"
            class="fixed inset-0 z-50 lg:hidden"
            role="dialog"
            aria-modal="true"
            :aria-label="t('chat.all')"
          >
            <div
              class="absolute inset-0 bg-black/40 backdrop-blur-sm"
              @click="closeSessionList"
            />
            <aside
              ref="sessionDrawer"
              tabindex="-1"
              class="absolute inset-y-0 left-0 flex w-[86vw] max-w-xs flex-col bg-surface px-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))] pt-[calc(0.75rem_+_env(safe-area-inset-top))] shadow-2xl outline-none"
            >
              <ChatSessionList
                :sessions="sessions"
                :active-id="activeId"
                :loading="loadingList"
                :loaded="listLoaded"
                :deleting-id="deletingId"
                dismissible
                @open="openSession"
                @delete="deleteSession"
                @refresh="loadSessions(true)"
                @close="closeSessionList"
              />
            </aside>
          </div>
        </Transition>
      </Teleport>

      <!-- Chat -->
      <div
        v-if="activeSession"
        class="flex flex-col overflow-hidden rounded-xl border border-outline-variant/35 bg-surface-container-lowest shadow-sm"
        style="height: clamp(340px, calc(100dvh - 13rem), 760px)"
      >
        <header class="flex shrink-0 items-center gap-2 border-b border-outline-variant/30 px-2 py-3 sm:px-4">
          <button
            ref="sessionListButton"
            type="button"
            class="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface lg:hidden"
            :aria-label="t('chat.openList')"
            :title="t('chat.openList')"
            @click="openSessionList"
          >
            <PanelLeft :size="18" />
          </button>
          <div class="min-w-0 flex-1">
            <h3 class="truncate text-sm font-semibold text-on-surface">
              {{ activeSession.title }}
            </h3>
            <p class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-on-surface-variant">
              <span class="rounded bg-surface-container-high px-1.5 py-0.5 font-mono">
                {{ activeSession.env }}
              </span>
              <span v-if="activeSession.projectName" class="font-mono">
                {{ activeSession.projectName }}
              </span>
              <span v-if="activeSession.status === 'CLOSED'" class="text-primary">
                · {{ t('chat.closedBadge') }}
              </span>
              <span v-else-if="sessionOnline" class="flex items-center gap-1 text-secondary">
                <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-secondary" />
                {{ t('chat.online') }}
              </span>
              <span v-else class="flex items-center gap-1 text-error">
                <span class="h-1.5 w-1.5 rounded-full bg-error" />
                {{ t('chat.agentOffline') }}
              </span>
            </p>
          </div>
          <button
            v-if="activeSession.status === 'ACTIVE'"
            type="button"
            class="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-on-surface-variant transition hover:bg-error-container hover:text-on-error-container disabled:opacity-50"
            :disabled="closing"
            @click="closeSession"
          >
            <XCircle :size="13" />
            {{ t('chat.close') }}
          </button>
        </header>

        <div
          ref="messagesEl"
          class="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4"
          @scroll.passive="updateStick"
        >
          <div
            v-for="message in messages"
            :key="message.id"
            :class="message.role === 'user' ? 'flex justify-end' : 'flex justify-start'"
          >
            <div
              v-if="message.status === 'PROPOSED' || message.status === 'DISCARDED'"
              class="max-w-[85%] rounded-2xl border border-dashed px-3.5 py-2.5 text-[13px] leading-6"
              :class="
                message.status === 'PROPOSED'
                  ? 'border-primary/60 bg-surface-container text-on-surface'
                  : 'border-outline-variant/40 bg-surface-container/60 text-on-surface-variant'
              "
            >
              <p
                class="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium tracking-wide uppercase"
                :class="
                  message.status === 'PROPOSED'
                    ? 'text-primary'
                    : 'text-on-surface-variant'
                "
              >
                <Sparkles :size="12" />
                {{
                  message.status === 'PROPOSED'
                    ? t('chat.proposalBadge')
                    : t('chat.proposalDiscardedBadge')
                }}
              </p>

              <template v-if="editingProposal === message.id">
                <textarea
                  v-model="proposalDraft"
                  rows="3"
                  maxlength="32000"
                  class="w-full resize-none rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 py-1.5 text-[13px] leading-5 text-on-surface outline-none focus:border-primary"
                  @keydown.enter.exact.prevent="adoptProposal(message, proposalDraft)"
                  @keydown.esc.prevent="cancelEditProposal"
                />
              </template>
              <p v-else class="whitespace-pre-wrap break-words">{{ message.content }}</p>

              <p
                v-if="message.rationale"
                class="mt-1.5 text-[11px] text-on-surface-variant"
              >
                {{ t('chat.proposalWhy', { reason: message.rationale }) }}
              </p>

              <div
                v-if="message.status === 'PROPOSED'"
                class="mt-2 flex flex-wrap items-center gap-1.5"
              >
                <template v-if="editingProposal === message.id">
                  <button
                    type="button"
                    class="rounded-lg bg-primary px-2 py-1 text-[11px] font-medium text-on-primary transition hover:opacity-90 disabled:opacity-50"
                    :disabled="proposalBusy === message.id || !proposalDraft.trim()"
                    @click="adoptProposal(message, proposalDraft)"
                  >
                    {{ t('chat.proposalAdopt') }}
                  </button>
                  <button
                    type="button"
                    class="rounded-lg px-2 py-1 text-[11px] text-on-surface-variant transition hover:bg-surface-container-high"
                    @click="cancelEditProposal"
                  >
                    {{ t('chat.cancel') }}
                  </button>
                </template>
                <template v-else>
                  <button
                    type="button"
                    class="rounded-lg bg-primary px-2 py-1 text-[11px] font-medium text-on-primary transition hover:opacity-90 disabled:opacity-50"
                    :disabled="proposalBusy === message.id || activeSession.status !== 'ACTIVE'"
                    @click="adoptProposal(message)"
                  >
                    {{ t('chat.proposalAdopt') }}
                  </button>
                  <button
                    type="button"
                    class="rounded-lg border border-outline-variant/50 px-2 py-1 text-[11px] text-on-surface transition hover:bg-surface-container-high disabled:opacity-50"
                    :disabled="proposalBusy === message.id || activeSession.status !== 'ACTIVE'"
                    @click="startEditProposal(message)"
                  >
                    {{ t('chat.proposalEdit') }}
                  </button>
                  <button
                    type="button"
                    class="rounded-lg px-2 py-1 text-[11px] text-on-surface-variant transition hover:bg-error-container hover:text-on-error-container disabled:opacity-50"
                    :disabled="proposalBusy === message.id"
                    @click="discardProposal(message)"
                  >
                    {{ t('chat.proposalDiscard') }}
                  </button>
                </template>
              </div>
            </div>

            <div
              v-else
              class="max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-6"
              :class="
                message.role === 'user'
                  ? 'bg-primary text-on-primary'
                  : message.role === 'system'
                    ? 'bg-surface-container text-on-surface-variant'
                    : 'bg-surface-container text-on-surface'
              "
            >
              <p class="whitespace-pre-wrap break-words">{{ message.content }}</p>
              <p
                v-if="message.role === 'user' && message.status === 'FAILED'"
                class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[#ffd5d0]"
              >
                <span>{{ t('chat.failed') }}{{ message.error ? `: ${message.error}` : '' }}</span>
                <button
                  type="button"
                  class="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-medium text-white transition hover:bg-white/25 disabled:opacity-50"
                  :disabled="retrying === message.id || activeSession.status !== 'ACTIVE'"
                  @click="retryMessage(message)"
                >
                  {{ retrying === message.id ? t('chat.retrying') : t('chat.retry') }}
                </button>
              </p>
              <p
                v-if="message.role === 'user' && message.decision === 'AUTO'"
                class="mt-1 text-[10px] text-on-primary/70"
              >
                {{ t('chat.autoAdopted', { reason: message.rationale ?? '' }) }}
              </p>
              <p
                v-if="message.role === 'user' && message.status === 'PENDING'"
                class="mt-1 text-[10px] text-on-primary/70"
              >
                {{ sessionOnline ? t('chat.waiting') : t('chat.waitingOffline') }}
              </p>
            </div>
          </div>

          <p
            v-if="!messages.length"
            class="py-10 text-center text-[12px] text-on-surface-variant"
          >
            {{ t('chat.firstMessage') }}
          </p>

          <SessionOutput
            v-if="runningMessage"
            :key="runningMessage.id"
            :session-id="activeSession.id"
            :message-id="runningMessage.id"
            :active="true"
          />
        </div>

        <div class="shrink-0 border-t border-outline-variant/30 p-3">
          <div class="flex items-end gap-2">
            <textarea
              v-model="draft"
              rows="2"
              maxlength="32000"
              :disabled="activeSession.status !== 'ACTIVE' || sending"
              :placeholder="t('chat.inputPlaceholder')"
              class="min-h-[52px] flex-1 resize-none rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-3 py-2 text-[13px] leading-5 text-on-surface outline-none focus:border-primary disabled:opacity-60"
              @keydown.enter.exact.prevent="send"
            />
            <button
              type="button"
              class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary text-on-primary transition hover:bg-primary-container disabled:opacity-40"
              :disabled="!canSend"
              :aria-label="t('chat.send')"
              @click="send"
            >
              <ArrowUp :size="17" />
            </button>
          </div>
          <p class="mt-1.5 text-[10px] text-on-surface-variant/60">
            {{ t('chat.runnerHintBefore') }} <span class="font-mono">wake</span>
            {{ t('chat.runnerHintMiddle') }}
            <span class="font-mono">fleet</span>{{ t('chat.runnerHintAfter') }}
          </p>
        </div>
      </div>

      <div
        v-else
        class="flex min-h-[320px] items-center justify-center rounded-xl border border-dashed border-outline-variant bg-surface-container-low/60 p-6 text-center text-[12px] text-on-surface-variant"
      >
        <div>
          <template v-if="loadingSession">
            <RefreshCw
              :size="22"
              class="mx-auto mb-2 animate-spin text-on-surface-variant/50"
            />
            {{ t('chat.loadingSession') }}
          </template>
          <template v-else>
            <Plus :size="22" class="mx-auto mb-2 text-on-surface-variant/50" />
            {{ t('chat.selectOrCreate') }}
            <button
              type="button"
              class="mt-3 flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary shadow-sm transition hover:bg-primary-container lg:hidden"
              @click="openSessionList"
            >
              <PanelLeft :size="14" />
              {{ t('chat.openList') }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
