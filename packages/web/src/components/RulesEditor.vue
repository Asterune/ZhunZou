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
import { useI18n } from '../lib/i18n';
import { pushToast } from '../lib/toast';
import { useHubStore } from '../stores/hub';

const store = useHubStore();
const { t } = useI18n();
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
    pushToast(t('rules.copySuccess'), 'success');
    setTimeout(() => (copied.value = false), 1_800);
  } catch {
    pushToast(t('rules.copyFailed'), 'error');
  }
}
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-on-surface-variant">
          <span>{{ t('rules.eyebrow') }}</span>
          <span class="text-outline-variant">·</span>
          <span>{{ t('rules.eyebrowLocal') }}</span>
        </div>
        <h2
          class="mt-0.5 text-xl font-semibold text-on-surface"
          style="font-family: var(--font-serif)"
        >
          {{ t('rules.title') }}
        </h2>
        <p class="mt-1 max-w-2xl text-sm leading-6 text-on-surface-variant">
          {{ t('rules.subtitle') }}
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
                {{ t('rules.candidatesTitle') }}
              </h3>
              <span
                v-if="pendingCandidates.length"
                class="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-bold text-on-secondary"
              >
                {{ pendingCandidates.length }}
              </span>
            </div>
            <p class="truncate text-[11px] text-on-surface-variant">
              {{ t('rules.candidatesSubtitle') }}
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
          {{ t('rules.refresh') }}
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
              <span>{{ t('rules.fromTicket', { id: candidate.ticketId }) }}</span>
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
              {{ t('rules.ignore') }}
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
              {{ t('rules.accept') }}
            </button>
          </div>
        </div>
      </div>

      <p v-else class="px-4 py-4 text-xs leading-5 text-on-surface-variant">
        {{ t('rules.noCandidates') }}
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
                :title="t('rules.unsaved')"
              />
            </div>
            <div class="flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
              <span>{{ t('rules.charsLines', { chars: draft.length, lines: lineCount }) }}</span>
              <span v-if="store.rules?.updatedAt">
                · {{ t('rules.updatedAt', { time: relativeTime(store.rules.updatedAt) }) }}
              </span>
            </div>
          </div>

          <span
            v-if="dirty"
            class="ml-1 flex items-center gap-1.5 rounded-full bg-tertiary-fixed px-2.5 py-1 text-[10px] font-medium text-on-tertiary-fixed"
          >
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-tertiary" />
            {{ t('rules.unsaved') }}
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
            {{ t('rules.reload') }}
          </button>
          <button
            type="button"
            :disabled="!dirty || store.savingRules"
            class="flex h-10 flex-[1.4] items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary shadow-sm transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"
            @click="save"
          >
            <Loader2 v-if="store.savingRules" :size="15" class="animate-spin" />
            <Save v-else :size="15" />
            {{ store.savingRules ? t('rules.saving') : dirty ? t('rules.saveAndApply') : t('rules.saved') }}
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
            {{ copied ? t('rules.copied') : t('rules.copy') }}
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
            :placeholder="t('rules.placeholder')"
            class="h-full w-full resize-none overflow-auto whitespace-pre-wrap border-0 bg-transparent px-3 py-3 font-mono text-[13px] leading-6 text-on-surface outline-none placeholder:text-on-surface-variant/35 sm:whitespace-pre"
            @scroll="syncScroll"
          />
        </div>

        <div
          class="flex flex-wrap items-center justify-between gap-2 bg-surface-container px-3 py-2 text-[11px] text-on-surface-variant"
        >
          <span class="flex items-center gap-1">
            <Sparkles :size="13" class="text-secondary" />
            {{ t('rules.editorHint') }}
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
            {{ t('rules.tipsTitle') }}
          </h3>
          <div class="mt-2.5 space-y-2.5">
            <div class="flex items-start gap-2.5">
              <span class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-secondary">
                <GitBranch :size="15" />
              </span>
              <p class="text-xs leading-5 text-on-tertiary-fixed/85">
                <strong class="font-medium text-on-surface">{{ t('rules.tipContextTitle') }}</strong>
                {{ t('rules.tipContextBody') }}
              </p>
            </div>
            <div class="flex items-start gap-2.5">
              <span class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-tertiary">
                <KeyRound :size="15" />
              </span>
              <p class="text-xs leading-5 text-on-tertiary-fixed/85">
                <strong class="font-medium text-on-surface">{{ t('rules.tipSpecificTitle') }}</strong>
                {{ t('rules.tipSpecificBody') }}
              </p>
            </div>
            <div class="flex items-start gap-2.5">
              <span class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-primary">
                <History :size="15" />
              </span>
              <p class="text-xs leading-5 text-on-tertiary-fixed/85">
                <strong class="font-medium text-on-surface">{{ t('rules.tipBottomTitle') }}</strong>
                {{ t('rules.tipBottomBody') }}
              </p>
            </div>
          </div>
        </div>

        <div class="rounded-xl bg-surface-container-low p-3.5 shadow-sm">
          <h3 class="text-sm font-semibold text-on-surface">{{ t('rules.exampleTitle') }}</h3>
          <ul class="mt-2 space-y-1.5 text-xs leading-5 text-on-surface-variant">
            <li>· {{ t('rules.example1') }}</li>
            <li>· {{ t('rules.example2') }}</li>
            <li>· {{ t('rules.example3') }}</li>
          </ul>
          <p class="mt-2.5 rounded-lg bg-surface-container px-2.5 py-2 text-[11px] leading-5 text-on-surface-variant">
            {{ t('rules.note') }}
          </p>
        </div>
      </aside>
    </div>
  </section>
</template>
