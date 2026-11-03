<script setup lang="ts">
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Bot,
  Check,
  Clock,
  Gavel,
  Loader2,
  PenLine,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import type { DecisionTicket } from '@zhunzou/shared';

import {
  formatCountdown,
  relativeTime,
  TICKET_STATUS_CLASSES,
  TICKET_STATUS_LABELS,
} from '../lib/format';
import { useHubStore } from '../stores/hub';

const props = defineProps<{ ticket: DecisionTicket }>();

const store = useHubStore();
const instruction = ref('');
const submitting = ref(false);
const pendingKey = ref('');
const confirmingKey = ref('');
const confirmingCancel = ref(false);
const extending = ref(false);
const cancelling = ref(false);
const now = ref(Date.now());

let countdownTimer: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let cancelTimer: ReturnType<typeof setTimeout> | null = null;

const env = computed(() =>
  store.envs.find((heartbeat) => heartbeat.env === props.ticket.env),
);
const envOffline = computed(() => !!env.value && !env.value.online);

const remainingMs = computed(() =>
  props.ticket.expiresAt
    ? Math.max(0, props.ticket.expiresAt - now.value)
    : 0,
);
const countdownLabel = computed(() => formatCountdown(remainingMs.value));
const recommendedRisk = computed(
  () =>
    props.ticket.options.find(
      (option) => option.key === props.ticket.recommendedOption,
    )?.risk,
);

onMounted(() => {
  if (!props.ticket.expiresAt) return;
  countdownTimer = setInterval(() => {
    now.value = Date.now();
  }, 1_000);
});

onBeforeUnmount(() => {
  if (countdownTimer) clearInterval(countdownTimer);
  if (confirmTimer) clearTimeout(confirmTimer);
  if (cancelTimer) clearTimeout(cancelTimer);
});

function isRecommended(key: string): boolean {
  return key === props.ticket.recommendedOption;
}

function requestCancel(): void {
  if (cancelling.value) return;

  if (!confirmingCancel.value) {
    confirmingCancel.value = true;
    cancelTimer = setTimeout(() => {
      confirmingCancel.value = false;
    }, 4_000);
    return;
  }

  confirmingCancel.value = false;
  void cancelTicket();
}

async function cancelTicket(): Promise<void> {
  cancelling.value = true;
  try {
    await store.cancelTicket(props.ticket.id);
  } finally {
    cancelling.value = false;
  }
}

async function extend(): Promise<void> {
  if (extending.value) return;
  extending.value = true;
  try {
    await store.extendTicket(props.ticket.id, 10);
  } finally {
    extending.value = false;
  }
}

async function approve(key: string): Promise<void> {
  if (submitting.value) return;

  const option = props.ticket.options.find((item) => item.key === key);

  // Destructive options require a second, deliberate click.
  if (option?.risk === 'destructive' && confirmingKey.value !== key) {
    confirmingKey.value = key;
    confirmTimer = setTimeout(() => {
      confirmingKey.value = '';
    }, 4_000);
    return;
  }

  confirmingKey.value = '';
  await submit(key, option?.risk === 'destructive');
}

async function submit(key: string, confirmDestructive: boolean): Promise<void> {
  submitting.value = true;
  pendingKey.value = key;

  const ok = await store.resolveTicket(
    props.ticket.id,
    key,
    instruction.value.trim() || undefined,
    confirmDestructive,
  );

  if (!ok) {
    submitting.value = false;
    pendingKey.value = '';
  }
}
</script>

