import {
  DIAGNOSIS_SUMMARY_MAX_CHARS,
  SUPERVISOR_RETRY_CEILING,
  SUPERVISOR_SIGNATURE_SIMILARITY,
  supervisorDiagnosisSchema,
  type AgentTask,
  type SupervisorDiagnosis,
  type TaskLog,
} from '@zhunzou/shared';

import type { MetaAgentConfig } from '../config.js';
import { buildRequestHeaders, extractJsonObject } from '../meta-agent.js';
import { textSimilarity } from '../repository.js';

/**
 * L2: the diagnosis layer, read when a dispatched run reports FAILED.
 *
 * Two halves, in this order. The breaker is pure arithmetic over evidence the
 * hub already holds — a run that is provably going in circles gets stopped in
 * 0ms and 0 tokens, without ever waking a model. Only what the breaker cannot
 * judge is asked of the model, and an answer it cannot justify (invalid JSON,
 * timeout, provider off) changes nothing at all: the task stays exactly where
 * the engine left it.
 */

/** One attempt the supervisor itself acted on, oldest first. */
export interface HealRecord {
  diagnosis: string;
  errorSignature?: string;
  diffHash?: string;
}

export interface FailureEvidence {
  task: AgentTask;
  /** The newest error signature this attempt reported — its own conclusion. */
  lastSignature?: string;
  /** The newest worktree fingerprint this attempt reported. */
  lastDiffHash?: string;
  /** Rows the supervisor wrote, oldest→newest; each stands for one handled attempt. */
  heals: HealRecord[];
  /** De-noised tail of the run, already inside the prompt budget. */
  logTail: string;
}

/** How much raw output one diagnosis may spend reading. */
export const LOG_TAIL_CHARS = 2_000;

const MAX_TITLE_CHARS = 120;
const MAX_INSTRUCTION_CHARS = 500;
const MAX_SIGNATURE_CHARS = 300;
const MAX_DIAGNOSIS_CHARS = 200;

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/* ------------------------------------------------------------------ */
/* The breaker: three conditions, no model                             */
/* ------------------------------------------------------------------ */

function lastHeal(evidence: FailureEvidence): HealRecord | undefined {
  return evidence.heals.at(-1);
}

/**
 * Why this run must stop being retried automatically, or `undefined` when the
 * evidence does not condemn it. Checked in order of cost and confidence: the
 * counter never needs the node, the two comparisons stay silent without it.
 */
