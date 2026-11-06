import { describe, expect, it, vi } from 'vitest';

import type { HubApi } from '../src/hub-client.js';
import { HubApiError } from '../src/hub-client.js';
import type { RealtimeHubClient } from '../src/realtime-client.js';
import { createHybridHubApi, withWriteRetry } from '../src/hub.js';

const empty = { session: null, message: null, timedOut: true };

function fakes() {
  const http = {
    nextChatMessage: vi.fn(async () => empty),
  } as unknown as HubApi;
  const realtime = {
    nextChatMessage: vi.fn(async () => empty),
    close: vi.fn(),
  } as unknown as RealtimeHubClient;
  return { http, realtime };
}

describe('hybrid hub transport', () => {
  it('keeps chat claims on HTTP when a runner id is present', async () => {
    const { http, realtime } = fakes();
    const api = createHybridHubApi(http, realtime);

    await api.nextChatMessage(1_000, 'runner-1');

    // The WS chat.claim frame has no runner id, so using it would hide the
    // restart from the hub and leave the previous turn RUNNING forever.
    expect(http.nextChatMessage).toHaveBeenCalledWith(1_000, 'runner-1');
    expect(realtime.nextChatMessage).not.toHaveBeenCalled();
  });

  it('still uses the realtime socket when no runner id is supplied', async () => {
    const { http, realtime } = fakes();
    const api = createHybridHubApi(http, realtime);

    await api.nextChatMessage(1_000);

    expect(realtime.nextChatMessage).toHaveBeenCalledWith(1_000);
    expect(http.nextChatMessage).not.toHaveBeenCalled();
  });
});

describe('write-back retry', () => {
  it('rides out a hub restart instead of dropping the answer', async () => {
    const completeChatMessage = vi
      .fn()
      .mockRejectedValueOnce(new HubApiError(0, 'NETWORK_ERROR', 'Connection refused'))
      .mockRejectedValueOnce(new HubApiError(502, 'HTTP_502', 'Bad Gateway'))
      .mockResolvedValue({ ok: true });
    const api = withWriteRetry(
      { completeChatMessage } as unknown as HubApi,
      async () => undefined,
    );

    await expect(api.completeChatMessage('1', '2', { status: 'DONE' })).resolves.toEqual({
      ok: true,
    });
    expect(completeChatMessage).toHaveBeenCalledTimes(3);
  });

  it('stops at the first answer a restart never reached', async () => {
    const proposeChatReply = vi
      .fn()
      .mockRejectedValue(new HubApiError(400, 'SESSION_CLOSED', 'closed'));
    const api = withWriteRetry(
      { proposeChatReply } as unknown as HubApi,
      async () => undefined,
    );

    await expect(
      api.proposeChatReply({ content: '草稿' } as never),
    ).rejects.toBeInstanceOf(HubApiError);
    expect(proposeChatReply).toHaveBeenCalledTimes(1);
  });

  it('leaves polls and heartbeats to their own loops', async () => {
    const heartbeat = vi
      .fn()
      .mockRejectedValue(new HubApiError(0, 'NETWORK_ERROR', 'down'));
    const api = withWriteRetry({ heartbeat } as unknown as HubApi, async () => {
      throw new Error('should not wait');
    });

    await expect(api.heartbeat({ status: 'Idle' } as never)).rejects.toBeInstanceOf(
      HubApiError,
    );
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});
