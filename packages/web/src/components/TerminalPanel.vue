<script setup lang="ts">
import {
  FileClock,
  Monitor,
  Plus,
  RefreshCw,
  SquareTerminal,
  X,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import type {
  TerminalAuditEntry,
  TerminalSession,
  TerminalStatsResponse,
} from '@zhunzou/shared';

import { relativeTime } from '../lib/format';
import { hubApi } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';
import { useTerminalStore } from '../stores/terminals';
import TerminalView from './TerminalView.vue';

const hub = useHubStore();
const terminals = useTerminalStore();
const { t } = useI18n();

const formOpen = ref(false);
const form = reactive({
  env: '',
  projectName: '',
  title: '',
  shell: '',
});

const realtimeEnvs = computed(() =>
  hub.agents.filter((agent) => agent.online && agent.transport === 'ws'),
);
const projects = computed(() => hub.projectsForEnv(form.env));
const selected = computed(() => terminals.selected);
const auditOpen = ref(false);
const auditLoading = ref(false);
const auditEntries = ref<TerminalAuditEntry[]>([]);
const auditSession = ref<TerminalSession | null>(null);
const stats = ref<TerminalStatsResponse | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

function openCreate(): void {
  form.env = realtimeEnvs.value[0]?.env ?? '';
  form.projectName = '';
  form.title = '';
  form.shell = '';
  formOpen.value = true;
}

function closeCreate(): void {
  formOpen.value = false;
}

async function submit(): Promise<void> {
  if (!form.env) return;
  const session = await terminals.create({
    env: form.env,
    ...(form.projectName ? { projectName: form.projectName } : {}),
    ...(form.title.trim() ? { title: form.title.trim() } : {}),
    ...(form.shell.trim() ? { shell: form.shell.trim() } : {}),
    cols: 120,
    rows: 30,
  });
  if (session) formOpen.value = false;
}

function statusLabel(session: TerminalSession): string {
  return t(`terminal.status.${session.status}`);
}

function statusClass(session: TerminalSession): string {
  if (session.status === 'ACTIVE') return 'bg-secondary/10 text-secondary';
  if (session.status === 'STARTING') return 'bg-tertiary/10 text-tertiary';
  if (session.status === 'DETACHED') return 'bg-tertiary-fixed text-on-tertiary-fixed';
  return 'bg-surface-container-high text-on-surface-variant';
}

async function closeSession(session: TerminalSession): Promise<void> {
  if (!globalThis.confirm(t('terminal.confirmClose', { id: session.id }))) return;
  await terminals.close(session.id);
}

async function downloadAudit(format: 'jsonl' | 'csv'): Promise<void> {
  if (!hub.token || !auditSession.value) return;
  try {
    const text = await hubApi.exportTerminalAudit(
      hub.token,
      auditSession.value.id,
      format,
    );
    const blob = new Blob([text], {
      type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/x-ndjson;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `terminal-${auditSession.value.id}-audit.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    // The toast layer is optional here; keep the dialog usable.
  }
}

async function loadStats(): Promise<void> {
  if (!hub.token) return;
  try {
    stats.value = await hubApi.getTerminalStats(hub.token);
  } catch {
    // Metrics are advisory.
  }
}

async function openAudit(session: TerminalSession): Promise<void> {
  if (!hub.token) return;
  auditSession.value = session;
  auditOpen.value = true;
  auditLoading.value = true;
  auditEntries.value = [];
  try {
    const response = await hubApi.getTerminalAudit(hub.token, session.id, 0, 100);
    auditEntries.value = response.entries;
  } catch {
    auditEntries.value = [];
  } finally {
    auditLoading.value = false;
  }
}

onMounted(() => {
  void terminals.load();
  void loadStats();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      void terminals.load();
      void loadStats();
    }
  }, 8_000);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
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
          {{ t('terminal.title') }}
        </h2>
        <span
          v-if="terminals.activeSessions.length"
          class="rounded bg-surface-container px-2 py-0.5 text-[11px] font-medium text-on-surface-variant"
        >
          {{ t('terminal.activeCount', { count: terminals.activeSessions.length }) }}
        </span>
        <span
          v-if="stats"
          class="hidden text-[10px] text-on-surface-variant/60 sm:inline"
        >
          {{
            t('terminal.statsLine', {
              active: stats.active,
              viewers: stats.viewers,
              kb: Math.round(stats.outputBytes / 1024),
            })
          }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container"
          :disabled="terminals.loading"
          @click="terminals.load()"
        >
          <RefreshCw :size="14" :class="{ 'animate-spin': terminals.loading }" />
          {{ t('terminal.refresh') }}
        </button>
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary shadow-sm transition hover:bg-primary-container disabled:opacity-50"
          :disabled="!realtimeEnvs.length"
          @click="openCreate"
        >
          <Plus :size="14" />
          {{ t('terminal.new') }}
        </button>
      </div>
    </div>

    <div
      v-if="!realtimeEnvs.length"
      class="mb-4 rounded-xl border border-outline-variant/35 bg-surface-container-low px-4 py-3 text-[12px] leading-5 text-on-surface-variant"
    >
      {{ t('terminal.noDeviceBefore') }}
      <code class="rounded bg-surface-container px-1 font-mono text-[11px]">
        node packages/device/bin/device.js run --hub ... --token ... --env ...
      </code>
      {{ t('terminal.noDeviceAfter') }}
    </div>

    <div class="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside class="min-w-0">
        <div class="mb-2 flex items-center justify-between px-0.5">
          <span class="text-[11px] font-medium text-on-surface-variant">
            {{ t('terminal.sessions') }}
          </span>
          <span class="text-[10px] text-on-surface-variant/60">
            {{ terminals.sessions.length }}
          </span>
        </div>
        <div
          v-if="!terminals.sessions.length"
          class="rounded-xl border border-outline-variant/35 bg-surface-container-low px-4 py-8 text-center text-[12px] leading-5 text-on-surface-variant"
        >
          {{ t('terminal.empty') }}
        </div>
        <div v-else class="max-h-[420px] space-y-1.5 overflow-y-auto lg:max-h-[560px]">
          <button
            v-for="session in terminals.sessions"
            :key="session.id"
            type="button"
            class="w-full rounded-lg border px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-60"
            :class="
              terminals.selectedId === session.id
                ? 'border-primary/40 bg-primary/5'
                : 'border-outline-variant/30 bg-surface-container-low hover:bg-surface-container'
            "
            :disabled="session.status === 'CLOSED' || session.status === 'LOST'"
            @click="terminals.select(session.id)"
          >
            <div class="flex items-center gap-1.5">
              <span class="font-mono text-[11px] font-semibold text-primary">
                #{{ session.id }}
              </span>
              <span
                class="ml-auto shrink-0 rounded px-1 py-0.5 text-[9px] font-medium"
                :class="statusClass(session)"
              >
                {{ statusLabel(session) }}
              </span>
            </div>
            <p class="mt-1 truncate text-[12px] text-on-surface">
              {{ session.title }}
            </p>
            <p class="mt-0.5 flex items-center gap-1 truncate text-[10px] text-on-surface-variant">
              <Monitor :size="10" />
              <span class="font-mono">{{ session.env }}</span>
              <span>·</span>
              <span>{{ session.cols }}×{{ session.rows }}</span>
              <span>·</span>
              <span>{{ relativeTime(session.lastActiveAt) }}</span>
            </p>
          </button>
        </div>
      </aside>

      <div class="min-w-0">
        <div
          v-if="selected"
          class="overflow-hidden rounded-xl border border-outline-variant/40 bg-[#12100e] shadow-sm"
        >
          <div class="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
            <div class="flex min-w-0 items-center gap-2 text-[11px] text-white/70">
              <SquareTerminal :size="14" />
              <span class="truncate font-mono text-white/90">
                #{{ selected.id }} · {{ selected.title }}
              </span>
              <span class="truncate text-white/40">{{ selected.env }}</span>
            </div>
            <button
              type="button"
              class="shrink-0 rounded px-2 py-1 text-[10px] font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
              @click="openAudit(selected)"
            >
              {{ t('terminal.audit') }}
            </button>
            <button
              type="button"
              class="shrink-0 rounded px-2 py-1 text-[10px] font-medium text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
              :disabled="terminals.closingId === selected.id"
              @click="closeSession(selected)"
            >
              {{ t('terminal.close') }}
            </button>
          </div>
          <TerminalView
            :key="selected.id"
            :session="selected"
            @updated="terminals.upsert"
            @closed="terminals.refreshOne"
          />
        </div>
        <div
          v-else
          class="flex min-h-[360px] items-center justify-center rounded-xl border border-outline-variant/35 bg-surface-container-low text-[12px] text-on-surface-variant"
        >
          {{ t('terminal.selectHint') }}
        </div>
      </div>
    </div>

    <!-- New terminal dialog -->
    <Teleport to="body">
      <div
        v-if="formOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
        role="dialog"
        aria-modal="true"
        @click.self="closeCreate"
      >
        <form
          class="w-full max-w-md rounded-2xl border border-outline-variant/40 bg-surface p-5 shadow-xl"
          @submit.prevent="submit"
        >
          <div class="mb-4 flex items-center justify-between">
            <h3
              class="text-lg font-semibold text-on-surface"
              style="font-family: var(--font-serif)"
            >
              {{ t('terminal.newTitle') }}
            </h3>
            <button
              type="button"
              class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container"
              :aria-label="t('terminal.cancel')"
              @click="closeCreate"
            >
              <X :size="16" />
            </button>
          </div>

          <label class="mb-3 block text-[12px] text-on-surface-variant">
            {{ t('terminal.envLabel') }}
            <select
              v-model="form.env"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 font-mono text-[13px] text-on-surface outline-none focus:border-primary"
            >
              <option v-for="agent in realtimeEnvs" :key="agent.env" :value="agent.env">
                {{ agent.env }} · {{ agent.host || agent.os || '' }}
              </option>
            </select>
          </label>

          <label class="mb-3 block text-[12px] text-on-surface-variant">
            {{ t('terminal.projectLabel') }}
            <select
              v-model="form.projectName"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary"
            >
              <option value="">{{ t('terminal.anyProject') }}</option>
              <option
                v-for="project in projects"
                :key="project.id"
                :value="project.projectName"
              >
                {{ project.projectName }}
              </option>
            </select>
          </label>

          <label class="mb-3 block text-[12px] text-on-surface-variant">
            {{ t('terminal.titleLabel') }}
            <input
              v-model="form.title"
              maxlength="120"
              :placeholder="t('terminal.titlePlaceholder')"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary"
            />
          </label>

          <label class="mb-4 block text-[12px] text-on-surface-variant">
            {{ t('terminal.shellLabel') }}
            <input
              v-model="form.shell"
              maxlength="512"
              :placeholder="t('terminal.shellPlaceholder')"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 font-mono text-[13px] text-on-surface outline-none focus:border-primary"
            />
          </label>

          <p class="mb-3 text-[11px] leading-5 text-on-surface-variant/70">
            {{ t('terminal.createHint') }}
          </p>

          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-[12px] font-medium text-on-surface-variant hover:bg-surface-container"
              @click="closeCreate"
            >
              {{ t('terminal.cancel') }}
            </button>
            <button
              type="submit"
              class="h-9 rounded-lg bg-primary px-4 text-[12px] font-medium text-on-primary transition hover:bg-primary-container disabled:opacity-50"
              :disabled="terminals.creating || !form.env"
            >
              {{ terminals.creating ? t('terminal.creating') : t('terminal.create') }}
            </button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- Audit dialog -->
    <Teleport to="body">
      <div
        v-if="auditOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
        role="dialog"
        aria-modal="true"
        @click.self="auditOpen = false"
      >
        <div
          class="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-outline-variant/40 bg-surface p-5 shadow-xl"
        >
          <div class="mb-3 flex items-center justify-between">
            <h3
              class="text-lg font-semibold text-on-surface"
              style="font-family: var(--font-serif)"
            >
              {{ t('terminal.auditTitle', { id: auditSession?.id ?? '' }) }}
            </h3>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="rounded-md px-2 py-1 text-[11px] font-medium text-on-surface-variant hover:bg-surface-container"
                @click="downloadAudit('jsonl')"
              >
                JSONL
              </button>
              <button
                type="button"
                class="rounded-md px-2 py-1 text-[11px] font-medium text-on-surface-variant hover:bg-surface-container"
                @click="downloadAudit('csv')"
              >
                CSV
              </button>
              <button
                type="button"
                class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container"
                :aria-label="t('terminal.cancel')"
                @click="auditOpen = false"
              >
                <X :size="16" />
              </button>
            </div>
          </div>

          <div v-if="auditLoading" class="py-10 text-center text-[12px] text-on-surface-variant">
            {{ t('terminal.loading') }}
          </div>
          <div
            v-else-if="!auditEntries.length"
            class="py-10 text-center text-[12px] text-on-surface-variant"
          >
            {{ t('terminal.auditEmpty') }}
          </div>
          <div v-else class="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            <div
              v-for="entry in auditEntries"
              :key="entry.id"
              class="rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-2"
            >
              <div class="flex items-center gap-2 text-[10px] text-on-surface-variant">
                <FileClock :size="12" />
                <span class="font-mono font-semibold text-primary">{{ entry.kind }}</span>
                <span v-if="entry.viewerId" class="font-mono">{{ entry.viewerId }}</span>
                <span class="ml-auto">{{ relativeTime(entry.createdAt) }}</span>
              </div>
              <pre
                v-if="entry.data"
                class="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-on-surface"
              >{{ entry.data }}</pre>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
