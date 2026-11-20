import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DecisionTicket } from '@zhunzou/shared';

import { textSimilarity } from '../src/repository.js';
import {
  createTestContext,
  ticketInput,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

async function createTicket(
  overrides: Parameters<typeof ticketInput>[0] = {},
): Promise<DecisionTicket> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tickets',
    headers: ctx.auth,
    payload: ticketInput(overrides),
  });
  expect(response.statusCode).toBe(201);
  return response.json().ticket as DecisionTicket;
}

async function resolveTicket(
  ticketId: string,
  selectedOption = 'B',
): Promise<DecisionTicket> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/tickets/${ticketId}/resolve`,
    headers: ctx.auth,
    payload: { selectedOption },
  });
  expect(response.statusCode).toBe(200);
  return response.json().ticket as DecisionTicket;
}

describe('textSimilarity', () => {
  it('scores reformulations higher than unrelated questions', () => {
    const base = '错误提示用 Toast 还是行内文案？';
    const similar = '登录页错误提示应该用 Toast 还是行内文案';
    const unrelated = '数据库 schema 变更是否需要人工确认？';

    expect(textSimilarity(base, similar)).toBeGreaterThan(0.5);
    expect(textSimilarity(base, similar)).toBeGreaterThan(
      textSimilarity(base, unrelated),
    );
  });

  it('returns zero for empty input', () => {
    expect(textSimilarity('', 'anything')).toBe(0);
    expect(textSimilarity('???', '!!!')).toBe(0);
  });
});

describe('findSimilarTickets', () => {
  it('returns resolved tickets from the same project ranked by similarity', async () => {
    const projectName = 'memory-project';
    const resolved = await createTicket({
      projectName,
      blockerQuestion: '错误提示用 Toast 还是行内文案？',
    });
    await resolveTicket(resolved.id, 'B');

    await createTicket({
      projectName: 'other-memory-project',
      blockerQuestion: '错误提示用 Toast 还是行内文案？',
    });

    const matches = ctx.app.repo.findSimilarTickets({
      projectName,
      blockerQuestion: '登录页错误提示应该用 Toast 还是行内文案',
      limit: 5,
    });

    expect(matches.map((ticket) => ticket.id)).toContain(resolved.id);
    expect(matches.every((ticket) => ticket.projectName === projectName)).toBe(true);
    expect(matches[0]?.selectedOption).toBe('B');
  });

  it('ignores unresolved and dissimilar tickets', async () => {
    const projectName = 'memory-filter-project';
    const pending = await createTicket({
      projectName,
      blockerQuestion: '错误提示用 Toast 还是行内文案？',
    });

    const unrelated = await createTicket({
      projectName,
      blockerQuestion: '数据库 schema 变更是否需要人工确认？',
    });
    await resolveTicket(unrelated.id, 'A');

    const matches = ctx.app.repo.findSimilarTickets({
      projectName,
      blockerQuestion: '错误提示用 Toast 还是行内文案？',
    });

    expect(matches.map((ticket) => ticket.id)).not.toContain(pending.id);
    expect(matches.map((ticket) => ticket.id)).not.toContain(unrelated.id);
  });

  it('can exclude the current ticket id', async () => {
    const projectName = 'memory-exclude-project';
    const resolved = await createTicket({
      projectName,
      blockerQuestion: '统一使用 Pinia 还是 Vuex？',
    });
    await resolveTicket(resolved.id, 'A');

    const matches = ctx.app.repo.findSimilarTickets({
      projectName,
      blockerQuestion: '统一使用 Pinia 还是 Vuex？',
      excludeId: Number(resolved.id),
    });

    expect(matches.map((ticket) => ticket.id)).not.toContain(resolved.id);
  });

  it('separates presence changes from dashboard content', async () => {
    const repo = ctx.app.repo;
    const before = repo.syncFingerprints();

    repo.recordHeartbeat(
      { env: 'fingerprint-env', status: 'Idle' },
      Date.now() + 1,
    );
    const afterBeat = repo.syncFingerprints();
    expect(afterBeat.structural).toBe(before.structural);
    expect(afterBeat.presence).not.toBe(before.presence);

    await createTicket({ projectName: 'fingerprint-project' });
    const afterTicket = repo.syncFingerprints();
    expect(afterTicket.structural).not.toBe(afterBeat.structural);
  });

  it('bounds streamed chat output while trimming in batches', () => {    const repo = ctx.app.repo;
    const session = repo.createChatSession({
      env: 'trim-env',
      title: '输出上限',
    });
    const now = Date.now();
    const chunk = 'x'.repeat(12_000);

    // Trimming is amortised, so a burst is allowed to overshoot the cap by at
    // most one chunk before the batch trigger re-reads the session.
    for (let index = 0; index < 40; index += 1) {
      repo.appendChatEvent(
        Number(session.id),
        1,
        { stream: 'stdout', chunk },
        now,
      );
    }

    const { events } = repo.listChatEvents(Number(session.id), {
      after: 0,
      limit: 500,
    });
    const bytes = events.reduce((sum, event) => sum + event.chunk.length, 0);

    expect(events.length).toBeLessThan(40);
    expect(bytes).toBeLessThanOrEqual(
      256 * 1024 + 64 * 1024,
    );
  });

  it('derives the project from the runner directory when the heartbeat omits it', () => {
    const beat = ctx.app.repo.recordHeartbeat({
      env: 'derive-project-env',
      status: 'Idle',
      workspacePath: '/Users/qiliu/agent-hub',
    });

    expect(beat.projectName).toBe('agent-hub');
    const bindings = ctx.app.repo.listWorkspaceProjects({
      env: 'derive-project-env',
    }).projects;
    expect(bindings.map((item) => item.projectName)).toContain('agent-hub');
  });

  it('keeps an explicit project name over the directory name', () => {
    const beat = ctx.app.repo.recordHeartbeat({
      env: 'derive-project-env-2',
      status: 'Idle',
      projectName: 'FitAI',
      workspacePath: '/Users/qiliu/agent-hub',
    });

    expect(beat.projectName).toBe('FitAI');
  });

  it('bounds streamed task logs while trimming in batches', async () => {    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: ctx.auth,
      payload: {
        env: 'trim-log-env',
        projectName: 'agent-hub',
        title: '输出上限',
        instruction: '写一段很长的日志。',
      },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json().task as { id: string };

    const chunk = 'x'.repeat(12_000);
    const now = Date.now();
    for (let index = 0; index < 40; index += 1) {
      ctx.app.repo.appendTaskLog(
        Number(task.id),
        { stream: 'stdout', chunk },
        now + index,
      );
    }

    const { logs } = ctx.app.repo.listTaskLogs(Number(task.id), {
      after: 0,
      limit: 500,
    });
    const bytes = logs.reduce((sum, log) => sum + log.chunk.length, 0);

    expect(logs.length).toBeLessThan(40);
    expect(bytes).toBeLessThanOrEqual(256 * 1024 + 64 * 1024);
  });

  it('prunes resolved tickets but never pending ones', async () => {
    const pending = await createTicket({
      projectName: 'retention-project',
      blockerQuestion: '保留策略：这条应该还在吗？',
    });
    const resolved = await createTicket({
      projectName: 'retention-project',
      blockerQuestion: '保留策略：这条会被清掉吗？',
    });
    await resolveTicket(resolved.id, 'A');

    const removed = ctx.app.repo.pruneResolvedTickets(Date.now() + 1_000);

    expect(removed).toBeGreaterThan(0);
    expect(ctx.app.repo.get(Number(resolved.id))).toBeNull();
    expect(ctx.app.repo.get(Number(pending.id))).not.toBeNull();
  });

  it('prunes terminal audit rows past the cutoff', () => {
    const entry = ctx.app.repo.appendTerminalAudit({
      sessionId: 1,
      env: 'retention-env',
      kind: 'CLAIM',
    });

    const removed = ctx.app.repo.pruneTerminalAudit(Date.now() + 1_000);

    expect(removed).toBeGreaterThan(0);
    expect(ctx.app.repo.listTerminalAudit(1, { after: 0, limit: 10 }).entries)
      .not.toContainEqual(expect.objectContaining({ id: entry.id }));
  });
});
