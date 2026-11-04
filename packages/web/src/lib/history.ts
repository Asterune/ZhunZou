import type { DecisionTicket } from '@zhunzou/shared';

export type HistoryFilter =
  | 'all'
  | 'human'
  | 'meta'
  | 'timeout'
  | 'cancelled';

export const HISTORY_FILTERS: Array<{ key: HistoryFilter }> = [
  { key: 'all' },
  { key: 'human' },
  { key: 'meta' },
  { key: 'timeout' },
  { key: 'cancelled' },
];

function optionLabel(ticket: DecisionTicket): string {
  if (!ticket.selectedOption) return '';
  return (
    ticket.options.find((option) => option.key === ticket.selectedOption)?.label ??
    ''
  );
}

export function ticketSearchText(ticket: DecisionTicket): string {
  return [
    ticket.id,
    ticket.projectName,
    ticket.env,
    ticket.doneSummary,
    ticket.blockerQuestion,
    ticket.nextStepPlan,
    ticket.selectedOption ?? '',
    optionLabel(ticket),
    ticket.customInstruction ?? '',
    ticket.resolutionReason ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

export function filterHistory(
  tickets: DecisionTicket[],
  query: string,
  filter: HistoryFilter,
): DecisionTicket[] {
  const needle = query.trim().toLowerCase();

  return tickets.filter((ticket) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'human' &&
        ticket.status === 'HUMAN_RESOLVED' &&
        ticket.resolvedBy === 'HUMAN') ||
      (filter === 'meta' && ticket.resolvedBy === 'META_AGENT') ||
      (filter === 'timeout' && ticket.resolvedBy === 'TIMEOUT') ||
      (filter === 'cancelled' && ticket.status === 'CANCELLED');

    if (!matchesFilter) return false;
    if (!needle) return true;
    return ticketSearchText(ticket).includes(needle);
  });
}