<template>
  <article
    class="relative overflow-hidden rounded-xl border border-outline-variant/35 bg-surface-container-lowest shadow-[0_10px_30px_-24px_rgba(30,27,25,0.5)] transition-shadow hover:shadow-[0_16px_40px_-28px_rgba(30,27,25,0.55)]"
  >
    <div class="pointer-events-none absolute right-3 top-3 select-none opacity-15">
      <div
        class="grid h-16 w-16 rotate-6 place-items-center rounded border-2 border-primary text-lg font-black tracking-widest text-primary"
        style="font-family: var(--font-serif)"
      >
        待批
      </div>
    </div>

    <div class="p-4 sm:p-5">
      <header class="flex flex-wrap items-start justify-between gap-2 pr-14">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-lg font-bold tracking-tight text-primary">
              #{{ ticket.id }}
            </span>
            <h3
              class="text-lg font-semibold text-on-surface"
              style="font-family: var(--font-serif)"
            >
              {{ ticket.projectName }}
            </h3>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
            <span
              class="rounded bg-surface-container-high px-1.5 py-0.5 font-mono text-on-surface-variant"
            >
              env: {{ ticket.env }}
            </span>
            <span class="text-on-surface-variant/70">
              {{ relativeTime(ticket.createdAt) }}起奏
            </span>
          </div>
        </div>

        <span
          class="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold shadow-sm"
          :class="TICKET_STATUS_CLASSES[ticket.status]"
        >
          {{ TICKET_STATUS_LABELS[ticket.status] }}
        </span>
      </header>

      <div class="mt-3.5 space-y-2 rounded-lg bg-surface-container-low p-3">
        <div class="flex items-start gap-2.5">
          <span
            class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary-container text-on-secondary-container"
          >
            <Check :size="12" />
          </span>
          <div class="min-w-0">
            <span class="block text-[11px] font-medium text-on-surface-variant">
              已完成进展
            </span>
            <p class="text-sm leading-6 text-on-surface">{{ ticket.doneSummary }}</p>
          </div>
        </div>

        <div
          class="relative overflow-hidden rounded-lg bg-surface-container-high p-3 shadow-sm"
        >
          <span class="absolute inset-y-0 left-0 w-1.5 bg-primary-container" />
          <div class="space-y-1 pl-2">
            <div class="flex items-center gap-1.5 text-primary">
              <Gavel :size="16" />
              <span class="text-[13px] font-bold">请旨阻塞关键抉择</span>
            </div>
            <p class="break-words text-sm font-medium leading-6 text-on-surface">
              {{ ticket.blockerQuestion }}
            </p>
          </div>
        </div>

        <div class="flex items-start gap-2.5">
          <span
            class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-container-highest text-on-surface-variant"
          >
            <ArrowRight :size="12" />
          </span>
          <div class="min-w-0">
            <span class="block text-[11px] font-medium text-on-surface-variant">
              候命下一步
            </span>
            <p class="text-sm leading-6 text-on-surface">{{ ticket.nextStepPlan }}</p>
          </div>
        </div>
      </div>

      <p
        v-if="ticket.status === 'PENDING_META'"
        class="mt-3 rounded-lg bg-surface-container px-3 py-2 text-xs leading-5 text-on-surface-variant"
      >
        总管 Agent 正在按 GLOBAL_RULES.md 预审，通常几秒内自动处理；你也可以直接拍板。
      </p>

      <div
        v-if="ticket.status === 'PENDING_HUMAN' && ticket.resolutionReason"
        class="mt-3 rounded-lg bg-tertiary-fixed/45 px-3 py-2.5 ring-1 ring-inset ring-tertiary/10"
      >
        <span
          class="flex items-center gap-1.5 text-[11px] font-semibold text-on-tertiary-fixed"
        >
          <Bot :size="14" />
          总管为何不敢批
        </span>
        <p class="mt-1 text-xs leading-5 text-on-tertiary-fixed/85">
          {{ ticket.resolutionReason }}
        </p>
      </div>

      <div
        v-if="ticket.expiresAt"
        class="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-surface-container px-3 py-2 text-[11px] text-on-surface-variant ring-1 ring-inset ring-outline-variant/40"
      >
        <Clock :size="14" class="shrink-0 text-tertiary" />
        <template v-if="remainingMs > 0">
          <span>
            <strong class="font-mono font-semibold text-on-surface">
              {{ countdownLabel }}
            </strong>
            后默认准奏方案 {{ ticket.recommendedOption }}
          </span>
          <span
            v-if="recommendedRisk === 'destructive'"
            class="rounded bg-error-container px-1.5 py-0.5 text-[10px] font-semibold text-on-error-container"
          >
            高风险，不会自动执行
          </span>
        </template>
        <span v-else class="font-medium text-tertiary">
          已到时限，正在执行默认裁决…
        </span>
        <button
          type="button"
          :disabled="extending || remainingMs <= 0"
          class="ml-auto shrink-0 rounded-md bg-surface-container-high px-2 py-1 text-[10px] font-medium text-on-surface transition hover:bg-surface-container-highest disabled:opacity-40"
          @click="extend"
        >
          {{ extending ? '延长中…' : '暂缓 10 分钟' }}
        </button>
      </div>

      <div
        v-if="envOffline"
        class="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-error-container/45 px-3 py-2 text-[11px] text-on-error-container ring-1 ring-inset ring-error/15"
      >
        <AlertTriangle :size="14" class="shrink-0" />
        <span class="min-w-0 flex-1">
          端侧 <span class="font-mono">{{ ticket.env }}</span> 已离线，工单可能已无人等待。
        </span>
        <button
          type="button"
          :disabled="cancelling"
          class="shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold transition hover:bg-error/10 disabled:opacity-50"
          @click="requestCancel"
        >
          {{ confirmingCancel ? '再次点击确认取消' : cancelling ? '取消中…' : '取消工单' }}
        </button>
      </div>

      <div class="mt-3.5">
        <label
          :for="`instruction-${ticket.id}`"
          class="flex items-center justify-between px-0.5 text-[11px] text-on-surface-variant"
        >
          <span class="flex items-center gap-1 font-medium text-primary">
            <PenLine :size="13" />
            批红备忘 / 补充指令（选填）
          </span>
          <span class="font-mono text-[10px] text-on-surface-variant/60">
            随审批一起发送
          </span>
        </label>
        <textarea
          :id="`instruction-${ticket.id}`"
          v-model="instruction"
          rows="2"
          maxlength="2000"
          placeholder="例如：先只改登录页，其他页面下个迭代处理"
          class="mt-1.5 w-full resize-none rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface shadow-inner outline-none transition placeholder:text-on-surface-variant/45 focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div class="mt-3 space-y-2">
        <span
          class="block px-0.5 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant"
        >
          抉择分支 · 高风险选项需二次确认
        </span>

        <button
          v-for="option in ticket.options"
          :key="option.key"
          type="button"
          :disabled="submitting"
          class="group flex min-h-[54px] w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-60"
          :class="
            option.risk === 'destructive'
              ? 'border-error/25 bg-error-container/20 shadow-xs hover:bg-error-container/35'
              : isRecommended(option.key)
                ? 'border-primary/20 bg-surface-container shadow-sm hover:bg-surface-container-high'
                : 'border-transparent bg-surface-container-low shadow-xs hover:bg-surface-container'
          "
          @click="approve(option.key)"
        >
          <span class="flex min-w-0 items-center gap-2.5">
            <span
              class="grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[11px] font-bold"
              :class="
                option.risk === 'destructive'
                  ? 'bg-error text-white'
                  : isRecommended(option.key)
                    ? 'bg-primary text-on-primary'
                    : 'bg-surface-container-highest text-on-surface'
              "
            >
              {{ option.key }}
            </span>
            <span class="min-w-0">
              <span
                class="block text-sm font-medium text-on-surface transition group-hover:text-primary"
              >
                {{ option.label }}
              </span>
              <span
                v-if="option.prosCons"
                class="mt-0.5 block text-[11px] leading-5 text-on-surface-variant"
              >
                {{ option.prosCons }}
              </span>
            </span>
          </span>

          <span class="flex shrink-0 items-center gap-2">
            <span
              v-if="option.risk === 'destructive'"
              class="hidden rounded bg-error px-2 py-0.5 text-[10px] font-bold text-white sm:inline"
            >
              高风险
            </span>
            <span
              v-if="isRecommended(option.key)"
              class="hidden rounded bg-primary-container px-2 py-0.5 text-[10px] font-bold text-on-primary shadow-sm sm:inline"
            >
              推荐
            </span>
            <Loader2
              v-if="submitting && pendingKey === option.key"
              :size="15"
              class="animate-spin text-primary"
            />
            <span
              v-else-if="confirmingKey === option.key"
              class="text-[11px] font-semibold text-error"
            >
              再次点击确认
            </span>
            <span v-else class="text-[11px] text-on-surface-variant/70">
              {{ option.risk === 'destructive' ? '确认' : '准奏' }}
            </span>
          </span>
        </button>
      </div>

      <div
        class="mt-3 flex items-center gap-1.5 border-t border-outline-variant/30 pt-2.5 text-[11px] text-on-surface-variant/75"
      >
        <BadgeCheck :size="13" class="text-primary" />
        点击选项即提交审批 · 批红后 Agent 将立即恢复运行 · 高风险选项需二次确认
      </div>
    </div>
  </article>
</template>
