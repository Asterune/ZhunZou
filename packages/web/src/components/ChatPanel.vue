<script setup lang="ts">
import {
  ArrowUp,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import type {
  ChatMessage,
  ChatSession,
  CreateChatSessionInput,
} from '@zhunzou/shared';

import { hubApi } from '../lib/api';
import { relativeTime } from '../lib/format';
import { useHubStore } from '../stores/hub';
import { pushToast } from '../lib/toast';
import SessionOutput from './SessionOutput.vue';

const store = useHubStore();

const sessions = ref<ChatSession[]>([]);
const activeId = ref('');
const session = ref<ChatSession | null>(null);
const messages = ref<ChatMessage[]>([]);
const draft = ref('');
const loadingList = ref(false);
const loadingSession = ref(false);
const creating = ref(false);
const sending = ref(false);
const closing = ref(false);
const error = ref('');

const formOpen = ref(false);
const form = reactive({
  env: '',
  projectName: '',
  title: '',
});

let pollTimer: ReturnType<typeof setInterval> | null = null;

const envOptions = computed(() => {
  const agents = store.agents.filter((agent) => agent.status === 'active');
  if (agents.length > 0) return agents;
  return [];
});

const projectOptions = computed(() => {
  if (!form.env) return [];
  const bound = store.projectsForEnv(form.env).map(
    (project) => project.projectName,
  );
  return [...new Set([...bound, ...store.knownProjects])].sort((left, right) =>
    left.localeCompare(right),
  );
});

const runningMessage = computed(() =>
  [...messages.value]
    .reverse()
    .find((message) => message.role === 'user' && message.status === 'RUNNING'),
);

const activeSession = computed(() => session.value);

const canSend = computed(
  () =>
    Boolean(session.value) &&
    session.value?.status === 'ACTIVE' &&
    draft.value.trim().length > 0 &&
    !sending.value,
);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

async function loadSessions(selectFirst = false): Promise<void> {
  if (loadingList.value) return;
  loadingList.value = true;
  try {
    const response = await hubApi.listChatSessions(store.token, undefined, 50);
    sessions.value = response.sessions;
    error.value = '';

    if (selectFirst && !activeId.value && response.sessions[0]) {
      await openSession(response.sessions[0].id);
    } else if (
      activeId.value &&
      !response.sessions.some((item) => item.id === activeId.value)
    ) {
      activeId.value = '';
      session.value = null;
      messages.value = [];
    }
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    loadingList.value = false;
  }
}

async function refreshSession(): Promise<void> {
  if (!activeId.value || loadingSession.value) return;
  loadingSession.value = true;
  try {
    const response = await hubApi.getChatSession(store.token, activeId.value);
    session.value = response.session;
    messages.value = response.messages ?? [];
    error.value = '';
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    loadingSession.value = false;
  }
}

async function openSession(id: string): Promise<void> {
  activeId.value = id;
  session.value = null;
  messages.value = [];
  await refreshSession();
  if (typeof window !== 'undefined') {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => {
    if (typeof document === 'undefined' || !document.hidden) {
      void loadSessions();
      void refreshSession();
    }
  }, 2_000);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function createSession(): Promise<void> {
  if (creating.value) return;
  const env = form.env.trim();
  if (!env) {
    pushToast('请选择目标环境', 'error');
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
    pushToast('已创建会话', 'success');
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
    // The runner long-polls and picks this up immediately.
    setTimeout(() => void refreshSession(), 800);
  } catch (cause) {
    pushToast(describe(cause), 'error');
  } finally {
    sending.value = false;
  }
}

async function closeSession(): Promise<void> {
  if (!session.value || closing.value) return;
  if (!globalThis.confirm('关闭这个会话？关闭后不能继续发消息。')) return;

  closing.value = true;
  try {
    const response = await hubApi.closeChatSession(store.token, session.value.id);
    session.value = response.session;
    await loadSessions();
    pushToast('会话已关闭', 'success');
  } catch (cause) {
    pushToast(describe(cause), 'error');
  } finally {
    closing.value = false;
  }
}

function openForm(): void {
  formOpen.value = true;
  if (!form.env && envOptions.value[0]) form.env = envOptions.value[0].env;
}

watch(envOptions, (options) => {
  if (!form.env && options[0]) form.env = options[0].env;
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

onBeforeUnmount(stopPolling);
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
          会话
        </h2>
        <span class="text-[11px] text-on-surface-variant/70">
          与任意项目的 Agent 多轮对话
        </span>
      </div>
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary shadow-sm transition hover:bg-primary-container"
        @click="openForm"
      >
        <MessageSquarePlus :size="14" />
        新建会话
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
              新建会话
            </h3>
            <button
              type="button"
              class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container"
              aria-label="关闭"
              @click="formOpen = false"
            >
              <X :size="16" />
            </button>
          </div>

          <label class="mb-3 block text-[12px] text-on-surface-variant">
            目标环境
            <select
              v-model="form.env"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary"
            >
              <option value="" disabled>选择在线 Agent</option>
              <option v-for="agent in envOptions" :key="agent.env" :value="agent.env">
                {{ agent.env }} · {{ agent.kind }}
              </option>
            </select>
          </label>

          <label class="mb-3 block text-[12px] text-on-surface-variant">
            项目（可选）
            <select
              v-model="form.projectName"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary"
            >
              <option value="">使用项目默认目录</option>
              <option v-for="project in projectOptions" :key="project" :value="project">
                {{ project }}
              </option>
            </select>
          </label>

          <label class="mb-4 block text-[12px] text-on-surface-variant">
            标题（可选）
            <input
              v-model="form.title"
              maxlength="120"
              placeholder="例如：重构登录页"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 text-[13px] text-on-surface outline-none focus:border-primary"
            />
          </label>

          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-[12px] font-medium text-on-surface-variant hover:bg-surface-container"
              @click="formOpen = false"
            >
              取消
            </button>
            <button
              type="submit"
              class="h-9 rounded-lg bg-primary px-4 text-[12px] font-medium text-on-primary transition hover:bg-primary-container disabled:opacity-50"
              :disabled="creating || !form.env"
            >
              {{ creating ? '创建中…' : '创建' }}
            </button>
          </div>
        </form>
      </div>
    </Teleport>

    <div class="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
      <!-- Session list -->
      <aside class="space-y-2">
        <div class="flex items-center justify-between px-0.5 text-[11px] text-on-surface-variant">
          <span>全部会话</span>
          <button
            type="button"
            class="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-container"
            :disabled="loadingList"
            @click="loadSessions()"
          >
            <RefreshCw :size="12" :class="{ 'animate-spin': loadingList }" />
          </button>
        </div>

        <button
          v-for="item in sessions"
          :key="item.id"
          type="button"
          class="w-full rounded-xl border px-3 py-2.5 text-left transition"
          :class="
            item.id === activeId
              ? 'border-primary/40 bg-primary/5'
              : 'border-outline-variant/35 bg-surface-container-low hover:bg-surface-container'
          "
          @click="openSession(item.id)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="truncate text-[12px] font-semibold text-on-surface">
              {{ item.title }}
            </span>
            <span
              v-if="item.status === 'CLOSED'"
              class="shrink-0 rounded bg-surface-container-high px-1.5 py-0.5 text-[9px] text-on-surface-variant"
            >
              已关闭
            </span>
          </div>
          <div class="mt-1 flex items-center gap-1.5 text-[10px] text-on-surface-variant">
            <span class="rounded bg-surface-container-high px-1 py-0.5 font-mono">
              {{ item.env }}
            </span>
            <span v-if="item.projectName" class="truncate">{{ item.projectName }}</span>
          </div>
          <div class="mt-1 text-[10px] text-on-surface-variant/60">
            {{ item.messageCount ?? 0 }} 条消息 · {{ item.lastMessageAt ? relativeTime(item.lastMessageAt) : '刚创建' }}
          </div>
        </button>

        <p
          v-if="!sessions.length && !loadingList"
          class="rounded-xl border border-dashed border-outline-variant bg-surface-container-low/60 px-3 py-6 text-center text-[12px] text-on-surface-variant"
        >
          还没有会话。点「新建会话」选一个在线 Agent 开始。
        </p>
      </aside>

      <!-- Chat -->
      <div
        v-if="activeSession"
        class="flex min-h-[480px] flex-col rounded-xl border border-outline-variant/35 bg-surface-container-lowest shadow-sm"
      >
        <header class="flex items-center justify-between gap-2 border-b border-outline-variant/30 px-4 py-3">
          <div class="min-w-0">
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
                · 已关闭
              </span>
              <span v-else class="flex items-center gap-1 text-secondary">
                <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-secondary" />
                在线
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
            关闭
          </button>
        </header>

        <div class="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <div
            v-for="message in messages"
            :key="message.id"
            :class="message.role === 'user' ? 'flex justify-end' : 'flex justify-start'"
          >
            <div
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
                class="mt-1 text-[11px] text-[#ffd5d0]"
              >
                执行失败{{ message.error ? `：${message.error}` : '' }}
              </p>
              <p
                v-if="message.role === 'user' && message.status === 'PENDING'"
                class="mt-1 text-[10px] text-on-primary/70"
              >
                等待端侧领取…
              </p>
            </div>
          </div>

          <p
            v-if="!messages.length"
            class="py-10 text-center text-[12px] text-on-surface-variant"
          >
            发送第一条消息开始对话。
          </p>

          <SessionOutput
            v-if="runningMessage"
            :session-id="activeSession.id"
            :message-id="runningMessage.id"
            :active="true"
          />
        </div>

        <div class="border-t border-outline-variant/30 p-3">
          <div class="flex items-end gap-2">
            <textarea
              v-model="draft"
              rows="2"
              maxlength="8000"
              :disabled="activeSession.status !== 'ACTIVE' || sending"
              placeholder="给这个项目的 Agent 发消息…（Enter 发送，Shift+Enter 换行）"
              class="min-h-[52px] flex-1 resize-none rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-3 py-2 text-[13px] leading-5 text-on-surface outline-none focus:border-primary disabled:opacity-60"
              @keydown.enter.exact.prevent="send"
            />
            <button
              type="button"
              class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary text-on-primary transition hover:bg-primary-container disabled:opacity-40"
              :disabled="!canSend"
              aria-label="发送"
              @click="send"
            >
              <ArrowUp :size="17" />
            </button>
          </div>
          <p class="mt-1.5 text-[10px] text-on-surface-variant/60">
            会话由端侧 runner 执行；没有运行中的 fleet 时消息会停在待领取。
          </p>
        </div>
      </div>

      <div
        v-else
        class="flex min-h-[320px] items-center justify-center rounded-xl border border-dashed border-outline-variant bg-surface-container-low/60 p-6 text-center text-[12px] text-on-surface-variant"
      >
        <div>
          <Plus :size="22" class="mx-auto mb-2 text-on-surface-variant/50" />
          选择一个会话，或新建一个。
        </div>
      </div>
    </div>
  </section>
</template>
