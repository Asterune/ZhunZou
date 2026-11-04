<script setup lang="ts">
import {
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ShieldCheck,
} from 'lucide-vue-next';
import { ref } from 'vue';

import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';
import LocaleToggle from './LocaleToggle.vue';

const store = useHubStore();
const { t } = useI18n();
const tokenInput = ref('');
const showToken = ref(false);

async function submit(): Promise<void> {
  await store.login(tokenInput.value);
}
</script>

<template>
  <div
    class="paper-grain relative flex min-h-screen flex-col bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
  >
    <div class="absolute right-4 top-4 z-10">
      <LocaleToggle />
    </div>
    <main class="flex flex-1 items-center justify-center px-4 py-10">
      <div class="w-full max-w-sm">
        <div
          class="mb-6 flex items-center justify-center gap-3 text-[11px] font-medium uppercase tracking-[0.18em] text-tertiary/70"
        >
          <span class="h-px w-8 bg-outline-variant" />
          <span>{{ t('login.eyebrow') }}</span>
          <span class="h-px w-8 bg-outline-variant" />
        </div>

        <form
          class="relative overflow-hidden rounded-2xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-[0_18px_50px_-28px_rgba(30,27,25,0.35)] sm:p-8"
          @submit.prevent="submit"
        >
          <div
            class="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-primary-fixed/40 blur-2xl"
          />

          <div class="relative flex flex-col items-center">
            <div
              class="grid h-16 w-16 rotate-[-1deg] place-items-center rounded-xl bg-primary text-3xl font-bold text-on-primary shadow-[0_6px_20px_-8px_rgba(147,0,11,0.55)]"
              style="font-family: var(--font-serif)"
            >
              {{ t('app.mark') }}
            </div>

            <h1
              class="mt-4 text-3xl font-semibold tracking-tight text-on-surface"
              style="font-family: var(--font-serif)"
            >
              {{ t('login.title') }}
            </h1>
            <p class="mt-1 flex items-center gap-2 text-sm text-on-surface-variant">
              <span>{{ t('login.subtitle') }}</span>
              <span class="h-1 w-1 rounded-full bg-primary" />
              <span
                class="tracking-wide text-primary"
                style="font-family: var(--font-serif)"
              >
                {{ t('login.subtitleAccent') }}
              </span>
            </p>
          </div>

          <div class="mt-7">
            <label
              for="hub-token"
              class="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-on-surface-variant"
            >
              <KeyRound :size="13" class="text-primary" />
              {{ t('login.tokenLabel') }}
            </label>

            <div class="relative mt-2">
              <input
                id="hub-token"
                v-model="tokenInput"
                :type="showToken ? 'text' : 'password'"
                autocomplete="current-password"
                :placeholder="t('login.tokenPlaceholder')"
                class="h-11 w-full rounded-lg bg-surface-container-low pl-3.5 pr-11 font-mono text-sm text-on-surface shadow-inner outline-none transition placeholder:text-on-surface-variant/45 focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="button"
                :aria-label="showToken ? t('login.hideToken') : t('login.showToken')"
                class="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-on-surface-variant transition hover:bg-surface-container hover:text-primary"
                @click="showToken = !showToken"
              >
                <EyeOff v-if="showToken" :size="18" />
                <Eye v-else :size="18" />
              </button>
            </div>

            <p
              v-if="store.authError"
              class="mt-2 flex items-start gap-2 rounded-lg bg-error-container px-3 py-2 text-xs leading-5 text-on-error-container"
              role="alert"
            >
              <span class="mt-0.5 shrink-0 font-bold">!</span>
              <span>{{ store.authError }}</span>
            </p>
          </div>

          <button
            type="submit"
            :disabled="store.authenticating || !tokenInput.trim()"
            class="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-base font-medium tracking-wide text-on-primary shadow-sm transition hover:bg-primary-container active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Loader2 v-if="store.authenticating" :size="19" class="animate-spin" />
            <ShieldCheck v-else :size="19" />
            {{ store.authenticating ? t('login.submitting') : t('login.submit') }}
          </button>

          <p class="mt-3 text-center text-[11px] leading-5 text-on-surface-variant/80">
            {{ t('login.tokenHintBefore') }}
            <code class="rounded bg-surface-container px-1 py-0.5 font-mono text-[10px] text-on-surface">
              HUB_SECRET_TOKEN
            </code>
            {{ t('login.tokenHintAfter') }}
          </p>
        </form>

        <div
          class="mt-4 flex items-start gap-2.5 rounded-xl bg-surface-container-low px-3.5 py-3 text-[11px] leading-5 text-on-surface-variant shadow-sm"
        >
          <span
            class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary-container text-on-secondary-container"
          >
            <ShieldCheck :size="12" />
          </span>
          <p>
            <strong class="font-medium text-on-surface">{{ t('login.securityTitle') }}</strong>
            {{ t('login.securityBody') }}
          </p>
        </div>

        <p class="mt-6 text-center text-[11px] tracking-wide text-outline">
          {{ t('login.footer') }}
        </p>
      </div>
    </main>
  </div>
</template>