export function evaluateBreaker(evidence: FailureEvidence): string | undefined {
  if (evidence.task.retryCount >= SUPERVISOR_RETRY_CEILING) {
    return `自动重试次数已用尽（已自愈 ${evidence.task.retryCount} 次），停止重跑`;
  }

  const previous = lastHeal(evidence);
  if (previous?.errorSignature && evidence.lastSignature) {
    const similarity = textSimilarity(evidence.lastSignature, previous.errorSignature);
    if (similarity > SUPERVISOR_SIGNATURE_SIMILARITY) {
      return `连续两次失败是同一个错（相似度 ${similarity.toFixed(2)}）：${clip(
        evidence.lastSignature,
        MAX_SIGNATURE_CHARS,
      )}`;
    }
  }

  if (previous?.diffHash && evidence.lastDiffHash) {
    if (previous.diffHash === evidence.lastDiffHash) {
      return '两次尝试之间工作树没有任何变化，重跑不会有新结果';
    }
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

/**
 * Reduce a task's log rows to what a judgment needs. `logs` is oldest→newest,
 * as `listTaskLogs` returns it; the trimmer only ever drops the oldest rows,
 * so everything looked at here is the freshest evidence available.
 */
export function collectEvidence(
  task: AgentTask,
  logs: readonly TaskLog[],
): FailureEvidence {
  let lastSignature: string | undefined;
  let lastDiffHash: string | undefined;

  const heals: HealRecord[] = [];
  for (const log of logs) {
    if (log.errorSignature) lastSignature = log.errorSignature;
    if (log.diffHash) lastDiffHash = log.diffHash;

    // A row carrying a diagnosis is the supervisor's own, so it stands for one
    // handled attempt. Engine rows are evidence; they are never attempts.
    if (log.diagnosis) {
      heals.push({
        diagnosis: log.diagnosis,
        ...(log.errorSignature ? { errorSignature: log.errorSignature } : {}),
        ...(log.diffHash ? { diffHash: log.diffHash } : {}),
      });
    }
  }

  const joined = logs.map((log) => log.chunk).join('\n');

  return {
    task,
    ...(lastSignature ? { lastSignature } : {}),
    ...(lastDiffHash ? { lastDiffHash } : {}),
    heals,
    logTail: clipTail(joined, LOG_TAIL_CHARS),
  };
}

/** Keep the end: the last words a run says are the ones that killed it. */
function clipTail(value: string, max: number): string {
  const trimmed = value.trimEnd();
  return trimmed.length > max ? `…${trimmed.slice(trimmed.length - (max - 1))}` : trimmed;
}

/* ------------------------------------------------------------------ */
/* The question                                                        */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `你是无人值守 Agent 集群的「总管」，负责判断一次失败的运行下一步该怎么办。

只能输出一个 JSON 对象，不要 Markdown、代码块或任何解释：
{"decision":"APPROVE"|"RETRY_WITH_FIX"|"ESCALATE_TO_HUMAN","diagnosisSummary":"一句话中文诊断","fixPrompt":"仅在 RETRY_WITH_FIX 时必填","errorSignature":"归一化后的错误特征"}

约束：
1. diagnosisSummary 不超过 ${DIAGNOSIS_SUMMARY_MAX_CHARS} 个字符，给人看的收件箱标题。
2. 你没有否决权，也没有改代码的手：RETRY_WITH_FIX 只是把任务重新排队，并把 fixPrompt 交给下一次运行的引擎。
3. 只有当证据说明「知道该改什么」时才选 RETRY_WITH_FIX；同一个错反复出现、或者方向本身需要人来拍板时选 ESCALATE_TO_HUMAN。
4. 失败本身是合理结果（例如按要求跑测试、测试如实报了错）时选 APPROVE，什么都不做。
5. fixPrompt 写给引擎，说明这次要改哪里、怎么验证，不要复述原始需求。`;

/** Everything the model is allowed to see, and nothing more. */
export function buildDiagnosisMessages(
  evidence: FailureEvidence,
): { system: string; user: string } {
  const task = evidence.task;
  const previousHeal = lastHeal(evidence);

  const lines = [
    `# 失败的任务`,
    `标题：${clip(task.title, MAX_TITLE_CHARS)}`,
    `指令：${clip(task.instruction, MAX_INSTRUCTION_CHARS)}`,
    `环境：${task.env} · 引擎：${task.engine ?? '未指定'} · 已领取 ${task.attempts} 次 · 已自愈 ${task.retryCount} 次`,
    '',
    `# 证据`,
    `错误特征：${evidence.lastSignature ? clip(evidence.lastSignature, MAX_SIGNATURE_CHARS) : '（节点未上报）'}`,
    `上次诊断：${previousHeal ? clip(previousHeal.diagnosis, MAX_DIAGNOSIS_CHARS) : '（管家没有处置过）'}`,
    `工作树指纹：${evidence.lastDiffHash ?? '（节点未上报）'}`,
    '',
    `# 尾部输出（已降噪，最新在最后）`,
    clipTail(evidence.logTail, LOG_TAIL_CHARS) || '（没有日志）',
  ];

  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}

/** Strict JSON in, validated diagnosis out; anything else is not a verdict. */
export function parseDiagnosis(raw: string): SupervisorDiagnosis | undefined {
  try {
    const parsed = supervisorDiagnosisSchema.safeParse(
      JSON.parse(extractJsonObject(raw)) as unknown,
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* The client                                                          */
/* ------------------------------------------------------------------ */

export interface HealerLogger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface SupervisorHealer {
  /** `undefined` = no verdict; the caller must leave the task alone. */
  diagnose(evidence: FailureEvidence): Promise<SupervisorDiagnosis | undefined>;
}

const MAX_DIAGNOSIS_TOKENS = 800;

type FetchLike = typeof fetch;

function buildRequestBody(
  config: MetaAgentConfig,
  evidence: FailureEvidence,
): Record<string, unknown> {
  const { system, user } = buildDiagnosisMessages(evidence);
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: 0,
    max_tokens: MAX_DIAGNOSIS_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  if (/deepseek/i.test(config.model)) {
    body.thinking = { type: 'disabled' };
  }

  return body;
}

async function requestJson(
  config: MetaAgentConfig,
  input: { url: string; body: unknown; headers: Record<string, string> },
  fetchImpl: FetchLike,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(input.url, {
      method: 'POST',
      headers: input.headers,
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`diagnosis request failed (${response.status}): ${text.slice(0, 200)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function diagnoseOpenAi(
  config: MetaAgentConfig,
  evidence: FailureEvidence,
  fetchImpl: FetchLike,
): Promise<SupervisorDiagnosis | undefined> {
  const text = await requestJson(
    config,
    {
      url: `${config.baseUrl}/chat/completions`,
      body: buildRequestBody(config, evidence),
      headers: { ...buildRequestHeaders(config), ...config.headers },
    },
    fetchImpl,
  );

  let content: unknown;
  try {
    content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> })
      .choices?.[0]?.message?.content;
  } catch {
    return undefined;
  }

  return typeof content === 'string' ? parseDiagnosis(content) : undefined;
}

async function diagnoseHttp(
  config: MetaAgentConfig,
  evidence: FailureEvidence,
  fetchImpl: FetchLike,
): Promise<SupervisorDiagnosis | undefined> {
  const text = await requestJson(
    config,
    {
      url: config.endpoint,
      body: {
        type: 'diagnose',
        task: evidence.task,
        evidence: {
          lastSignature: evidence.lastSignature,
          lastDiffHash: evidence.lastDiffHash,
          heals: evidence.heals,
          logTail: evidence.logTail,
        },
      },
      headers: { 'content-type': 'application/json', ...config.headers },
    },
    fetchImpl,
  );

  return parseDiagnosis(text);
}

export function createHealer(
  config: MetaAgentConfig,
  fetchImpl: FetchLike = fetch,
  logger?: HealerLogger,
): SupervisorHealer {
  return {
    async diagnose(evidence) {
      // Unlike the rule distiller there is no deterministic fallback here: a
      // "retry" nobody based on evidence is the exact loop the breaker exists
      // to prevent.
      if (config.provider === 'none') return undefined;
      if (config.provider === 'openai' && !config.apiKey) return undefined;
      if (config.provider === 'http' && !config.endpoint) return undefined;

      try {
        return config.provider === 'http'
          ? await diagnoseHttp(config, evidence, fetchImpl)
          : await diagnoseOpenAi(config, evidence, fetchImpl);
      } catch (error) {
        logger?.warn(
          { err: (error as Error).message, task: evidence.task.id },
          'L2 diagnosis failed; leaving the task as the engine reported it',
        );
        return undefined;
      }
    },
  };
}
