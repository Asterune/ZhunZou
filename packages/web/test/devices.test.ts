import { describe, expect, it } from 'vitest';

import type { Agent, Device, SyncState } from '@zhunzou/shared';

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

/** A hub whose agents and machines both live in one sync snapshot. */
function fakeHub(state: Partial<SyncState> = {}) {
  const snapshot = {
    envs: [],
    tickets: [],
    tasks: [],
    projects: [],
    agents: [],
    exchanges: [],
    fleetCandidates: [],
    fleetWorkspaces: [],
    devices: [],
    ...state,
  } as SyncState;

  const api = {
    sync: async () => ({ rev: 1, changed: true, state: snapshot }),
    deleteAgent: async (_token: string, env: string) => {
      snapshot.agents = snapshot.agents.filter((item) => item.env !== env);
      // The hub retires a machine card once nothing runs on it.
      snapshot.devices = snapshot.devices
        .map((item) => ({ ...item, envs: item.envs.filter((e) => e !== env) }))
        .filter((item) => item.envs.length);
      return { deleted: true, env };
    },
  } as unknown as HubApi;

  const store = createHubStore(api);
  store.token = 'test-token';
  return { store, snapshot };
}

describe('device registry in the dashboard', () => {
  it('reads machines from the sync snapshot', async () => {
    const { store } = fakeHub({
      agents: [agent('desk-one', 'pc-one'), agent('solo', 'pc-two')],
      devices: [device('pc-one', ['desk-one']), device('pc-two', ['solo'])],
    });

    await store.refresh();

    expect(store.devices.map((item) => item.id)).toEqual(['pc-one', 'pc-two']);
  });

  it('drops a node card when its last agent is deleted', async () => {
    const { store } = fakeHub({
      agents: [agent('desk-one', 'pc-one'), agent('desk-two', 'pc-one')],
      devices: [device('pc-one', ['desk-one', 'desk-two'])],
    });
    await store.refresh();
    expect(store.devices).toHaveLength(1);

    await store.deleteAgent('desk-one');
    expect(store.devices[0]?.envs).toEqual(['desk-two']);

    await store.deleteAgent('desk-two');
    expect(store.devices).toHaveLength(0);
  });

  it('keeps working against a hub that has no device registry', async () => {
    const { store, snapshot } = fakeHub({ agents: [agent('desk-one', null)] });
    delete (snapshot as Partial<SyncState>).devices;

    await store.refresh();

    expect(store.agents).toHaveLength(1);
    expect(store.devices).toEqual([]);
  });
});
