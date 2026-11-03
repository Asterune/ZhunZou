<script setup lang="ts">
import {
  Check,
  Copy,
  FileText,
  GitBranch,
  History,
  KeyRound,
  Lightbulb,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  X,
} from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';

import { relativeTime } from '../lib/format';
import { pushToast } from '../lib/toast';
import { useHubStore } from '../stores/hub';

const store = useHubStore();
const draft = ref('');
const original = ref('');
const copied = ref(false);
const gutter = ref<HTMLElement | null>(null);
const editor = ref<HTMLTextAreaElement | null>(null);

const dirty = computed(() => draft.value !== original.value);
const pendingCandidates = computed(() => store.pendingRuleCandidates);
const lineCount = computed(() => Math.max(1, draft.value.split('\n').length));
const lines = computed(() =>
  Array.from({ length: lineCount.value }, (_, index) => index + 1),
);

watch(
  () => store.rules,
  (rules) => {
    if (!rules) return;
    if (!dirty.value) {
      draft.value = rules.content;
      original.value = rules.content;
    }
  },
  { immediate: true },
);

onMounted(() => {
  void store.loadRules();
  void store.loadRuleCandidates();
});

async function acceptCandidate(candidateId: string): Promise<void> {
  await store.acceptRuleCandidate(candidateId);
}

async function dismissCandidate(candidateId: string): Promise<void> {
  await store.dismissRuleCandidate(candidateId);
}

async function save(): Promise<void> {
  const ok = await store.saveRules(draft.value);
  if (ok) original.value = draft.value;
}

async function reload(): Promise<void> {
  await store.loadRules(true);
  if (store.rules) {
    draft.value = store.rules.content;
    original.value = store.rules.content;
  }
}

function syncScroll(): void {
  if (gutter.value && editor.value) {
    gutter.value.scrollTop = editor.value.scrollTop;
  }
}

