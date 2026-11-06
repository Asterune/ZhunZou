import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  FleetBrowseRequest,
  FleetCandidate,
  FleetDesiredWorkspace,
  FleetWorkspace,
} from '@zhunzou/shared';

import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

async function registerAgent(
  env: string,
  host: string,
): Promise<{ authorization: string }> {
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: ctx.auth,
    payload: { env, kind: 'cursor', host },
  });
  expect(registered.statusCode).toBe(201);

  const issued = await ctx.app.inject({
    method: 'POST',
    url: `/api/agents/${encodeURIComponent(env)}/token`,
    headers: ctx.auth,
  });
  expect(issued.statusCode).toBe(200);
  const token = issued.json().token as string;
  return { authorization: `Bearer ${token}` };
}

async function report(
  auth: { authorization: string },
  host: string,
  candidates: Array<{
    path: string;
    projectName: string;
    env: string;
    adapter?: string;
  }>,
): Promise<FleetCandidate[]> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/fleet/candidates',
    headers: auth,
    payload: { host, candidates },
  });
  expect(response.statusCode).toBe(200);
  return response.json().candidates as FleetCandidate[];
}

async function createWorkspace(candidateId: string): Promise<FleetWorkspace> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/fleet/workspaces',
    headers: ctx.auth,
    payload: { candidateId },
  });
  expect(response.statusCode).toBe(201);
  return response.json().workspace as FleetWorkspace;
}

