import type {
  DecisionRequest,
  DecisionTicket,
  DecisionVerdict,
  TicketOption,
} from '@zhunzou/shared';

import type { AdjudicationMeta, AdjudicationResult } from './adjudication.js';
import type { DecisionMode } from './config.js';

/**
 * The hub's judgment layer.
 *
 * Under the "hub decides" model an agent never picks between acting and
 * asking. It submits the exact thing it wants to do, plus the facts, and this
 * module answers `APPROVED` (go ahead) or `PENDING` (a human must rule). The
 * same gates back tickets and replies, so there is exactly one policy in the
 * system.
 */
export interface DecisionOutcome {
  verdict: DecisionVerdict;
  reason: string;
  /** Set when the hub picked one of the submitted options. */
  selectedOption?: string;
  /** Judge metadata persisted on the ticket for audit and demotion. */
  meta: AdjudicationMeta;
}

export interface DecisionContext {
  mode: DecisionMode;
  /**
   * The L2 adjudicator. It receives the same synthetic ticket the dashboard
   * would see, so a decision and an escalated ticket are judged identically.
   */
  adjudicate: (
    input: DecisionInput,
    ticket: DecisionTicket,
  ) => Promise<AdjudicationResult>;
}

/** The least the policy needs from the request; keeps tests cheap. */
export type DecisionInput = DecisionRequest;

const MAX_QUESTION = 2_000;

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function questionFor(input: DecisionInput): string {
  const lead =
    input.kind === 'reply'
      ? `是否把这条回复发给 Agent：${truncate(input.proposal, 200)}`
      : `是否允许 Agent 执行：${truncate(input.proposal, 200)}`;
  const context = input.context ? `\n背景：${truncate(input.context, 600)}` : '';
  return truncate(`${lead}${context}`, MAX_QUESTION);
}

function optionsFor(input: DecisionInput): TicketOption[] {
  if (input.options && input.options.length > 0) return input.options;
  return [
    {
      key: 'A',
      label: `执行：${truncate(input.proposal, 60)}`,
      prosCons: '按 Agent 提交的提案继续',
      risk: input.risk ?? 'safe',
    },
    {
      key: 'B',
      label: '交给人类确认',
      prosCons: '暂停，等待人工拍板',
      risk: 'safe',
    },
  ];
}

/** Build the ticket shape the adjudicator knows how to judge. */
export function syntheticTicket(input: DecisionInput): DecisionTicket {
  const options = optionsFor(input);
  const now = Date.now();
  return {
    id: '0',
    env: input.env,
    projectName: input.projectName,
    status: 'PENDING_META',
    doneSummary: input.doneSummary ?? 'Agent 提交情境，等待准奏裁决',
    blockerQuestion: questionFor(input),
    nextStepPlan: input.nextStepPlan ?? truncate(input.proposal, 600),
    options,
    recommendedOption: input.recommendedOption ?? options[0]!.key,
    createdAt: now,
    updatedAt: now,
  };
}

function modeAllows(mode: DecisionMode, input: DecisionInput): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return input.kind === 'reply';
}

export async function evaluateDecision(
  input: DecisionInput,
  ctx: DecisionContext,
): Promise<DecisionOutcome> {
  // Hard rule first: irreversible things never leave the human's hands.
  if (input.risk === 'destructive') {
    return {
      verdict: 'PENDING',
      reason: '提交标记为 destructive，必须人工确认',
      meta: {},
    };
  }
  if (
    input.recommendedOption &&
    input.options?.find((item) => item.key === input.recommendedOption)?.risk ===
      'destructive'
  ) {
    return {
      verdict: 'PENDING',
      reason: '推荐方案标记为 destructive，必须人工确认',
      meta: {},
    };
  }

  if (!modeAllows(ctx.mode, input)) {
    return {
      verdict: 'PENDING',
      reason:
        ctx.mode === 'off'
          ? '裁决权已关闭（DECISION_POLICY=off）'
          : `当前策略只自动裁决会话回复（DECISION_POLICY=${ctx.mode}）`,
      meta: {},
    };
  }

  const ticket = syntheticTicket(input);
  try {
    return await ctx.adjudicate(input, ticket);
  } catch (error) {
    return {
      verdict: 'PENDING',
      reason: `裁决失败，转人工：${
        error instanceof Error ? error.message : String(error)
      }`,
      meta: {},
    };
  }
}
