<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { Agent } from '@zhunzou/shared';

import { clientKindLabel } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useHubStore, type MachineTarget } from '../stores/hub';

const props = withDefaults(
  defineProps<{
    machines: MachineTarget[];
    env: string;
    projectName?: string;
    /** Dialogs stack their fields; the dispatch page spreads them over a row. */
    variant?: 'page' | 'dialog';
    machineLabel?: string;
    projectLabel?: string;
    /** Copy for the "no project" choice, which each flow words differently. */
    noProjectText?: string;
  }>(),
  {
    projectName: '',
    variant: 'page',
  },
);

const emit = defineEmits<{
  'update:env': [env: string];
  'update:projectName': [projectName: string];
}>();

const store = useHubStore();
const { t } = useI18n();

const machineId = ref('');

const machine = computed<MachineTarget | null>(
  () => props.machines.find((item) => item.id === machineId.value) ?? null,
);

const projects = computed(() =>
  machine.value ? store.projectsForMachine(machine.value) : [],
);

const clients = computed(() =>
  machine.value
    ? store.splitGhostClients(
        store.clientsForMachine(machine.value, props.projectName),
      )
    : { visible: [], ghosts: [] },
);

const machineText = computed(() => props.machineLabel ?? t('picker.machine'));
const projectText = computed(() => props.projectLabel ?? t('picker.project'));

const labelClass = computed(() =>
  props.variant === 'dialog'
    ? 'text-[12px] text-on-surface-variant'
    : 'text-[11px] font-medium text-on-surface-variant',
);

const fieldClass = computed(() =>
  props.variant === 'dialog'
    ? 'mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary'
    : 'mt-1 h-10 w-full rounded-lg bg-surface-container-low px-3 text-sm text-on-surface shadow-inner outline-none transition focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20',
);

function machineOptionLabel(item: MachineTarget): string {
  if (!item.online) return `${item.label} ${t('picker.machineOffline')}`;
  return `${item.label} · ${t('picker.machineCount', {
    online: item.online,
    total: item.total,
  })}`;
}

/** Two identities of one client type on one box cannot be told apart by type alone. */
function clientOptionLabel(agent: Agent): string {
  const shared =
    clients.value.visible.filter((item) => item.kind === agent.kind).length > 1;
  return `${clientKindLabel(agent.kind)}${shared ? ` · ${agent.env}` : ''}${
    agent.online ? '' : t('picker.offlineSuffix')
  }`;
}

function visibleFor(projectName: string): Agent[] {
  return machine.value
    ? store.splitGhostClients(
        store.clientsForMachine(machine.value, projectName),
      ).visible
    : [];
}

/**
 * One candidate needs no decision; several means the user has to say which
 * identity should take the work, and a guess would send it to the wrong end.
 */
function resolveClient(projectName: string): void {
  const list = visibleFor(projectName);
  if (list.length === 1) {
    emit('update:env', list[0]!.env);
    return;
  }
  const kept = list.find((agent) => agent.env === props.env);
  emit('update:env', kept?.env ?? '');
}

function selectMachine(id: string): void {
  machineId.value = id;
  const name = projects.value.includes(props.projectName)
    ? props.projectName
    : '';
  if (name !== props.projectName) emit('update:projectName', name);
  resolveClient(name);
}

function selectProject(projectName: string): void {
  emit('update:projectName', projectName);
  resolveClient(projectName);
}

const machineModel = computed({
  get: () => machineId.value,
  set: (id: string) => selectMachine(id),
});

const projectModel = computed({
  get: () => props.projectName,
  set: (name: string) => selectProject(name),
});

const envModel = computed({
  get: () => props.env,
  set: (env: string) => emit('update:env', env),
});

watch(
  () => props.machines,
  (list) => {
    // An env the caller picked elsewhere decides its own machine.
    const owner = list.find((item) =>
      item.agents.some((agent) => agent.env === props.env),
    );
    if (owner) {
      machineId.value = owner.id;
      return;
    }
    if (!list.some((item) => item.id === machineId.value)) {
      machineId.value = list[0]?.id ?? '';
    }
    resolveClient(props.projectName);
  },
  { immediate: true },
);
</script>

<template>
  <div>
    <div
      class="grid gap-3"
      :class="variant === 'dialog' ? 'grid-cols-1' : 'sm:grid-cols-3'"
    >
      <label class="block">
        <span :class="labelClass">
          {{ machineText }} <span class="text-primary">*</span>
        </span>
        <select
          v-model="machineModel"
          :class="fieldClass"
        >
          <option value="" disabled>{{ t('picker.machinePlaceholder') }}</option>
          <option v-for="item in machines" :key="item.id" :value="item.id">
            {{ machineOptionLabel(item) }}
          </option>
        </select>
        <span v-if="!machines.length" class="mt-1 block text-[11px] text-on-surface-variant/70">
          {{ t('picker.noMachine') }}
        </span>
      </label>

      <label class="block">
        <span :class="labelClass">{{ projectText }}</span>
        <select
          v-model="projectModel"
          :class="fieldClass"
          :disabled="!machine"
        >
          <option value="">{{ noProjectText || t('picker.noProject') }}</option>
          <option v-for="project in projects" :key="project" :value="project">
            {{ project }}
          </option>
        </select>
        <span
          v-if="machine && !projects.length"
          class="mt-1 block text-[11px] text-on-surface-variant/70"
        >
          {{ t('picker.noProjectOnMachine') }}
        </span>
      </label>

      <label class="block">
        <span :class="labelClass">
          {{ t('picker.client') }} <span class="text-primary">*</span>
        </span>
        <select
          v-model="envModel"
          :class="fieldClass"
          :disabled="!machine"
        >
          <option value="" disabled>{{ t('picker.clientPlaceholder') }}</option>
          <option v-for="agent in clients.visible" :key="agent.env" :value="agent.env">
            {{ clientOptionLabel(agent) }}
          </option>
          <optgroup
            v-if="clients.ghosts.length"
            :label="t('picker.ghosts', { count: clients.ghosts.length })"
          >
            <option v-for="agent in clients.ghosts" :key="agent.env" :value="agent.env">
              {{ clientOptionLabel(agent) }}
            </option>
          </optgroup>
        </select>
        <span
          v-if="machine && clients.visible.length > 1 && !env"
          class="mt-1 block text-[11px] text-on-surface-variant/70"
        >
          {{ t('picker.chooseClient') }}
        </span>
        <span
          v-else-if="machine && !clients.visible.length && !clients.ghosts.length"
          class="mt-1 block text-[11px] text-on-surface-variant/70"
        >
          {{ t('picker.noClientForProject') }}
        </span>
      </label>
    </div>

    <p
      v-if="env"
      class="mt-1.5 text-[11px] text-on-surface-variant/70"
    >
      {{ t('picker.deliversTo', { env }) }}
    </p>
  </div>
</template>
