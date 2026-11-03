#!/usr/bin/env node
/**
 * End-to-end M3 acceptance test.
 *
 * Boots nothing itself: expects a real 准奏 server at HUB_URL.
 * - connects to bin/mcp.js over stdio using the official MCP client
 * - escalate → resolve via HTTP → tool returns the decision
 * - escalate → no answer → returns STILL_WAITING for agent_hub_wait
 * - notify_done → dashboard shows Idle
 * - spawns bin/cli.js wait → resolves via HTTP → CLI exits 0 with stdout
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HUB_URL = (process.env.HUB_URL ?? 'http://127.0.0.1:8789').replace(/\/+$/, '');
const TOKEN = process.env.HUB_TOKEN ?? 'bridge-smoke-token';
const BRIDGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MCP_BIN = join(BRIDGE_ROOT, 'bin', 'mcp.js');
const CLI_BIN = join(BRIDGE_ROOT, 'bin', 'cli.js');

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ok - ${message}`);
}

async function api(path, init = {}) {
  const response = await fetch(`${HUB_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function toolText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function payload(projectName) {
  return {
    env: 'smoke-test',
    projectName,
    doneSummary: '完成桥接器冒烟测试',
    blockerQuestion: '端侧 MCP 能否正确阻塞并接收决策？',
    nextStepPlan: '验证通过后进入 Milestone 4',
    options: [
      { key: 'A', label: '继续 M4', prosCons: '按计划推进' },
      { key: 'B', label: '先修 bug', prosCons: '更稳妥' },
    ],
    recommendedOption: 'A',
  };
}

async function waitForTicket(projectName) {
  for (let i = 0; i < 100; i += 1) {
    const list = await api(`/api/tickets?projectName=${encodeURIComponent(projectName)}`);
    const ticket = list.body?.tickets?.find((item) =>
      ['PENDING_META', 'PENDING_HUMAN'].includes(item.status),
    );
    if (ticket) return ticket;
    await sleep(100);
  }
  throw new Error(`ticket for ${projectName} was not created`);
}

async function main() {
  console.log(`zhunzou bridge smoke test → ${HUB_URL}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    env: {
      ...cleanEnv,
      HUB_URL,
      HUB_TOKEN: TOKEN,
      AGENT_ENV: 'smoke-mcp',
      AGENT_HUB_FALLBACK: 'mcp',
      AGENT_HUB_WAIT_TIMEOUT_MS: '4000',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    for (const line of String(chunk).trim().split('\n')) {
      console.log(`     [mcp] ${line}`);
    }
  });

  const client = new Client({ name: 'zhunzou-smoke', version: '1.0.0' });

  try {
    console.log('\n[1/7] MCP handshake + tool discovery');
    await withTimeout(client.connect(transport), 10_000, 'MCP connect');
    const { tools } = await client.listTools();
    assert(
      [
        'agent_hub_next_task',
        'agent_hub_complete_task',
        'agent_hub_report_task',
        'agent_hub_escalate',
        'agent_hub_wait',
        'agent_hub_notify_done',
      ].every((name) => tools.some((tool) => tool.name === name)),
      `all bridge tools exposed (${tools.length} total)`,
    );

    console.log('\n[2/7] escalate → human approves → tool returns decision');
    const projectA = `smoke-mcp-approve-${Date.now()}`;
    const escalate = client.callTool({
      name: 'agent_hub_escalate',
      arguments: payload(projectA),
    });
    const ticketA = await waitForTicket(projectA);
    assert(/^\d+$/.test(ticketA.id), `ticket created (#${ticketA.id})`);

    await sleep(200);
    const approveStarted = Date.now();
    const resolved = await api(`/api/tickets/${ticketA.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ selectedOption: 'B', customInstruction: '先修 bug' }),
    });
    assert(resolved.status === 200, 'approval accepted');

    const result = await withTimeout(escalate, 10_000, 'escalate result');
    const text = toolText(result);
    assert(!result.isError, 'escalate returned success');
    assert(text.includes('Decision Approved: Option [B]'), 'decision option B returned');
    assert(text.includes('Instruction: 先修 bug'), 'custom instruction returned');
    console.log(`     tool wake latency: ${Date.now() - approveStarted}ms`);
    assert(Date.now() - approveStarted < 1_000, 'tool woke in under 1s');

    console.log('\n[3/7] escalate → no answer → MCP relay instruction');
    const projectB = `smoke-mcp-timeout-${Date.now()}`;
    const timedOut = await withTimeout(
      client.callTool({ name: 'agent_hub_escalate', arguments: payload(projectB) }),
      15_000,
      'escalate timeout path',
    );
    const timeoutText = toolText(timedOut);
    assert(timeoutText.includes('[STATUS: STILL_WAITING]'), 'STILL_WAITING returned');
    assert(timeoutText.includes('agent_hub_wait(ticketId:'), 'relay instruction returned');

    const ticketB = await waitForTicket(projectB);
    await api(`/api/tickets/${ticketB.id}/cancel`, { method: 'POST' });
    assert(true, 'timed-out ticket cancelled');

    console.log('\n[4/7] dashboard dispatch → agent_hub_next_task → complete');
    const taskTitle = `smoke-task-${Date.now()}`;
    const dispatched = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        env: 'smoke-mcp',
        projectName: projectA,
        title: taskTitle,
        instruction: '验证人 → Agent 任务下发链路。',
      }),
    });
    assert(dispatched.status === 201, 'task dispatched from dashboard');

    const next = await withTimeout(
      client.callTool({ name: 'agent_hub_next_task', arguments: { timeoutMs: 4000 } }),
      10_000,
      'next_task',
    );
    const nextText = toolText(next);
    assert(!next.isError, 'next_task returned success');
    assert(nextText.includes('[TASK: RECEIVED]'), 'task received');
    assert(nextText.includes(taskTitle), 'dispatched task title returned');

    const complete = await client.callTool({
      name: 'agent_hub_complete_task',
      arguments: {
        taskId: dispatched.body.task.id,
        status: 'DONE',
        result: 'smoke task completed',
      },
    });
    assert(toolText(complete).includes('is now DONE'), 'task completion accepted');

    console.log('\n[5/7] agent_hub_notify_done → Idle');
    const done = await client.callTool({
      name: 'agent_hub_notify_done',
      arguments: { projectName: projectA, note: '冒烟测试完成' },
    });
    assert(toolText(done).includes('smoke-mcp is now Idle'), 'done notification accepted');

    const status = await api('/api/status');
    const env = status.body.envs.find((item) => item.env === 'smoke-mcp');
    assert(env?.status === 'Idle' && env?.online === true, 'dashboard shows Idle + online');

    console.log('\n[6/7] CLI wait → resolve → stdout decision');
    const projectC = `smoke-cli-${Date.now()}`;
    const created = await api('/api/tickets', {
      method: 'POST',
      body: JSON.stringify({ ...payload(projectC), env: 'smoke-cli' }),
    });
    assert(created.status === 201, 'CLI test ticket created');

    const child = spawn(
      process.execPath,
      [CLI_BIN, 'wait', '--ticket', created.body.ticket.id, '--interval', '1000'],
      {
        env: {
          ...cleanEnv,
          HUB_URL,
          HUB_TOKEN: TOKEN,
          AGENT_ENV: 'smoke-cli',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exitPromise = new Promise((resolve) => child.on('exit', resolve));

    await sleep(400);
    await api(`/api/tickets/${created.body.ticket.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ selectedOption: 'A' }),
    });

    const exitCode = await withTimeout(exitPromise, 15_000, 'CLI exit');
    assert(exitCode === 0, `CLI exited 0 (stderr: ${stderr.trim() || 'none'})`);
    assert(stdout.includes('Decision Approved: Option [A]'), 'CLI printed the decision to stdout');

    console.log('\n[7/7] teardown');
    await client.close();
    assert(true, 'MCP stdio connection closed');

    console.log('\nBRIDGE SMOKE TEST PASSED\n');
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  console.error(`\nBRIDGE SMOKE TEST FAILED: ${error.message}\n`);
  process.exit(1);
});
