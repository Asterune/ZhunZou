<script setup lang="ts">
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Folder,
  FolderGit2,
  FolderPlus,
  FolderSearch,
  Home,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';

import type {
  FleetBrowseEntry,
  FleetWorkspaceStatus,
} from '@zhunzou/shared';

import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';

const store = useHubStore();
const { t } = useI18n();

const open = ref(false);
const host = ref('');
const pathInput = ref('');

const hosts = computed(() => {
  const names = new Set<string>([
    ...store.fleetCandidatesByHost.keys(),
    ...store.fleetWorkspacesByHost.keys(),
  ]);
  // A fresh bridge may have no candidates yet (no scan.roots and no editor
  // history), but the directory browser must still be reachable.
  for (const agent of store.agents) {
    const name = agent.host?.trim();
    if (name) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
});

const candidates = computed(
  () => store.fleetCandidatesByHost.get(host.value) ?? [],
);
const workspaces = computed(
  () => store.fleetWorkspacesByHost.get(host.value) ?? [],
);

const workspacePaths = computed(
  () => new Set(workspaces.value.map((workspace) => workspace.path)),
);

const unassociated = computed(() =>
  candidates.value.filter(
    (candidate) =>
      !candidate.associated && !workspacePaths.value.has(candidate.path),
  ),
);

watch(open, (value) => {
  if (value) {
    ensureHost();
    void store.loadFleet();
    startBrowse();
  }
});

watch(hosts, ensureHost, { immediate: true });

watch(host, (value, previous) => {
  if (open.value && value && value !== previous) {
    startBrowse();
  }
});

watch(
  () => store.fleetBrowse?.current?.path,
  (value) => {
    if (value) pathInput.value = value;
  },
);

function ensureHost(): void {
  if (!hosts.value.includes(host.value)) {
    host.value = hosts.value[0] ?? '';
  }
}

function projectNameOf(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? 'project';
}

function startBrowse(path?: string): void {
  if (!host.value) return;
  void store.browseFleet(host.value, path);
}

function go(): void {
  startBrowse(pathInput.value);
}

function goUp(): void {
  const parent = store.fleetBrowse?.current?.parent;
  if (parent) startBrowse(parent);
}

function goHome(): void {
  startBrowse(store.fleetBrowse?.current?.home);
}

function associateCurrent(): void {
  const current = store.fleetBrowse?.current;
  if (!current) return;
  void store.associateFleetPath(
    host.value,
    current.path,
    projectNameOf(current.path),
    current.adapter,
  );
}

function associateEntry(entry: FleetBrowseEntry): void {
  const current = store.fleetBrowse?.current;
  void store.associateFleetPath(
    host.value,
    entry.path,
    entry.name,
    current?.adapter,
  );
}

function statusLabel(status: FleetWorkspaceStatus): string {
  return t(`fleet.status.${status}`);
}

function statusClass(status: FleetWorkspaceStatus): string {
  switch (status) {
    case 'APPLIED':
      return 'bg-secondary/10 text-secondary';
    case 'FAILED':
      return 'bg-error-container text-on-error-container';
    case 'ISSUED':
      return 'bg-primary/10 text-primary';
    default:
      return 'bg-surface-container-high text-on-surface-variant';
  }
}

async function associate(candidateId: string): Promise<void> {
  await store.associateFleetCandidate(candidateId);
}
</script>

<template>
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container"
    @click="open = true"
  >
    <FolderPlus :size="14" />
    {{ t('fleet.open') }}
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
      role="dialog"
      aria-modal="true"
      @click.self="open = false"
    >
      <div
        class="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-outline-variant/40 bg-surface p-5 shadow-xl"
      >
        <div class="mb-2 flex items-center justify-between">
          <h3
            class="flex items-center gap-2 text-lg font-semibold text-on-surface"
            style="font-family: var(--font-serif)"
          >
            <FolderSearch :size="18" class="text-primary" />
            {{ t('fleet.title') }}
          </h3>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant transition hover:bg-surface-container"
              :title="t('fleet.refresh')"
              @click="store.loadFleet()"
            >
              <RefreshCw :size="15" :class="{ 'animate-spin': store.fleetLoading }" />
            </button>
            <button
              type="button"
              class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container"
              :aria-label="t('fleet.close')"
              @click="open = false"
            >
              <X :size="16" />
            </button>
          </div>
        </div>

        <p class="mb-4 text-[12px] leading-5 text-on-surface-variant">
          {{ t('fleet.desc') }}
        </p>

        <div
          v-if="!hosts.length"
          class="rounded-xl border border-outline-variant/35 bg-surface-container-low px-5 py-8 text-center text-[12px] leading-6 text-on-surface-variant"
        >
          {{ t('fleet.empty') }}
        </div>

        <template v-else>
          <label class="mb-3 flex items-center gap-2 text-[12px] text-on-surface-variant">
            {{ t('fleet.host') }}
            <select
              v-model="host"
              class="h-8 min-w-[200px] rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 font-mono text-[12px] text-on-surface outline-none focus:border-primary"
            >
              <option v-for="name in hosts" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
          </label>

          <section v-if="workspaces.length" class="mb-5">
            <h4 class="mb-2 text-[11px] font-medium text-on-surface-variant">
              {{ t('fleet.associated') }}
            </h4>
            <ul class="space-y-1.5">
              <li
                v-for="workspace in workspaces"
                :key="workspace.id"
                class="flex items-start gap-2 rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-2"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-mono text-[12px] font-semibold text-on-surface">
                      {{ workspace.env }}
                    </span>
                    <span
                      class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                      :class="statusClass(workspace.status)"
                    >
                      <Loader2
                        v-if="workspace.status === 'PENDING' || workspace.status === 'ISSUED'"
                        :size="10"
                        class="animate-spin"
                      />
                      <AlertTriangle v-else-if="workspace.status === 'FAILED'" :size="10" />
                      <Check v-else :size="10" />
                      {{ statusLabel(workspace.status) }}
                    </span>
                  </div>
                  <p class="mt-0.5 truncate font-mono text-[11px] text-on-surface-variant" :title="workspace.path">
                    {{ workspace.path }}
                  </p>
                  <p v-if="workspace.error" class="mt-0.5 text-[11px] text-error">
                    {{ workspace.error }}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <button
                    v-if="workspace.status === 'FAILED'"
                    type="button"
                    class="grid h-7 w-7 place-items-center rounded-md text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface disabled:opacity-40"
                    :disabled="Boolean(store.fleetActionId)"
                    :title="t('fleet.retry')"
                    @click="store.retryFleetWorkspace(workspace.id)"
                  >
                    <RotateCcw :size="13" />
                  </button>
                  <button
                    type="button"
                    class="grid h-7 w-7 place-items-center rounded-md text-on-surface-variant transition hover:bg-error-container hover:text-on-error-container disabled:opacity-40"
                    :disabled="Boolean(store.fleetActionId)"
                    :title="t('fleet.remove')"
                    @click="store.removeFleetWorkspace(workspace.id)"
                  >
                    <Trash2 :size="13" />
                  </button>
                </div>
              </li>
            </ul>
          </section>

          <section>
            <h4 class="mb-2 text-[11px] font-medium text-on-surface-variant">
              {{ t('fleet.candidates') }}
            </h4>
            <p
              v-if="!unassociated.length"
              class="rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-4 text-center text-[12px] text-on-surface-variant"
            >
              {{ t('fleet.noCandidates') }}
            </p>
            <ul v-else class="space-y-1.5">
              <li
                v-for="candidate in unassociated"
                :key="candidate.id"
                class="flex items-center gap-2 rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-2"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-mono text-[12px] font-semibold text-on-surface">
                      {{ candidate.projectName }}
                    </span>
                    <span class="font-mono text-[10px] text-on-surface-variant/70">
                      {{ candidate.env }}
                    </span>
                  </div>
                  <p class="mt-0.5 truncate font-mono text-[11px] text-on-surface-variant" :title="candidate.path">
                    {{ candidate.path }}
                  </p>
                </div>
                <button
                  type="button"
                  class="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-primary px-2.5 text-[11px] font-medium text-on-primary transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="Boolean(store.fleetActionId)"
                  @click="associate(candidate.id)"
                >
                  <Loader2
                    v-if="store.fleetActionId === candidate.id"
                    :size="11"
                    class="animate-spin"
                  />
                  {{ t('fleet.associate') }}
                </button>
              </li>
            </ul>
          </section>

          <section class="mt-5 border-t border-outline-variant/30 pt-4">
            <h4 class="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-on-surface-variant">
              <FolderSearch :size="12" />
              {{ t('fleet.browse') }}
            </h4>

            <div class="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant transition hover:bg-surface-container disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="!store.fleetBrowse?.current?.parent || store.fleetBrowseLoading"
                :title="t('fleet.up')"
                @click="goUp"
              >
                <ArrowUp :size="14" />
              </button>
              <button
                type="button"
                class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant transition hover:bg-surface-container disabled:opacity-40"
                :disabled="store.fleetBrowseLoading"
                :title="t('fleet.home')"
                @click="goHome"
              >
                <Home :size="14" />
              </button>
              <input
                v-model="pathInput"
                type="text"
                spellcheck="false"
                :placeholder="t('fleet.pathPlaceholder')"
                class="h-8 min-w-[220px] flex-1 rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 font-mono text-[11px] text-on-surface outline-none focus:border-primary"
                @keyup.enter="go"
              />
              <button
                type="button"
                class="inline-flex h-8 items-center gap-1 rounded-lg bg-surface-container-high px-2.5 text-[11px] font-medium text-on-surface transition hover:bg-surface-container disabled:opacity-50"
                :disabled="store.fleetBrowseLoading"
                @click="go"
              >
                {{ t('fleet.go') }}
              </button>
            </div>

            <p
              v-if="store.fleetBrowseLoading"
              class="mt-2 flex items-center gap-1.5 text-[11px] text-on-surface-variant"
            >
              <Loader2 :size="12" class="animate-spin" />
              {{ t('fleet.browseLoading') }}
            </p>
            <p v-if="store.fleetBrowseError" class="mt-2 text-[11px] text-error">
              {{ store.fleetBrowseError }}
            </p>

            <div v-if="store.fleetBrowse?.current" class="mt-2">
              <div class="flex flex-wrap items-center gap-2 rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-2">
                <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-on-surface" :title="store.fleetBrowse.current.path">
                  {{ store.fleetBrowse.current.path }}
                </span>
                <span
                  v-if="store.fleetBrowse.current.isRepo"
                  class="shrink-0 rounded bg-secondary/10 px-1.5 py-0.5 text-[10px] font-medium text-secondary"
                >
                  Git
                </span>
                <button
                  v-if="store.fleetBrowse.current.isRepo"
                  type="button"
                  class="inline-flex h-7 shrink-0 items-center rounded-lg bg-primary px-2.5 text-[11px] font-medium text-on-primary transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="Boolean(store.fleetActionId)"
                  @click="associateCurrent"
                >
                  {{ t('fleet.associateCurrent') }}
                </button>
                <span
                  v-else
                  class="shrink-0 text-[10px] text-on-surface-variant/70"
                >
                  {{ t('fleet.repoOnly') }}
                </span>
              </div>

              <ul
                v-if="store.fleetBrowse.entries.length"
                class="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1"
              >
                <li
                  v-for="entry in store.fleetBrowse.entries"
                  :key="entry.path"
                  class="flex items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-surface-container-low"
                >
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    @click="startBrowse(entry.path)"
                  >
                    <FolderGit2
                      v-if="entry.isRepo"
                      :size="13"
                      class="shrink-0 text-secondary"
                    />
                    <Folder v-else :size="13" class="shrink-0 text-on-surface-variant" />
                    <span class="truncate font-mono text-[12px] text-on-surface">
                      {{ entry.name }}
                    </span>
                  </button>
                  <button
                    v-if="entry.isRepo"
                    type="button"
                    class="shrink-0 rounded px-2 py-0.5 text-[10px] font-medium text-primary transition hover:bg-primary/10 disabled:opacity-40"
                    :disabled="Boolean(store.fleetActionId)"
                    @click="associateEntry(entry)"
                  >
                    <Loader2
                      v-if="store.fleetActionId === `browse:${entry.path}`"
                      :size="10"
                      class="mr-0.5 inline animate-spin"
                    />
                    {{ t('fleet.associate') }}
                  </button>
                </li>
              </ul>
              <p v-else class="mt-2 text-[11px] text-on-surface-variant/70">
                {{ t('fleet.noSubdirs') }}
              </p>
            </div>
          </section>
        </template>
      </div>
    </div>
  </Teleport>
</template>
