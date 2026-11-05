<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { TerminalSession } from '@zhunzou/shared';

import { hubApi } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useHubStore } from '../stores/hub';

const props = defineProps<{ session: TerminalSession }>();
const emit = defineEmits<{
  (event: 'closed', sessionId: string): void;
  (event: 'updated', session: TerminalSession): void;
}>();

const hub = useHubStore();
const { t } = useI18n();
const container = ref<HTMLDivElement | null>(null);
const status = ref<'connecting' | 'online' | 'offline'>('connecting');
const errorText = ref('');
const viewerId = ref('');
const writerId = ref<string | null>(null);

const readOnly = computed(
  () => Boolean(writerId.value && writerId.value !== viewerId.value),
);
const canWrite = computed(
  () => Boolean(viewerId.value && writerId.value === viewerId.value),
);

const keyBar = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl+C', data: '\x03' },
  { label: 'Ctrl+D', data: '\x04' },
  { label: 'Ctrl+Z', data: '\x1a' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '→', data: '\x1b[C' },
  { label: '←', data: '\x1b[D' },
  { label: '|', data: '|' },
  { label: '~', data: '~' },
  { label: '/', data: '/' },
] as const;

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let socket: WebSocket | null = null;
let resizeObserver: ResizeObserver | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
let lastSeq = 0;
let attempts = 0;

function wsUrl(ticket: string): string {
  const protocol = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = globalThis.location?.host ?? '127.0.0.1:8787';
  const params = new URLSearchParams({
    sessionId: props.session.id,
    ticket,
    afterSeq: String(lastSeq),
  });
  return `${protocol}//${host}/ws/terminal?${params.toString()}`;
}

function send(frame: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

function sendInput(data: string): void {
  if (!canWrite.value) {
    if (readOnly.value) errorText.value = t('terminal.readOnlyHint');
    return;
  }
  send({ type: 'terminal.input', data });
}

function claimControl(): void {
  const label =
    globalThis.navigator?.platform?.slice(0, 40) ||
    t('terminal.thisWindow');
  send({ type: 'terminal.claim', label });
}

function releaseControl(): void {
  send({ type: 'terminal.release' });
}

function sendKey(data: string): void {
  sendInput(data);
}

function fit(): void {
  try {
    fitAddon?.fit();
    if (term && canWrite.value) {
      send({ type: 'terminal.resize', cols: term.cols, rows: term.rows });
    }
  } catch {
    // The container can briefly have zero size during a tab switch.
  }
}

async function connect(): Promise<void> {
  if (disposed || !hub.token) return;
  status.value = 'connecting';
  errorText.value = '';

  let ticket: string;
  try {
    const response = await hubApi.createRealtimeTicket(hub.token);
    ticket = response.ticket;
  } catch (error) {
    status.value = 'offline';
    errorText.value = error instanceof Error ? error.message : String(error);
    scheduleReconnect();
    return;
  }

  const ws = new WebSocket(wsUrl(ticket));
  socket = ws;

  ws.addEventListener('open', () => {
    attempts = 0;
    status.value = 'online';
    errorText.value = '';
    fit();
  });

  ws.addEventListener('message', (event) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (frame.type) {
      case 'terminal.ready':
        viewerId.value = String(frame.viewerId ?? '');
        writerId.value =
          typeof frame.writerId === 'string' ? frame.writerId : null;
        if (frame.session) emit('updated', frame.session as TerminalSession);
        status.value = 'online';
        fit();
        break;
      case 'terminal.control':
        writerId.value =
          typeof frame.writerId === 'string' ? frame.writerId : null;
        if (canWrite.value) {
          errorText.value = '';
          fit();
        }
        break;
      case 'terminal.updated':
        if (frame.session) emit('updated', frame.session as TerminalSession);
        break;
      case 'terminal.output':
        if (typeof frame.data === 'string') {
          term?.write(frame.data);
          if (typeof frame.seq === 'number') lastSeq = frame.seq;
        }
        break;
      case 'terminal.exit':
        term?.write(
          `\r\n\x1b[90m[${t('terminal.exited')}${frame.code !== null ? ` (${frame.code})` : ''}]\x1b[0m\r\n`,
        );
        status.value = 'offline';
        emit('closed', props.session.id);
        break;
      case 'terminal.error':
        errorText.value = String(frame.message ?? frame.code ?? 'terminal error');
        if (frame.code !== 'READ_ONLY' && frame.code !== 'RATE_LIMITED') {
          status.value = 'offline';
        }
        term?.write(`\r\n\x1b[31m${errorText.value}\x1b[0m\r\n`);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  });

  ws.addEventListener('close', () => {
    if (socket === ws) socket = null;
    if (disposed) return;
    status.value = 'offline';
    viewerId.value = '';
    writerId.value = null;
    if (
      !socket &&
      (props.session.status === 'ACTIVE' ||
        props.session.status === 'STARTING' ||
        props.session.status === 'DETACHED')
    ) {
      scheduleReconnect();
    }
  });

  ws.addEventListener('error', () => {
    if (!disposed) status.value = 'offline';
  });
}

function scheduleReconnect(): void {
  if (disposed || reconnectTimer) return;
  const delay = Math.min(10_000, 500 * 2 ** Math.min(attempts, 5));
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

onMounted(() => {
  if (!container.value) return;

  term = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily:
      'JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.25,
    scrollback: 5_000,
    theme: {
      background: '#12100e',
      foreground: '#f4ece8',
      cursor: '#e8c9a0',
      selectionBackground: '#5b403d',
      black: '#1e1b19',
      red: '#ff8a80',
      green: '#8fd6b0',
      yellow: '#f0c674',
      blue: '#8ab4f8',
      magenta: '#d7a6ff',
      cyan: '#8fd6d0',
      white: '#f4ece8',
    },
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container.value);
  fitAddon.fit();

  term.onData((data) => sendInput(data));
  term.onResize(({ cols, rows }) => {
    if (canWrite.value) send({ type: 'terminal.resize', cols, rows });
  });

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(container.value);
  }
  window.addEventListener('focus', fit);
  void connect();
});

