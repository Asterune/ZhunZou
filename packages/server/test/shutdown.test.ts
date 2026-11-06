import { describe, expect, it } from 'vitest';

import {
  createTestContext,
  sleep,
  ticketInput,
  type TestContext,
} from './helpers.js';

const POLL_MS = 50_000;

/**
 * A deploy bounces the hub while bridges and dashboards are parked in long
 * polls. Closing must answer them instead of holding the port for their
 * windows, and their handlers must still find an open database.
 */
describe('close with held long polls', () => {
  it('answers every parked poll as a timeout', async () => {
    const ctx: TestContext = await createTestContext();
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput(),
      });
      const ticketId = created.json().ticket.id as string;

      const snapshot = await ctx.app.inject({
        method: 'GET',
        url: `/api/sync?after=0&timeout=0`,
        headers: ctx.auth,
      });
      const rev = snapshot.json().rev as number;

      const polls = {
        chat: ctx.app.inject({
          method: 'GET',
          url: `/api/sessions/next?env=company-cursor&timeout=${POLL_MS}`,
          headers: ctx.auth,
        }),
        task: ctx.app.inject({
          method: 'GET',
          url: `/api/tasks/next?env=company-cursor&timeout=${POLL_MS}`,
          headers: ctx.auth,
        }),
        decision: ctx.app.inject({
          method: 'GET',
          url: `/api/tickets/${ticketId}/wait?timeout=${POLL_MS}`,
          headers: ctx.auth,
        }),
        sync: ctx.app.inject({
          method: 'GET',
          url: `/api/sync?after=${rev}&timeout=${POLL_MS}`,
          headers: ctx.auth,
        }),
      };
      await sleep(50);

      const startedAt = Date.now();
      await ctx.app.close();
      const [chat, task, decision, syncState] = await Promise.all([
        polls.chat,
        polls.task,
        polls.decision,
        polls.sync,
      ]);
      const elapsed = Date.now() - startedAt;

      for (const response of [chat, task, decision, syncState]) {
        expect(response.statusCode).toBe(200);
      }
      expect(chat.json()).toMatchObject({ session: null, message: null, timedOut: true });
      expect(task.json()).toMatchObject({ task: null, timedOut: true });
      expect(decision.json()).toMatchObject({ resolved: false, timedOut: true });
      expect(syncState.json()).toMatchObject({ changed: false });
      expect(elapsed).toBeLessThan(POLL_MS / 10);
    } finally {
      await ctx.close();
    }
  });
});
