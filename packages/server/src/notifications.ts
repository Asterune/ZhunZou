import { formatTicketId, type AgentTask, type DecisionTicket } from '@zhunzou/shared';

import type { NotificationChannelConfig } from './config.js';

export interface NotifierLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * A card button. Channels can only ever jump with these — a button that acts
 * back into the hub would need a signed callback endpoint per channel, and the
 * configuration surface is one webhook URL.
 */
export interface NotificationAction {
  label: string;
  url: string;
}

/** Which moment a notification speaks about; decides the webhook `type`. */
export type NotificationKind = 'ticket' | 'blocked' | 'done';

const EVENT_TYPE: Record<NotificationKind, string> = {
  ticket: 'ticket.pending_human',
  blocked: 'task.blocked',
  done: 'task.done',
};

export interface NotificationMessage {
  title: string;
  text: string;
  /** Set for a ticket awaiting a ruling. */
  ticket?: DecisionTicket;
  /** Set for a task that stopped owing a person a look. */
  task?: AgentTask;
  /** Signed mobile approval page, when PUBLIC_BASE_URL is configured. */
  approvalUrl?: string;
  /** Dashboard link, so a card can offer a second, read-only button. */
  refUrl?: string;
  /**
   * What the `kind` was; an absent kind means a ticket, which is the only
   * event this module ever announced.
   */
  kind?: NotificationKind;
  actions?: NotificationAction[];
}

export interface Notifier {
  /** Stable identifier used in logs. */
  name: string;
  send(message: NotificationMessage): Promise<void>;
}

