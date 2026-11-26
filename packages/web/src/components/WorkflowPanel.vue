<script setup lang="ts">
import { Plus, RefreshCw, Trash2, Workflow as WorkflowIcon } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import type {
  CreateWorkflowInput,
  Workflow,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepRole,
} from '@zhunzou/shared';

import { relativeTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';

/**
 * 线性流程：设计 → 编码 → 审查/测试。每一步是一条普通任务，跑完后 hub 自动把
 * 上一步结果注入下一步的指令并派发；步骤可以各自指定执行端和模型。
 */
const store = useHubStore();
const { t } = useI18n();

const ROLES: WorkflowStepRole[] = ['design', 'code', 'review', 'test', 'custom'];
const REFRESH_MS = 5_000;
let timer: ReturnType<typeof setInterval> | null = null;

interface StepDraft {
  name: string;
  role: WorkflowStepRole;
  env: string;
  model: string;
  instruction: string;
}

const dialogOpen = ref(false);
const saving = ref(false);
const selected = ref('');
const brief = ref('');

const form = reactive({
  name: '',
  projectName: '',
  steps: [] as StepDraft[],
});

const envs = computed(() =>
  store.agents.map((agent) => ({ env: agent.env, name: agent.name })),
);
const projects = computed(() => store.knownProjects);

const runs = computed(() =>
  selected.value
    ? store.workflowRuns.filter((run) => run.workflowId === selected.value)
    : store.workflowRuns,
);

const canSave = computed(
  () =>
    form.name.trim().length > 0 &&
    form.projectName.trim().length > 0 &&
    form.steps.length >= 2 &&
    form.steps.every(
      (step) =>
        step.name.trim().length > 0 &&
        step.env.length > 0 &&
        step.instruction.trim().length > 0,
    ),
);

function defaultStep(role: WorkflowStepRole): StepDraft {
  const env = envs.value[0]?.env ?? '';
  if (role === 'design') {
    return {
      name: t('workflow.role.design'),
      role,
      env,
      model: '',
      instruction: t('workflow.template.design'),
    };
  }
  if (role === 'code') {
    return {
      name: t('workflow.role.code'),
      role,
      env,
      model: '',
      instruction: t('workflow.template.code'),
    };
  }
  return { name: '', role, env, model: '', instruction: '' };
}

function openCreate(): void {
  form.name = '';
  form.projectName = store.knownProjects[0] ?? '';
  form.steps = [defaultStep('design'), defaultStep('code')];
  dialogOpen.value = true;
}

function addStep(): void {
  if (form.steps.length >= 8) return;
  form.steps.push(defaultStep('custom'));
}

function removeStep(index: number): void {
  if (form.steps.length <= 2) return;
  form.steps.splice(index, 1);
}

async function save(): Promise<void> {
  if (!canSave.value || saving.value) return;
  saving.value = true;
  try {
    const input: CreateWorkflowInput = {
      name: form.name.trim(),
      projectName: form.projectName.trim(),
      steps: form.steps.map((step) => ({
        name: step.name.trim(),
        role: step.role,
        env: step.env,
        ...(step.model.trim() ? { model: step.model.trim() } : {}),
        instruction: step.instruction.trim(),
      })),
    };
    const created = await store.createWorkflow(input);
    if (created) {
      dialogOpen.value = false;
      selected.value = created.id;
      await store.loadWorkflowRuns(created.id);
    }
  } finally {
    saving.value = false;
  }
}

async function run(workflow: Workflow): Promise<void> {
  const created = await store.startWorkflowRun(
    workflow.id,
    brief.value.trim() || undefined,
  );
  if (created) {
    selected.value = workflow.id;
    brief.value = '';
  }
}

async function remove(workflow: Workflow): Promise<void> {
  if (!window.confirm(t('workflow.deleteConfirm', { name: workflow.name }))) {
    return;
  }
  await store.deleteWorkflow(workflow.id);
  if (selected.value === workflow.id) selected.value = '';
}

function statusClass(status: WorkflowRunStatus): string {
  if (status === 'DONE') return 'bg-secondary/10 text-secondary';
  if (status === 'FAILED') return 'bg-error-container text-on-error-container';
  if (status === 'RUNNING') return 'bg-primary/10 text-primary';
  return 'bg-surface-container-high text-on-surface-variant';
}

onMounted(() => {
  void store.loadWorkflows();
  void store.loadWorkflowRuns();
  timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void store.loadWorkflowRuns(selected.value || undefined);
  }, REFRESH_MS);
});

onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
});
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-2 px-0.5">
      <div class="flex items-center gap-2">
        <span class="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-primary-container" />
        <h2 class="text-xl font-semibold text-on-surface" style="font-family: var(--font-serif)">
          {{ t('workflow.title') }}
        </h2>
        <span class="rounded bg-surface-container px-2 py-0.5 text-[11px] font-medium text-on-surface-variant">
          {{ t('workflow.count', { count: store.workflows.length }) }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container"
          @click="store.loadWorkflows(); store.loadWorkflowRuns(selected || undefined)"
        >
          <RefreshCw :size="14" />
          {{ t('workflow.refresh') }}
        </button>
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary shadow-sm transition hover:bg-primary-container"
          @click="openCreate"
        >
          <Plus :size="14" />
          {{ t('workflow.new') }}
        </button>
      </div>
    </div>

    <div class="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside class="space-y-2">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-outline-variant px-2.5 py-1.5 text-[11px] text-on-surface-variant"
          :class="selected === '' ? 'border-primary/40 text-primary' : ''"
          @click="selected = ''"
        >
          <WorkflowIcon :size="12" />
          {{ t('workflow.allRuns') }}
        </button>

        <p
          v-if="!store.workflows.length"
          class="rounded-lg border border-dashed border-outline-variant bg-surface-container-low/60 px-3 py-6 text-center text-[11.5px] text-on-surface-variant"
        >
          {{ t('workflow.empty') }}
        </p>

        <article
          v-for="workflow in store.workflows"
          :key="workflow.id"
          class="rounded-xl border border-outline-variant/35 bg-surface-container-low p-3 shadow-sm"
          :class="selected === workflow.id ? 'border-primary/40' : ''"
        >
          <button type="button" class="w-full text-left" @click="selected = workflow.id">
            <p class="truncate text-[13px] font-semibold text-on-surface">
              {{ workflow.name }}
            </p>
            <p class="mt-0.5 text-[11px] text-on-surface-variant">
              {{ workflow.projectName }} · {{ t('workflow.stepsCount', { count: workflow.steps.length }) }}
            </p>
          </button>
          <div class="mt-2 flex flex-wrap gap-1">
            <span
              v-for="(step, index) in workflow.steps"
              :key="index"
              class="rounded bg-surface-container-high px-1.5 py-0.5 text-[10px] text-on-surface-variant"
            >
              {{ index + 1 }}. {{ step.name }}
            </span>
          </div>
          <div class="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              class="flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-on-primary transition hover:bg-primary-container"
              @click="run(workflow)"
            >
              {{ t('workflow.run') }}
            </button>
            <button
              type="button"
              class="grid h-7 w-7 place-items-center rounded-md text-on-surface-variant transition hover:bg-error-container hover:text-on-error-container"
              :title="t('workflow.delete')"
              @click="remove(workflow)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
        </article>
      </aside>

      <div class="min-w-0">
        <label class="mb-2 block text-[11px] text-on-surface-variant">
          {{ t('workflow.brief') }}
          <input
            v-model="brief"
            maxlength="20000"
            :placeholder="t('workflow.briefPlaceholder')"
            class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 text-[12px] text-on-surface outline-none focus:border-primary"
          />
        </label>

        <p
          v-if="!runs.length"
          class="rounded-lg border border-dashed border-outline-variant bg-surface-container-low/60 px-3 py-8 text-center text-[11.5px] text-on-surface-variant"
        >
          {{ t('workflow.noRuns') }}
        </p>

        <article
          v-for="run in runs"
          :key="run.id"
          class="mb-2 rounded-xl border border-outline-variant/35 bg-surface-container-low p-3 shadow-sm"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="truncate text-[12.5px] font-semibold text-on-surface">
                {{ run.workflowName }}
              </span>
              <span class="font-mono text-[10px] text-on-surface-variant/60">#{{ run.id }}</span>
            </div>
            <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" :class="statusClass(run.status)">
              {{ t(`workflow.status.${run.status}`) }}
            </span>
          </div>
          <div class="mt-2 space-y-1">
            <div
              v-for="task in run.tasks"
              :key="task.index"
              class="flex items-center gap-2 text-[11px]"
            >
              <span class="w-4 shrink-0 text-center font-mono text-on-surface-variant/60">
                {{ task.index + 1 }}
              </span>
              <span class="min-w-0 flex-1 truncate text-on-surface" :title="task.title">
                {{ task.title }}
              </span>
              <span class="shrink-0 rounded px-1 text-[9.5px]" :class="statusClass(
                task.status === 'DONE'
                  ? 'DONE'
                  : task.status === 'FAILED' || task.status === 'CANCELLED'
                    ? 'FAILED'
                    : 'RUNNING',
              )">
                {{ task.status }}
              </span>
              <span class="shrink-0 font-mono text-[10px] text-on-surface-variant/50">
                #{{ task.taskId }}
              </span>
            </div>
          </div>
          <p class="mt-1.5 text-[10px] text-on-surface-variant/60">
            {{ relativeTime(run.updatedAt) }}
            <span v-if="run.error" class="text-error"> · {{ run.error }}</span>
          </p>
        </article>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="dialogOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
        role="dialog"
        aria-modal="true"
        @click.self="dialogOpen = false"
      >
        <div class="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-outline-variant/40 bg-surface p-5 shadow-xl">
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-lg font-semibold text-on-surface" style="font-family: var(--font-serif)">
              {{ t('workflow.newTitle') }}
            </h3>
            <button
              type="button"
              class="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container"
              :aria-label="t('workflow.cancel')"
              @click="dialogOpen = false"
            >
              ✕
            </button>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block text-[12px] text-on-surface-variant">
              {{ t('workflow.name') }}
              <input
                v-model="form.name"
                maxlength="120"
                class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 text-[13px] text-on-surface outline-none focus:border-primary"
              />
            </label>
            <label class="block text-[12px] text-on-surface-variant">
              {{ t('workflow.project') }}
              <select
                v-model="form.projectName"
                class="mt-1 h-9 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[13px] text-on-surface outline-none focus:border-primary"
              >
                <option v-for="project in projects" :key="project" :value="project">
                  {{ project }}
                </option>
              </select>
            </label>
          </div>

          <div class="mt-4 space-y-3">
            <div
              v-for="(step, index) in form.steps"
              :key="index"
              class="rounded-xl border border-outline-variant/35 bg-surface-container-low p-3"
            >
              <div class="mb-2 flex items-center justify-between">
                <span class="text-[11px] font-medium text-on-surface-variant">
                  {{ t('workflow.stepN', { n: index + 1 }) }}
                </span>
                <button
                  v-if="form.steps.length > 2"
                  type="button"
                  class="text-[11px] text-on-surface-variant hover:text-error"
                  @click="removeStep(index)"
                >
                  {{ t('workflow.removeStep') }}
                </button>
              </div>
              <div class="grid gap-2 sm:grid-cols-2">
                <input
                  v-model="step.name"
                  maxlength="80"
                  :placeholder="t('workflow.stepName')"
                  class="h-8 rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[12px] text-on-surface outline-none focus:border-primary"
                />
                <select
                  v-model="step.role"
                  class="h-8 rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[12px] text-on-surface outline-none focus:border-primary"
                >
                  <option v-for="role in ROLES" :key="role" :value="role">
                    {{ t(`workflow.role.${role}`) }}
                  </option>
                </select>
                <select
                  v-model="step.env"
                  class="h-8 rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 text-[12px] text-on-surface outline-none focus:border-primary"
                >
                  <option value="" disabled>{{ t('workflow.env') }}</option>
                  <option v-for="item in envs" :key="item.env" :value="item.env">
                    {{ item.name }} · {{ item.env }}
                  </option>
                </select>
                <input
                  v-model="step.model"
                  maxlength="120"
                  :placeholder="t('workflow.model')"
                  class="h-8 rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 font-mono text-[12px] text-on-surface outline-none focus:border-primary"
                />
              </div>
              <textarea
                v-model="step.instruction"
                rows="3"
                :placeholder="t('workflow.instructionHint')"
                class="mt-2 w-full resize-y rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2.5 py-1.5 text-[12px] leading-5 text-on-surface outline-none focus:border-primary"
              />
            </div>
          </div>

          <div class="mt-3 flex items-center justify-between">
            <button
              type="button"
              class="flex h-8 items-center gap-1 rounded-lg px-2.5 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container"
              :disabled="form.steps.length >= 8"
              @click="addStep"
            >
              <Plus :size="12" />
              {{ t('workflow.addStep') }}
            </button>
            <div class="flex gap-2">
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-[12px] font-medium text-on-surface-variant hover:bg-surface-container"
                @click="dialogOpen = false"
              >
                {{ t('workflow.cancel') }}
              </button>
              <button
                type="button"
                class="h-9 rounded-lg bg-primary px-4 text-[12px] font-medium text-on-primary transition hover:bg-primary-container disabled:opacity-50"
                :disabled="!canSave || saving"
                @click="save"
              >
                {{ saving ? t('workflow.saving') : t('workflow.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