describe('fleet directory association', () => {
  it('runs candidate → association → token delivery → applied end to end', async () => {
    const auth = await registerAgent('fleet-control', 'host-a');
    const candidates = await report(auth, 'host-a', [
      {
        path: '/work/repo-a',
        projectName: 'repo-a',
        env: 'cursor-repo-a',
        adapter: 'cursor-agent',
      },
      {
        path: '/work/repo-b',
        projectName: 'repo-b',
        env: 'cursor-repo-b',
        adapter: 'cursor-agent',
      },
    ]);

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      '/work/repo-a',
      '/work/repo-b',
    ]);
    expect(candidates[0]?.associated).toBe(false);

    // Re-reporting replaces the host list instead of duplicating it.
    const replaced = await report(auth, 'host-a', [
      {
        path: '/work/repo-a',
        projectName: 'repo-a',
        env: 'cursor-repo-a',
        adapter: 'cursor-agent',
      },
    ]);
    expect(replaced).toHaveLength(1);

    const workspace = await createWorkspace(replaced[0]!.id);
    expect(workspace).toMatchObject({
      host: 'host-a',
      env: 'cursor-repo-a',
      path: '/work/repo-a',
      projectName: 'repo-a',
      status: 'PENDING',
    });

    const desiredResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/fleet/desired?host=host-a',
      headers: auth,
    });
    expect(desiredResponse.statusCode).toBe(200);
    const desired = desiredResponse.json().workspaces as FleetDesiredWorkspace[];
    expect(desired).toHaveLength(1);
    expect(desired[0]?.status).toBe('ISSUED');
    expect(desired[0]?.token).toMatch(/^zz_/);

    // The bridge confirms with the freshly minted scoped token.
    const applied = await ctx.app.inject({
      method: 'POST',
      url: `/api/fleet/desired/${workspace.id}/status`,
      headers: { authorization: `Bearer ${desired[0]!.token}` },
      payload: { status: 'APPLIED' },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().workspace.status).toBe('APPLIED');

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/fleet/workspaces?host=host-a',
      headers: ctx.auth,
    });
    const workspaces = list.json().workspaces as FleetWorkspace[];
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.status).toBe('APPLIED');

    // Applied workspaces no longer hand out the token.
    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/fleet/desired?host=host-a',
      headers: auth,
    });
    expect((after.json().workspaces as FleetDesiredWorkspace[])[0]?.token).toBeUndefined();
  });

  it('scopes candidates and desired directories to the registered host', async () => {
    const hostA = await registerAgent('fleet-host-a', 'host-1');
    const hostB = await registerAgent('fleet-host-b', 'host-2');

    await report(hostA, 'host-1', [
      {
        path: '/work/only-a',
        projectName: 'only-a',
        env: 'cursor-only-a',
      },
    ]);
    await report(hostB, 'host-2', [
      {
        path: '/work/only-b',
        projectName: 'only-b',
        env: 'cursor-only-b',
      },
    ]);

    const spoofed = await ctx.app.inject({
      method: 'POST',
      url: '/api/fleet/candidates',
      headers: hostA,
      payload: {
        host: 'host-2',
        candidates: [
          { path: '/work/spoof', projectName: 'spoof', env: 'agent-spoof' },
        ],
      },
    });
    expect(spoofed.statusCode).toBe(403);
    expect(spoofed.json().error.code).toBe('HOST_FORBIDDEN');

    const listA = await ctx.app.inject({
      method: 'GET',
      url: '/api/fleet/candidates',
      headers: ctx.auth,
    });
    const candidates = listA.json().candidates as FleetCandidate[];
    expect(candidates.filter((candidate) => candidate.host === 'host-1')).toHaveLength(1);
    expect(candidates.filter((candidate) => candidate.host === 'host-2')).toHaveLength(1);
  });

  it('browses directories on one host and associates a chosen path', async () => {
    const auth = await registerAgent('fleet-browse', 'host-browse');
    const other = await registerAgent('fleet-other', 'host-other');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/fleet/browse',
      headers: ctx.auth,
      payload: { host: 'host-browse', path: '/work' },
    });
    expect(created.statusCode).toBe(201);
    const request = created.json().request as FleetBrowseRequest;
    expect(request).toMatchObject({
      host: 'host-browse',
      path: '/work',
      status: 'PENDING',
      entries: [],
    });

    const desired = await ctx.app.inject({
      method: 'GET',
      url: '/api/fleet/desired?host=host-browse',
      headers: auth,
    });
    expect(desired.statusCode).toBe(200);
    expect(desired.json().browse).toEqual([
      expect.objectContaining({ id: request.id, path: '/work' }),
    ]);

    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/fleet/browse/${request.id}/result`,
      headers: other,
      payload: { entries: [] },
    });
    expect(refused.statusCode).toBe(403);

    const result = await ctx.app.inject({
      method: 'POST',
      url: `/api/fleet/browse/${request.id}/result`,
      headers: auth,
      payload: {
        current: {
          path: '/work',
          home: '/home/me',
          isRepo: false,
          adapter: 'cursor-agent',
        },
        entries: [
          {
            name: 'repo',
            path: '/work/repo',
            isRepo: true,
            isDirectory: true,
          },
        ],
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().request).toMatchObject({
      id: request.id,
      status: 'DONE',
      entries: [{ name: 'repo', path: '/work/repo', isRepo: true }],
    });

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/api/fleet/browse/${request.id}`,
      headers: ctx.auth,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().request.current.path).toBe('/work');

    // A directory chosen in the browser can be associated without a candidate.
    const workspaceResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/fleet/workspaces',
      headers: ctx.auth,
      payload: {
        host: 'host-browse',
        path: '/work/repo',
        projectName: 'repo',
        adapter: 'cursor-agent',
      },
    });
    expect(workspaceResponse.statusCode).toBe(201);
    const workspace = workspaceResponse.json().workspace as FleetWorkspace;
    expect(workspace).toMatchObject({
      host: 'host-browse',
      path: '/work/repo',
      projectName: 'repo',
      env: 'cursor-repo',
      status: 'PENDING',
    });

    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: '/api/fleet/workspaces',
      headers: ctx.auth,
      payload: { host: 'host-browse', path: '/work/repo' },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().workspace.id).toBe(workspace.id);
  });

  it('removes an association and rejects unknown candidates', async () => {
    const auth = await registerAgent('fleet-remove', 'host-remove');
    const candidates = await report(auth, 'host-remove', [
      {
        path: '/work/remove-me',
        projectName: 'remove-me',
        env: 'cursor-remove-me',
      },
    ]);
    const workspace = await createWorkspace(candidates[0]!.id);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/fleet/workspaces/${workspace.id}`,
      headers: ctx.auth,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().workspace.id).toBe(workspace.id);

    const desired = await ctx.app.inject({
      method: 'GET',
      url: '/api/fleet/desired?host=host-remove',
      headers: auth,
    });
    expect(desired.json().workspaces).toEqual([]);

    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/fleet/workspaces',
      headers: ctx.auth,
      payload: { candidateId: '999999' },
    });
    expect(missing.statusCode).toBe(404);
  });
});