async function copyRules(): Promise<void> {
  try {
    await navigator.clipboard.writeText(draft.value);
    copied.value = true;
    pushToast('规则全文已复制', 'success');
    setTimeout(() => (copied.value = false), 1_800);
  } catch {
    pushToast('复制失败，请手动选择文本', 'error');
  }
}
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-on-surface-variant">
          <span>Meta-Agent Policy</span>
          <span class="text-outline-variant">·</span>
          <span>御批枢密章法</span>
        </div>
        <h2
          class="mt-0.5 text-xl font-semibold text-on-surface"
          style="font-family: var(--font-serif)"
        >
          全局工程与架构规范
        </h2>
        <p class="mt-1 max-w-2xl text-sm leading-6 text-on-surface-variant">
          Meta-Agent 预审的唯一依据。保存后立即生效，无需重启服务。
        </p>
      </div>
    </div>

    <div
      class="mb-3 overflow-hidden rounded-xl border border-secondary/20 bg-surface-container-lowest shadow-sm"
    >
      <div
        class="flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant/30 bg-surface-container-high px-4 py-3"
      >
        <div class="flex min-w-0 items-center gap-2.5">
          <span
            class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface text-secondary"
          >
            <Sparkles :size="16" />
          </span>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <h3
                class="truncate text-sm font-semibold text-on-surface"
                style="font-family: var(--font-serif)"
              >
                御前待议 · 批复沉淀
              </h3>
              <span
                v-if="pendingCandidates.length"
                class="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-bold text-on-secondary"
              >
                {{ pendingCandidates.length }}
              </span>
            </div>
            <p class="truncate text-[11px] text-on-surface-variant">
              从人工批复中提炼的候选规则，采纳后立即并入 GLOBAL_RULES.md。
            </p>
          </div>
        </div>
        <button
          type="button"
          :disabled="store.ruleCandidatesLoading"
          class="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-surface-container px-2.5 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:opacity-50"
          @click="store.loadRuleCandidates()"
        >
          <RefreshCw
            :size="13"
            :class="{ 'animate-spin': store.ruleCandidatesLoading }"
          />
          刷新
        </button>
      </div>

      <div
        v-if="pendingCandidates.length"
        class="divide-y divide-outline-variant/25"
      >
        <div
          v-for="candidate in pendingCandidates"
          :key="candidate.id"
          class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <div
              class="flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant"
            >
              <span
                class="rounded bg-surface-container px-1.5 py-0.5 font-mono font-semibold text-on-surface"
              >
                #{{ candidate.id }}
              </span>
              <span>来自工单 #{{ candidate.ticketId }}</span>
              <span class="text-outline-variant">·</span>
              <span>{{ relativeTime(candidate.createdAt) }}</span>
            </div>
            <p class="mt-1 break-words text-sm leading-6 text-on-surface">
              {{ candidate.content }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              type="button"
              :disabled="!!store.ruleCandidateActionId"
              class="flex h-8 items-center gap-1 rounded-lg px-2.5 text-[11px] font-medium text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface disabled:opacity-50"
              @click="dismissCandidate(candidate.id)"
            >
              <X :size="13" />
              忽略
            </button>
            <button
              type="button"
              :disabled="!!store.ruleCandidateActionId"
              class="flex h-8 items-center gap-1 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary shadow-sm transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50"
              @click="acceptCandidate(candidate.id)"
            >
              <Loader2
                v-if="store.ruleCandidateActionId === candidate.id"
                :size="13"
                class="animate-spin"
              />
              <Check v-else :size="13" />
              采纳
            </button>
          </div>
        </div>
      </div>

      <p v-else class="px-4 py-4 text-xs leading-5 text-on-surface-variant">
        暂无候选规则。每次人工批复后，系统会自动提炼一条可复用规范，供你一键采纳。
      </p>
    </div>

    <div class="mb-3 rounded-xl bg-surface-container p-3.5 shadow-sm sm:p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-2.5">
          <span
            class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-container-high text-primary"
          >
            <FileText :size="18" />
          </span>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="truncate font-mono text-[13px] font-semibold text-on-surface">
                GLOBAL_RULES.md
              </span>
              <span
                v-if="dirty"
                class="h-1.5 w-1.5 rounded-full bg-tertiary"
                title="有未保存修改"
              />
            </div>
            <div class="flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
              <span>{{ draft.length }} 字符 / {{ lineCount }} 行</span>
              <span v-if="store.rules?.updatedAt">
                · 更新于 {{ relativeTime(store.rules.updatedAt) }}
              </span>
            </div>
          </div>

          <span
            v-if="dirty"
            class="ml-1 flex items-center gap-1.5 rounded-full bg-tertiary-fixed px-2.5 py-1 text-[10px] font-medium text-on-tertiary-fixed"
          >
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-tertiary" />
            有未保存修改
          </span>
        </div>

        <div class="flex w-full items-center gap-2 sm:w-auto">
          <button
            type="button"
            :disabled="store.rulesLoading"
            class="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-surface-container-high px-3.5 text-xs font-medium text-on-surface transition hover:bg-surface-container-highest disabled:opacity-50 sm:flex-none"
            @click="reload"
          >
            <RefreshCw :size="15" :class="{ 'animate-spin': store.rulesLoading }" />
            重新加载
          </button>
          <button
            type="button"
            :disabled="!dirty || store.savingRules"
            class="flex h-10 flex-[1.4] items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary shadow-sm transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"
            @click="save"
          >
            <Loader2 v-if="store.savingRules" :size="15" class="animate-spin" />
            <Save v-else :size="15" />
            {{ store.savingRules ? '颁行中…' : dirty ? '保存规则并生效' : '已保存' }}
          </button>
        </div>
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]">
      <div class="overflow-hidden rounded-xl border border-outline-variant/35 bg-surface-container-lowest shadow-sm">
        <div
          class="flex items-center justify-between border-b border-outline-variant/30 bg-surface-container-high px-3 py-2"
        >
          <div class="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
            <span class="h-2 w-2 rounded-full bg-outline-variant" />
            <span class="h-2 w-2 rounded-full bg-outline-variant" />
            <span class="h-2 w-2 rounded-full bg-outline-variant" />
            <span class="ml-2 font-mono">MARKDOWN · UTF-8 · LF</span>
          </div>
          <button
            type="button"
            class="flex h-6 items-center gap-1 rounded bg-surface-container px-2 text-[10px] font-medium text-on-surface-variant transition hover:text-on-surface"
            @click="copyRules"
          >
            <Check v-if="copied" :size="12" class="text-secondary" />
            <Copy v-else :size="12" />
            {{ copied ? '已复制' : '复制' }}
          </button>
        </div>

        <div class="flex h-[480px] bg-surface-container-low">
          <div
            ref="gutter"
            class="hidden h-full shrink-0 select-none overflow-hidden border-r border-outline-variant/30 py-3 pl-3 pr-2 text-right font-mono text-[13px] leading-6 text-on-surface-variant/35 sm:block"
          >
            <div v-for="line in lines" :key="line">{{ line }}</div>
          </div>
          <textarea
            ref="editor"
            v-model="draft"
            spellcheck="false"
            placeholder="# 全局工程与架构规范&#10;&#10;1. 非破坏性重构一律采纳推荐方案。&#10;2. 数据库 schema 变更必须人工确认。"
            class="h-full w-full resize-none overflow-auto whitespace-pre-wrap border-0 bg-transparent px-3 py-3 font-mono text-[13px] leading-6 text-on-surface outline-none placeholder:text-on-surface-variant/35 sm:whitespace-pre"
            @scroll="syncScroll"
          />
        </div>

        <div
          class="flex flex-wrap items-center justify-between gap-2 bg-surface-container px-3 py-2 text-[11px] text-on-surface-variant"
        >
          <span class="flex items-center gap-1">
            <Sparkles :size="13" class="text-secondary" />
            保存后 Meta-Agent 立即使用新规则
          </span>
          <span class="font-mono">GLOBAL_RULES.md</span>
        </div>
      </div>

      <aside class="flex flex-col gap-3">
        <div
          class="rounded-xl border border-tertiary/10 bg-tertiary-fixed/45 p-3.5"
        >
          <h3
            class="flex items-center gap-1.5 text-sm font-semibold text-on-tertiary-fixed"
            style="font-family: var(--font-serif)"
          >
            <Lightbulb :size="16" />
            怎么写更省事
          </h3>
          <div class="mt-2.5 space-y-2.5">
            <div class="flex items-start gap-2.5">
              <span class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-secondary">
                <GitBranch :size="15" />
              </span>
              <p class="text-xs leading-5 text-on-tertiary-fixed/85">
                <strong class="font-medium text-on-surface">写清上下文边界。</strong>
                例如 feature/* 可自动放行，main 分支合并必须人工呈批。
              </p>
            </div>
            <div class="flex items-start gap-2.5">
              <span class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-tertiary">
                <KeyRound :size="15" />
              </span>
              <p class="text-xs leading-5 text-on-tertiary-fixed/85">
                <strong class="font-medium text-on-surface">规则越具体，自动放行率越高。</strong>
                模糊的「视情况而定」等于没有规则。
              </p>
            </div>
            <div class="flex items-start gap-2.5">
              <span class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-primary">
                <History :size="15" />
              </span>
              <p class="text-xs leading-5 text-on-tertiary-fixed/85">
                <strong class="font-medium text-on-surface">把底线写死。</strong>
                删除数据、schema 变更、生产配置一律人工确认。
              </p>
            </div>
          </div>
        </div>

        <div class="rounded-xl bg-surface-container-low p-3.5 shadow-sm">
          <h3 class="text-sm font-semibold text-on-surface">示例偏好</h3>
          <ul class="mt-2 space-y-1.5 text-xs leading-5 text-on-surface-variant">
            <li>· 前端状态管理统一 Pinia，禁止 Vuex。</li>
            <li>· 后端优先 Fastify + SQLite，不引入消息队列。</li>
            <li>· 非破坏性重构一律采纳推荐方案。</li>
          </ul>
          <p class="mt-2.5 rounded-lg bg-surface-container px-2.5 py-2 text-[11px] leading-5 text-on-surface-variant">
            这里的修改会直接写入服务器的 GLOBAL_RULES.md，建议纳入版本管理。
          </p>
        </div>
      </aside>
    </div>
  </section>
</template>
