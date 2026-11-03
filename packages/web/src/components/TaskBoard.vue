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
import { computed, reactive, ref, watch } from 'vue';

import type { CreateTaskInput } from '@zhunzou/shared';

import {
  relativeTime,
  TASK_STATUS_CLASSES,
  TASK_STATUS_LABELS,
} from '../lib/format';
import { useHubStore } from '../stores/hub';
import ProjectBindings from './ProjectBindings.vue';
import TaskLogViewer from './TaskLogViewer.vue';

const store = useHubStore();

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

const envOptions = computed(() =>
  [...store.envs].sort((left, right) => left.env.localeCompare(right.env)),
);

const projectOptions = computed(() => {
  if (!form.env) return [];
  return store.projectsForEnv(form.env).map((project) => project.projectName);
});

const canSubmit = computed(
  () =>
    form.env.trim().length > 0 &&
    form.title.trim().length > 0 &&
    form.instruction.trim().length > 0,
);

watch(
  envOptions,
  (options) => {
    if (!form.env && options[0]) form.env = options[0].env;
  },
  { immediate: true },
);

watch(
  () => form.env,
  (env) => {
    const bound = store.projectsForEnv(env);
    const current = store.envs.find((item) => item.env === env)?.projectName;

    if (current && bound.some((project) => project.projectName === current)) {
      form.projectName = current;
    } else if (bound.length === 1) {
      form.projectName = bound[0]!.projectName;
    } else {
      form.projectName = '';
    }
  },
);

