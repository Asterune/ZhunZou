import { ticketIdSchema } from '@zhunzou/shared';

import { formatCancelled, formatCliDecision } from './format.js';
import { HubApiError, type HubApi } from './hub-client.js';

export interface WaitForDecisionOptions {
  client: HubApi;
  ticketId: string;
  /** Long-poll window per attempt (ms). Each request waits this long. */
  intervalMs: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function normalizeTicketId(raw: string): string {
  return raw.trim().replace(/^#/, '');
}

/**
 * Block until a human/Meta-Agent decision exists, printing the final decision
 * to stdout so Cursor/OpenCode can read it back from the terminal.
 *
 * Exit codes: 0 resolved, 1 fatal error, 2 cancelled, 130 interrupted.
 */
export async function waitForDecision(options: WaitForDecisionOptions): Promise<number> {
  const write = options.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const writeError =
    options.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let ticketId: string;
  try {
    ticketId = ticketIdSchema.parse(normalizeTicketId(options.ticketId));
  } catch {
    writeError(`[zhunzou] invalid ticket id: ${options.ticketId}`);
    return 1;
  }

  let attempts = 0;

  for (;;) {
    attempts += 1;

    try {
      const outcome = await options.client.wait(ticketId, options.intervalMs);

      if (outcome.resolved) {
        write(formatCliDecision(outcome.ticket));
        return 0;
      }

      if (outcome.ticket.status === 'CANCELLED') {
        writeError(formatCancelled(outcome.ticket));
        return 2;
      }

      writeError(
        `[zhunzou] still waiting for ticket #${ticketId} (check ${attempts})...`,
      );
      continue;
    } catch (error) {
      if (error instanceof HubApiError && !error.retryable) {
        writeError(`[zhunzou] ${error.code}: ${error.message}`);
        return 1;
      }

      const message = error instanceof Error ? error.message : String(error);
      writeError(
        `[zhunzou] temporary failure (${message}); retrying in ${options.intervalMs}ms`,
      );
      await sleep(options.intervalMs);
    }
  }
}
