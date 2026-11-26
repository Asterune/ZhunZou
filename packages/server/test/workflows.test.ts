import { describe, expect, it } from 'vitest';

import type { AgentTask, Workflow, WorkflowRun } from '@zhunzou/shared';

import { createTestContext } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function createWorkflow(ctx: Ctx): Promise<Workflow> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: ctx.auth,
    payload: {
      projectName: 'agent-hub',
      name: '设计到编码',
      steps: [
        {
          name: '设计',
          role: 'design',
          env: 'agent-a',
          instruction: '设计：{{previous}}',
        },
        {
          name: '编码',
          role: 'code',
          env: 'agent-b',
          model: 'test-model',
          instruction: '按方案实现：{{previous}}',
        },
      ],
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().workflow as Workflow;
}

async function claim(ctx: Ctx, env: string): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/next?env=${env}&timeout=10`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  const task = (response.json() as { task: AgentTask | null }).task;
  expect(task).not.toBeNull();
  return task!;
}

async function complete(
  ctx: Ctx,
  task: AgentTask,
  status: 'DONE' | 'FAILED',
  result: string,
): Promise<void> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/tasks/${task.id}/complete`,
    headers: ctx.auth,
    payload: { status, result },
  });
  expect(response.statusCode).toBe(200);
}

async function getRun(ctx: Ctx, id: string): Promise<WorkflowRun> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/workflow-runs/${id}`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return response.json().run as WorkflowRun;
}

describe('linear workflows', () => {
  it('runs each step in order and hands the result to the next one', async () => {
    const ctx = await createTestContext();
    try {
      const workflow = await createWorkflow(ctx);

      const started = await ctx.app.inject({
        method: 'POST',
        url: `/api/workflows/${workflow.id}/runs`,
        headers: ctx.auth,
        payload: { brief: '给登录页加校验' },
      });
      expect(started.statusCode).toBe(201);
      let run = started.json().run as WorkflowRun;
      expect(run.status).toBe('RUNNING');
      expect(run.tasks).toHaveLength(1);

      const design = await claim(ctx, 'agent-a');
      expect(design.instruction).toBe('设计：给登录页加校验');

      await complete(ctx, design, 'DONE', '方案：在提交前校验邮箱与密码长度');

      run = await getRun(ctx, run.id);
      expect(run.stepIndex).toBe(1);
      expect(run.tasks).toHaveLength(2);
      expect(run.tasks[0]).toMatchObject({
        taskId: design.id,
        status: 'DONE',
      });

      const code = await claim(ctx, 'agent-b');
      expect(code.instruction).toContain('按方案实现：');
      expect(code.instruction).toContain('校验邮箱与密码长度');
      expect(code.model).toBe('test-model');

      await complete(ctx, code, 'DONE', '已实现');
      run = await getRun(ctx, run.id);
      expect(run.status).toBe('DONE');
      expect(run.tasks.map((item) => item.status)).toEqual(['DONE', 'DONE']);
    } finally {
      await ctx.close();
    }
  });

  it('stops the run when a step fails', async () => {
    const ctx = await createTestContext();
    try {
      const workflow = await createWorkflow(ctx);
      const started = await ctx.app.inject({
        method: 'POST',
        url: `/api/workflows/${workflow.id}/runs`,
        headers: ctx.auth,
        payload: {},
      });
      const run = started.json().run as WorkflowRun;

      const design = await claim(ctx, 'agent-a');
      await complete(ctx, design, 'FAILED', '无法继续');

      const after = await getRun(ctx, run.id);
      expect(after.status).toBe('FAILED');
      expect(after.error).toContain('无法继续');
      expect(after.tasks).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  it('rejects a workflow with fewer than two steps', async () => {
    const ctx = await createTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: ctx.auth,
        payload: {
          projectName: 'agent-hub',
          name: '太短',
          steps: [
            {
              name: '一步',
              role: 'custom',
              env: 'agent-a',
              instruction: '做点事',
            },
          ],
        },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});
