<script setup lang="ts">
import { Bot, Clock, Folder } from 'lucide-vue-next';
import { computed } from 'vue';

import {
  ENV_STATUS_LABELS,
  envBadgeClass,
  envDotClass,
  relativeTime,
} from '../lib/format';
import { useHubStore } from '../stores/hub';

const store = useHubStore();
const envs = computed(() => store.envs);
const disabledEnvs = computed(
  () =>
    new Set(
      store.agents
        .filter((agent) => agent.status === 'disabled')
        .map((agent) => agent.env),
    ),
);
const onlineCount = computed(
  () =>
    envs.value.filter(
      (env) => env.online && !disabledEnvs.value.has(env.env),
    ).length,
);
const isDisabled = (env: { env: string }): boolean =>
  disabledEnvs.value.has(env.env);
</script>

<template>
  <section class="mb-6">
    <div class="mb-2.5 flex items-center justify-between px-0.5">
      <div class="flex items-center gap-2">
        <span class="h-3.5 w-1.5 rounded-full bg-primary" />
        <h2
          class="text-base font-semibold text-on-surface"
          style="font-family: var(--font-serif)"
        >
          环境状态卷轴
        </h2>
        <span class="text-[11px] text-on-surface-variant/70">
          {{ onlineCount }} / {{ envs.length }} 在线
        </span>
      </div>
      <span class="flex items-center gap-1 text-[11px] font-medium text-secondary">
        <span class="h-1.5 w-1.5 rounded-full bg-secondary" />
        自动轮询中
      </span>
    </div>

    <div
      v-if="envs.length"
      class="scrollbar-none -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 md:grid md:grid-cols-[repeat(auto-fit,minmax(240px,1fr))] md:overflow-visible"
    >
      <article
        v-for="env in envs"
        :key="env.env"
        class="min-w-[248px] flex-1 rounded-xl border border-outline-variant/35 bg-surface-container-low p-3.5 shadow-sm md:min-w-0"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="relative flex h-2 w-2">
                <span
                  v-if="env.online && env.status === 'Blocked'"
                  class="absolute inline-flex h-full w-full animate-ping rounded-full bg-tertiary opacity-60"
                />
                <span
                  class="relative inline-flex h-2 w-2 rounded-full"
                  :class="isDisabled(env) ? 'bg-outline' : envDotClass(env)"
                />
              </span>
              <span class="truncate font-mono text-[13px] font-semibold text-on-surface">
                {{ env.env }}
              </span>
            </div>
            <p class="mt-0.5 truncate text-[11px] text-on-surface-variant/70">
              <Bot :size="11" class="mr-0.5 inline" />
              {{ env.projectName || '未命名项目' }}
            </p>
          </div>

          <span
            class="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold"
            :class="
              isDisabled(env)
                ? 'bg-surface-container-high text-on-surface-variant'
                : envBadgeClass(env)
            "
          >
            {{
              isDisabled(env)
                ? '已停用'
                : env.online
                  ? ENV_STATUS_LABELS[env.status]
                  : '离线'
            }}
          </span>
        </div>

        <div class="mt-2 rounded-lg bg-surface-container px-2.5 py-2">
          <p class="flex items-center gap-1 text-[11px] text-on-surface-variant">
            <Folder :size="12" />
            <span class="truncate font-mono">{{ env.projectName || '—' }}</span>
          </p>
          <p class="mt-0.5 truncate text-xs leading-5 text-on-surface">
            {{ env.currentTask || '暂无活跃任务' }}
          </p>
        </div>

        <div
          class="mt-2 flex items-center justify-between text-[11px] text-on-surface-variant/80"
        >
          <span class="flex items-center gap-1">
            <Clock :size="11" />
            心跳 {{ relativeTime(env.lastSeenAt) }}
          </span>
          <span v-if="env.status === 'Blocked'" class="font-mono text-primary">
            等待审批
          </span>
        </div>
      </article>
    </div>

    <p
      v-else
      class="rounded-xl border border-dashed border-outline-variant bg-surface-container-low/60 px-4 py-5 text-sm text-on-surface-variant"
    >
      暂无接入端心跳。启动 Cursor / OpenCode 后会自动出现在这里。
    </p>
  </section>
</template>
