<script setup lang="ts">
import { Loader2, Send, Sparkles, X, Zap } from 'lucide-vue-next';
import { computed, reactive, ref, watch } from 'vue';

import { TASK_ENGINES } from '@zhunzou/shared';
import type { AgentKind, DispatchTaskInput, CreateTaskInput } from '@zhunzou/shared';

import { clientKindLabel } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';
import TargetPicker from './TargetPicker.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const store = useHubStore();
const { t } = useI18n();

type Mode = 'target' | 'route';

const form = reactive({
  mode: 'target' as Mode,
  env: '',
  projectName: '',
  repoName: '',
  engine: '' as AgentKind | '',
  tags: '',
  title: '',
  instruction: '',
});
const submitting = ref(false);

const tagList = computed(() =>
  form.tags
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 10),
);

const canSubmit = computed(() => {
  if (!form.title.trim() || !form.instruction.trim()) return false;
  return form.mode === 'target'
    ? form.env.trim().length > 0
    : form.repoName.trim().length > 0;
});

watch(
  () => props.open,
  (open) => {
    if (!open) submitting.value = false;
  },
);

function close(): void {
  if (submitting.value) return;
  emit('close');
}

async function submit(): Promise<void> {
  if (!canSubmit.value || submitting.value) return;

  submitting.value = true;
  const common = {
    title: form.title.trim(),
    instruction: form.instruction.trim(),
  };

  const ok =
    form.mode === 'target'
      ? await store.createTask({
          env: form.env.trim(),
          ...(form.projectName.trim()
            ? { projectName: form.projectName.trim() }
            : {}),
          ...common,
        } satisfies CreateTaskInput)
      : await store.dispatchTask({
          repoName: form.repoName.trim(),
          ...(form.engine ? { engine: form.engine } : {}),
          tags: tagList.value,
          ...common,
        } satisfies DispatchTaskInput);

  submitting.value = false;
  if (ok) {
    form.title = '';
    form.instruction = '';
    emit('close');
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4"
    role="dialog"
    aria-modal="true"
    :aria-label="t('dispatch.aria')"
    @click.self="close"
  >
    <div
      class="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 pb-[calc(1.25rem_+_env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:pb-5"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-2.5">
          <span
            class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary text-on-primary shadow-sm"
          >
            <Send :size="19" />
          </span>
          <div>
            <h2
              class="text-lg font-semibold text-on-surface"
              style="font-family: var(--font-serif)"
            >
              {{ t('dispatch.title') }}
            </h2>
            <p class="text-[11px] text-on-surface-variant">{{ t('dispatch.subtitle') }}</p>
          </div>
        </div>
        <button
          type="button"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-on-surface-variant transition hover:bg-surface-container"
          :aria-label="t('dispatch.close')"
          @click="close"
        >
          <X :size="16" />
        </button>
      </div>

      <div class="mt-4 flex items-center gap-1 rounded-lg bg-surface-container p-1">
        <button
          v-for="option in (['target', 'route'] as const)"
          :key="option"
          type="button"
          class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition"
          :class="
            form.mode === option
              ? 'bg-surface text-on-surface shadow-sm'
              : 'text-on-surface-variant'
          "
          @click="form.mode = option"
        >
          <component :is="option === 'route' ? Sparkles : Zap" :size="13" />
          {{ option === 'route' ? t('dispatch.modeRoute') : t('dispatch.modeTarget') }}
        </button>
      </div>

      <form class="mt-4 space-y-3" @submit.prevent="submit">
        <template v-if="form.mode === 'target'">
          <TargetPicker
            v-model:env="form.env"
            v-model:project-name="form.projectName"
            :machines="store.targetMachines"
            variant="dialog"
            :project-label="t('dispatch.projectLabel')"
            :no-project-text="t('dispatch.noProject')"
          />
        </template>

        <template v-else>
          <label class="block">
            <span class="text-[11px] font-medium text-on-surface-variant">
              {{ t('dispatch.repoLabel') }} <span class="text-primary">*</span>
            </span>
            <input
              v-model="form.repoName"
              maxlength="128"
              :placeholder="t('dispatch.repoPlaceholder')"
              class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 font-mono text-[13px] text-on-surface outline-none focus:border-primary"
            />
          </label>
          <p class="text-[11px] leading-4 text-on-surface-variant/70">
            {{ t('dispatch.routeHint') }}
          </p>

          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="text-[11px] font-medium text-on-surface-variant">
                {{ t('dispatch.engineLabel') }}
              </span>
              <select
                v-model="form.engine"
                class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary"
              >
                <option value="">{{ t('dispatch.engineAny') }}</option>
                <option v-for="kind in TASK_ENGINES" :key="kind" :value="kind">
                  {{ clientKindLabel(kind) }}
                </option>
              </select>
            </label>
            <label class="block">
              <span class="text-[11px] font-medium text-on-surface-variant">
                {{ t('dispatch.tagsLabel') }}
              </span>
              <input
                v-model="form.tags"
                maxlength="120"
                :placeholder="t('dispatch.tagsPlaceholder')"
                class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 font-mono text-[13px] text-on-surface outline-none focus:border-primary"
              />
            </label>
          </div>
        </template>

        <label class="block">
          <span class="text-[11px] font-medium text-on-surface-variant">
            {{ t('dispatch.titleLabel') }} <span class="text-primary">*</span>
          </span>
          <input
            v-model="form.title"
            maxlength="200"
            :placeholder="t('dispatch.titlePlaceholder')"
            class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 text-[13px] text-on-surface outline-none focus:border-primary"
          />
        </label>

        <label class="block">
          <span class="text-[11px] font-medium text-on-surface-variant">
            {{ t('dispatch.instructionLabel') }} <span class="text-primary">*</span>
          </span>
          <textarea
            v-model="form.instruction"
            rows="4"
            maxlength="4000"
            :placeholder="t('dispatch.instructionPlaceholder')"
            class="mt-1 w-full resize-y rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 py-2 text-[13px] leading-6 text-on-surface outline-none focus:border-primary"
          />
        </label>

        <div class="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            class="h-9 rounded-lg px-3 text-[12px] font-medium text-on-surface-variant transition hover:bg-surface-container"
            @click="close"
          >
            {{ t('dispatch.cancel') }}
          </button>
          <button
            type="submit"
            :disabled="!canSubmit || submitting"
            class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-[12px] font-medium text-on-primary transition hover:bg-primary-container disabled:opacity-50"
          >
            <Loader2 v-if="submitting" :size="14" class="animate-spin" />
            <Send v-else :size="14" />
            {{ submitting ? t('dispatch.sending') : t('dispatch.submit') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