watch(projectOptions, (options) => {
  if (form.projectName && !options.includes(form.projectName)) {
    form.projectName = '';
  }
  if (!form.projectName && options.length === 1) {
    form.projectName = options[0]!;
  }
});

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
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-on-surface-variant">
          <span>Dispatch Desk</span>
          <span class="text-outline-variant">·</span>
          <span>自上而下 · 差遣</span>
        </div>
        <h2
          class="mt-0.5 flex items-center gap-2 text-xl font-semibold text-on-surface"
          style="font-family: var(--font-serif)"
        >
          下发任务
          <span
            class="rounded bg-surface-container px-1.5 py-0.5 text-[11px] font-medium tracking-normal text-on-surface-variant"
          >
            待办 {{ store.activeTasks.length }} 项
          </span>
        </h2>
      </div>
      <span class="text-[11px] text-on-surface-variant">
        Agent 调用 agent_hub_next_task 即可领取
      </span>
    </div>

    <form
      class="mb-6 rounded-2xl border border-outline-variant/35 bg-surface-container-lowest p-4 shadow-sm sm:p-5"
      @submit.prevent="submit"
    >
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="flex items-center gap-1 text-[11px] font-medium text-on-surface-variant">
            目标环境 <span class="text-primary">*</span>
          </span>
          <select
            v-model="form.env"
            required
            class="mt-1 h-10 w-full rounded-lg bg-surface-container-low px-3 font-mono text-sm text-on-surface shadow-inner outline-none transition focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20"
          >
            <option value="" disabled>请选择已接入环境</option>
            <option v-for="env in envOptions" :key="env.env" :value="env.env">
              {{ env.env }}{{ env.online ? ' · 在线' : ' · 离线' }}
            </option>
          </select>
          <span
            v-if="!envOptions.length"
            class="mt-1 block text-[11px] text-on-surface-variant/70"
          >
            暂无已接入环境，请先启动 Agent 桥接。
          </span>
        </label>

        <label class="block">
          <span class="text-[11px] font-medium text-on-surface-variant">项目名（选填）</span>
          <select
            v-model="form.projectName"
            class="mt-1 h-10 w-full rounded-lg bg-surface-container-low px-3 font-mono text-sm text-on-surface shadow-inner outline-none transition focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20"
          >
            <option value="">不指定项目</option>
            <option v-for="project in projectOptions" :key="project" :value="project">
              {{ project }}
            </option>
          </select>
          <span
            v-if="form.env && !projectOptions.length"
            class="mt-1 block text-[11px] text-on-surface-variant/70"
          >
            该工作区还没有绑定项目，可在下方直接绑定。
          </span>
        </label>
      </div>

      <div
        class="mt-3 rounded-lg border border-dashed border-outline-variant/70 bg-surface-container-low/50 px-3 py-2.5"
      >
        <ProjectBindings :env="form.env" />
        <p class="mt-1.5 text-[11px] leading-4 text-on-surface-variant/70">
          绑定的项目会出现在上方下拉框；Agent 心跳自动读取 OpenCode / Cursor 当前工作区，无需手动输入。
        </p>
      </div>

      <label class="mt-3 block">
        <span class="text-[11px] font-medium text-on-surface-variant">
          任务标题 <span class="text-primary">*</span>
        </span>
        <input
          v-model="form.title"
          required
          maxlength="200"
          placeholder="一句话说明要做什么"
          class="mt-1 h-10 w-full rounded-lg bg-surface-container-low px-3 text-sm text-on-surface shadow-inner outline-none transition placeholder:text-on-surface-variant/45 focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20"
        />
      </label>

      <label class="mt-3 block">
        <span class="text-[11px] font-medium text-on-surface-variant">
          详细指令 <span class="text-primary">*</span>
        </span>
        <textarea
          v-model="form.instruction"
          required
          rows="4"
          maxlength="2000"
          placeholder="写清目标、边界与验收标准。Agent 会按这段指令执行，完成后回报结果。"
          class="mt-1 w-full resize-y rounded-lg bg-surface-container-low px-3 py-2.5 text-sm leading-6 text-on-surface shadow-inner outline-none transition placeholder:text-on-surface-variant/45 focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20"
        />
      </label>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p class="text-[11px] text-on-surface-variant/70">
          任务会排队到下一位在线的同环境 Agent 领取，不会打断正在审批的工单。
        </p>
        <button
          type="submit"
          :disabled="!canSubmit || submitting"
          class="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary shadow-sm transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Loader2 v-if="submitting" :size="16" class="animate-spin" />
          <Send v-else :size="16" />
          {{ submitting ? '下发中…' : '下发任务' }}
        </button>
      </div>
    </form>

    <div class="mb-2.5 flex items-center justify-between px-0.5">
      <h3
        class="flex items-center gap-2 text-base font-semibold text-on-surface"
        style="font-family: var(--font-serif)"
      >
        <Inbox :size="16" class="text-primary" />
        待办与执行中
      </h3>
      <span class="text-[11px] text-on-surface-variant">
        最近下发的排在前面
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
      <p class="mt-3 text-sm font-medium text-on-surface">暂无待办任务</p>
      <p class="mt-1 text-xs text-on-surface-variant">
        在上方写下任务，指定环境后 Agent 领取即开始执行。
      </p>
    </div>

    <div v-else class="space-y-3">
      <article
        v-for="task in store.activeTasks"
        :key="task.id"
        class="rounded-xl border border-outline-variant/35 bg-surface-container-lowest p-4 shadow-sm"
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
                {{ TASK_STATUS_LABELS[task.status] }}
              </span>
              <span
                v-if="task.attempts > 1"
                class="rounded bg-tertiary-fixed px-2 py-0.5 text-[10px] font-semibold text-on-tertiary-fixed"
              >
                第 {{ task.attempts }} 次领取
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
                {{ relativeTime(task.createdAt) }}下发
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
              {{ openLogs === task.id ? '收起输出' : '查看输出' }}
            </button>
            <button
              type="button"
              :disabled="cancelling === task.id"
              class="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-on-surface-variant transition hover:bg-error-container hover:text-on-error-container disabled:opacity-50"
              @click="cancel(task.id)"
            >
              <Loader2 v-if="cancelling === task.id" :size="13" class="animate-spin" />
              <XCircle v-else :size="13" />
              取消
            </button>
          </div>
        </div>

        <p class="mt-2.5 whitespace-pre-wrap break-words rounded-lg bg-surface-container-low px-3 py-2 text-sm leading-6 text-on-surface">
          {{ task.instruction }}
        </p>

        <p
          v-if="task.status === 'CLAIMED'"
          class="mt-2 flex items-center gap-1.5 text-[11px] text-secondary"
        >
          <CheckCircle2 :size="13" />
          Agent 已领取，执行中{{ task.claimedAt ? ` · ${relativeTime(task.claimedAt)}` : '' }}
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
        已结束
        <span class="text-[11px] font-normal text-on-surface-variant">
          共 {{ store.finishedTasks.length }} 条
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
              {{ TASK_STATUS_LABELS[task.status] }}
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
              {{ openLogs === task.id ? '收起输出' : '输出' }}
            </button>
          </div>
          <p class="mt-1.5 text-sm font-medium text-on-surface">{{ task.title }}</p>
          <p v-if="task.result" class="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-on-surface-variant">
            {{ task.result }}
          </p>
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
