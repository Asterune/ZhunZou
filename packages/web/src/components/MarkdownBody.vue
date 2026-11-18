<script setup lang="ts">
import { computed } from 'vue';

import { renderMarkdown } from '../lib/markdown';

const props = defineProps<{
  content: string;
}>();

// markdown-it runs with `html: false`, so any raw HTML in the agent's answer
// stays escaped text instead of becoming markup.
const html = computed(() => renderMarkdown(props.content));
</script>

<template>
  <div class="markdown-body" v-html="html" />
</template>