export interface NotifierRuntime {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export function buildNotificationMessage(
  ticket: DecisionTicket,
  approvalUrl?: string,
): NotificationMessage {
  const options = ticket.options
    .map((option) => {
      const risk =
        option.risk === 'destructive'
          ? '（高风险）'
          : option.risk === 'caution'
            ? '（需谨慎）'
            : '';
      return `${option.key}. ${option.label}${risk}`;
    })
    .join(' / ');

  return {
    title: `【准奏 · 待批奏折 ${formatTicketId(ticket.id)}】${ticket.projectName}`,
    text: [
      `来源：${ticket.env}`,
      `已完成：${ticket.doneSummary}`,
      `卡点：${ticket.blockerQuestion}`,
      `下一步：${ticket.nextStepPlan}`,
      `选项：${options}`,
      `推荐：${ticket.recommendedOption}`,
      ...(approvalUrl ? [`一键审批：${approvalUrl}`] : []),
    ].join('\n'),
    ticket,
    ...(approvalUrl ? { approvalUrl } : {}),
  };
}

/** What a task notification needs besides the task row itself. */
export interface TaskNotificationFacts {
  kind: 'blocked' | 'done';
  /** The supervisor's one line, not the engine's. */
  diagnosis?: string;
  errorSignature?: string;
  /** Only for tasks that ran in an isolated worktree. */
  branch?: string;
  workspacePath?: string;
  /** Signed task page; only `blocked` earns one. */
  approvalUrl?: string;
  refUrl?: string;
}

export function buildTaskNotificationMessage(
  task: AgentTask,
  facts: TaskNotificationFacts,
): NotificationMessage {
  const headline = facts.kind === 'blocked' ? '卡住了，等人放行' : '完工，等人合并';
  const actions: NotificationAction[] = [
    ...(facts.approvalUrl
      ? [{ label: '批准继续', url: facts.approvalUrl }]
      : []),
    ...(facts.refUrl
      ? [
          {
            label: facts.kind === 'done' && facts.branch ? '合并信息' : '打开看板',
            url: facts.refUrl,
          },
        ]
      : []),
  ];

  return {
    kind: facts.kind,
    title: `【准奏 · ${headline} ${formatTicketId(task.id)}】${
      task.projectName ?? task.repoName ?? task.title
    }`,
    text: [
      `来源：${task.env}`,
      `任务：${task.title}`,
      ...(facts.diagnosis ? [`管家诊断：${facts.diagnosis}`] : []),
      ...(facts.errorSignature ? [`错误特征：${facts.errorSignature}`] : []),
      ...(facts.kind === 'done' && task.result
        ? [`引擎结论：${task.result}`]
        : []),
      ...(facts.branch ? [`分支：${facts.branch}`] : []),
      ...(facts.workspacePath ? [`工作区：${facts.workspacePath}`] : []),
    ].join('\n'),
    task,
    ...(facts.approvalUrl ? { approvalUrl: facts.approvalUrl } : {}),
    ...(facts.refUrl ? { refUrl: facts.refUrl } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

/** Backward-compatible generic webhook payload. */
export function buildWebhookPayload(
  ticket: DecisionTicket,
  approvalUrl?: string,
) {
  const message = buildNotificationMessage(ticket, approvalUrl);
  return webhookBody(message);
}

function webhookBody(message: NotificationMessage) {
  return {
    type: EVENT_TYPE[message.kind ?? 'ticket'],
    text: `${message.title}\n${message.text}`,
    ...(message.ticket ? { ticket: message.ticket } : {}),
    ...(message.task ? { task: message.task } : {}),
    ...(message.approvalUrl ? { approvalUrl: message.approvalUrl } : {}),
    ...(message.actions?.length ? { actions: message.actions } : {}),
  };
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function webhookNotifier(
  config: Extract<NotificationChannelConfig, { type: 'webhook' }>,
  runtime: Required<NotifierRuntime>,
): Notifier {
  return {
    name: 'webhook',
    send: (message) =>
      postJson(
        runtime.fetchImpl,
        config.url,
        webhookBody(message),
        config.secret ? { 'x-webhook-secret': config.secret } : {},
        runtime.timeoutMs,
      ),
  };
}

function barkNotifier(
  config: Extract<NotificationChannelConfig, { type: 'bark' }>,
  runtime: Required<NotifierRuntime>,
): Notifier {
  return {
    name: 'bark',
    send: (message) =>
      postJson(
        runtime.fetchImpl,
        config.url,
        {
          title: message.title,
          body: message.text,
          group: 'zhunzou',
          ...(message.approvalUrl ? { url: message.approvalUrl } : {}),
        },
        {},
        runtime.timeoutMs,
      ),
  };
}

function feishuNotifier(
  config: Extract<NotificationChannelConfig, { type: 'feishu' }>,
  runtime: Required<NotifierRuntime>,
): Notifier {
  return {
    name: 'feishu',
    send: (message) =>
      postJson(
        runtime.fetchImpl,
        config.url,
        message.actions?.length ? feishuCard(message) : feishuText(message),
        {},
        runtime.timeoutMs,
      ),
  };
}

function feishuText(message: NotificationMessage) {
  return {
    msg_type: 'text',
    content: { text: `${message.title}\n${message.text}` },
  };
}

/**
 * A custom-bot webhook can build a card, but every button on it is a link:
 * acting back into the hub would need a self-built app with encrypted event
 * callbacks, and the only thing configured here is a URL.
 */
function feishuCard(message: NotificationMessage): Record<string, unknown> {
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: message.kind === 'done' ? 'green' : 'red',
        title: { tag: 'plain_text', content: message.title },
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: message.text } },
        ...(message.actions ?? []).map((action) => ({
          tag: 'action',
          actions: [
            {
              tag: 'button',
              type: 'primary',
              text: { tag: 'plain_text', content: action.label },
              url: action.url,
            },
          ],
        })),
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: '按钮只把你送到签名页面，批准仍然要在页面上提交。',
            },
          ],
        },
      ],
    },
  };
}

/** WeCom group robots have no button at all; markdown with links is the card. */
const WECOM_TEXT_BUDGET = 1_200;

function wecomNotifier(
  config: Extract<NotificationChannelConfig, { type: 'wecom' }>,
  runtime: Required<NotifierRuntime>,
): Notifier {
  return {
    name: 'wecom',
    send: (message) =>
      postJson(
        runtime.fetchImpl,
        config.url,
        {
          msgtype: 'markdown',
          markdown: {
            content: clip(
              [
                `**${message.title}**`,
                message.text,
                ...(message.actions ?? []).map(
                  (action) => `[${action.label}](${action.url})`,
                ),
              ].join('\n\n'),
              WECOM_TEXT_BUDGET,
            ),
          },
        },
        {},
        runtime.timeoutMs,
      ),
  };
}

function clip(value: string, budget: number): string {
  return value.length <= budget ? value : `${value.slice(0, budget - 1)}…`;
}

function slackNotifier(
  config: Extract<NotificationChannelConfig, { type: 'slack' }>,
  runtime: Required<NotifierRuntime>,
): Notifier {
  return {
    name: 'slack',
    send: (message) =>
      postJson(
        runtime.fetchImpl,
        config.url,
        { text: `${message.title}\n${message.text}` },
        {},
        runtime.timeoutMs,
      ),
  };
}

