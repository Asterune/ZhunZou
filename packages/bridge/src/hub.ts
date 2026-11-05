import type { BridgeConfig } from './config.js';
import type { HubApi } from './hub-client.js';
import { HubClient } from './hub-client.js';
import { RealtimeHubClient } from './realtime-client.js';

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
    nextChatMessage: async (timeoutMs) => {
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
  if (config.transport === 'http') return http;
  return createHybridHubApi(http, new RealtimeHubClient(config));
}
