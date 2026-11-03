import type {
  AgentTask,
  DecisionTicket,
  ResumeResponse,
} from '@zhunzou/shared';
import { formatTicketId } from '@zhunzou/shared';

import type { FallbackStrategy } from './config.js';

function optionLabel(ticket: DecisionTicket): string {
  const selected = ticket.options.find((option) => option.key === ticket.selectedOption);
  return selected ? ` - ${selected.label}` : '';
}

/** Text returned to the model when a decision exists. */
export function formatApproved(ticket: DecisionTicket): string {
  const lines = [
    `Decision Approved: Option [${ticket.selectedOption ?? '?'}]${optionLabel(ticket)}`,
  ];

  if (ticket.customInstruction) {
    lines.push(`Instruction: ${ticket.customInstruction}`);
  }
  if (ticket.resolutionReason) {
    lines.push(`Reason: ${ticket.resolutionReason}`);
  }

  lines.push(
    `Ticket: ${formatTicketId(ticket.id)} (${ticket.status}, resolved by ${ticket.resolvedBy ?? 'UNKNOWN'})`,
  );

  return lines.join('\n');
}

/** Text returned when the 40s wait expired without a decision. */
export function formatWaiting(
  ticket: DecisionTicket,
  fallback: FallbackStrategy,
  cliCommand = 'npx zhunzou-bridge',
): string {
  if (fallback === 'mcp') {
    return `[STATUS: STILL_WAITING] Human has not replied to Ticket ${formatTicketId(
      ticket.id,
    )} yet. Call tool 'agent_hub_wait(ticketId: ${ticket.id})' immediately to continue waiting.`;
  }

  return `Ticket ${formatTicketId(
    ticket.id,
  )} is pending human approval. Please execute terminal command: ${cliCommand} wait --ticket ${
    ticket.id
  } and wait for its stdout output before proceeding.`;
}

export function formatCancelled(ticket: DecisionTicket): string {
  return `Ticket ${formatTicketId(
    ticket.id,
  )} was cancelled before a decision was made. Do not continue with the blocked work; ask the human for new instructions.`;
}

/** CLI stdout for a resolved ticket. */
export function formatCliDecision(ticket: DecisionTicket): string {
  return formatApproved(ticket);
}

/** Text returned to the model when the dashboard dispatched a task. */
export function formatDispatchedTask(task: AgentTask): string {
  const lines = [
    `[TASK: RECEIVED] ${formatTicketId(task.id)} ${task.title}`,
  ];

  if (task.projectName) {
    lines.push(`Project: ${task.projectName}`);
  }

  lines.push('', 'Instruction:', task.instruction);
  lines.push(
    '',
    `When finished, call agent_hub_complete_task(taskId: ${task.id}, status: "DONE", result: "what you did").`,
    'If you are blocked, call agent_hub_escalate instead and keep this task id as context.',
  );

  return lines.join('\n');
}

/** Text returned after a restart/reconnect so the model can recover context. */
export function formatResume(resume: ResumeResponse): string {
  const pending = resume.tickets.filter(
    (ticket) =>
      ticket.status === 'PENDING_META' || ticket.status === 'PENDING_HUMAN',
  );
  const resolved = resume.tickets.filter(
    (ticket) =>
      ticket.status === 'AUTO_RESOLVED' || ticket.status === 'HUMAN_RESOLVED',
  );
  const tasks = resume.tasks;

  if (pending.length === 0 && resolved.length === 0 && tasks.length === 0) {
    return '[STATUS: NO_RESUME] No pending decisions or active tasks for this environment.';
  }

  const lines = [
    `[RESUME] ${pending.length} pending decision(s), ${tasks.length} active task(s).`,
  ];

  if (pending.length > 0) {
    lines.push('', 'Pending decisions:');
    for (const ticket of pending) {
      lines.push(
        `- ${formatTicketId(ticket.id)} ${ticket.projectName}: ${ticket.blockerQuestion}`,
        `  Call agent_hub_wait(ticketId: ${ticket.id}) to resume waiting.`,
      );
    }
  }

  if (tasks.length > 0) {
    lines.push('', 'Active tasks:');
    for (const task of tasks) {
      lines.push(
        `- ${formatTicketId(task.id)} [${task.status}] ${task.title} (attempt ${task.attempts})`,
        `  ${task.instruction}`,
        `  When done, call agent_hub_complete_task(taskId: ${task.id}, status: "DONE", result: "...").`,
      );
    }
  }

  if (resolved.length > 0) {
    lines.push('', 'Recently resolved:');
    for (const ticket of resolved) {
      lines.push(
        `- ${formatTicketId(ticket.id)} ${ticket.projectName} -> option ${ticket.selectedOption ?? '?'}${
          ticket.customInstruction ? `; instruction: ${ticket.customInstruction}` : ''
        }`,
      );
    }
  }

  return lines.join('\n');
}

/** Text returned when no task is waiting for this env. */
export function formatNoTask(env: string): string {
  return `[STATUS: NO_TASK] No task is currently dispatched for ${env}. Continue current work, or call agent_hub_next_task again later.`;
}

/** Text returned after a task is marked complete. */
export function formatTaskCompleted(task: AgentTask): string {
  return `Task ${formatTicketId(task.id)} is now ${task.status}. Dashboard status has been set to Idle.`;
}

export function renderToolResult(text: string): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text', text }] };
}

export function renderToolError(text: string): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  return { isError: true, content: [{ type: 'text', text }] };
}
