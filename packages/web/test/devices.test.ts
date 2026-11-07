import { describe, expect, it } from 'vitest';

import type { Agent, Device } from '@zhunzou/shared';

import type { HubApi } from '../src/lib/api';
import { createHubStore } from '../src/stores/hub';

function agent(env: string, deviceId: string | null): Agent {
  return {
    env,
    name: env,
    kind: 'cursor',
    status: 'active',
    online: true,
    deviceId,
    lastSeenAt: 1_700_000_000_000,
  } as Agent;
}

function device(id: string, envs: string[]): Device {
  return {
    id,
    host: id,
    online: envs.length > 0,
    envs,
    createdAt: 1,
    updatedAt: 1,
  } as Device;
}

/** A hub whose agents and machines both live in memory. */
function fakeHub(agents: Agent[], devices: Device[]) {
  const state = { agents: [...agents], devices: [...devices], deviceCalls: 0 };

  const api = {
    listAgents: async () => ({ agents: [...state.agents] }),
    listDevices: async () => {
      state.deviceCalls += 1;
      return { devices: [...state.devices] };
    },
    deleteAgent: async (_token: string, env: string) => {
      state.agents = state.agents.filter((item) => item.env !== env);
      state.devices = state.devices
        .map((item) => ({ ...item, envs: item.envs.filter((e) => e !== env) }))
        .filter((item) => item.envs.length);
      return { deleted: true, env };
    },
  } as unknown as HubApi;

  const store = createHubStore(api);
  store.token = 'test-token';
  return { store, state };
}

describe('device registry in the dashboard', () => {
  it('loads machines alongside the agent list', async () => {
    const { store } = fakeHub(
      [agent('desk-one', 'pc-one'), agent('solo', 'pc-two')],
      [device('pc-one', ['desk-one']), device('pc-two', ['solo'])],
    );

    await store.loadAgents();

    expect(store.devices.map((item) => item.id)).toEqual(['pc-one', 'pc-two']);
  });

  it('drops a node card when its last agent is deleted', async () => {
    const { store, state } = fakeHub(
      [agent('desk-one', 'pc-one'), agent('desk-two', 'pc-one')],
      [device('pc-one', ['desk-one', 'desk-two'])],
    );
    await store.loadAgents();
    expect(store.devices).toHaveLength(1);

    await store.deleteAgent('desk-one');
    expect(store.devices[0]?.envs).toEqual(['desk-two']);

    await store.deleteAgent('desk-two');
    expect(store.devices).toHaveLength(0);
    expect(state.deviceCalls).toBe(3);
  });

  it('keeps working against a hub that has no device registry', async () => {
    const store = createHubStore({
      listAgents: async () => ({ agents: [agent('desk-one', null)] }),
      listDevices: async () => {
        throw new Error('404');
      },
    } as unknown as HubApi);
    store.token = 'test-token';

    await store.loadAgents();

    expect(store.agents).toHaveLength(1);
    expect(store.devices).toEqual([]);
  });
});
