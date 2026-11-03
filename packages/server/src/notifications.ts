import { formatTicketId, type DecisionTicket } from '@zhunzou/shared';

import type { NotificationChannelConfig } from './config.js';

export interface NotifierLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface NotificationMessage {
  title: string;
  text: string;
  ticket: DecisionTicket;
  /** Signed mobile approval page, when PUBLIC_BASE_URL is configured. */
  approvalUrl?: string;
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

/** Backward-compatible generic webhook payload. */
export function buildWebhookPayload(
  ticket: DecisionTicket,
  approvalUrl?: string,
) {
  const message = buildNotificationMessage(ticket, approvalUrl);
  return {
    type: 'ticket.pending_human',
    text: `${message.title}\n${message.text}`,
    ticket,
    ...(approvalUrl ? { approvalUrl } : {}),
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
        {
          type: 'ticket.pending_human',
          text: `${message.title}\n${message.text}`,
          ticket: message.ticket,
          ...(message.approvalUrl
            ? { approvalUrl: message.approvalUrl }
            : {}),
        },
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
        { msg_type: 'text', content: { text: `${message.title}\n${message.text}` } },
        {},
        runtime.timeoutMs,
      ),
  };
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
      logger.info(
        { ticket: formatTicketId(message.ticket.id), text: message.text },
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
 * fail ticket creation, so every rejection is only logged.
 */
export function notifyTicketPendingHuman(
  notifiers: Notifier[],
  ticket: DecisionTicket,
  logger: NotifierLogger,
  approvalUrl?: string,
): void {
  if (notifiers.length === 0) {
    logger.info(
      { ticket: formatTicketId(ticket.id) },
      'ticket pending human; no notification channel configured',
    );
    return;
  }

  const message = buildNotificationMessage(ticket, approvalUrl);
  void Promise.allSettled(
    notifiers.map(async (notifier) => {
      try {
        await notifier.send(message);
      } catch (error) {
        logger.warn(
          {
            channel: notifier.name,
            ticket: formatTicketId(ticket.id),
            err: (error as Error).message,
          },
          'notification failed',
        );
      }
    }),
  );
}
