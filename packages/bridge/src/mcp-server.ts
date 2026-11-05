import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ticketOptionSchema } from '@zhunzou/shared';

import type { BridgeConfig } from './config.js';
import {
  formatApproved,
  formatCancelled,
  formatDispatchedTask,
  formatNoTask,
  formatResume,
  formatTaskCompleted,
  formatWaiting,
  renderToolError,
  renderToolResult,
} from './format.js';
import { HubApiError, type HubApi } from './hub-client.js';

import {
  createPresenceReporter,
  type PresenceReporter,
} from './presence.js';

const SERVER_NAME = 'zhunzou-bridge';
const SERVER_VERSION = '0.1.0';

function errorText(error: unknown): string {
  if (error instanceof HubApiError) {
    return `[ZHUNZOU_ERROR] ${error.code}: ${error.message}`;
  }
  return `[ZHUNZOU_ERROR] ${error instanceof Error ? error.message : String(error)}`;
}

const escalateInput = {
  projectName: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .describe('Project identifier, e.g. yikuaomed-erp'),
  doneSummary: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('Line 1: what was just completed, in one sentence'),
  blockerQuestion: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('Line 2: the blocker and the concrete question that needs a decision'),
  nextStepPlan: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('Line 3: what will be done after the decision'),
  options: z
    .array(ticketOptionSchema)
    .min(2)
    .max(6)
    .describe('Closed-form options (never open-ended questions)'),
  recommendedOption: z
    .string()
    .trim()
    .min(1)
    .max(8)
    .describe('Key of the option the agent recommends, e.g. A'),
};

const waitInput = {
  ticketId: z
    .union([z.string(), z.number()])
    .describe('Ticket id returned by agent_hub_escalate, e.g. 104'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(55_000)
    .optional()
    .describe('Single wait window in ms (default 40000, max 55000)'),
};

const notifyDoneInput = {
  projectName: z.string().trim().min(1).max(128).optional(),
  currentTask: z.string().trim().max(300).optional(),
  note: z.string().trim().max(500).optional(),
};

const nextTaskInput = {
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(55_000)
    .optional()
    .describe('Single wait window in ms (default 40000, max 55000)'),
};

const resumeInput = {
  sinceMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Only include terminal tickets updated after this Unix timestamp. Defaults to the last 24 hours.',
    ),
};

const completeTaskInput = {
  taskId: z
    .union([z.string(), z.number()])
    .describe('Task id returned by agent_hub_next_task, e.g. 12'),
  status: z
    .enum(['DONE', 'FAILED'])
    .optional()
    .describe('Outcome of the task; defaults to DONE'),
  result: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .describe('Short summary of what was done, or why it failed'),
};

const reportTaskInput = {
  currentTask: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe('What you are working on right now, in one short sentence'),
  projectName: z.string().trim().min(1).max(128).optional(),
  status: z
    .enum(['Running', 'Blocked', 'Idle'])
    .optional()
    .describe('Current env status; defaults to Running'),
};

const decideInput = {
  kind: z
    .enum(['reply', 'next_step', 'action'])
    .describe(
      'What you are asking about: a chat reply, the next development step, or a concrete action',
    ),
  proposal: z
    .string()
    .trim()
    .min(1)
    .max(32000)
    .describe(
      'The exact reply text, next step, or command you want to take. The hub rules on this verbatim.',
    ),
  rationale: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe('One line on why this is the right move'),
  context: z
    .string()
    .trim()
    .max(8000)
    .optional()
    .describe('Facts the hub should weigh: test output, diff summary, constraints'),
  risk: z
    .enum(['safe', 'caution', 'destructive'])
    .optional()
    .describe('Mark destructive for irreversible actions; those always go to a human'),
  options: z
    .array(ticketOptionSchema)
    .min(2)
    .max(6)
    .optional()
    .describe('Only when the choice is a genuine fork you cannot resolve'),
  recommendedOption: z
    .string()
    .trim()
    .min(1)
    .max(8)
    .optional()
    .describe('Key of the option you recommend; required when options are passed'),
  doneSummary: z.string().trim().max(2000).optional(),
  nextStepPlan: z.string().trim().max(2000).optional(),
};

const proposeReplyInput = {
  content: z
    .string()
    .trim()
    .min(1)
    .max(32000)
    .describe(
      'The exact reply you would send as the human next. It is stored as a draft and never sent until a human adopts it.',
    ),
  rationale: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe('One sentence on why this is the right next step'),
};

const reportExchangeInput = {
  question: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .optional()
    .describe("The human's request or follow-up question for this turn"),
  conclusion: z
    .string()
    .trim()
    .min(1)
    .max(20000)
    .optional()
    .describe('What you concluded or delivered in this turn'),
  projectName: z.string().trim().min(1).max(128).optional(),
};

