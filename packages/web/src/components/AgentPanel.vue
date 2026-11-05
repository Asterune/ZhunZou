<script setup lang="ts">
import {
  Bot,
  Check,
  Copy,
  KeyRound,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldOff,
  SquareTerminal,
  Trash2,
  UserRoundCheck,
  UserRoundX,
  X,
} from 'lucide-vue-next';
import { computed, reactive, ref } from 'vue';

import type { Agent, AgentKind, UpdateAgentInput } from '@zhunzou/shared';

import { relativeTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';

const store = useHubStore();
const { t } = useI18n();

const KIND_LABELS: Record<AgentKind, string> = {
  cursor: 'Cursor',
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  windsurf: 'Windsurf',
  other: 'Other',
};

const KIND_OPTIONS = Object.keys(KIND_LABELS) as AgentKind[];

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

interface NodeCard {
  host: string;
  os?: string;
  version?: string;
  total: number;
  online: number;
  disabled: number;
  lastSeenAt?: number;
}

/** Group agents by the host reported in their heartbeat. */
const nodes = computed<NodeCard[]>(() => {
  const groups = new Map<string, NodeCard>();

  for (const agent of store.agents) {
    const host = agent.host?.trim() || t('agents.unknownHost');
    const node = groups.get(host) ?? {
      host,
      total: 0,
      online: 0,
      disabled: 0,
    };

    node.total += 1;
    if (agent.online) node.online += 1;
    if (agent.status === 'disabled') node.disabled += 1;
    if (!node.os && agent.os) node.os = agent.os;
    if (!node.version && agent.version) node.version = agent.version;
    if (
      agent.lastSeenAt &&
      (!node.lastSeenAt || agent.lastSeenAt > node.lastSeenAt)
    ) {
      node.lastSeenAt = agent.lastSeenAt;
    }

    groups.set(host, node);
  }

  return [...groups.values()].sort(
    (left, right) =>
      right.online - left.online ||
      right.total - left.total ||
      left.host.localeCompare(right.host),
  );
});

function kindLabel(agent: Agent): string {
  return agent.kind === 'other'
    ? t('agents.kind.other')
    : KIND_LABELS[agent.kind] ?? agent.kind;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '—';
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(1)} GiB`;
}

function visibleTools(agent: Agent) {
  return agent.capabilities?.tools.slice(0, 10) ?? [];
}

function extraToolCount(agent: Agent): number {
  return Math.max(0, (agent.capabilities?.tools.length ?? 0) - 10);
}

function hasDeviceInfo(agent: Agent): boolean {
  return Boolean(agent.capabilities || agent.deviceStats || agent.transport === 'ws');
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

async function toggleTerminal(agent: Agent): Promise<void> {
  await store.updateAgent(agent.env, {
    terminalEnabled: agent.terminalEnabled === false,
  });
}

async function issueToken(agent: Agent): Promise<void> {
  const token = await store.issueAgentToken(agent.env);
  if (!token) return;
  copied.value = false;
  tokenDialog.value = { env: agent.env, token };
}

async function revokeToken(agent: Agent): Promise<void> {
  if (!globalThis.confirm(t('agents.confirmRevoke', { env: agent.env }))) {
    return;
  }
  await store.revokeAgentToken(agent.env);
}

async function removeAgent(agent: Agent): Promise<void> {
  if (
    !globalThis.confirm(
      t('agents.confirmDelete', { env: agent.env }),
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
          {{ t('agents.title') }}
        </h2>
        <span
          v-if="agentCount"
          class="rounded bg-surface-container px-2 py-0.5 text-[11px] font-medium text-on-surface-variant"
        >
          {{ t('agents.count', { count: agentCount, offline: offlineCount }) }}
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
          {{ t('agents.refresh') }}
        </button>
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary shadow-sm transition hover:bg-primary-container"
          @click="openRegister"
        >
          <Plus :size="14" />
          {{ t('agents.register') }}
        </button>
      </div>
    </div>

    <div v-if="nodes.length" class="mb-5">
      <div class="mb-2 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-on-surface-variant">
        <Server :size="13" />
        {{ t('agents.nodes') }}
        <span class="text-on-surface-variant/50">· {{ nodes.length }}</span>
      </div>
      <div class="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
        <article
          v-for="node in nodes"
          :key="node.host"
          class="rounded-xl border border-outline-variant/35 bg-surface-container-low px-3.5 py-3 shadow-sm"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-1.5">
              <Monitor :size="14" class="shrink-0 text-on-surface-variant" />
              <span class="truncate font-mono text-[12px] font-semibold text-on-surface">
                {{ node.host }}
              </span>
            </div>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
              :class="
                node.online > 0
                  ? 'bg-secondary/10 text-secondary'
                  : 'bg-surface-container-high text-on-surface-variant'
              "
            >
              {{ t('agents.onlineOf', { online: node.online, total: node.total }) }}
            </span>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-on-surface-variant">
            <span>{{ t('agents.hosts', { count: node.total }) }}</span>
            <span v-if="node.disabled">· {{ t('agents.disabledCount', { count: node.disabled }) }}</span>
            <span v-if="node.os" class="font-mono">· {{ node.os }}</span>
            <span v-if="node.version" class="font-mono">· bridge {{ node.version }}</span>
          </div>
          <p class="mt-1 text-[11px] text-on-surface-variant/60">
            {{ t('agents.lastHeartbeat', { time: node.lastSeenAt ? relativeTime(node.lastSeenAt) : '—' }) }}
          </p>
        </article>
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
        {{ t('agents.emptyTitle') }}
      </h3>
      <p class="mx-auto mt-1 max-w-md text-sm leading-6 text-on-surface-variant">
        {{ t('agents.emptyDescBefore') }}
        <code class="rounded bg-surface-container px-1.5 py-0.5 font-mono text-xs">
          npx zhunzou-bridge init
        </code>
        {{ t('agents.emptyDescAfter') }}
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
                    ? t('agents.disabled')
                    : agent.online
                      ? t('agents.online')
                      : t('agents.offline')
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
            :title="t('agents.editTitle')"
            @click="openEdit(agent)"
          >
            <Pencil :size="14" />
          </button>
        </div>

        <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
          <div class="min-w-0">
            <dt class="text-on-surface-variant/60">{{ t('agents.currentProject') }}</dt>
            <dd class="truncate text-on-surface">{{ agent.projectName || '—' }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-on-surface-variant/60">{{ t('agents.lastHeartbeatLabel') }}</dt>
            <dd class="truncate text-on-surface">
              {{ agent.lastSeenAt ? relativeTime(agent.lastSeenAt) : '—' }}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-on-surface-variant/60">{{ t('agents.versionHost') }}</dt>
            <dd class="truncate text-on-surface">
              {{ agent.version || '—' }} · {{ agent.host || '—' }}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-on-surface-variant/60">{{ t('agents.os') }}</dt>
            <dd class="truncate text-on-surface">{{ agent.os || '—' }}</dd>
          </div>
        </dl>

        <div
          v-if="hasDeviceInfo(agent)"
          class="mt-2 rounded-md border border-outline-variant/25 bg-surface-container-lowest px-2 py-1.5 text-[11px]"
        >
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              class="rounded px-1.5 py-0.5 text-[10px] font-medium"
              :class="
                agent.transport === 'ws'
                  ? 'bg-secondary/10 text-secondary'
                  : 'bg-surface-container-high text-on-surface-variant'
              "
            >
              {{ agent.transport === 'ws' ? t('agents.realtime') : t('agents.httpHeartbeat') }}
            </span>
            <span v-if="agent.deviceStats?.cpuCount" class="text-on-surface-variant">
              {{ t('agents.cpu') }} {{ agent.deviceStats.cpuCount }}
            </span>
            <span v-if="agent.deviceStats?.load1 !== undefined" class="text-on-surface-variant">
              {{ t('agents.load') }} {{ agent.deviceStats?.load1?.toFixed(2) }}
            </span>
            <span v-if="agent.deviceStats?.totalMemBytes" class="text-on-surface-variant">
              {{ t('agents.memory') }} {{ formatBytes(agent.deviceStats.totalMemBytes) }}
            </span>
            <span
              v-if="agent.capabilities?.pty"
              class="text-on-surface-variant"
              :class="agent.capabilities.pty.available ? 'text-secondary' : ''"
            >
              {{ agent.capabilities.pty.available ? t('agents.ptyReady') : t('agents.ptyMissing') }}
            </span>
          </div>
          <div
            v-if="visibleTools(agent).length"
            class="mt-1 flex flex-wrap items-center gap-1"
          >
            <span class="text-on-surface-variant/60">{{ t('agents.tools') }}</span>
            <span
              v-for="tool in visibleTools(agent)"
              :key="tool.name"
              class="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[10px] text-on-surface-variant"
              :title="tool.version || tool.path"
            >
              {{ tool.name }}
            </span>
            <span
              v-if="extraToolCount(agent)"
              class="text-[10px] text-on-surface-variant/60"
            >
              {{ t('agents.moreTools', { count: extraToolCount(agent) }) }}
            </span>
          </div>
        </div>

        <p
          v-if="agent.currentTask"
          class="mt-2 truncate rounded-md bg-surface-container px-2 py-1 text-[11px] text-on-surface-variant"
        >
          {{ agent.currentTask }}
        </p>

        <div
          v-if="store.latestExchangeFor(agent.env)"
          class="mt-2 rounded-md border border-outline-variant/25 bg-surface-container-lowest px-2 py-1.5 text-[11px] leading-5"
        >
          <template
            v-for="exchange in [store.latestExchangeFor(agent.env)!]"
            :key="exchange.id"
          >
            <p v-if="exchange.question" class="text-on-surface-variant">
              <span class="text-on-surface-variant/60">{{ t('agents.exchangeQuestion') }} · </span>{{ exchange.question }}
            </p>
            <p v-if="exchange.conclusion" class="mt-1 text-on-surface">
              <span class="text-on-surface-variant/60">{{ t('agents.exchangeConclusion') }} · </span>{{ exchange.conclusion }}
            </p>
            <p class="mt-1 text-[10px] text-on-surface-variant/50">
              {{ relativeTime(exchange.createdAt) }}
            </p>
          </template>
        </div>

        <div
          class="mt-3 flex items-center justify-between gap-2 rounded-lg border border-outline-variant/25 bg-surface-container-lowest px-2.5 py-2"
        >
          <div class="flex min-w-0 items-center gap-1.5 text-[11px]">
            <KeyRound :size="13" class="shrink-0 text-on-surface-variant" />
            <span class="truncate font-mono text-on-surface-variant">
              {{ agent.hasToken ? `${agent.tokenPrefix || 'zz_'}••••` : t('agents.noToken') }}
            </span>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="rounded-md px-2 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/10 disabled:opacity-50"
              :disabled="store.agentActionEnv === agent.env || agent.status === 'disabled'"
              @click="issueToken(agent)"
            >
              {{ agent.hasToken ? t('agents.rotate') : t('agents.issue') }}
            </button>
            <button
              v-if="agent.hasToken"
              type="button"
              class="rounded-md px-2 py-1 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container disabled:opacity-50"
              :disabled="store.agentActionEnv === agent.env"
              @click="revokeToken(agent)"
            >
              {{ t('agents.revoke') }}
            </button>
          </div>
        </div>

        <div class="mt-3 flex items-center justify-between gap-2">
          <div class="flex items-center gap-1">
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
            {{ agent.status === 'active' ? t('agents.disable') : t('agents.enable') }}
          </button>
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition disabled:opacity-50"
            :class="
              agent.terminalEnabled === false
                ? 'text-secondary hover:bg-secondary/10'
                : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
            "
            :disabled="store.agentActionEnv === agent.env"
            @click="toggleTerminal(agent)"
          >
            <SquareTerminal :size="13" />
            {{ agent.terminalEnabled === false ? t('agents.enableTerminal') : t('agents.disableTerminal') }}
          </button>
          </div>
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-on-surface-variant transition hover:bg-error/10 hover:text-error disabled:opacity-50"
            :disabled="store.agentActionEnv === agent.env"
            @click="removeAgent(agent)"
          >
            <Trash2 :size="13" />
            {{ t('agents.delete') }}
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
              {{ editingEnv ? t('agents.dialog.edit') : t('agents.dialog.register') }}
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
            {{ t('agents.envLabel') }}
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
            {{ t('agents.nameLabel') }}
            <input
              v-model="form.name"
              maxlength="64"
              :placeholder="t('agents.namePlaceholder')"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 text-[13px] text-on-surface outline-none focus:border-primary"
            />
          </label>

          <label class="mb-4 block text-[12px] text-on-surface-variant">
            {{ t('agents.kindLabel') }}
            <select
              v-model="form.kind"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary"
            >
              <option v-for="value in KIND_OPTIONS" :key="value" :value="value">
                {{ value === 'other' ? t('agents.kind.other') : KIND_LABELS[value] }}
              </option>
            </select>
          </label>

          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-[12px] font-medium text-on-surface-variant hover:bg-surface-container"
              @click="formOpen = false"
            >
              {{ t('agents.cancel') }}
            </button>
            <button
              type="submit"
              class="h-9 rounded-lg bg-primary px-4 text-[12px] font-medium text-on-primary transition hover:bg-primary-container disabled:opacity-50"
              :disabled="saving || !form.env.trim()"
            >
              {{ saving ? t('agents.saving') : t('agents.save') }}
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
              {{ t('agents.tokenTitle') }}
            </h3>
            <button
              type="button"
              class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container"
              :aria-label="t('agents.close')"
              @click="tokenDialog = null"
            >
              <X :size="16" />
            </button>
          </div>

          <p class="mb-3 text-[12px] leading-5 text-on-surface-variant">
            {{ t('agents.tokenDescBefore') }}
            <span class="font-mono text-on-surface">{{ tokenDialog.env }}</span>
            {{ t('agents.tokenDescMiddle') }}
            <code class="rounded bg-surface-container px-1 font-mono text-[11px]">HUB_TOKEN</code>
            {{ t('agents.tokenDescAfter') }}
            <code class="rounded bg-surface-container px-1 font-mono text-[11px]">HUB_SECRET_TOKEN</code>{{ t('agents.tokenDescEnd') }}
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
              {{ copied ? t('agents.copied') : t('agents.copy') }}
            </button>
          </div>

          <div
            class="mt-3 flex items-start gap-2 rounded-lg bg-tertiary-fixed px-3 py-2 text-[11px] leading-5 text-on-tertiary-fixed"
          >
            <ShieldOff :size="14" class="mt-0.5 shrink-0" />
            {{ t('agents.tokenWarning') }}
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