onBeforeUnmount(() => {
  disposed = true;
  clearReconnect();
  resizeObserver?.disconnect();
  window.removeEventListener('focus', fit);
  socket?.close(1000, 'viewer disconnected');
  socket = null;
  term?.dispose();
  term = null;
  fitAddon = null;
});

watch(
  () => props.session.id,
  () => {
    lastSeq = 0;
    viewerId.value = '';
    writerId.value = null;
    term?.reset();
    term?.clear();
    socket?.close(1000, 'session switched');
    socket = null;
    clearReconnect();
    void connect();
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex items-center justify-between gap-2 border-b border-outline-variant/30 px-3 py-1.5">
      <div class="flex min-w-0 items-center gap-2 text-[11px] text-on-surface-variant">
        <span
          class="h-1.5 w-1.5 rounded-full"
          :class="
            status === 'online'
              ? 'bg-secondary'
              : status === 'connecting'
                ? 'bg-tertiary'
                : 'bg-outline'
          "
        />
        <span class="truncate">
          {{ status === 'online' ? t('terminal.connected') : status === 'connecting' ? t('terminal.connecting') : t('terminal.disconnected') }}
        </span>
        <span v-if="errorText" class="truncate text-error">· {{ errorText }}</span>
        <span
          v-if="readOnly"
          class="shrink-0 rounded bg-tertiary-fixed px-1.5 py-0.5 text-[10px] font-medium text-on-tertiary-fixed"
        >
          {{ t('terminal.readOnly') }}
        </span>
      </div>
      <div class="flex items-center gap-1">
        <button
          v-if="!canWrite && viewerId"
          type="button"
          class="rounded px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10"
          @click="claimControl"
        >
          {{ t('terminal.takeControl') }}
        </button>
        <button
          v-else-if="canWrite"
          type="button"
          class="rounded px-2 py-1 text-[11px] font-medium text-on-surface-variant hover:bg-surface-container"
          @click="releaseControl"
        >
          {{ t('terminal.releaseControl') }}
        </button>
        <button
          type="button"
          class="rounded px-2 py-1 text-[11px] font-medium text-on-surface-variant hover:bg-surface-container"
          @click="socket?.close(); void connect();"
        >
          {{ t('terminal.reconnect') }}
        </button>
      </div>
    </div>
    <div
      class="flex flex-wrap gap-1 border-b border-outline-variant/20 bg-surface-container-low px-2 py-1 lg:hidden"
    >
      <button
        v-for="key in keyBar"
        :key="key.label"
        type="button"
        class="min-h-8 min-w-9 rounded border border-outline-variant/40 bg-surface px-2 text-[11px] font-medium text-on-surface-variant disabled:opacity-40"
        :disabled="!canWrite"
        @click="sendKey(key.data)"
      >
        {{ key.label }}
      </button>
    </div>
    <div
      ref="container"
      class="min-h-[320px] flex-1 overflow-hidden bg-[#12100e] px-2 py-1"
    />
  </div>
</template>
