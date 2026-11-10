import type { ChatMessage, ChatSession, DecisionTicket } from '@zhunzou/shared';

type SessionScope = Pick<ChatSession, 'env' | 'projectName'>;

/**
 * Petitions that belong next to an open chat.
 *
 * Tickets carry no session id, so the chat scopes them by environment: once a
 * project is set, only that project's tickets are relevant; otherwise the
 * whole environment is shown.
 */
export function ticketsForSession(
  session: SessionScope | null | undefined,
  tickets: readonly DecisionTicket[],
): DecisionTicket[] {
  if (!session) return [];
  const project = session.projectName?.trim();
  return tickets.filter(
    (ticket) =>
      ticket.env === session.env &&
      (!project || ticket.projectName === project),
  );
}

/** User messages already accepted by the hub and waiting for the runner. */
export function queuedUserMessages(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return messages.filter(
    (message) => message.role === 'user' && message.status === 'PENDING',
  );
}
