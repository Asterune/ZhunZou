import type { EnvHeartbeat, EnvStatus } from '@zhunzou/shared';

import type { HubApi } from './hub-client.js';

export interface PresenceState {
  status: EnvStatus;
  projectName?: string;
  currentTask?: string;
  note?: string;
}

export interface PresenceReporter {
  /** Send an initial heartbeat and start the keep-alive timer. */
  start(): void;
  /** Stop the keep-alive timer. */
  stop(): void;
  /** Pause the timer while a long-poll request is in flight. */
  pause(): void;
  /** Resume the timer after a long-poll request. */
  resume(): void;
  /** Update the local state and send a heartbeat immediately. */
  beat(patch: Partial<PresenceState>): Promise<EnvHeartbeat>;
}

export interface PresenceOptions {
  intervalMs: number;
  /** Project name reported with every heartbeat so the dashboard can bind it. */
  projectName?: string;
  onError?: (error: unknown) => void;
}

function payloadOf(state: PresenceState) {
  return {
    status: state.status,
    ...(state.projectName ? { projectName: state.projectName } : {}),
    ...(state.currentTask ? { currentTask: state.currentTask } : {}),
    ...(state.note ? { note: state.note } : {}),
  };
}

/**
 * Keeps the dashboard's env card online while the MCP process is connected.
 * Without this, status would only update on escalate/notify_done and the
 * dashboard would show "offline" after 90 seconds of agent thinking.
 */
export function createPresenceReporter(
  client: HubApi,
  options: PresenceOptions,
): PresenceReporter {
  let state: PresenceState = {
    status: 'Idle',
    ...(options.projectName ? { projectName: options.projectName } : {}),
    currentTask: 'MCP 已连接',
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;

  const send = () => client.heartbeat(payloadOf(state));

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const startTimer = () => {
    if (timer !== null || paused) return;
    timer = setInterval(() => {
      void send().catch((error: unknown) => options.onError?.(error));
    }, options.intervalMs);
    timer.unref?.();
  };

  return {
    start() {
      paused = false;
      void send().catch((error: unknown) => options.onError?.(error));
      startTimer();
    },
    stop() {
      paused = true;
      stopTimer();
    },
    pause() {
      paused = true;
      stopTimer();
    },
    resume() {
      paused = false;
      void send().catch((error: unknown) => options.onError?.(error));
      startTimer();
    },
    async beat(patch) {
      state = { ...state, ...patch };
      return send();
    },
  };
}
