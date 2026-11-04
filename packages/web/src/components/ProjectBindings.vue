<script setup lang="ts">
import { Folder, Loader2, Plus, X } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';

import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';

const props = defineProps<{ env: string }>();

const store = useHubStore();
const { t } = useI18n();
const adding = ref(false);
const projectName = ref('');

const bound = computed(() =>
  props.env ? store.projectsForEnv(props.env) : [],
);

const activeProject = computed(
  () => store.envs.find((env) => env.env === props.env)?.projectName ?? '',
);

const candidates = computed(() =>
  store.knownProjects.filter(
    (name) => !bound.value.some((project) => project.projectName === name),
  ),
);

const canAdd = computed(
  () => props.env.trim().length > 0 && projectName.value.trim().length > 0,
);

watch(
  () => props.env,
  () => {
    adding.value = false;
    projectName.value = '';
  },
);

async function submit(): Promise<void> {
  if (!canAdd.value || store.bindingProject) return;

  const ok = await store.bindProject(props.env, projectName.value.trim());
  if (ok) {
    projectName.value = '';
    adding.value = false;
  }
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="flex items-center gap-1 text-[11px] font-medium text-on-surface-variant">
        <Folder :size="11" />
        {{ t('bindings.label') }}
      </span>

      <span
        v-for="project in bound"
        :key="project.id"
        class="inline-flex items-center gap-1 rounded bg-surface-container-high px-1.5 py-0.5 font-mono text-[11px] text-on-surface"
      >
        {{ project.projectName }}
        <button
          type="button"
          :disabled="
            store.unbindingProjectId === project.id ||
            project.projectName === activeProject
          "
          :aria-label="t('bindings.unbind', { project: project.projectName })"
          :title="
            project.projectName === activeProject
              ? t('bindings.activeHint')
              : t('bindings.unbind', { project: project.projectName })
          "
          class="grid h-4 w-4 place-items-center rounded text-on-surface-variant transition hover:bg-error-container hover:text-on-error-container disabled:cursor-not-allowed disabled:opacity-40"
          @click="store.unbindProject(project.id)"
        >
          <Loader2
            v-if="store.unbindingProjectId === project.id"
            :size="11"
            class="animate-spin"
          />
          <X v-else :size="11" />
        </button>
      </span>

      <span
        v-if="env && !bound.length"
        class="text-[11px] text-on-surface-variant/70"
      >
        {{ t('bindings.none') }}
      </span>

      <button
        v-if="env && !adding && candidates.length"
        type="button"
        class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-primary transition hover:bg-primary/10"
        @click="adding = true"
      >
        <Plus :size="11" />
        {{ t('bindings.bind') }}
      </button>

      <span
        v-if="env && !adding && !candidates.length && bound.length"
        class="text-[11px] text-on-surface-variant/70"
      >
        {{ t('bindings.allBound') }}
      </span>

      <span v-if="!env" class="text-[11px] text-on-surface-variant/70">
        {{ t('bindings.selectEnv') }}
      </span>
    </div>

    <form
      v-if="adding"
      class="mt-2 flex flex-wrap items-center gap-2"
      @submit.prevent="submit"
    >
      <select
        v-model="projectName"
        class="h-8 min-w-[200px] flex-1 rounded-lg bg-surface-container-low px-2.5 font-mono text-xs text-on-surface shadow-inner outline-none transition focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20"
      >
        <option value="" disabled>{{ t('bindings.placeholder') }}</option>
        <option v-for="name in candidates" :key="name" :value="name">
          {{ name }}
        </option>
      </select>
      <button
        type="submit"
        :disabled="!canAdd || store.bindingProject"
        class="inline-flex h-8 items-center gap-1 rounded-lg bg-primary px-2.5 text-xs font-medium text-on-primary transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Loader2 v-if="store.bindingProject" :size="12" class="animate-spin" />
        {{ t('bindings.bindBtn') }}
      </button>
      <button
        type="button"
        class="h-8 rounded-lg px-2 text-xs text-on-surface-variant transition hover:bg-surface-container"
        @click="adding = false"
      >
        {{ t('bindings.cancel') }}
      </button>
    </form>
  </div>
</template>
