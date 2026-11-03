import { randomUUID } from 'node:crypto';

import type { DecisionTicket } from '@zhunzou/shared';

import type { MetaAgentConfig } from './config.js';

export interface MetaReview {
  canResolve: boolean;
  selectedOption?: string;
  reason: string;
}

export interface MetaAgent {
  review(
    ticket: DecisionTicket,
    rules: string,
    precedents?: DecisionTicket[],
  ): Promise<MetaReview>;
}

export class MetaAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaAgentError';
  }
}

const SYSTEM_PROMPT = `你是软件工程团队的「总管 Agent（Meta-Agent）」。你的职责是依据团队《全局工程与架构规范》，判断一个开发卡点是否可以由你直接拍板，从而避免打扰人类。

判断原则：
1. 只有在规范明确覆盖该场景、且选择推荐方案风险很低时，才允许自动拍板。
2. 涉及数据删除、数据库结构变更、API 契约变更、产品交互变更、引入新依赖、部署/域名变更时，必须交给人类。
3. 规范没有覆盖或存在明显权衡时，交给人类。
4. 只能从工单提供的 options 中选择一个 key，禁止发明新选项。
5. 可以参考「历史判例」保持决策一致性；若本次情况与判例明显不同，以规范和当前上下文为准。若高度相似，请在 reason 中注明「沿用 #编号」。
6. 任何标记为 risk="destructive" 的选项都不允许自动拍板，必须转人工。

只输出一个 JSON 对象，不要输出 Markdown、解释或代码块：
{"canResolve": boolean, "selectedOption": "A", "reason": "一句话中文理由"}
当 canResolve 为 false 时，selectedOption 可省略。`;

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function formatPrecedents(precedents: DecisionTicket[]): string {
  if (precedents.length === 0) return '';

  const lines = precedents.slice(0, 5).map((precedent, index) => {
    const option = precedent.options.find(
      (item) => item.key === precedent.selectedOption,
    );
    const decision = precedent.selectedOption
      ? `${precedent.selectedOption}${option ? `（${truncate(option.label, 60)}）` : ''}`
      : '未记录';
    const actor =
      precedent.resolvedBy === 'HUMAN'
        ? '人工审批'
        : precedent.resolvedBy === 'META_AGENT'
          ? '总管自动'
          : '未知';

    return [
      `${index + 1}. #${precedent.id} · ${actor}`,
      `   卡点：${truncate(precedent.blockerQuestion, 240)}`,
      `   决定：${decision}`,
      ...(precedent.customInstruction
        ? [`   补充：${truncate(precedent.customInstruction, 160)}`]
        : []),
      ...(precedent.resolutionReason
        ? [`   理由：${truncate(precedent.resolutionReason, 160)}`]
        : []),
    ].join('\n');
  });

  return `\n\n# 历史判例（仅供一致性参考，不是规则；若本次情况明显不同可以忽略）

${lines.join('\n')}`;
}

