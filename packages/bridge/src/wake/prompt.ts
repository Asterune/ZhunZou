import type { AgentTask } from '@zhunzou/shared';

function header(task: AgentTask): string {
  const project = task.projectName ?? '未指定项目';
  return [
    `环境：${task.env}`,
    `项目：${project}`,
    `标题：${task.title}`,
  ].join('\n');
}

/**
 * Prompt used when the daemon injects into a live session (OpenCode).
 *
 * The daemon has already claimed the task, so the agent must not call
 * `agent_hub_next_task` again — it would steal an unrelated task.
 */
export function buildInjectPrompt(task: AgentTask): string {
  return [
    `【准奏下发任务 #${task.id} · 已自动领取】`,
    header(task),
    '',
    '指令：',
    task.instruction,
    '',
    '这条任务已经由唤醒守护进程领取（状态 CLAIMED），不要再调用 agent_hub_next_task。',
    `请直接执行；完成后调用 agent_hub_complete_task(taskId: "${task.id}", status: "DONE", result: "简述改动与验证")。`,
    '如果执行失败，用 status: "FAILED" 说明原因；遇到需要人类拍板的卡点，按 AGENTS.md 调用 agent_hub_escalate。',
  ].join('\n');
}

/**
 * Prompt used when the daemon spawns a one-shot CLI agent.
 *
 * Exit status decides DONE / FAILED, so the prompt only needs the task body.
 */
export function buildRunPrompt(task: AgentTask): string {
  return [
    `【准奏下发任务 #${task.id}】`,
    header(task),
    '',
    '指令：',
    task.instruction,
    '',
    '请直接在当前工作区内完成上述任务，完成后输出一段简要总结（改了什么、如何验证）。',
    '如果遇到需要人类拍板的卡点，按项目规则调用 agent_hub_escalate 上奏并等待结果；不要自行决定不可逆操作。',
  ].join('\n');
}
