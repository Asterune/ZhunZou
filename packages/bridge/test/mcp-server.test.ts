import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import type { EnvHeartbeat } from '@zhunzou/shared';

import { HubApiError, type HubApi } from '../src/hub-client.js';
import { createMcpServer } from '../src/mcp-server.js';
import { makeTask, makeTicket, testConfig } from './helpers.js';

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

function textOf(result: unknown): string {
  const typed = result as ToolResult;
  return (typed.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}

async function connect(client: HubApi, fallback: 'cli' | 'mcp' = 'cli') {
  const config = testConfig({ fallback });
  const server = createMcpServer({ client, config, logger: () => undefined });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'bridge-test', version: '1.0.0' });

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  return {
    mcpClient,
    close: async () => {
      await mcpClient.close();
      await server.close();
    },
  };
}

function heartbeat(status: EnvHeartbeat['status'] = 'Idle'): EnvHeartbeat {
  return {
    env: 'company-cursor',
    status,
    projectName: 'yikuaomed-erp',
    lastSeenAt: Date.now(),
    online: true,
  };
}

function fakeHub(overrides: Partial<HubApi> = {}): HubApi {
  return {
    createTicket: vi.fn(async () => makeTicket({ status: 'PENDING_META' })),
    wait: vi.fn(async () => ({
      resolved: true,
      timedOut: false,
      ticket: makeTicket({
        status: 'HUMAN_RESOLVED',
        selectedOption: 'B',
        customInstruction: '先只改登录页',
        resolvedBy: 'HUMAN',
      }),
    })),
    heartbeat: vi.fn(async (input: { status: EnvHeartbeat['status'] }) =>
      heartbeat(input.status),
    ),
    nextTask: vi.fn(async () => ({
      task: makeTask(),
      timedOut: false,
    })),
    completeTask: vi.fn(async () =>
      makeTask({ status: 'DONE', result: '已补测试', completedAt: 3 }),
    ),
    resume: vi.fn(async () => ({
      tickets: [makeTicket(), makeTicket({ status: 'AUTO_RESOLVED', selectedOption: 'A' })],
      tasks: [makeTask()],
    })),
    ...overrides,
  };
}

const escalateArgs = {
  projectName: 'yikuaomed-erp',
  doneSummary: '完成登录页表单校验',
  blockerQuestion: '错误提示用 Toast 还是行内文案？',
  nextStepPlan: '确定后接入统一错误处理',
  options: [
    { key: 'A', label: 'Toast 提示' },
    { key: 'B', label: '行内文案' },
  ],
  recommendedOption: 'A',
};

describe('MCP tool registration', () => {
  it('exposes the bridge tools', async () => {
    const { mcpClient, close } = await connect(fakeHub());
    try {
      const { tools } = await mcpClient.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'agent_hub_complete_task',
        'agent_hub_escalate',
        'agent_hub_next_task',
        'agent_hub_notify_done',
        'agent_hub_report_task',
        'agent_hub_resume',
        'agent_hub_wait',
      ]);
    } finally {
      await close();
    }
  });
});

describe('agent_hub_resume', () => {
  it('returns pending tickets, active tasks and recent decisions', async () => {
    const client = fakeHub();
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_resume',
        arguments: {},
      });
      const text = textOf(result);

      expect(client.resume).toHaveBeenCalledWith(undefined);
      expect(text).toContain('[RESUME]');
      expect(text).toContain('agent_hub_wait(ticketId: 104)');
      expect(text).toContain('Active tasks');
      expect(text).toContain('Recently resolved');
    } finally {
      await close();
    }
  });

  it('passes through the since timestamp', async () => {
    const client = fakeHub();
    const { mcpClient, close } = await connect(client);

    try {
      await mcpClient.callTool({
        name: 'agent_hub_resume',
        arguments: { sinceMs: 1_700_000_000_000 },
      });
      expect(client.resume).toHaveBeenCalledWith(1_700_000_000_000);
    } finally {
      await close();
    }
  });
});

