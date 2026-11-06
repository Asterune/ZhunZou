import type { BridgeConfig } from './config.js';
import { HubApiError, type HubApi } from './hub-client.js';
import { HubClient } from './hub-client.js';
import { RealtimeHubClient } from './realtime-client.js';

/**
 * A hub deploy drops the server for a few seconds. Reads and polls have their
 * own loops, but a write-back carries work that cannot be recomputed — an
 * agent's reply, a drafted decision — so it retries until the hub is back.
 */
const WRITE_RETRY_ATTEMPTS = 12;
const WRITE_RETRY_BASE_MS = 1_000;
const WRITE_RETRY_MAX_MS = 20_000;

const RETRYABLE_WRITE_METHODS = [
  'createTicket',
  'decide',
  'appendChatEvent',
  'completeChatMessage',
  'proposeChatReply',
  'reportExchange',
  'reportFleetCandidates',
  'reportFleetWorkspaceStatus',
  'reportFleetBrowseResult',
] as const satisfies readonly (keyof HubApi)[];

type WriteMethod = (typeof RETRYABLE_WRITE_METHODS)[number];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A retry is safe only when replaying is harmless. A response lost after the
 * hub stored the row re-stores an equivalent one (same turn result, same
 * proposal), which beats losing the turn; a rejected state change is surfaced
 * unchanged so callers keep their idempotency guards.
 */
function isRetryable(error: unknown): boolean {
  return error instanceof HubApiError && error.retryable;
}

export function withWriteRetry(
  api: HubApi,
  wait: (ms: number) => Promise<void> = sleep,
): HubApi {
  const retry = <A extends unknown[], R>(
    call: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A) => {
      let delay = WRITE_RETRY_BASE_MS;
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await call(...args);
        } catch (error) {
          if (!isRetryable(error) || attempt >= WRITE_RETRY_ATTEMPTS) throw error;
          await wait(delay);
          delay = Math.min(delay * 2, WRITE_RETRY_MAX_MS);
        }
      }
    };
  };

  const source = api as unknown as Record<
    WriteMethod,
    ((...args: never[]) => Promise<unknown>) | undefined
  >;
  const retried = new Map<string, unknown>();
  for (const name of RETRYABLE_WRITE_METHODS) {
    const call = source[name];
    if (typeof call === 'function') retried.set(name, retry(call.bind(api)));
  }

  return new Proxy(api, {
    get(target, property, receiver) {
      const override = retried.get(property as string);
      if (override) return override;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Wrap the HTTP client so claim/wait calls try the bridge WebSocket first.
 * Any connection or protocol failure falls back to the existing long poll.
 */
export function createHybridHubApi(
  http: HubApi,
  realtime: RealtimeHubClient,
): HubApi {
  const overrides: Partial<HubApi> = {
    nextTask: async (timeoutMs) => {
      try {
        return await realtime.nextTask(timeoutMs);
      } catch {
        return http.nextTask(timeoutMs);
      }
    },
    wait: async (ticketId, timeoutMs) => {
      try {
        return await realtime.wait(ticketId, timeoutMs);
      } catch {
        return http.wait(ticketId, timeoutMs);
      }
    },
    nextChatMessage: async (timeoutMs, runnerId) => {
      // The runner instance id is part of the HTTP contract; the WS chat.claim
      // frame does not carry it yet, so use the long poll when it is set. The
      // hub uses it to recover messages left RUNNING by a replaced runner.
      if (runnerId) return http.nextChatMessage(timeoutMs, runnerId);
      try {
        return await realtime.nextChatMessage(timeoutMs);
      } catch {
        return http.nextChatMessage(timeoutMs);
      }
    },
    close: () => realtime.close(),
  };

  return new Proxy(http, {
    get(target, property, receiver) {
      if (property in overrides) {
        return overrides[property as keyof HubApi];
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createHubApi(config: BridgeConfig): HubApi {
  const http = new HubClient(config);
  const api =
    config.transport === 'http' ? http : createHybridHubApi(http, new RealtimeHubClient(config));
  return withWriteRetry(api);
}