export function buildUserPrompt(
  ticket: DecisionTicket,
  rules: string,
  precedents: DecisionTicket[] = [],
): string {
  return `# 全局工程与架构规范

${rules.trim() || '（规范为空，请保守处理，一律交给人类。）'}
${formatPrecedents(precedents)}

# 待审批工单

${JSON.stringify(
    {
      id: `#${ticket.id}`,
      env: ticket.env,
      projectName: ticket.projectName,
      doneSummary: ticket.doneSummary,
      blockerQuestion: ticket.blockerQuestion,
      nextStepPlan: ticket.nextStepPlan,
      options: ticket.options,
      recommendedOption: ticket.recommendedOption,
    },
    null,
    2,
  )}`;
}

function extractJsonObject(raw: string): string {
  const withoutFence = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new MetaAgentError('meta-agent response did not contain a JSON object');
  }
  return withoutFence.slice(start, end + 1);
}

/** Parse and validate the model's verdict. Never trusts the model blindly. */
export function parseMetaReview(raw: string, ticket: DecisionTicket): MetaReview {
  let payload: unknown;
  try {
    payload = JSON.parse(extractJsonObject(raw));
  } catch (error) {
    if (error instanceof MetaAgentError) throw error;
    throw new MetaAgentError(
      `meta-agent returned invalid JSON: ${(error as Error).message}`,
    );
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new MetaAgentError('meta-agent response must be a JSON object');
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.canResolve !== 'boolean') {
    throw new MetaAgentError('meta-agent response is missing boolean "canResolve"');
  }

  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';

  if (!record.canResolve) {
    return { canResolve: false, reason: reason || 'Meta-Agent 认为需要人工确认' };
  }

  const selectedOption =
    typeof record.selectedOption === 'string' ? record.selectedOption.trim() : '';

  const option = ticket.options.find((item) => item.key === selectedOption);
  if (!option) {
    return {
      canResolve: false,
      reason: `Meta-Agent 选择了不存在的选项 "${selectedOption}"，转人工确认`,
    };
  }

  if (option.risk === 'destructive') {
    return {
      canResolve: false,
      reason: `选项 ${selectedOption} 标记为 destructive，必须人工确认`,
    };
  }

  return {
    canResolve: true,
    selectedOption,
    reason: reason || '符合全局规范，自动采纳推荐方案',
  };
}

type FetchLike = typeof fetch;

/** OpenCode Go gateway routes on this header; one stable id per process is enough. */
const OPENCODE_SESSION_ID = randomUUID();

export function buildRequestHeaders(
  config: MetaAgentConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
  };

  // OpenCode Go (opencode.ai/inference/go) rejects requests without a client
  // identity and session id. Mirrors what pte-dojo sends to the same gateway.
  if (/opencode\.ai/i.test(config.baseUrl)) {
    headers['user-agent'] = 'zhunzou/0.1';
    headers['x-opencode-session'] = OPENCODE_SESSION_ID;
  }

  return headers;
}

/** Disable reasoning traces for DeepSeek so the reply stays strict JSON. */
function buildRequestBody(
  config: MetaAgentConfig,
  ticket: DecisionTicket,
  rules: string,
  precedents: DecisionTicket[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: 0,
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(ticket, rules, precedents) },
    ],
  };

  if (/deepseek/i.test(config.model)) {
    body.thinking = { type: 'disabled' };
  }

  return body;
}

function disabledAgent(reason: string): MetaAgent {
  return {
    async review() {
      return { canResolve: false, reason };
    },
  };
}

function openAiAgent(config: MetaAgentConfig, fetchImpl: FetchLike): MetaAgent {
  return {
    async review(ticket, rules, precedents = []) {
      if (!config.apiKey) {
        return { canResolve: false, reason: '未配置 OPENAI_API_KEY，跳过自动预审' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);

      try {
        const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { ...buildRequestHeaders(config), ...config.headers },
          body: JSON.stringify(
            buildRequestBody(config, ticket, rules, precedents),
          ),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new MetaAgentError(
            `LLM request failed (${response.status}): ${body.slice(0, 300)}`,
          );
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim() === '') {
          throw new MetaAgentError('LLM response contained no message content');
        }

        return parseMetaReview(content, ticket);
      } catch (error) {
        if (error instanceof MetaAgentError) throw error;
        if ((error as Error).name === 'AbortError') {
          throw new MetaAgentError(`LLM request timed out after ${config.timeoutMs}ms`);
        }
        throw new MetaAgentError(`LLM request failed: ${(error as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Generic HTTP provider: POST { ticket, rules } to META_AGENT_ENDPOINT and
 * expect { canResolve, selectedOption?, reason }. Lets users plug in any
 * model, workflow engine, or rules service without touching server code.
 */
function httpAgent(config: MetaAgentConfig, fetchImpl: FetchLike): MetaAgent {
  return {
    async review(ticket, rules, precedents = []) {
      if (!config.endpoint) {
        return {
          canResolve: false,
          reason: '未配置 META_AGENT_ENDPOINT，跳过自动预审',
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);

      try {
        const response = await fetchImpl(config.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...config.headers },
          body: JSON.stringify({
            ticket,
            rules,
            ...(precedents.length > 0 ? { precedents } : {}),
          }),
          signal: controller.signal,
        });

        const body = await response.text().catch(() => '');
        if (!response.ok) {
          throw new MetaAgentError(
            `meta-agent endpoint failed (${response.status}): ${body.slice(0, 300)}`,
          );
        }

        return parseMetaReview(body, ticket);
      } catch (error) {
        if (error instanceof MetaAgentError) throw error;
        if ((error as Error).name === 'AbortError') {
          throw new MetaAgentError(
            `meta-agent endpoint timed out after ${config.timeoutMs}ms`,
          );
        }
        throw new MetaAgentError(
          `meta-agent endpoint request failed: ${(error as Error).message}`,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createMetaAgent(
  config: MetaAgentConfig,
  fetchImpl: FetchLike = fetch,
): MetaAgent {
  if (config.provider === 'none') {
    return disabledAgent('Meta-Agent 已禁用（META_AGENT_PROVIDER=none）');
  }
  if (config.provider === 'http') {
    return httpAgent(config, fetchImpl);
  }
  return openAiAgent(config, fetchImpl);
}