export interface McpServerDependencies {
  client: HubApi;
  config: BridgeConfig;
  /** Optional injection point for tests; defaults to a real presence reporter. */
  presence?: PresenceReporter;
  logger?: (message: string) => void;
}

export function createMcpServer(deps: McpServerDependencies): McpServer {
  const { client, config } = deps;
  const log = deps.logger ?? ((message: string) => console.error(message));
  const presence =
    deps.presence ??
    createPresenceReporter(client, {
      intervalMs: config.heartbeatIntervalMs,
      ...(config.projectName ? { projectName: config.projectName } : {}),
      onError: (error) => log(`[zhunzou] heartbeat failed: ${(error as Error).message}`),
    });

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    'agent_hub_escalate',
    {
      title: 'Escalate a blocked decision to Zhunzou',
      description:
        'Use this when you are blocked on a decision that needs human input or an architecture-policy ruling. ' +
        'You MUST provide a three-line brief (doneSummary, blockerQuestion, nextStepPlan), at least two closed-form options, ' +
        'and a recommendedOption. Mark irreversible options with risk: "destructive" so they can never be auto-approved. ' +
        'The call blocks up to 40 seconds. ' +
        'If approved, it returns the final decision and instruction. If it times out, follow the returned waiting instruction exactly ' +
        '(run the CLI command or call agent_hub_wait again) before continuing.',
      inputSchema: escalateInput,
    },
    async (args) => {
      try {
        const ticket = await client.createTicket(args);

        // Dashboard nicety: show this env as blocked while waiting.
        presence.pause();
        void presence
          .beat({
            status: 'Blocked',
            projectName: args.projectName,
            currentTask: args.blockerQuestion.slice(0, 300),
          })
          .catch(() => undefined);

        log(
          `[zhunzou] ticket #${ticket.id} created for ${config.agentEnv}; waiting up to ${config.waitTimeoutMs}ms`,
        );

        const outcome = await client.wait(ticket.id, config.waitTimeoutMs);

        if (outcome.resolved) {
          log(`[zhunzou] ticket #${ticket.id} resolved with option ${outcome.ticket.selectedOption}`);
          void presence
            .beat({ status: 'Running', currentTask: '已获审批，恢复执行' })
            .catch(() => undefined);
          presence.resume();
          return renderToolResult(formatApproved(outcome.ticket));
        }
        if (outcome.ticket.status === 'CANCELLED') {
          void presence
            .beat({ status: 'Idle', currentTask: '工单已取消，等待新任务' })
            .catch(() => undefined);
          presence.resume();
          return renderToolResult(formatCancelled(outcome.ticket));
        }

        log(`[zhunzou] ticket #${ticket.id} still waiting; fallback=${config.fallback}`);
        presence.resume();
        return renderToolResult(
          formatWaiting(outcome.ticket, config.fallback, config.cliCommand),
        );
      } catch (error) {
        presence.resume();
        log(`[zhunzou] escalate failed: ${(error as Error).message}`);
        return renderToolError(errorText(error));
      }
    },
  );

  server.registerTool(
    'agent_hub_wait',
    {
      title: 'Keep waiting for an Zhunzou decision',
      description:
        'Continue waiting for an existing ticket. Use this only when a previous agent_hub_escalate call returned ' +
        '"[STATUS: STILL_WAITING]". It blocks up to 40 seconds and returns the decision, a cancellation notice, or another ' +
        '"still waiting" instruction to call this tool again.',
      inputSchema: waitInput,
    },
    async (args) => {
      try {
        presence.pause();
        void presence
          .beat({ status: 'Blocked', currentTask: '等待审批结果' })
          .catch(() => undefined);

        const outcome = await client.wait(String(args.ticketId), args.timeoutMs);

        if (outcome.resolved) {
          void presence
            .beat({ status: 'Running', currentTask: '已获审批，恢复执行' })
            .catch(() => undefined);
          presence.resume();
          return renderToolResult(formatApproved(outcome.ticket));
        }
        if (outcome.ticket.status === 'CANCELLED') {
          void presence
            .beat({ status: 'Idle', currentTask: '工单已取消，等待新任务' })
            .catch(() => undefined);
          presence.resume();
          return renderToolResult(formatCancelled(outcome.ticket));
        }

        // This tool is the MCP relay strategy: always ask the model to call it
        // again, regardless of the escalate fallback setting.
        presence.resume();
        return renderToolResult(formatWaiting(outcome.ticket, 'mcp'));
      } catch (error) {
        presence.resume();
        return renderToolError(errorText(error));
      }
    },
  );

  server.registerTool(
    'agent_hub_resume',
    {
      title: 'Recover pending Zhunzou decisions and tasks after a restart',
      description:
        'Call this at the start of a new session or after a reconnect. It returns pending/recent tickets and ' +
        'still-active tasks for this environment, so you can resume waiting or continue dispatched work without ' +
        'losing context.',
      inputSchema: resumeInput,
    },
    async (args) => {
      try {
        const resume = await client.resume(args.sinceMs);
        const active = resume.tasks.find((task) => task.status === 'CLAIMED');

        if (active) {
          void presence
            .beat({
              status: 'Running',
              ...(active.projectName ? { projectName: active.projectName } : {}),
              currentTask: active.title,
            })
            .catch(() => undefined);
        }

        log(
          `[zhunzou] resume for ${config.agentEnv}: ${resume.tickets.length} ticket(s), ${resume.tasks.length} task(s)`,
        );
        return renderToolResult(formatResume(resume));
      } catch (error) {
        return renderToolError(errorText(error));
      }
    },
  );

  server.registerTool(
    'agent_hub_next_task',
    {
      title: 'Pick up a task dispatched from the Zhunzou dashboard',
      description:
        'Call this when you are idle or starting a new session. It long-polls for a task the human dispatched to this ' +
        'environment and blocks up to 40 seconds. If a task is returned, execute its instruction, then call ' +
        'agent_hub_complete_task. If no task is waiting, it returns "[STATUS: NO_TASK]".',
      inputSchema: nextTaskInput,
    },
    async (args) => {
      try {
        presence.pause();
        const outcome = await client.nextTask(args.timeoutMs ?? config.waitTimeoutMs);

        if (!outcome.task) {
          presence.resume();
          return renderToolResult(formatNoTask(config.agentEnv));
        }

        const task = outcome.task;
        void presence
          .beat({
            status: 'Running',
            ...(task.projectName ? { projectName: task.projectName } : {}),
            currentTask: task.title,
          })
          .catch(() => undefined);
        presence.resume();
        log(`[zhunzou] task #${task.id} dispatched to ${config.agentEnv}`);
        return renderToolResult(formatDispatchedTask(task));
      } catch (error) {
        presence.resume();
        log(`[zhunzou] next_task failed: ${(error as Error).message}`);
        return renderToolError(errorText(error));
      }
    },
  );

  server.registerTool(
    'agent_hub_complete_task',
    {
      title: 'Mark a dispatched task as done or failed',
      description:
        'Call this after finishing (or failing) a task returned by agent_hub_next_task. It records the result and turns ' +
        'the dashboard status light for this environment back to Idle.',
      inputSchema: completeTaskInput,
    },
    async (args) => {
      try {
        const task = await client.completeTask(String(args.taskId), {
          status: args.status ?? 'DONE',
          ...(args.result ? { result: args.result } : {}),
        });

        void presence
          .beat({
            status: 'Idle',
            ...(task.projectName ? { projectName: task.projectName } : {}),
            currentTask: '任务已完成，等待新任务',
          })
          .catch(() => undefined);

        return renderToolResult(formatTaskCompleted(task));
      } catch (error) {
        return renderToolError(errorText(error));
      }
    },
  );

  server.registerTool(
    'agent_hub_report_task',
    {
      title: 'Report the current task to Zhunzou',
      description:
        'Call this when you start working on something that was not dispatched by Zhunzou (for example a prompt typed ' +
        'directly in the IDE). It updates the dashboard env card with the real current task instead of the default ' +
        '"waiting for task" label.',
      inputSchema: reportTaskInput,
    },
    async (args) => {
      try {
        const heartbeat = await presence.beat({
          status: args.status ?? 'Running',
          ...(args.projectName ? { projectName: args.projectName } : {}),
          currentTask: args.currentTask,
        });

        return renderToolResult(
          `Zhunzou status updated: ${heartbeat.env} is now ${heartbeat.status} (${args.currentTask}).`,
        );
      } catch (error) {
        return renderToolError(errorText(error));
      }
    },
  );

  server.registerTool(
    'agent_hub_report_exchange',
    {
      title: 'Mirror this turn to the Zhunzou dashboard',
      description:
        "Call this once per turn after you answer the human, so the dashboard's conversation view shows what was asked " +
        'and what you concluded. Interactive IDE chats do not stream their transcript, so this summary is the only way ' +
        'the human can follow the work from the hub. Keep the conclusion short (a few sentences), skip secrets, and pass ' +
        'at least one of question / conclusion.',
      inputSchema: reportExchangeInput,
    },
    async (args) => {
      try {
        const exchange = await client.reportExchange({
          ...(args.question ? { question: args.question } : {}),
          ...(args.conclusion ? { conclusion: args.conclusion } : {}),
          ...(args.projectName ? { projectName: args.projectName } : {}),
        });

        return renderToolResult(
          `Zhunzou exchange #${exchange.id} synced from ${exchange.env}.`,
        );
      } catch (error) {
        return renderToolError(errorText(error));
      }
    },
  );

  server.registerTool(
    'agent_hub_notify_done',
    {
      title: 'Report task completion to Zhunzou',
      description:
        'Call this when the current task is finished or you are going idle. It turns the dashboard status light for this ' +
        'environment to Idle.',
      inputSchema: notifyDoneInput,
    },
    async (args) => {
      try {
        const heartbeat = await presence.beat({
          status: 'Idle',
          ...(args.projectName ? { projectName: args.projectName } : {}),
          currentTask: args.currentTask ?? '已空闲，等待新任务',
          ...(args.note ? { note: args.note } : {}),
        });

        return renderToolResult(
          `Zhunzou status updated: ${heartbeat.env} is now ${heartbeat.status}.`,
        );
      } catch (error) {
        return renderToolError(errorText(error));
      }
    },
  );

  server.registerTool(
    'agent_hub_decide',
    {
      title: 'Ask the hub to rule on the next move',
      description:
        'Call this before any non-trivial action or chat reply. Do not decide on your own whether to act or to ask a ' +
        'human — the hub holds the policy, rules and precedents. Submit the exact reply/step/command you want to take ' +
        'plus the facts (test output, diff summary, constraints). It returns either "[DECISION: APPROVED]" (proceed) ' +
        'or a ticket waiting for a human, in which case keep waiting with agent_hub_wait.',
      inputSchema: decideInput,
    },
    async (args) => {
      try {
        const outcome = await client.decide({
          kind: args.kind,
          proposal: args.proposal,
          ...(args.rationale ? { rationale: args.rationale } : {}),
          ...(args.context ? { context: args.context } : {}),
          ...(args.risk ? { risk: args.risk } : {}),
          ...(args.options ? { options: args.options } : {}),
          ...(args.recommendedOption
            ? { recommendedOption: args.recommendedOption }
            : {}),
          ...(args.doneSummary ? { doneSummary: args.doneSummary } : {}),
          ...(args.nextStepPlan ? { nextStepPlan: args.nextStepPlan } : {}),
        });

        if (outcome.verdict === 'APPROVED') {
          return renderToolResult(
            [
              '[DECISION: APPROVED]',
              `Reason: ${outcome.reason}`,
              ...(outcome.selectedOption
                ? [`Selected option: ${outcome.selectedOption}`]
                : []),
              'Proceed now. Do not ask the human again for this step.',
            ].join('\n'),
          );
        }

        const ticket = outcome.ticket;
        if (!ticket) {
          return renderToolResult(
            `[DECISION: PENDING] ${outcome.reason}\n等待人工裁决后再继续。`,
          );
        }

        presence.pause();
        void presence
          .beat({
            status: 'Blocked',
            currentTask: args.proposal.slice(0, 300),
          })
          .catch(() => undefined);

        log(
          `[zhunzou] decision escalated to ticket #${ticket.id} for ${config.agentEnv}`,
        );
        const waited = await client.wait(ticket.id, config.waitTimeoutMs);
        presence.resume();

        if (waited.resolved) {
          void presence
            .beat({ status: 'Running', currentTask: '已获裁决，恢复执行' })
            .catch(() => undefined);
          return renderToolResult(formatApproved(waited.ticket));
        }
        if (waited.ticket.status === 'CANCELLED') {
          void presence
            .beat({ status: 'Idle', currentTask: '工单已取消，等待新指令' })
            .catch(() => undefined);
          return renderToolResult(formatCancelled(waited.ticket));
        }

        return renderToolResult(
          formatWaiting(waited.ticket, config.fallback, config.cliCommand),
        );
      } catch (error) {
        presence.resume();
        log(`[zhunzou] decide failed: ${(error as Error).message}`);
        return renderToolError(errorText(error));
      }
    },
  );

  server.registerTool(
    'agent_hub_propose_reply',
    {
      title: 'Draft the next reply for the human to adopt',
      description:
        'Use this at the end of a turn when you can see the obvious next step: write the reply the human would send, ' +
        'instead of asking them to type it. Zhunzou stores it as a draft and the human adopts, edits or discards it in ' +
        'the dashboard; nothing is delivered to the agent until they do. Do not use this for decisions that need a ' +
        'ruling — call agent_hub_escalate for those.',
      inputSchema: proposeReplyInput,
    },
    async (args) => {
      try {
        const response = await client.proposeChatReply({
          content: args.content,
          ...(args.rationale ? { rationale: args.rationale } : {}),
        });

        return renderToolResult(
          `已提交待采纳草稿 #${response.message.id}（会话 #${response.session.id}）：${args.rationale ?? '等待人工采纳'}`,
        );
      } catch (error) {
        return renderToolError(errorText(error));
      }
    },
  );

  return server;
}