describe('agent_hub_escalate', () => {
  it('creates a ticket, marks the env Blocked, and returns the decision', async () => {
    const client = fakeHub();
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_escalate',
        arguments: escalateArgs,
      });

      const text = textOf(result);
      expect((result as ToolResult).isError).toBeFalsy();
      expect(text).toContain('Decision Approved: Option [B] - 行内文案');
      expect(text).toContain('Instruction: 先只改登录页');
      expect(client.createTicket).toHaveBeenCalledWith(escalateArgs);
      expect(client.wait).toHaveBeenCalledWith('104', 40_000);
      expect(client.heartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'Blocked', projectName: 'yikuaomed-erp' }),
      );
    } finally {
      await close();
    }
  });

  it('returns the CLI fallback instruction after a timeout', async () => {
    const client = fakeHub({
      wait: vi.fn(async () => ({
        resolved: false,
        timedOut: true,
        ticket: makeTicket(),
      })),
    });
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_escalate',
        arguments: escalateArgs,
      });

      const text = textOf(result);
      expect(text).toContain('npx zhunzou-bridge wait --ticket 104');
      expect((result as ToolResult).isError).toBeFalsy();
    } finally {
      await close();
    }
  });

  it('returns the MCP relay instruction when configured', async () => {
    const client = fakeHub({
      wait: vi.fn(async () => ({
        resolved: false,
        timedOut: true,
        ticket: makeTicket(),
      })),
    });
    const { mcpClient, close } = await connect(client, 'mcp');

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_escalate',
        arguments: escalateArgs,
      });
      expect(textOf(result)).toContain("agent_hub_wait(ticketId: 104)");
    } finally {
      await close();
    }
  });

  it('surfaces hub failures as a tool error', async () => {
    const client = fakeHub({
      createTicket: vi.fn(async () => {
        throw new HubApiError(401, 'UNAUTHORIZED', 'bad token');
      }),
    });
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_escalate',
        arguments: escalateArgs,
      });
      expect((result as ToolResult).isError).toBe(true);
      expect(textOf(result)).toContain('UNAUTHORIZED');
      expect(textOf(result)).toContain('bad token');
    } finally {
      await close();
    }
  });
});

describe('agent_hub_wait', () => {
  it('waits on the requested ticket and returns the decision', async () => {
    const client = fakeHub();
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_wait',
        arguments: { ticketId: 104, timeoutMs: 5000 },
      });

      expect(textOf(result)).toContain('Option [B]');
      expect(client.wait).toHaveBeenCalledWith('104', 5000);
    } finally {
      await close();
    }
  });

  it('returns STILL_WAITING when this window also expires', async () => {
    const client = fakeHub({
      wait: vi.fn(async () => ({
        resolved: false,
        timedOut: true,
        ticket: makeTicket(),
      })),
    });
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_wait',
        arguments: { ticketId: '104' },
      });
      expect(textOf(result)).toContain('[STATUS: STILL_WAITING]');
    } finally {
      await close();
    }
  });
});

describe('agent_hub_notify_done', () => {
  it('sets the dashboard status to Idle', async () => {
    const client = fakeHub();
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_notify_done',
        arguments: { projectName: 'yikuaomed-erp', note: '全部完成' },
      });

      expect(textOf(result)).toContain('company-cursor is now Idle');
      expect(client.heartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'Idle', projectName: 'yikuaomed-erp' }),
      );
    } finally {
      await close();
    }
  });
});

describe('agent_hub_next_task', () => {
  it('claims a dispatched task and reports it as Running', async () => {
    const client = fakeHub();
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_next_task',
        arguments: { timeoutMs: 5000 },
      });

      const text = textOf(result);
      expect(text).toContain('[TASK: RECEIVED] #12');
      expect(text).toContain('给登录页补错误提示');
      expect(text).toContain('agent_hub_complete_task(taskId: 12');
      expect(client.nextTask).toHaveBeenCalledWith(5000);
      expect(client.heartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'Running', currentTask: '给登录页补错误提示' }),
      );
    } finally {
      await close();
    }
  });

  it('returns NO_TASK when the queue is empty', async () => {
    const client = fakeHub({
      nextTask: vi.fn(async () => ({ task: null, timedOut: true })),
    });
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_next_task',
        arguments: {},
      });
      expect(textOf(result)).toContain('[STATUS: NO_TASK]');
    } finally {
      await close();
    }
  });
});

describe('agent_hub_complete_task', () => {
  it('marks the task done and returns the env to Idle', async () => {
    const client = fakeHub();
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_complete_task',
        arguments: { taskId: 12, status: 'DONE', result: '已补测试' },
      });

      expect(textOf(result)).toContain('Task #12 is now DONE');
      expect(client.completeTask).toHaveBeenCalledWith('12', {
        status: 'DONE',
        result: '已补测试',
      });
      expect(client.heartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'Idle', currentTask: '任务已完成，等待新任务' }),
      );
    } finally {
      await close();
    }
  });
});

describe('agent_hub_report_task', () => {
  it('updates the dashboard with the real current task', async () => {
    const client = fakeHub();
    const { mcpClient, close } = await connect(client);

    try {
      const result = await mcpClient.callTool({
        name: 'agent_hub_report_task',
        arguments: { currentTask: '修复登录页校验', projectName: 'yikuaomed-erp' },
      });

      expect(textOf(result)).toContain('is now Running');
      expect(client.heartbeat).toHaveBeenCalledWith({
        status: 'Running',
        projectName: 'yikuaomed-erp',
        currentTask: '修复登录页校验',
      });
    } finally {
      await close();
    }
  });
});
