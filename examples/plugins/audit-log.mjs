/**
 * Example plugin: append every ticket lifecycle event to a JSONL audit log.
 *
 * Enable with:
 *   HUB_PLUGINS=./examples/plugins/audit-log.mjs
 * Optional:
 *   ZHUNZOU_AUDIT_LOG=./data/audit.log
 */
import { appendFile } from 'node:fs/promises';

export default function createPlugin({ logger }) {
  const file = process.env.ZHUNZOU_AUDIT_LOG ?? './data/audit.log';

  async function record(event, ticket) {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      ticketId: ticket.id,
      status: ticket.status,
      project: ticket.projectName,
      env: ticket.env,
      option: ticket.selectedOption ?? null,
      resolvedBy: ticket.resolvedBy ?? null,
    });
    await appendFile(file, `${line}\n`, 'utf8');
  }

  return {
    name: 'audit-log',
    onTicketCreated: (ticket) => record('created', ticket),
    onTicketPendingHuman: (ticket) => record('pending_human', ticket),
    onTicketResolved: (ticket) => record('resolved', ticket),
    onTicketCancelled: (ticket) => record('cancelled', ticket),
    onReady() {
      logger.info({ file }, 'audit-log plugin ready');
    },
  };
}