function discordNotifier(
  config: Extract<NotificationChannelConfig, { type: 'discord' }>,
  runtime: Required<NotifierRuntime>,
): Notifier {
  return {
    name: 'discord',
    send: (message) =>
      postJson(
        runtime.fetchImpl,
        config.url,
        { content: `**${message.title}**\n${message.text}` },
        {},
        runtime.timeoutMs,
      ),
  };
}

function ntfyNotifier(
  config: Extract<NotificationChannelConfig, { type: 'ntfy' }>,
  runtime: Required<NotifierRuntime>,
): Notifier {
  return {
    name: 'ntfy',
    async send(message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
      try {
        const response = await runtime.fetchImpl(config.url, {
          method: 'POST',
          headers: {
            ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
            ...(message.approvalUrl ? { click: message.approvalUrl } : {}),
          },
          body: `${message.title}\n${message.text}`,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function telegramNotifier(
  config: Extract<NotificationChannelConfig, { type: 'telegram' }>,
  runtime: Required<NotifierRuntime>,
): Notifier {
  return {
    name: 'telegram',
    send: (message) =>
      postJson(
        runtime.fetchImpl,
        `https://api.telegram.org/bot${config.token}/sendMessage`,
        { chat_id: config.chatId, text: `${message.title}\n${message.text}` },
        {},
        runtime.timeoutMs,
      ),
  };
}

function consoleNotifier(logger: NotifierLogger): Notifier {
  return {
    name: 'console',
    async send(message) {
      const ref = message.ticket ?? message.task;
      logger.info(
        {
          ...(ref ? { ticket: formatTicketId(ref.id) } : {}),
          text: message.text,
        },
        message.title,
      );
    },
  };
}

/** Build one notifier per configured channel. */
export function createNotifiers(
  channels: NotificationChannelConfig[],
  logger: NotifierLogger,
  runtime: NotifierRuntime = {},
): Notifier[] {
  const resolved: Required<NotifierRuntime> = {
    fetchImpl: runtime.fetchImpl ?? fetch,
    timeoutMs: runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  return channels.map((channel) => {
    switch (channel.type) {
      case 'webhook':
        return webhookNotifier(channel, resolved);
      case 'bark':
        return barkNotifier(channel, resolved);
      case 'feishu':
        return feishuNotifier(channel, resolved);
      case 'wecom':
        return wecomNotifier(channel, resolved);
      case 'slack':
        return slackNotifier(channel, resolved);
      case 'discord':
        return discordNotifier(channel, resolved);
      case 'ntfy':
        return ntfyNotifier(channel, resolved);
      case 'telegram':
        return telegramNotifier(channel, resolved);
      case 'console':
        return consoleNotifier(logger);
    }
  });
}

/**
 * Fire-and-forget fan-out. A broken notification channel must never block or
 * fail the event that caused it, so every rejection is only logged.
 * The log key stays `ticket` for both kinds — it is the existing log shape,
 * and a task reference reads the same `#<id>` form.
 */
function fanout(
  notifiers: Notifier[],
  message: NotificationMessage,
  logger: NotifierLogger,
  ref: string,
): void {
  if (notifiers.length === 0) {
    logger.info({ ticket: ref }, 'no notification channel configured');
    return;
  }

  void Promise.allSettled(
    notifiers.map(async (notifier) => {
      try {
        await notifier.send(message);
      } catch (error) {
        logger.warn(
          {
            channel: notifier.name,
            ticket: ref,
            err: (error as Error).message,
          },
          'notification failed',
        );
      }
    }),
  );
}

export function notifyTicketPendingHuman(
  notifiers: Notifier[],
  ticket: DecisionTicket,
  logger: NotifierLogger,
  approvalUrl?: string,
): void {
  fanout(
    notifiers,
    buildNotificationMessage(ticket, approvalUrl),
    logger,
    formatTicketId(ticket.id),
  );
}

/** Announce a task that stopped owing a person a look. */
export function notifyTaskOutcome(
  notifiers: Notifier[],
  task: AgentTask,
  facts: TaskNotificationFacts,
  logger: NotifierLogger,
): void {
  fanout(
    notifiers,
    buildTaskNotificationMessage(task, facts),
    logger,
    formatTicketId(task.id),
  );
}
