import { computed, reactive, ref } from 'vue';

import type {
  CreateTerminalInput,
  TerminalSession,
} from '@zhunzou/shared';

import { ApiError, hubApi, type HubApi } from '../lib/api';
import { t } from '../lib/i18n';
import { pushToast } from '../lib/toast';
import { useHubStore } from './hub';

const ACTIVE_STATUSES = new Set(['STARTING', 'ACTIVE', 'DETACHED']);

export function createTerminalStore(api: HubApi = hubApi) {
  const hub = useHubStore();
  const sessions = ref<TerminalSession[]>([]);
  const selectedId = ref('');
  const loading = ref(false);
  const creating = ref(false);
  const closingId = ref('');
  const lastError = ref('');

  const selected = computed(
    () => sessions.value.find((session) => session.id === selectedId.value) ?? null,
  );
  const activeSessions = computed(() =>
    sessions.value.filter((session) => ACTIVE_STATUSES.has(session.status)),
  );
  const finishedSessions = computed(() =>
    sessions.value.filter((session) => !ACTIVE_STATUSES.has(session.status)),
  );

  function upsert(session: TerminalSession): void {
    const index = sessions.value.findIndex((item) => item.id === session.id);
    if (index === -1) {
      sessions.value = [session, ...sessions.value];
      return;
    }
    const next = [...sessions.value];
    next[index] = session;
    sessions.value = next;
  }

  function select(id: string): void {
    selectedId.value = id;
  }

  async function load(env?: string): Promise<void> {
    if (!hub.token) return;
    loading.value = true;
    try {
      const response = await api.listTerminals(hub.token, env);
      sessions.value = response.sessions;
      if (
        selectedId.value &&
        !sessions.value.some((session) => session.id === selectedId.value)
      ) {
        selectedId.value = '';
      }
      lastError.value = '';
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        hub.logout(t('store.sessionExpired'));
        return;
      }
      lastError.value = error instanceof Error ? error.message : String(error);
      pushToast(lastError.value || t('terminal.loadFailed'), 'error');
    } finally {
      loading.value = false;
    }
  }

  async function refreshOne(id: string): Promise<void> {
    if (!hub.token) return;
    try {
      const response = await api.getTerminal(hub.token, id);
      upsert(response.session);
    } catch {
      // The list poll / WS will reconcile; ignore a transient miss.
    }
  }

  async function create(input: CreateTerminalInput): Promise<TerminalSession | null> {
    if (!hub.token || creating.value) return null;
    creating.value = true;
    try {
      const response = await api.createTerminal(hub.token, input);
      upsert(response.session);
      selectedId.value = response.session.id;
      pushToast(
        t('terminal.created', { id: response.session.id }),
        'success',
      );
      return response.session;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        hub.logout(t('store.sessionExpired'));
        return null;
      }
      pushToast(
        error instanceof Error ? error.message : t('terminal.createFailed'),
        'error',
      );
      return null;
    } finally {
      creating.value = false;
    }
  }

  async function close(id: string, reason?: string): Promise<boolean> {
    if (!hub.token || closingId.value) return false;
    closingId.value = id;
    try {
      const response = await api.closeTerminal(hub.token, id, reason);
      upsert(response.session);
      pushToast(t('terminal.closed', { id }), 'success');
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        hub.logout(t('store.sessionExpired'));
        return false;
      }
      pushToast(
        error instanceof Error ? error.message : t('terminal.closeFailed'),
        'error',
      );
      return false;
    } finally {
      closingId.value = '';
    }
  }

  return reactive({
    sessions,
    selectedId,
    selected,
    activeSessions,
    finishedSessions,
    loading,
    creating,
    closingId,
    lastError,
    load,
    refreshOne,
    create,
    close,
    select,
    upsert,
  });
}

export type TerminalStore = ReturnType<typeof createTerminalStore>;

let store: TerminalStore | null = null;

export function useTerminalStore(): TerminalStore {
  store ??= createTerminalStore();
  return store;
}
