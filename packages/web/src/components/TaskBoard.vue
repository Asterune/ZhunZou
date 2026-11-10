<script setup lang="ts">
import {
  CheckCircle2,
  Clock,
  Folder,
  Inbox,
  Loader2,
  Send,
  Terminal,
  XCircle,
} from 'lucide-vue-next';
import { computed, nextTick, reactive, ref, watch } from 'vue';

import type { CreateTaskInput } from '@zhunzou/shared';

import {
  relativeTime,
  TASK_STATUS_CLASSES,
  taskStatusLabel,
  TICKET_STATUS_CLASSES,
  ticketStatusLabel,
} from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';
import TargetPicker from './TargetPicker.vue';
import TaskLogViewer from './TaskLogViewer.vue';

const props = defineProps<{
  /** Rendered inside the Chat page, so the page-level title is redundant. */
  embedded?: boolean;
  /** Task picked from the merged sidebar; scroll to and ring it. */
  focusTaskId?: string;
}>();

const store = useHubStore();
const { t } = useI18n();

const form = reactive({
  env: '',
  projectName: '',
  title: '',
  instruction: '',
});
const submitting = ref(false);
const cancelling = ref('');
const openLogs = ref('');

function toggleLogs(taskId: string): void {
  openLogs.value = openLogs.value === taskId ? '' : taskId;
}

