import type {
  DecisionCategory,
  DecisionTicket,
  OptionRisk,
} from '@zhunzou/shared';

import type { DecisionConfig } from './config.js';
import type { DecisionKind, MetaAgent } from './meta-agent.js';

/**
 * L2 adjudication: one place that turns a ticket plus the rules into either an
 * auto-approval or a human escalation.
 *
 * The judge alone is not enough to trust. Before an approval leaves the hub it
 * must clear four gates:
 *
 * 1. confidence — a model that is not sure must ask;
 * 2. dual review — a challenger with the opposite default must agree on
 *    high-risk categories;
 * 3. quota — each project only gets so many auto-approvals per day;
 * 4. demotion — a category a human overturned recently is not auto-approved.
 *
 * Sampling (`auditRequired`) does not block the approval; it keeps the record
 * on the dashboard so a human can confirm or overturn it after the fact.
 */
export interface AdjudicationMeta {
  category?: DecisionCategory;
  confidence?: number;
  reviewCount?: number;
  auditRequired?: boolean;
}

export interface AdjudicationResult {
  verdict: 'APPROVED' | 'PENDING';
  reason: string;
  selectedOption?: string;
  meta: AdjudicationMeta;
}

export interface AdjudicationInput {
  rules: string;
  precedents: DecisionTicket[];
  /** Risk hint the agent attached to its submission, when it sent one. */
  risk?: OptionRisk;
  /** Replies have no ticket to audit, so they skip quota and sampling. */
  applyQuota?: boolean;
  /** Replies are judged against their own rubric, not the engineering rules. */
  kind?: DecisionKind;
}

