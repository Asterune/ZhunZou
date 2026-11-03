<script setup lang="ts">
import {
  Bot,
  Check,
  Copy,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  ShieldOff,
  Trash2,
  UserRoundCheck,
  UserRoundX,
  X,
} from 'lucide-vue-next';
import { computed, reactive, ref } from 'vue';

import type { Agent, AgentKind, UpdateAgentInput } from '@zhunzou/shared';

import { relativeTime } from '../lib/format';
import { useHubStore } from '../stores/hub';

const store = useHubStore();

const KIND_LABELS: Record<AgentKind, string> = {
  cursor: 'Cursor',
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  windsurf: 'Windsurf',
  other: '其他客户端',
};

const KIND_OPTIONS = Object.entries(KIND_LABELS) as Array<
  [AgentKind, string]
>;

const formOpen = ref(false);
const editingEnv = ref('');
const saving = ref(false);
const form = reactive({
  env: '',
  name: '',
  kind: 'cursor' as AgentKind,
});

const tokenDialog = ref<{ env: string; token: string } | null>(null);
const copied = ref(false);

const agentCount = computed(() => store.agents.length);
const offlineCount = computed(
  () => store.agents.filter((agent) => !agent.online).length,
);

function kindLabel(agent: Agent): string {
  return KIND_LABELS[agent.kind] ?? agent.kind;
}

function openRegister(): void {
  editingEnv.value = '';
  form.env = '';
  form.name = '';
  form.kind = 'cursor';
  formOpen.value = true;
}

function openEdit(agent: Agent): void {
  editingEnv.value = agent.env;
  form.env = agent.env;
  form.name = agent.name;
  form.kind = agent.kind;
  formOpen.value = true;
}

