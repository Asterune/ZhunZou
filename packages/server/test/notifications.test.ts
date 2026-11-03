import { describe, expect, it, vi } from 'vitest';

import type { DecisionTicket } from '@zhunzou/shared';

import type { NotificationChannelConfig } from '../src/config.js';
import {
  buildNotificationMessage,
  buildWebhookPayload,
  createNotifiers,
  notifyTicketPendingHuman,
  type NotifierLogger,
} from '../src/notifications.js';

const ticket: DecisionTicket = {
  id: '104',
  env: 'company-cursor',
  projectName: 'yikuaomed-erp',
  status: 'PENDING_HUMAN',
  doneSummary: '完成登录页',
  blockerQuestion: 'Toast 还是行内？',
  nextStepPlan: '接入错误处理',
  options: [
    { key: 'A', label: 'Toast' },
    { key: 'B', label: '行内' },
  ],
  recommendedOption: 'A',
  createdAt: 1,
  updatedAt: 1,
};

function logger(): NotifierLogger {
  return { info: vi.fn(), warn: vi.fn() };
}

interface Captured {
  url: string;
  headers: Headers;
  body: string;
}

function captureFetch(): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ''),
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function sendOne(
  channel: NotificationChannelConfig,
  approvalUrl?: string,
): Promise<Captured> {
  const { fetchImpl, calls } = captureFetch();
  const [notifier] = createNotifiers([channel], logger(), { fetchImpl });
  await notifier!.send(buildNotificationMessage(ticket, approvalUrl));
  return calls[0]!;
}

describe('notification message', () => {
  it('contains the three-line brief, options and ticket id', () => {
    const message = buildNotificationMessage(ticket);
    expect(message.title).toContain('#104');
    expect(message.text).toContain('完成登录页');
    expect(message.text).toContain('Toast 还是行内');
    expect(message.text).toContain('选项：A. Toast / B. 行内');
    expect(buildWebhookPayload(ticket)).toMatchObject({
      type: 'ticket.pending_human',
      ticket,
    });
  });

  it('includes a signed approval link when provided', () => {
    const url = 'https://hub.example.com/a/104.999.deadbeef';
    const message = buildNotificationMessage(ticket, url);

    expect(message.text).toContain(`一键审批：${url}`);
    expect(buildWebhookPayload(ticket, url)).toMatchObject({
      approvalUrl: url,
    });
    expect(message.approvalUrl).toBe(url);
  });
});

describe('notification channels', () => {
  it('posts a signed generic webhook', async () => {
    const call = await sendOne({
      type: 'webhook',
      url: 'https://hooks.example/hub',
      secret: 's3cret',
    });

    expect(call.url).toBe('https://hooks.example/hub');
    expect(call.headers.get('x-webhook-secret')).toBe('s3cret');
    expect(JSON.parse(call.body).type).toBe('ticket.pending_human');
  });

  it('formats Bark, Feishu, Slack and Discord payloads', async () => {
    const bark = await sendOne(
      { type: 'bark', url: 'https://api.day.app/key' },
      'https://hub.example.com/a/xxx',
    );
    expect(JSON.parse(bark.body)).toMatchObject({
      group: 'zhunzou',
      url: 'https://hub.example.com/a/xxx',
    });

    const feishu = await sendOne({
      type: 'feishu',
      url: 'https://open.feishu.cn/hook',
    });
    expect(JSON.parse(feishu.body)).toMatchObject({ msg_type: 'text' });

    const slack = await sendOne({ type: 'slack', url: 'https://hooks.slack.com/x' });
    expect(JSON.parse(slack.body).text).toContain('#104');

    const discord = await sendOne({
      type: 'discord',
      url: 'https://discord.com/api/webhooks/x',
    });
    expect(JSON.parse(discord.body).content).toContain('#104');
  });

  it('posts to ntfy and Telegram', async () => {
    const ntfy = await sendOne(
      {
        type: 'ntfy',
        url: 'https://ntfy.sh/zhunzou',
        token: 'tk',
      },
      'https://hub.example.com/a/xxx',
    );
    expect(ntfy.url).toBe('https://ntfy.sh/zhunzou');
    expect(ntfy.headers.get('authorization')).toBe('Bearer tk');
    expect(ntfy.headers.get('click')).toBe('https://hub.example.com/a/xxx');
    expect(ntfy.body).toContain('完成登录页');

    const telegram = await sendOne({
      type: 'telegram',
      token: 'bot-token',
      chatId: '42',
    });
    expect(telegram.url).toContain('/botbot-token/sendMessage');
    expect(JSON.parse(telegram.body)).toMatchObject({ chat_id: '42' });
  });

  it('never rejects when a channel fails', async () => {
    const warn = vi.fn();
    const notifiers = createNotifiers(
      [{ type: 'webhook', url: 'https://hooks.example/hub' }],
      { info: vi.fn(), warn },
      {
        fetchImpl: (async () => new Response('down', { status: 503 })) as unknown as typeof fetch,
      },
    );

    expect(() => notifyTicketPendingHuman(notifiers, ticket, { info: vi.fn(), warn })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'webhook' }),
      'notification failed',
    );
  });
});
