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

/**
 * Keys that send a chat turn: Shift+Enter.
 *
 * Bare Enter must stay a newline — it is also what confirms an IME candidate,
 * so treating it as "send" fired half-finished Chinese sentences.
 */
export function isSendShortcut(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing'>,
): boolean {
  return event.key === 'Enter' && !event.isComposing && event.shiftKey;
}

/**
 * Share of the native session's context budget already spent, 0–100.
 *
 * The hub's figure is a four-chars-per-token estimate, so the badge rounds
 * instead of pretending to be precise, and a value past the budget clamps at
 * 100 rather than overflowing the bar.
 */
export function contextUsagePercent(
  tokens: number | undefined,
  budget: number | undefined,
): number {
  if (!tokens || !budget || budget <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((tokens / budget) * 100)));
}

/** The parts of a fleet workspace a conversation needs to describe itself. */
export interface WorkspaceDirectory {
  env: string;
  path: string;
  projectName?: string | null;
}

/** Last path segment; a workspace without a project label still has a name. */
export function dirName(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? '';
}

/**
 * Directory the runner will execute this conversation in, when the hub knows it.
 *
 * A session's `projectName` is only a label the hub stores; the runner works in
 * the node's fleet workspace for that `env`. The workspace is therefore the
 * honest answer to "where will this run" — and looking it up by env rather than
 * by project is what lets a mislabelled session show that it is mislabelled.
 */
export function workspaceForSession<T extends WorkspaceDirectory>(
  session: SessionScope | null | undefined,
  workspaces: readonly T[],
): T | null {
  const env = session?.env;
  if (!env) return null;
  const rows = workspaces.filter((workspace) => workspace.env === env);
  if (rows.length <= 1) return rows[0] ?? null;
  // One env should own one directory; if the hub ever reports more, prefer the
  // workspace that actually carries this session's project name.
  const project = session?.projectName?.trim();
  return (
    rows.find((workspace) => workspace.projectName === project) ?? rows[0] ?? null
  );
}

/**
 * True when the session's project label and the directory the runner executes
 * in name different things.
 *
 * That is the state where "部署一下" typed in a project conversation redeploys
 * whichever repo the node was started in, so the chat has to say so out loud
 * instead of letting the label imply the directory.
 */
/**
 * Project labels drift by punctuation and case (`FitAI-`, `fitai `), which is
 * the same checkout. Compare the way the hub canonicalises them: trimmed,
 * lowercased, without a `.git` suffix or trailing separators.
 */
export function sameProjectName(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/\.git$/, '')
      .replace(/[-_\s]+$/, '');
  return normalize(left) === normalize(right);
}

export function sessionProjectMismatch(
  session: SessionScope | null | undefined,
  directory: { path: string; projectName?: string | null } | null | undefined,
): boolean {
  const project = session?.projectName?.trim();
  if (!project || !directory) return false;
  const actual = directory.projectName?.trim() || dirName(directory.path);
  return !sameProjectName(project, actual);
}