async function submitForm(): Promise<void> {
  if (saving.value) return;
  const name = form.name.trim();
  const env = form.env.trim();
  if (!env) return;

  saving.value = true;
  try {
    if (editingEnv.value) {
      const patch: UpdateAgentInput = {
        name: name || env,
        kind: form.kind,
      };
      if (await store.updateAgent(editingEnv.value, patch)) formOpen.value = false;
    } else {
      const created = await store.registerAgent({
        env,
        ...(name ? { name } : {}),
        kind: form.kind,
      });
      if (created) formOpen.value = false;
    }
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(agent: Agent): Promise<void> {
  await store.updateAgent(agent.env, {
    status: agent.status === 'active' ? 'disabled' : 'active',
  });
}

async function issueToken(agent: Agent): Promise<void> {
  const token = await store.issueAgentToken(agent.env);
  if (!token) return;
  copied.value = false;
  tokenDialog.value = { env: agent.env, token };
}

async function revokeToken(agent: Agent): Promise<void> {
  if (!globalThis.confirm(`吊销 ${agent.env} 的 Token？该端会立即失去访问权限。`)) {
    return;
  }
  await store.revokeAgentToken(agent.env);
}

async function removeAgent(agent: Agent): Promise<void> {
  if (
    !globalThis.confirm(
      `删除接入端 ${agent.env}？历史工单会保留，但该端需要重新登记并签发 Token。`,
    )
  ) {
    return;
  }
  await store.deleteAgent(agent.env);
}

async function copyToken(): Promise<void> {
  if (!tokenDialog.value) return;
  try {
    await navigator.clipboard.writeText(tokenDialog.value.token);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}
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
          接入端管理
        </h2>
        <span
          v-if="agentCount"
          class="rounded bg-surface-container px-2 py-0.5 text-[11px] font-medium text-on-surface-variant"
        >
          {{ agentCount }} 个 · {{ offlineCount }} 个离线
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container"
          :disabled="store.agentsLoading"
          @click="store.loadAgents()"
        >
          <RefreshCw :size="14" :class="{ 'animate-spin': store.agentsLoading }" />
          刷新
        </button>
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary shadow-sm transition hover:bg-primary-container"
          @click="openRegister"
        >
          <Plus :size="14" />
          登记接入端
        </button>
      </div>
    </div>

    <div
      v-if="!agentCount"
      class="rounded-xl border border-outline-variant/35 bg-surface-container-low px-6 py-12 text-center shadow-inner"
    >
      <div
        class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-surface-container text-primary"
      >
        <Bot :size="27" />
      </div>
      <h3
        class="mt-3 text-lg font-semibold text-on-surface"
        style="font-family: var(--font-serif)"
      >
        尚无接入端
      </h3>
      <p class="mx-auto mt-1 max-w-md text-sm leading-6 text-on-surface-variant">
        在项目里运行
        <code class="rounded bg-surface-container px-1.5 py-0.5 font-mono text-xs">
          npx zhunzou-bridge init
        </code>
        ，桥接第一次心跳后会自动出现在这里；也可以手动登记。
      </p>
    </div>

    <div v-else class="grid gap-3 md:grid-cols-[repeat(auto-fit,minmax(340px,1fr))]">
      <article
        v-for="agent in store.agents"
        :key="agent.env"
        class="rounded-xl border border-outline-variant/35 bg-surface-container-low p-4 shadow-sm"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="relative flex h-2 w-2 shrink-0">
                <span
                  v-if="agent.online"
                  class="absolute inline-flex h-full w-full animate-ping rounded-full bg-secondary opacity-50"
                />
                <span
                  class="relative inline-flex h-2 w-2 rounded-full"
                  :class="
                    agent.status === 'disabled'
                      ? 'bg-outline'
                      : agent.online
                        ? 'bg-secondary'
                        : 'bg-outline-variant'
                  "
                />
              </span>
              <h3 class="truncate font-mono text-[13px] font-semibold text-on-surface">
                {{ agent.env }}
              </h3>
              <span
                class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                :class="
                  agent.status === 'disabled'
                    ? 'bg-surface-container-high text-on-surface-variant'
                    : agent.online
                      ? 'bg-secondary/10 text-secondary'
                      : 'bg-surface-container-high text-on-surface-variant'
                "
              >
                {{
                  agent.status === 'disabled'
                    ? '已停用'
                    : agent.online
                      ? '在线'
                      : '离线'
                }}
              </span>
            </div>
            <p class="mt-1 truncate text-[12px] text-on-surface-variant">
              {{ agent.name }} · {{ kindLabel(agent) }}
            </p>
          </div>
          <button
            type="button"
            class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface"
            title="编辑名称 / 类型"
            @click="openEdit(agent)"
          >
            <Pencil :size="14" />
          </button>
        </div>

        <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
          <div class="min-w-0">
            <dt class="text-on-surface-variant/60">当前项目</dt>
            <dd class="truncate text-on-surface">{{ agent.projectName || '—' }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-on-surface-variant/60">最近心跳</dt>
            <dd class="truncate text-on-surface">
              {{ agent.lastSeenAt ? relativeTime(agent.lastSeenAt) : '—' }}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-on-surface-variant/60">版本 / 主机</dt>
            <dd class="truncate text-on-surface">
              {{ agent.version || '—' }} · {{ agent.host || '—' }}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-on-surface-variant/60">系统</dt>
            <dd class="truncate text-on-surface">{{ agent.os || '—' }}</dd>
          </div>
        </dl>

        <p
          v-if="agent.currentTask"
          class="mt-2 truncate rounded-md bg-surface-container px-2 py-1 text-[11px] text-on-surface-variant"
        >
          {{ agent.currentTask }}
        </p>

        <div
          class="mt-3 flex items-center justify-between gap-2 rounded-lg border border-outline-variant/25 bg-surface-container-lowest px-2.5 py-2"
        >
          <div class="flex min-w-0 items-center gap-1.5 text-[11px]">
            <KeyRound :size="13" class="shrink-0 text-on-surface-variant" />
            <span class="truncate font-mono text-on-surface-variant">
              {{ agent.hasToken ? `${agent.tokenPrefix || 'zz_'}••••` : '未签发 Token' }}
            </span>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="rounded-md px-2 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/10 disabled:opacity-50"
              :disabled="store.agentActionEnv === agent.env || agent.status === 'disabled'"
              @click="issueToken(agent)"
            >
              {{ agent.hasToken ? '轮换' : '签发' }}
            </button>
            <button
              v-if="agent.hasToken"
              type="button"
              class="rounded-md px-2 py-1 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container disabled:opacity-50"
              :disabled="store.agentActionEnv === agent.env"
              @click="revokeToken(agent)"
            >
              吊销
            </button>
          </div>
        </div>

        <div class="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition disabled:opacity-50"
            :class="
              agent.status === 'active'
                ? 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
                : 'text-secondary hover:bg-secondary/10'
            "
            :disabled="store.agentActionEnv === agent.env"
            @click="toggleStatus(agent)"
          >
            <component
              :is="agent.status === 'active' ? UserRoundX : UserRoundCheck"
              :size="13"
            />
            {{ agent.status === 'active' ? '停用' : '启用' }}
          </button>
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-on-surface-variant transition hover:bg-error/10 hover:text-error disabled:opacity-50"
            :disabled="store.agentActionEnv === agent.env"
            @click="removeAgent(agent)"
          >
            <Trash2 :size="13" />
            删除
          </button>
        </div>
      </article>
    </div>

    <!-- Register / edit dialog -->
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
          @submit.prevent="submitForm"
        >
          <div class="mb-4 flex items-center justify-between">
            <h3
              class="text-lg font-semibold text-on-surface"
              style="font-family: var(--font-serif)"
            >
              {{ editingEnv ? '编辑接入端' : '登记接入端' }}
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
            环境标识 AGENT_ENV
            <input
              v-model="form.env"
              :disabled="Boolean(editingEnv)"
              required
              maxlength="64"
              placeholder="company-cursor"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 font-mono text-[13px] text-on-surface outline-none focus:border-primary disabled:opacity-60"
            />
          </label>

          <label class="mb-3 block text-[12px] text-on-surface-variant">
            显示名称
            <input
              v-model="form.name"
              maxlength="64"
              placeholder="公司的 Cursor"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 text-[13px] text-on-surface outline-none focus:border-primary"
            />
          </label>

          <label class="mb-4 block text-[12px] text-on-surface-variant">
            客户端类型
            <select
              v-model="form.kind"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary"
            >
              <option v-for="[value, label] in KIND_OPTIONS" :key="value" :value="value">
                {{ label }}
              </option>
            </select>
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
              :disabled="saving || !form.env.trim()"
            >
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- One-time token dialog -->
    <Teleport to="body">
      <div
        v-if="tokenDialog"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
        role="dialog"
        aria-modal="true"
        @click.self="tokenDialog = null"
      >
        <div
          class="w-full max-w-lg rounded-2xl border border-outline-variant/40 bg-surface p-5 shadow-xl"
        >
          <div class="mb-2 flex items-center justify-between">
            <h3
              class="text-lg font-semibold text-on-surface"
              style="font-family: var(--font-serif)"
            >
              专属 Agent Token
            </h3>
            <button
              type="button"
              class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container"
              aria-label="关闭"
              @click="tokenDialog = null"
            >
              <X :size="16" />
            </button>
          </div>

          <p class="mb-3 text-[12px] leading-5 text-on-surface-variant">
            这是
            <span class="font-mono text-on-surface">{{ tokenDialog.env }}</span>
            的专属 Token，只会显示这一次。把它写入该端的
            <code class="rounded bg-surface-container px-1 font-mono text-[11px]">HUB_TOKEN</code>
            ，不要再共用管理员的
            <code class="rounded bg-surface-container px-1 font-mono text-[11px]">HUB_SECRET_TOKEN</code>。
          </p>

          <div
            class="flex items-center gap-2 rounded-lg border border-outline-variant/40 bg-surface-container-lowest p-2.5"
          >
            <code class="min-w-0 flex-1 break-all font-mono text-[12px] text-on-surface">
              {{ tokenDialog.token }}
            </code>
            <button
              type="button"
              class="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-on-primary hover:bg-primary-container"
              @click="copyToken"
            >
              <component :is="copied ? Check : Copy" :size="13" />
              {{ copied ? '已复制' : '复制' }}
            </button>
          </div>

          <div
            class="mt-3 flex items-start gap-2 rounded-lg bg-tertiary-fixed px-3 py-2 text-[11px] leading-5 text-on-tertiary-fixed"
          >
            <ShieldOff :size="14" class="mt-0.5 shrink-0" />
            关闭后无法再次查看；如果丢失，只能轮换生成新 Token（旧 Token 立即失效）。
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
