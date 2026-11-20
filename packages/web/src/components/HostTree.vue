<script setup lang="ts">
import { FolderGit2, Monitor } from 'lucide-vue-next';
import { computed } from 'vue';

import type { Agent } from '@zhunzou/shared';

import { clientKindLabel } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useHubStore, type MachineTarget } from '../stores/hub';

/**
 * The hub's core hierarchy, shown the way a person explains it:
 * a machine (host) runs projects (checkouts), and each project is reachable
 * through one or more clients (Cursor, OpenCode, Qoder…).
 *
 * Env names — the technical identity the runner uses — stay in the tooltip
 * instead of being the thing the reader has to decode.
 */
const store = useHubStore();
const { t } = useI18n();

const machines = computed<MachineTarget[]>(() => store.targetMachines);

function projectsOf(machine: MachineTarget): string[] {
  return store.projectsForMachine(machine);
}

function clientsOf(machine: MachineTarget, project: string): Agent[] {
  return store.clientsForMachine(machine, project);
}
</script>

<template>
  <div class="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
    <article
      v-for="machine in machines"
      :key="machine.id"
      class="rounded-xl border border-outline-variant/35 bg-surface-container-low px-3.5 py-3 shadow-sm"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-1.5">
          <Monitor :size="14" class="shrink-0 text-on-surface-variant" />
          <span class="truncate font-mono text-[12px] font-semibold text-on-surface">
            {{ machine.label }}
          </span>
        </div>
        <span
          class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
          :class="
            machine.online > 0
              ? 'bg-secondary/10 text-secondary'
              : 'bg-surface-container-high text-on-surface-variant'
          "
        >
          {{ t('picker.machineCount', { online: machine.online, total: machine.total }) }}
        </span>
      </div>

      <div v-if="projectsOf(machine).length" class="mt-2 space-y-2">
        <div
          v-for="project in projectsOf(machine)"
          :key="project"
          class="rounded-lg bg-surface-container/70 px-2.5 py-2"
        >
          <div class="flex items-center gap-1.5 text-[11.5px] font-medium text-on-surface">
            <FolderGit2 :size="12" class="shrink-0 text-on-surface-variant" />
            <span class="truncate">{{ project }}</span>
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-1">
            <span
              v-for="client in clientsOf(machine, project)"
              :key="client.env"
              class="flex items-center gap-1 rounded bg-surface-container-high px-1.5 py-0.5 text-[10.5px] text-on-surface"
              :title="client.env"
            >
              <span
                class="h-1.5 w-1.5 rounded-full"
                :class="client.online ? 'bg-secondary' : 'bg-outline-variant'"
              />
              {{ client.name || clientKindLabel(client.kind) }}
            </span>
            <span
              v-if="!clientsOf(machine, project).length"
              class="text-[10.5px] text-on-surface-variant/60"
            >
              {{ t('hosts.noClient') }}
            </span>
          </div>
        </div>
      </div>
      <p v-else class="mt-2 text-[11px] leading-5 text-on-surface-variant/70">
        {{ t('hosts.noProject') }}
      </p>
    </article>
  </div>
</template>
