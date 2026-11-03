import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { HubClient, HubApiError } from '../src/hub-client.js';
import { makeTask, makeTicket, testConfig } from './helpers.js';

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

interface FakeHub {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

async function startHub(
  handler: (request: CapturedRequest, response: ServerResponse) => void,
): Promise<FakeHub> {
  const requests: CapturedRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(captured);
      handler(captured, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

let hub: FakeHub | null = null;

afterEach(async () => {
  await hub?.close();
  hub = null;
});

describe('HubClient', () => {
  it('creates a ticket with the configured env and bearer token', async () => {
    hub = await startHub((_request, res) => {
      json(res, 201, { ticket: makeTicket({ status: 'PENDING_META' }) });
    });
    const client = new HubClient(testConfig({ hubUrl: hub.baseUrl }));

    const ticket = await client.createTicket({
      projectName: 'yikuaomed-erp',
      doneSummary: '完成登录页',
      blockerQuestion: 'Toast 还是行内？',
      nextStepPlan: '接入错误处理',
      options: [
        { key: 'A', label: 'Toast' },
        { key: 'B', label: '行内' },
      ],
      recommendedOption: 'A',
    });

    expect(ticket.id).toBe('104');
    expect(hub.requests).toHaveLength(1);
    const request = hub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/tickets');
    expect(request.authorization).toBe('Bearer test-token');
    expect(request.body).toMatchObject({
      env: 'company-cursor',
      projectName: 'yikuaomed-erp',
    });
  });

  it('builds the long-poll URL and forwards the timeout', async () => {
    hub = await startHub((_request, res) => {
      json(res, 200, {
        resolved: true,
        timedOut: false,
        ticket: makeTicket({ status: 'AUTO_RESOLVED', selectedOption: 'A' }),
      });
    });
    const client = new HubClient(testConfig({ hubUrl: hub.baseUrl }));

    const result = await client.wait('104', 12_345);
    expect(result.resolved).toBe(true);
    expect(hub.requests[0]?.url).toBe('/api/tickets/104/wait?timeout=12345');
  });

  it('sends heartbeats with the configured env', async () => {
    hub = await startHub((_request, res) => {
      json(res, 200, {
        heartbeat: {
          env: 'company-cursor',
          status: 'Idle',
          projectName: 'yikuaomed-erp',
          lastSeenAt: 1,
          online: true,
        },
      });
    });
    const client = new HubClient(testConfig({ hubUrl: hub.baseUrl }));

    await client.heartbeat({ status: 'Idle', projectName: 'yikuaomed-erp' });
    expect(hub.requests[0]?.body).toMatchObject({
      env: 'company-cursor',
      status: 'Idle',
      agent: {
        kind: 'cursor',
        os: expect.stringMatching(/^(darwin|linux|win32)-/),
      },
    });
  });

  it('posts task log chunks', async () => {
    hub = await startHub((_request, res) => {
      json(res, 201, {
        log: {
          id: 1,
          taskId: '12',
          stream: 'stdout',
          chunk: 'hello',
          createdAt: 1,
        },
      });
    });
    const client = new HubClient(testConfig({ hubUrl: hub.baseUrl }));

    const log = await client.appendTaskLog('12', {
      stream: 'stdout',
      chunk: 'hello',
    });

    expect(log.chunk).toBe('hello');
    expect(hub.requests[0]?.url).toBe('/api/tasks/12/log');
    expect(hub.requests[0]?.body).toEqual({
      stream: 'stdout',
      chunk: 'hello',
    });
  });

  it('requests resume data for the configured env', async () => {
    hub = await startHub((_request, res) => {
      json(res, 200, {
        tickets: [makeTicket()],
        tasks: [makeTask()],
      });
    });
    const client = new HubClient(testConfig({ hubUrl: hub.baseUrl }));

    const result = await client.resume(1_700_000_000_000);

    expect(result.tickets).toHaveLength(1);
    expect(result.tasks).toHaveLength(1);
    expect(hub.requests[0]?.method).toBe('GET');
    expect(hub.requests[0]?.url).toBe(
      '/api/resume?env=company-cursor&since=1700000000000',
    );
  });

  it('maps API errors to HubApiError', async () => {
    hub = await startHub((_request, res) => {
      json(res, 409, {
        error: { code: 'ALREADY_FINALIZED', message: 'ticket is done' },
      });
    });
    const client = new HubClient(testConfig({ hubUrl: hub.baseUrl }));

    await expect(client.wait('104', 1000)).rejects.toMatchObject({
      status: 409,
      code: 'ALREADY_FINALIZED',
      message: 'ticket is done',
    });
  });

  it('marks 5xx failures as retryable but 401 as fatal', async () => {
    hub = await startHub((_request, res) => json(res, 500, {}));
    const serverError = await new HubClient(testConfig({ hubUrl: hub.baseUrl }))
      .wait('104', 1000)
      .catch((error: unknown) => error);

    expect(serverError).toBeInstanceOf(HubApiError);
    expect((serverError as HubApiError).retryable).toBe(true);

    await hub.close();
    hub = await startHub((_request, res) => json(res, 401, {}));
    const authError = await new HubClient(testConfig({ hubUrl: hub.baseUrl }))
      .wait('104', 1000)
      .catch((error: unknown) => error);

    expect((authError as HubApiError).retryable).toBe(false);
  });

  it('reports network failures as retryable status 0', async () => {
    hub = await startHub((_request, res) => json(res, 200, {}));
    const url = hub.baseUrl;
    await hub.close();
    hub = null;

    const client = new HubClient(testConfig({ hubUrl: url, waitTimeoutMs: 1000 }));
    const error = await client.wait('104', 1000).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HubApiError);
    expect((error as HubApiError).status).toBe(0);
    expect((error as HubApiError).retryable).toBe(true);
  });

  it('maps aborted requests to REQUEST_TIMEOUT', async () => {
    const client = new HubClient(
      testConfig(),
      (async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }) as unknown as typeof fetch,
    );

    await expect(client.wait('104', 1000)).rejects.toMatchObject({
      status: 0,
      code: 'REQUEST_TIMEOUT',
    });
  });
});