/** The sidebar and this list share a page, so a click must scroll the card in. */
watch(
  () => props.focusTaskId,
  async (id) => {
    if (!id || typeof document === 'undefined') return;
    await nextTick();
    document
      .querySelector(`[data-task-id="${id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
  { immediate: true },
);

function ticketsForTask(taskId: string) {
  return store.tickets.filter((ticket) => ticket.taskId === taskId);
}

const canSubmit = computed(
  () =>
    form.env.trim().length > 0 &&
    form.title.trim().length > 0 &&
    form.instruction.trim().length > 0,
);

async function submit(): Promise<void> {
  if (!canSubmit.value || submitting.value) return;

  submitting.value = true;
  const input: CreateTaskInput = {
    env: form.env.trim(),
    ...(form.projectName.trim()
      ? { projectName: form.projectName.trim() }
      : {}),
    title: form.title.trim(),
    instruction: form.instruction.trim(),
  };

  const ok = await store.createTask(input);
  if (ok) {
    form.title = '';
    form.instruction = '';
  }
  submitting.value = false;
}

async function cancel(taskId: string): Promise<void> {
  if (cancelling.value) return;
  cancelling.value = taskId;
  await store.cancelTask(taskId);
  cancelling.value = '';
}
</script>

<template>
  <section>
    <div
      v-if="!embedded"
      class="mb-4 flex flex-wrap items-end justify-between gap-3"
    >
      <div>
        <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-on-surface-variant">
          <span>{{ t('tasks.eyebrow') }}</span>
          <span class="text-outline-variant">·</span>
          <span>{{ t('tasks.eyebrowLocal') }}</span>
        </div>
        <h2
          class="mt-0.5 flex items-center gap-2 text-xl font-semibold text-on-surface"
          style="font-family: var(--font-serif)"
        >
          {{ t('tasks.title') }}
          <span
            class="rounded bg-surface-container px-1.5 py-0.5 text-[11px] font-medium tracking-normal text-on-surface-variant"
          >
            {{ t('tasks.count', { count: store.activeTasks.length }) }}
          </span>
        </h2>
      </div>
      <span class="text-[11px] text-on-surface-variant">
        {{ t('tasks.hint') }}
      </span>
    </div>

    <form
      class="mb-6 rounded-2xl border border-outline-variant/35 bg-surface-container-lowest p-4 shadow-sm sm:p-5"
      @submit.prevent="submit"
    >
      <TargetPicker
        v-model:env="form.env"
        v-model:project-name="form.projectName"
        :machines="store.targetMachines"
        :project-label="t('tasks.projectLabel')"
        :no-project-text="t('tasks.noProject')"
      />

      <p class="mt-2 text-[11px] leading-4 text-on-surface-variant/70">
        {{ t('tasks.bindingHint') }}
      </p>
      <label class="mt-3 block">
        <span class="text-[11px] font-medium text-on-surface-variant">
          {{ t('tasks.titleLabel') }} <span class="text-primary">*</span>
        </span>
        <input
          v-model="form.title"
          required
          maxlength="200"
          :placeholder="t('tasks.titlePlaceholder')"
          class="mt-1 h-10 w-full rounded-lg bg-surface-container-low px-3 text-sm text-on-surface shadow-inner outline-none transition placeholder:text-on-surface-variant/45 focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20"
        />
      </label>

      <label class="mt-3 block">
        <span class="text-[11px] font-medium text-on-surface-variant">
          {{ t('tasks.instructionLabel') }} <span class="text-primary">*</span>
        </span>
        <textarea
          v-model="form.instruction"
          required
          rows="4"
          maxlength="2000"
          :placeholder="t('tasks.instructionPlaceholder')"
          class="mt-1 w-full resize-y rounded-lg bg-surface-container-low px-3 py-2.5 text-sm leading-6 text-on-surface shadow-inner outline-none transition placeholder:text-on-surface-variant/45 focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20"
        />
      </label>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p class="text-[11px] text-on-surface-variant/70">
          {{ t('tasks.queueHint') }}
        </p>
        <button
          type="submit"
          :disabled="!canSubmit || submitting"
          class="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary shadow-sm transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Loader2 v-if="submitting" :size="16" class="animate-spin" />
          <Send v-else :size="16" />
          {{ submitting ? t('tasks.submitting') : t('tasks.submit') }}
        </button>
      </div>
    </form>

    <div class="mb-2.5 flex items-center justify-between px-0.5">
      <h3
        class="flex items-center gap-2 text-base font-semibold text-on-surface"
        style="font-family: var(--font-serif)"
      >
        <Inbox :size="16" class="text-primary" />
        {{ t('tasks.listTitle') }}
      </h3>
      <span class="text-[11px] text-on-surface-variant">
        {{ t('tasks.listHint') }}
      </span>
    </div>

    <div
      v-if="!store.activeTasks.length"
      class="rounded-2xl border border-dashed border-outline-variant bg-surface-container-low/60 px-6 py-10 text-center"
    >
      <div
        class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-container text-primary"
      >
        <Inbox :size="22" />
      </div>
      <p class="mt-3 text-sm font-medium text-on-surface">{{ t('tasks.emptyTitle') }}</p>
      <p class="mt-1 text-xs text-on-surface-variant">
        {{ t('tasks.emptyDesc') }}
      </p>
    </div>

    <div v-else class="space-y-3">
      <article
        v-for="task in store.activeTasks"
        :key="task.id"
        :data-task-id="task.id"
        class="rounded-xl border bg-surface-container-lowest p-4 shadow-sm"
        :class="
          focusTaskId === task.id
            ? 'border-primary ring-2 ring-primary/25'
            : 'border-outline-variant/35'
        "
      >
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-sm font-bold text-primary">#{{ task.id }}</span>
              <h4 class="text-base font-semibold text-on-surface">{{ task.title }}</h4>
              <span
                class="rounded px-2 py-0.5 text-[11px] font-semibold"
                :class="TASK_STATUS_CLASSES[task.status]"
              >
                {{ taskStatusLabel(task.status) }}
              </span>
              <span
                v-if="task.attempts > 1"
                class="rounded bg-tertiary-fixed px-2 py-0.5 text-[10px] font-semibold text-on-tertiary-fixed"
              >
                {{ t('tasks.attempt', { count: task.attempts }) }}
              </span>
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
              <span class="rounded bg-surface-container-high px-1.5 py-0.5 font-mono">
                env: {{ task.env }}
              </span>
              <span v-if="task.projectName" class="flex items-center gap-1">
                <Folder :size="11" />
                <span class="font-mono">{{ task.projectName }}</span>
              </span>
              <span class="flex items-center gap-1">
                <Clock :size="11" />
                {{ t('tasks.dispatchedAt', { time: relativeTime(task.createdAt) }) }}
              </span>
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface"
              @click="toggleLogs(task.id)"
            >
              <Terminal :size="13" />
              {{ openLogs === task.id ? t('tasks.hideOutput') : t('tasks.showOutput') }}
            </button>
            <button
              type="button"
              :disabled="cancelling === task.id"
              class="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-on-surface-variant transition hover:bg-error-container hover:text-on-error-container disabled:opacity-50"
              @click="cancel(task.id)"
            >
              <Loader2 v-if="cancelling === task.id" :size="13" class="animate-spin" />
              <XCircle v-else :size="13" />
              {{ t('tasks.cancel') }}
            </button>
          </div>
        </div>

        <p class="mt-2.5 whitespace-pre-wrap break-words rounded-lg bg-surface-container-low px-3 py-2 text-sm leading-6 text-on-surface">
          {{ task.instruction }}
        </p>

        <div
          v-if="ticketsForTask(task.id).length"
          class="mt-2 rounded-lg border border-outline-variant/30 bg-surface-container-low/60 px-3 py-2"
        >
          <p class="text-[11px] font-medium text-on-surface-variant">
            {{ t('tasks.linkedTickets') }}
          </p>
          <ul class="mt-1 space-y-1">
            <li
              v-for="ticket in ticketsForTask(task.id)"
              :key="ticket.id"
              class="flex flex-wrap items-center gap-1.5 text-xs text-on-surface"
            >
              <span class="font-mono font-semibold text-primary">#{{ ticket.id }}</span>
              <span class="min-w-0 break-words">{{ ticket.blockerQuestion }}</span>
              <span
                class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                :class="TICKET_STATUS_CLASSES[ticket.status]"
              >
                {{ ticketStatusLabel(ticket.status) }}
              </span>
              <span v-if="ticket.selectedOption" class="font-mono text-[10px] text-on-surface-variant">
                → {{ ticket.selectedOption }}
              </span>
            </li>
          </ul>
        </div>

        <p
          v-if="task.status === 'CLAIMED'"
          class="mt-2 flex items-center gap-1.5 text-[11px] text-secondary"
        >
          <CheckCircle2 :size="13" />
          {{ t('tasks.claimed') }}{{ task.claimedAt ? ` · ${relativeTime(task.claimedAt)}` : '' }}
        </p>

        <TaskLogViewer
          v-if="openLogs === task.id"
          :task-id="task.id"
          :active="task.status === 'CLAIMED'"
        />
      </article>
    </div>

    <div v-if="store.finishedTasks.length" class="mt-6">
      <h3
        class="mb-2.5 flex items-center gap-2 px-0.5 text-base font-semibold text-on-surface"
        style="font-family: var(--font-serif)"
      >
        <CheckCircle2 :size="16" class="text-secondary" />
        {{ t('tasks.finished') }}
        <span class="text-[11px] font-normal text-on-surface-variant">
          {{ t('tasks.finishedCount', { count: store.finishedTasks.length }) }}
        </span>
      </h3>

      <div class="space-y-2">
        <article
          v-for="task in store.finishedTasks"
          :key="task.id"
          class="rounded-xl border border-outline-variant/25 bg-surface-container-low/60 p-3.5"
        >
          <div class="flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
            <span class="font-mono font-semibold text-on-surface">#{{ task.id }}</span>
            <span
              class="rounded px-2 py-0.5 font-semibold"
              :class="TASK_STATUS_CLASSES[task.status]"
            >
              {{ taskStatusLabel(task.status) }}
            </span>
            <span class="font-mono">{{ task.env }}</span>
            <span class="text-outline-variant">·</span>
            <span>{{ relativeTime(task.updatedAt) }}</span>
            <button
              type="button"
              class="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface"
              @click="toggleLogs(task.id)"
            >
              <Terminal :size="12" />
              {{ openLogs === task.id ? t('tasks.hideOutput') : t('tasks.output') }}
            </button>
          </div>
          <p class="mt-1.5 text-sm font-medium text-on-surface">{{ task.title }}</p>
          <p v-if="task.result" class="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-on-surface-variant">
            {{ task.result }}
          </p>
          <ul v-if="ticketsForTask(task.id).length" class="mt-1.5 space-y-1">
            <li
              v-for="ticket in ticketsForTask(task.id)"
              :key="ticket.id"
              class="flex flex-wrap items-center gap-1.5 text-xs text-on-surface-variant"
            >
              <span class="font-mono font-semibold text-primary">#{{ ticket.id }}</span>
              <span class="min-w-0 break-words">{{ ticket.blockerQuestion }}</span>
              <span
                class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                :class="TICKET_STATUS_CLASSES[ticket.status]"
              >
                {{ ticketStatusLabel(ticket.status) }}
              </span>
              <span v-if="ticket.selectedOption" class="font-mono text-[10px]">
                → {{ ticket.selectedOption }}
              </span>
            </li>
          </ul>
          <TaskLogViewer
            v-if="openLogs === task.id"
            :task-id="task.id"
            :active="false"
          />
        </article>
      </div>
    </div>
  </section>
</template>
