import { describe, expect, it, vi } from 'vitest';

import type { AgentTask, DecisionTicket } from '@zhunzou/shared';

import type { NotificationChannelConfig } from '../src/config.js';
import {
  buildNotificationMessage,
  buildTaskNotificationMessage,
  buildWebhookPayload,
  createNotifiers,
  notifyTaskOutcome,
  notifyTicketPendingHuman,
  type NotificationMessage,
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

const stoppedTask: AgentTask = {
  id: '77',
  env: 'desk-b',
  projectName: 'pte-dojo',
  title: '修好登录页的单测',
  instruction: '跑测试并修',
  status: 'BLOCKED',
  attempts: 2,
  origin: 'HUB_DISPATCH',
  managedBySupervisor: true,
  retryCount: 3,
  workspacePath: '/repo/.zhunzou/wt/77',
  createdAt: 1,
  updatedAt: 2,
  result: '两个用例仍然红',
};

async function deliver(
  channel: NotificationChannelConfig,
  message: NotificationMessage,
): Promise<Captured> {
  const { fetchImpl, calls } = captureFetch();
  const [notifier] = createNotifiers([channel], logger(), { fetchImpl });
  await notifier!.send(message);
  return calls[0]!;
}

describe('task notification message', () => {
  const blockedMessage = buildTaskNotificationMessage(stoppedTask, {
    kind: 'blocked',
    diagnosis: '三轮重试都在同一个用例上打转',
    errorSignature: 'TS2345 expect(received)',
    branch: 'wip/zz-77',
    workspacePath: stoppedTask.workspacePath,
    approvalUrl: 'https://hub.example.com/t/xxx',
    refUrl: 'https://hub.example.com/?tab=inbox',
  });

  it('announces a stuck task without pretending to be a ticket', () => {
    expect(blockedMessage.title).toContain('#77');
    expect(blockedMessage.title).toContain('卡住');
    expect(blockedMessage.text).toContain('三轮重试都在同一个用例上打转');
    expect(blockedMessage.text).toContain('TS2345 expect(received)');
    expect(blockedMessage.text).toContain('分支：wip/zz-77');
    expect(blockedMessage.text).toContain('工作区：/repo/.zhunzou/wt/77');
    // N1: the ticket key stays absent rather than being set to undefined.
    expect('ticket' in blockedMessage).toBe(false);
    expect(Object.keys(blockedMessage)).toContain('task');
  });

  it('offers 批准继续 only when a signed page exists', () => {
    expect(blockedMessage.actions?.map((action) => action.label)).toEqual([
      '批准继续',
      '打开看板',
    ]);

    const noLink = buildTaskNotificationMessage(stoppedTask, { kind: 'blocked' });
    expect('actions' in noLink).toBe(false);
  });

  it('keeps the engine word for a finished task and asks for nothing', () => {
    const done = buildTaskNotificationMessage(
      { ...stoppedTask, status: 'DONE' },
      {
        kind: 'done',
        branch: 'wip/zz-77',
        workspacePath: stoppedTask.workspacePath,
        refUrl: 'https://hub.example.com/?tab=inbox',
      },
    );

    expect(done.title).toContain('完工');
    expect(done.text).toContain('引擎结论：两个用例仍然红');
    expect(done.text).not.toContain('管家诊断');
    expect(done.actions?.map((action) => action.label)).toEqual(['合并信息']);
  });

  it('types the generic webhook payload by the moment, not by the table', async () => {
    const body = JSON.parse(
      (
        await deliver(
          { type: 'webhook', url: 'https://hooks.example/hub' },
          blockedMessage,
        )
      ).body,
    ) as Record<string, unknown>;

    expect(body.type).toBe('task.blocked');
    expect(body.task).toMatchObject({ id: '77', status: 'BLOCKED' });
    expect('ticket' in body).toBe(false);
    expect(body.actions).toEqual(blockedMessage.actions);
    expect(buildWebhookPayload(ticket)).toMatchObject({
      type: 'ticket.pending_human',
    });
  });
});

describe('card channels', () => {
  const ticketMessage = buildNotificationMessage(
    ticket,
    'https://hub.example.com/a/104.999.deadbeef',
  );
  const withActions: NotificationMessage = {
    ...ticketMessage,
    actions: [{ label: '批准继续', url: 'https://hub.example.com/t/xxx' }],
  };

  it('leaves the text-only channels byte-for-byte alone', async () => {
    const plain = buildNotificationMessage(ticket);
    const carded: NotificationMessage = {
      ...plain,
      actions: [{ label: '批准继续', url: 'https://hub.example.com/t/xxx' }],
    };

    for (const channel of [
      { type: 'bark', url: 'https://api.day.app/key' },
      { type: 'slack', url: 'https://hooks.slack.com/x' },
      { type: 'discord', url: 'https://discord.com/api/webhooks/x' },
      { type: 'ntfy', url: 'https://ntfy.sh/zhunzou' },
      { type: 'telegram', token: 't', chatId: '42' },
    ] satisfies NotificationChannelConfig[]) {
      expect((await deliver(channel, carded)).body).toBe(
        (await deliver(channel, plain)).body,
      );
    }
  });

  it('turns a feishu text message into an interactive card only with actions', async () => {
    const channel: NotificationChannelConfig = {
      type: 'feishu',
      url: 'https://open.feishu.cn/hook',
    };

    const text = JSON.parse((await deliver(channel, ticketMessage)).body) as {
      msg_type: string;
    };
    expect(text.msg_type).toBe('text');

    const card = JSON.parse(
      (await deliver(channel, withActions)).body,
    ) as Record<string, any>;
    expect(card.msg_type).toBe('interactive');
    expect(card.card.header.title.content).toBe(ticketMessage.title);
    const buttons = card.card.elements.filter(
      (element: { tag: string }) => element.tag === 'action',
    );
    expect(buttons[0].actions[0]).toMatchObject({
      tag: 'button',
      url: 'https://hub.example.com/t/xxx',
    });
  });

  it('renders a wecom markdown card with its links', async () => {
    const channel: NotificationChannelConfig = {
      type: 'wecom',
      url: 'https://qyapi.weixin.qq.com/hook',
    };

    const taskMessage = buildTaskNotificationMessage(stoppedTask, {
      kind: 'blocked',
      diagnosis: '三轮重试都在同一个用例上打转',
      branch: 'wip/zz-77',
      workspacePath: stoppedTask.workspacePath,
      approvalUrl: 'https://hub.example.com/t/xxx',
    });
    const card = JSON.parse((await deliver(channel, taskMessage)).body) as {
      msgtype: string;
      markdown: { content: string };
    };

    expect(card.msgtype).toBe('markdown');
    expect(card.markdown.content).toContain('wip/zz-77');
    expect(card.markdown.content).toContain(
      '[批准继续](https://hub.example.com/t/xxx)',
    );

    const plainMessage = buildNotificationMessage(ticket);
    const plain = JSON.parse(
      (await deliver(channel, plainMessage)).body,
    ) as { markdown: { content: string } };
    // N7: no dangling separator when there is nothing to link.
    expect(plain.markdown.content).toBe(
      `**${plainMessage.title}**\n\n${plainMessage.text}`,
    );
    expect(plain.markdown.content).not.toContain('](');
  });
});

describe('task fan-out', () => {
  it('warns but keeps sending when one channel is down', async () => {
    const warn = vi.fn();
    const sent: string[] = [];
    const notifiers = createNotifiers(
      [
        { type: 'wecom', url: 'https://qyapi.weixin.qq.com/down' },
        { type: 'feishu', url: 'https://open.feishu.cn/hook' },
      ],
      { info: vi.fn(), warn },
      {
        fetchImpl: (async (url: string | URL | Request) => {
          if (String(url).includes('down')) {
            return new Response('down', { status: 503 });
          }
          sent.push(String(url));
          return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch,
      },
    );

    expect(() =>
      notifyTaskOutcome(
        notifiers,
        stoppedTask,
        { kind: 'blocked', diagnosis: '熔断' },
        { info: vi.fn(), warn },
      ),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent).toEqual(['https://open.feishu.cn/hook']);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'wecom', ticket: '#77' }),
      'notification failed',
    );
  });
});
