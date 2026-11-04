<script setup lang="ts">
import { Languages } from 'lucide-vue-next';
import { computed } from 'vue';

import { locale, t, toggleLocale } from '../lib/i18n';

const nextLabel = computed(() => t('app.languageNext'));
</script>

<template>
  <button
    type="button"
    :aria-label="t('app.language')"
    :title="`${t('app.language')} · ${nextLabel}`"
    class="flex h-9 items-center gap-1 rounded-lg px-2 text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface"
    @click="toggleLocale"
  >
    <Languages :size="16" />
    <span class="text-[11px] font-semibold">{{ locale === 'zh' ? 'EN' : '中' }}</span>
  </button>
</template>