export interface AdjudicationDeps {
  judge: MetaAgent;
  challenger: MetaAgent;
  config: DecisionConfig;
  /** Auto-approvals this project already spent in the rolling window. */
  quotaUsed: (projectName: string, since: number) => number;
  /** Millisecond timestamp this category is demoted until, or null. */
  demotedUntil: (
    projectName: string,
    category: string,
    now: number,
  ) => number | null;
  now?: () => number;
  random?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function confidenceOf(value: number | undefined): number {
  // Custom HTTP providers from before L2 do not send confidence. Treat their
  // deterministic ruling as fully confident instead of blocking every call.
  return value ?? 1;
}

function isHighRisk(
  ticket: DecisionTicket,
  input: AdjudicationInput,
  category: string,
  config: DecisionConfig,
): boolean {
  if (input.risk && input.risk !== 'safe') return true;
  if (ticket.options.some((option) => (option.risk ?? 'safe') !== 'safe')) {
    return true;
  }
  return config.highRiskCategories.includes(category);
}

function describeRisk(ticket: DecisionTicket): string {
  const risky = ticket.options
    .filter((option) => (option.risk ?? 'safe') !== 'safe')
    .map((option) => `${option.key}:${option.risk}`);
  return risky.length > 0 ? `（选项风险 ${risky.join(', ')}）` : '';
}

export async function adjudicate(
  ticket: DecisionTicket,
  input: AdjudicationInput,
  deps: AdjudicationDeps,
): Promise<AdjudicationResult> {
  const now = deps.now?.() ?? Date.now();
  const config = deps.config;

  // Hard rule first: irreversible things never leave the human's hands.
  if (input.risk === 'destructive') {
    return {
      verdict: 'PENDING',
      reason: '提交标记为 destructive，必须人工确认',
      meta: {},
    };
  }
  const recommended = ticket.options.find(
    (option) => option.key === ticket.recommendedOption,
  );
  if (recommended?.risk === 'destructive') {
    return {
      verdict: 'PENDING',
      reason: '推荐方案标记为 destructive，必须人工确认',
      meta: {},
    };
  }

  // Quota is checked before paying for a model call. Replies are exempt: a
  // chat answer has no ticket, no audit trail and no irreversible effect.
  if (input.applyQuota !== false && config.dailyQuota > 0) {
    const used = deps.quotaUsed(ticket.projectName, now - DAY_MS);
    if (used >= config.dailyQuota) {
      return {
        verdict: 'PENDING',
        reason: `今日自动放行配额已用完（${used}/${config.dailyQuota}），转人工`,
        meta: {},
      };
    }
  }

  // The challenger never sees the judge's answer, so when the policy always
  // runs both seats they can think at the same time instead of in series.
  // Other modes still wait for the category, which decides whether the second
  // reading is needed at all — a wasted model call is worse there.
  const challengerPromise =
    config.dualReview === 'all'
      ? deps.challenger.review(
          ticket,
          input.rules,
          input.precedents,
          'challenger',
          input.kind,
        )
      : null;
  // If the judge denies the request early, this promise is abandoned; attach a
  // handler so a late rejection is not reported as an unhandled one.
  challengerPromise?.catch(() => undefined);

  const judge = await deps.judge.review(
    ticket,
    input.rules,
    input.precedents,
    'judge',
    input.kind,
  );
  const judgeMeta: AdjudicationMeta = {
    ...(judge.category ? { category: judge.category } : {}),
    ...(judge.confidence !== undefined ? { confidence: judge.confidence } : {}),
  };

  if (!judge.canResolve || !judge.selectedOption) {
    return {
      verdict: 'PENDING',
      reason: judge.reason || '规范未覆盖，转人工',
      meta: { ...judgeMeta, reviewCount: 1 },
    };
  }

  const selected = ticket.options.find(
    (option) => option.key === judge.selectedOption,
  );
  if (!selected) {
    return {
      verdict: 'PENDING',
      reason: `裁决结果 ${judge.selectedOption} 不在候选项中，转人工`,
      meta: { ...judgeMeta, reviewCount: 1 },
    };
  }
  if (selected.risk === 'destructive') {
    return {
      verdict: 'PENDING',
      reason: `选项 ${selected.key} 标记为 destructive，必须人工确认`,
      meta: { ...judgeMeta, reviewCount: 1 },
    };
  }

  const confidence = confidenceOf(judge.confidence);
  if (confidence < config.minConfidence) {
    return {
      verdict: 'PENDING',
      reason: `裁决置信度 ${confidence.toFixed(2)} 低于阈值 ${config.minConfidence}，转人工`,
      meta: { ...judgeMeta, reviewCount: 1 },
    };
  }

  const category = judge.category ?? 'other';
  const demotedUntil = deps.demotedUntil(ticket.projectName, category, now);
  if (demotedUntil !== null && demotedUntil > now) {
    const minutes = Math.max(1, Math.ceil((demotedUntil - now) / 60_000));
    return {
      verdict: 'PENDING',
      reason: `类目「${category}」此前被人工推翻，暂停自动放行 ${minutes} 分钟`,
      meta: { ...judgeMeta, category, reviewCount: 1 },
    };
  }

  const needChallenger =
    config.dualReview === 'all' ||
    (config.dualReview === 'high' &&
      isHighRisk(ticket, input, category, config));

  let reviewCount = 1;
  if (needChallenger) {
    reviewCount = 2;
    let challenger;
    try {
      challenger = challengerPromise
        ? await challengerPromise
        : await deps.challenger.review(
            ticket,
            input.rules,
            input.precedents,
            'challenger',
            input.kind,
          );
    } catch (error) {
      return {
        verdict: 'PENDING',
        reason: `反方审计失败，转人工：${
          error instanceof Error ? error.message : String(error)
        }`,
        meta: { ...judgeMeta, category, reviewCount },
      };
    }

    if (!challenger.canResolve) {
      return {
        verdict: 'PENDING',
        reason: `反方审计不同意自动放行：${challenger.reason}`,
        meta: { ...judgeMeta, category, reviewCount },
      };
    }
    if (challenger.selectedOption !== judge.selectedOption) {
      return {
        verdict: 'PENDING',
        reason: `双审未达成一致（正审 ${judge.selectedOption} / 反审 ${
          challenger.selectedOption ?? '未选择'
        }），转人工`,
        meta: { ...judgeMeta, category, reviewCount },
      };
    }
    const challengerConfidence = confidenceOf(challenger.confidence);
    if (challengerConfidence < config.minConfidence) {
      return {
        verdict: 'PENDING',
        reason: `反方审计置信度 ${challengerConfidence.toFixed(
          2,
        )} 低于阈值 ${config.minConfidence}，转人工`,
        meta: { ...judgeMeta, category, reviewCount },
      };
    }
  }

  const random = deps.random?.() ?? Math.random();
  const auditRequired =
    input.applyQuota !== false && config.auditRate > 0 && random < config.auditRate;

  return {
    verdict: 'APPROVED',
    reason: `${judge.reason || '符合规范，hub 自动放行'}${
      needChallenger ? '（双审一致）' : ''
    }${describeRisk(ticket)}`,
    selectedOption: judge.selectedOption,
    meta: {
      category,
      confidence: judge.confidence,
      reviewCount,
      auditRequired,
    },
  };
}
