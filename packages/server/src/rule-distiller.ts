import type { DecisionTicket } from '@zhunzou/shared';

import type { MetaAgentConfig } from './config.js';
import { buildRequestHeaders } from './meta-agent.js';

export interface RuleDistillerLogger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface RuleDistiller {
  /**
   * Turn one human approval into a reusable rule candidate.
   * Returns null when the decision has no reusable value.
   */
  distill(ticket: DecisionTicket): Promise<string | null>;
}

const SYSTEM_PROMPT = `你是软件工程团队的规范维护者。请把一次人工审批抽象成一条可复用的《全局工程与架构规范》条目。

要求：
1. 只输出一条 Markdown 列表项，以 "- " 开头；
2. 不超过 80 个汉字；
3. 去掉工单编号、日期、具体文件路径等一次性细节；
4. 只在这条决策具有复用价值时输出；如果只适用于当前代码，输出 SKIP；
5. 不要输出解释、标题或代码块。`;

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/** Deterministic fallback so the feature still works without an LLM. */
export function fallbackRule(ticket: DecisionTicket): string {
  const option = ticket.options.find((item) => item.key === ticket.selectedOption);
  const selected = ticket.selectedOption ?? ticket.recommendedOption;
  const label = option?.label ?? selected;
  const question = truncate(ticket.blockerQuestion, 120);
  const instruction = ticket.customInstruction
    ? truncate(ticket.customInstruction, 100)
    : '';

  return `- 项目「${ticket.projectName}」遇到「${question}」时，默认采用方案 ${selected}「${label}」${instruction ? `；${instruction}` : ''}。`;
}

function sanitizeRule(raw: string): string | null {
  let text = raw
    .trim()
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!text) return null;

  text = text
    .replace(/^[-*]\s*/, '')
    .replace(/^["'“”‘’]/, '')
    .replace(/["'“”‘’]$/, '')
    .trim();

  if (!text) return null;
  if (/^skip$/i.test(text)) return null;
  if (text.length > 300) text = `${text.slice(0, 299)}…`;

  return text.startsWith('- ') ? text : `- ${text}`;
}

function buildRequestBody(config: MetaAgentConfig, ticket: DecisionTicket) {
  const option = ticket.options.find((item) => item.key === ticket.selectedOption);
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: 0.2,
    max_tokens: 200,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `项目：${ticket.projectName}`,
          `已完成：${ticket.doneSummary}`,
          `卡点：${ticket.blockerQuestion}`,
          `下一步：${ticket.nextStepPlan}`,
          `最终选择：${ticket.selectedOption ?? ticket.recommendedOption}${option ? `（${option.label}）` : ''}`,
          ...(ticket.customInstruction
            ? [`人工补充：${ticket.customInstruction}`]
            : []),
        ].join('\n'),
      },
    ],
  };

  if (/deepseek/i.test(config.model)) {
    body.thinking = { type: 'disabled' };
  }

  return body;
}

async function callOpenAi(
  config: MetaAgentConfig,
  ticket: DecisionTicket,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...buildRequestHeaders(config), ...config.headers },
      body: JSON.stringify(buildRequestBody(config, ticket)),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`LLM request failed (${response.status}): ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('LLM response contained no message content');
    }

    return sanitizeRule(content);
  } finally {
    clearTimeout(timer);
  }
}

async function callHttp(
  config: MetaAgentConfig,
  ticket: DecisionTicket,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...config.headers },
      body: JSON.stringify({ type: 'distill_rule', ticket }),
      signal: controller.signal,
    });

    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(
        `rule distiller endpoint failed (${response.status}): ${raw.slice(0, 200)}`,
      );
    }

    let rule = raw;
    try {
      const payload = JSON.parse(raw) as { rule?: unknown };
      if (typeof payload.rule === 'string') {
        rule = payload.rule;
      } else if (payload !== null && typeof payload === 'object') {
        // A review-style response is not a rule; skip instead of storing JSON.
        return null;
      }
    } catch {
      // Plain-text responses are also accepted.
    }

    return sanitizeRule(rule);
  } finally {
    clearTimeout(timer);
  }
}

export function createRuleDistiller(
  config: MetaAgentConfig,
  fetchImpl: typeof fetch = fetch,
  logger?: RuleDistillerLogger,
): RuleDistiller {
  return {
    async distill(ticket) {
      if (ticket.status !== 'HUMAN_RESOLVED') return null;

      try {
        if (config.provider === 'none') return fallbackRule(ticket);
        if (!config.apiKey && config.provider === 'openai') return fallbackRule(ticket);
        if (!config.endpoint && config.provider === 'http') return fallbackRule(ticket);

        const rule =
          config.provider === 'http'
            ? await callHttp(config, ticket, fetchImpl)
            : await callOpenAi(config, ticket, fetchImpl);

        // null means the model deliberately said SKIP.
        return rule;
      } catch (error) {
        logger?.warn(
          { err: (error as Error).message, ticket: ticket.id },
          'rule distillation failed; using deterministic fallback',
        );
        return fallbackRule(ticket);
      }
    },
  };
}
