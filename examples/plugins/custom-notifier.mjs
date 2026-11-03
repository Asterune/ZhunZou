/**
 * Example plugin: forward pending tickets to any custom HTTP endpoint.
 *
 * Built-in channels (webhook/bark/feishu/slack/discord/ntfy/telegram) cover
 * common cases; use a plugin when you need custom auth, routing or payloads.
 *
 * Enable with:
 *   HUB_PLUGINS=./examples/plugins/custom-notifier.mjs
 *   CUSTOM_NOTIFY_URL=https://example.com/hooks/zhunzou
 *   CUSTOM_NOTIFY_TOKEN=...
 */
export default function createPlugin({ logger }) {
  const url = process.env.CUSTOM_NOTIFY_URL;
  const token = process.env.CUSTOM_NOTIFY_TOKEN;

  if (!url) {
    logger.warn('custom-notifier loaded without CUSTOM_NOTIFY_URL; disabled');
  }

  return {
    name: 'custom-notifier',
    async onTicketPendingHuman(ticket) {
      if (!url) return;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          text: `待批奏折 #${ticket.id}：${ticket.blockerQuestion}`,
          ticket,
        }),
      });

      if (!response.ok) {
        throw new Error(`custom notifier returned HTTP ${response.status}`);
      }
    },
  };
}
