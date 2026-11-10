import { describe, expect, it } from 'vitest';

import type {
  Agent,
  AgentKind,
  EnvHeartbeat,
  SyncState,
  WorkspaceProject,
} from '@zhunzou/shared';

import type { HubApi } from '../src/lib/api';
import { createHubStore } from '../src/stores/hub';

function agent(
  env: string,
  fields: Partial<Agent> & { deviceId?: string | null } = {},
): Agent {
  return {
    env,
    name: env,
    kind: (fields.kind ?? 'cursor') as AgentKind,
    status: 'active',
    online: true,
    hasToken: true,
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  } as Agent;
}

function heartbeat(env: string, projectName?: string): EnvHeartbeat {
  return {
    env,
    status: 'Idle',
    projectName,
    lastSeenAt: 1_700_000_000_000,
    online: true,
  } as EnvHeartbeat;
}

function binding(env: string, projectName: string): WorkspaceProject {
  return {
    id: `${env}-${projectName}`,
    env,
    projectName,
    createdAt: 1,
    updatedAt: 1,
  } as WorkspaceProject;
}

/** A hub that answers one sync snapshot and nothing else. */
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
    ...state,
  } as SyncState;

  const store = createHubStore({
    sync: async () => ({ rev: 1, changed: true, state: snapshot }),
  } as unknown as HubApi);
  store.token = 'test-token';
  return store;
}

describe('machine targets in the dashboard', () => {
  it('collapses the client identities of one machine into a single target', async () => {
    const store = fakeHub({
      agents: [
        agent('company-cursor', { deviceId: 'pc-one' }),
        agent('company-opencode', { deviceId: 'pc-one', kind: 'opencode' }),
      ],
    });
    await store.refresh();

    expect(store.targetMachines).toHaveLength(1);
    expect(store.targetMachines[0]).toMatchObject({
      id: 'pc-one',
      total: 2,
      online: 2,
    });
  });

  it('groups agents that report no device id by hostname', async () => {
    const store = fakeHub({
      agents: [
        agent('cursor-a', { host: 'QideMacBook-Pro.local' }),
        agent('opencode-a', { host: 'qidemacbook-pro', kind: 'opencode' }),
        agent('cursor-b', { host: 'other-box' }),
      ],
    });
    await store.refresh();

    // The label keeps the spelling the machine reported; the key is normalized.
    expect(
      Object.fromEntries(
        store.targetMachines.map((item) => [item.label, item.total]),
      ),
    ).toEqual({
      'other-box': 1,
      'QideMacBook-Pro.local': 2,
    });
  });

  it('tells two machines that report one hostname apart', async () => {
    const store = fakeHub({
      agents: [
        agent('clone-one', { deviceId: 'fp-one', host: 'imaged-box' }),
        agent('clone-two', { deviceId: 'fp-two', host: 'imaged-box' }),
      ],
    });
    await store.refresh();

    const labels = store.targetMachines.map((item) => item.label);
    expect(new Set(labels).size).toBe(2);
  });

  it('folds an offline identity that duplicates a live client type', async () => {
    const store = fakeHub({
      agents: [
        agent('company-cursor', { deviceId: 'pc-one' }),
        agent('company-cursor-2', { deviceId: 'pc-one', online: false }),
        agent('company-opencode', {
          deviceId: 'pc-one',
          kind: 'opencode',
          online: false,
        }),
      ],
    });
    await store.refresh();

    const machine = store.targetMachines[0]!;
    const { visible, ghosts } = store.splitGhostClients(
      store.clientsForMachine(machine),
    );
    // The offline OpenCode duplicates nothing, so it stays a real choice.
    expect(visible.map((item) => item.env)).toEqual([
      'company-cursor',
      'company-opencode',
    ]);
    expect(ghosts.map((item) => item.env)).toEqual(['company-cursor-2']);
  });

  it('keeps every identity when nothing on the machine is online', async () => {
    const store = fakeHub({
      agents: [
        agent('company-cursor', { deviceId: 'pc-one', online: false }),
        agent('company-opencode', {
          deviceId: 'pc-one',
          kind: 'opencode',
          online: false,
        }),
      ],
    });
    await store.refresh();

    const machine = store.targetMachines[0]!;
    const { visible, ghosts } = store.splitGhostClients(
      store.clientsForMachine(machine),
    );
    expect(visible.map((item) => item.env)).toEqual([
      'company-cursor',
      'company-opencode',
    ]);
    expect(ghosts).toEqual([]);
  });

  it('unions the bindings and the open workspaces of a machine', async () => {
    const store = fakeHub({
      agents: [
        agent('company-cursor', { deviceId: 'pc-one' }),
        agent('company-opencode', { deviceId: 'pc-one', kind: 'opencode' }),
      ],
      projects: [binding('company-cursor', 'cursor-erp'), binding('company-opencode', 'pte-dojo')],
      envs: [heartbeat('company-cursor', 'cursor-erp'), heartbeat('company-opencode', 'sandbox')],
    });
    await store.refresh();

    expect(store.projectsForMachine(store.targetMachines[0]!)).toEqual([
      'cursor-erp',
      'pte-dojo',
      'sandbox',
    ]);
  });

  it('offers only the identities that serve the chosen project', async () => {
    const store = fakeHub({
      agents: [
        agent('company-cursor', { deviceId: 'pc-one' }),
        agent('company-opencode', { deviceId: 'pc-one', kind: 'opencode' }),
      ],
      projects: [binding('company-cursor', 'cursor-erp')],
    });
    await store.refresh();

    const machine = store.targetMachines[0]!;
    expect(
      store.clientsForMachine(machine, 'cursor-erp').map((item) => item.env),
    ).toEqual(['company-cursor']);
    expect(store.clientsForMachine(machine, 'unrelated')).toEqual([]);
  });

  it('fills the project list from the machine fleet scan when no client reports one', async () => {
    // Windows Cursor starts the bridge outside the workspace, so the identity
    // has no projectName. The fleet still walked the same folders.
    const store = fakeHub({
      agents: [
        agent('cursor-windows', { deviceId: 'pc-one', host: 'DESKTOP-1' }),
        agent('device-windows', {
          deviceId: 'pc-one',
          kind: 'other',
          host: 'DESKTOP-1',
        }),
      ],
      fleetCandidates: [
        {
          id: 1,
          host: 'DESKTOP-1',
          path: 'C:\\work\\erp-console',
          projectName: 'erp-console',
          env: 'fleet-erp-console',
          associated: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    await store.refresh();

    const machine = store.targetMachines[0]!;
    expect(store.projectsForMachine(machine)).toEqual(['erp-console']);
    expect(
      store.clientsForMachine(machine, 'erp-console').map((item) => item.env),
    ).toEqual(['cursor-windows', 'device-windows']);
  });

  it('lists realtime machines for the terminal and leaves the rest out', async () => {
    const store = fakeHub({
      agents: [
        agent('device-mac', { deviceId: 'pc-one', transport: 'ws' }),
        agent('company-cursor', { deviceId: 'pc-one' }),
        agent('device-old', {
          deviceId: 'pc-two',
          transport: 'ws',
          online: false,
        }),
      ],
    });
    await store.refresh();

    expect(store.realtimeMachines.map((item) => item.id)).toEqual(['pc-one']);
  });
});
