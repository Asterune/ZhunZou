import { beforeEach, describe, expect, it } from 'vitest';

import type { RuleCandidate, SyncState } from '@zhunzou/shared';

import type { HubApi } from '../src/lib/api';
import { candidateForTicket } from '../src/lib/history';
import { useToasts } from '../src/lib/toast';
import { createHubStore } from '../src/stores/hub';

const T0 = 1_700_000_000_000;

function candidate(
  id: string,
  ticketId: string,
  overrides: Partial<RuleCandidate> = {},
): RuleCandidate {
  return {
    id,
    ticketId,
    content: '改数据库迁移前必须先跑一遍测试。',
    status: 'PENDING',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as RuleCandidate;
}

function fakeHub(handlers: Partial<HubApi> = {}) {
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
  } as SyncState;

  const api = {
    sync: async () => ({ rev: 1, changed: true, state: snapshot }),
    ...handlers,
  } as unknown as HubApi;

  const store = createHubStore(api);
  store.token = 'test-token';
  return { store };
}

const { toasts, dismissToast } = useToasts();

beforeEach(() => {
  for (const toast of [...toasts.value]) dismissToast(toast.id);
});

describe('candidateForTicket', () => {
  const candidates = [candidate('7', '41'), candidate('8', '42')];

  it('T1: finds the rule distilled from a decision', () => {
    expect(candidateForTicket(candidates, '42')?.id).toBe('8');
  });

  it('T2: gives nothing when the distiller has not written one', () => {
    expect(candidateForTicket(candidates, '43')).toBeUndefined();
    expect(candidateForTicket([], '41')).toBeUndefined();
  });
});

describe('remembering a rule from the history page', () => {
  it('T3: accepting a candidate takes its chip off the resolved decision', async () => {
    const accepted: string[] = [];
    const { store } = fakeHub({
      listRuleCandidates: async () => ({
        candidates: [candidate('7', '41'), candidate('8', '42')],
      }),
      acceptRuleCandidate: async (_token, candidateId) => {
        accepted.push(candidateId);
        return {
          candidate: candidate(candidateId, candidateId === '7' ? '41' : '42', {
            status: 'ACCEPTED',
            updatedAt: T0 + 1,
          }),
          rules: { content: '', path: '/etc/GLOBAL_RULES.md', bytes: 0, updatedAt: T0 },
        };
      },
    });

    await store.loadRuleCandidates();
    expect(candidateForTicket(store.pendingRuleCandidates, '41')?.id).toBe('7');

    await expect(store.acceptRuleCandidate('7')).resolves.toBe(true);

    expect(accepted).toEqual(['7']);
    expect(candidateForTicket(store.pendingRuleCandidates, '41')).toBeUndefined();
    // The other decision keeps its handle.
    expect(candidateForTicket(store.pendingRuleCandidates, '42')?.id).toBe('8');
  });
});
