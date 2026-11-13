import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { DecisionTicket, RuleCandidate } from '@zhunzou/shared';

import { buildApp } from '../src/app.js';
import { buildApprovalToken } from '../src/approval-link.js';
import { loadConfig } from '../src/config.js';
import type { RuleDistiller } from '../src/rule-distiller.js';
import { ticketInput, waitFor } from './helpers.js';

const SECRET = 'rule-secret';
const BASE = 'https://hub.example.com';
const TEST_TOKEN = 'test-secret-token';
const RULE = '- 遇到同类表单校验歧义时，默认用行内文案，不引入全局 Toast。';
/** The rules document keeps one punctuation-free list item per remembered rule. */
const RULE_LINE = RULE.slice(0, -1);

interface Ctx {
  app: FastifyInstance;
  dir: string;
  auth: { authorization: string };
  rulesPath: string;
  /** Ticket ids the distiller was asked about, in call order. */
  asked: string[];
  close: () => Promise<void>;
}

async function createCtx(options: {
  rule?: string | null;
  /** Point the rules document at a path that can never be written. */
  unwritableRules?: boolean;
} = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-remember-'));
  const asked: string[] = [];
  const rule = options.rule === undefined ? RULE : options.rule;
  const distiller: RuleDistiller = {
    async distill(ticket) {
      asked.push(ticket.id);
      return rule;
    },
  };

  const rulesPath = options.unwritableRules
    ? join(dir, 'blocker', 'GLOBAL_RULES.md')
    : join(dir, 'GLOBAL_RULES.md');
  if (options.unwritableRules) {
    writeFileSync(join(dir, 'blocker'), 'not a directory', 'utf8');
  }

  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_SECRET_TOKEN: TEST_TOKEN,
    DATABASE_PATH: join(dir, 'test.db'),
    GLOBAL_RULES_PATH: rulesPath,
    APPROVAL_LINK_SECRET: SECRET,
    PUBLIC_BASE_URL: BASE,
    META_AGENT_ENABLED: 'false',
    SERVE_WEB: 'false',
    LOG_LEVEL: 'silent',
  });
  const app = await buildApp({ config, logger: false, ruleDistiller: distiller });

  return {
    app,
    dir,
    asked,
    rulesPath,
    auth: { authorization: `Bearer ${TEST_TOKEN}` },
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createTicket(ctx: Ctx, projectName: string): Promise<DecisionTicket> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tickets',
    headers: ctx.auth,
    payload: ticketInput({ projectName, env: 'rule-env' }),
  });
  expect(response.statusCode).toBe(201);
  return response.json().ticket as DecisionTicket;
}

async function resolveByApi(
  ctx: Ctx,
  ticket: DecisionTicket,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/tickets/${ticket.id}/resolve`,
    headers: ctx.auth,
    payload: body,
  });
  expect(response.statusCode).toBe(200);
}

function candidates(ctx: Ctx): RuleCandidate[] {
  return ctx.app.repo.listRuleCandidates({ limit: 100 }).candidates;
}

async function acceptedOf(ctx: Ctx, ticketId: string): Promise<RuleCandidate> {
  return waitFor(() =>
    candidates(ctx).find(
      (item) => item.ticketId === ticketId && item.status === 'ACCEPTED',
    ),
  );
}

/**
 * Adoption is a synchronous step right after the insert, so a candidate the
 * poll finds as PENDING had no flag to adopt it — or failed to write the file.
 */
async function candidateOf(ctx: Ctx, ticketId: string): Promise<RuleCandidate> {
  return waitFor(() => candidates(ctx).find((item) => item.ticketId === ticketId));
}

function readRules(ctx: Ctx): string {
  try {
    return readFileSync(ctx.rulesPath, 'utf8');
  } catch {
    return '';
  }
}

function tokenFor(ticketId: string): string {
  return buildApprovalToken(ticketId, Date.now() + 60_000, SECRET);
}

describe('remember the rule from an approval', () => {
  it('R1: rememberRule adopts the distilled candidate straight into the rules document', async () => {
    const ctx = await createCtx();
    try {
      const ticket = await createTicket(ctx, 'remember-api');
      await resolveByApi(ctx, ticket, {
        selectedOption: 'B',
        customInstruction: '先只改登录页',
        rememberRule: true,
      });

      const candidate = await acceptedOf(ctx, ticket.id);
      expect(candidate.content).toBe(RULE);

      const rules = await ctx.app.inject({
        method: 'GET',
        url: '/api/rules',
        headers: ctx.auth,
      });
      expect(rules.statusCode).toBe(200);
      expect(rules.json().content).toContain('## 历史批复沉淀');
      expect(rules.json().content).toContain(RULE_LINE);
      expect(readRules(ctx)).toContain(RULE_LINE);
    } finally {
      await ctx.close();
    }
  });

  it('R2: without the flag the candidate waits in the list, exactly as before', async () => {
    const ctx = await createCtx();
    try {
      const ticket = await createTicket(ctx, 'plain-approval');
      await resolveByApi(ctx, ticket, { selectedOption: 'B' });

      const candidate = await candidateOf(ctx, ticket.id);
      expect(candidate.status).toBe('PENDING');
      expect(readRules(ctx)).toBe('');
    } finally {
      await ctx.close();
    }
  });

  it('R3: a decision with nothing reusable to teach leaves no trace', async () => {
    const ctx = await createCtx({ rule: null });
    try {
      const ticket = await createTicket(ctx, 'skip-approval');
      await resolveByApi(ctx, ticket, { selectedOption: 'A', rememberRule: true });

      await waitFor(() => ctx.asked.includes(ticket.id));
      expect(candidates(ctx)).toHaveLength(0);
      expect(readRules(ctx)).toBe('');
    } finally {
      await ctx.close();
    }
  });

  it('R4: the signed page offers the button and honours it through the form', async () => {
    const ctx = await createCtx();
    try {
      const ticket = await createTicket(ctx, 'remember-page');
      const token = tokenFor(ticket.id);

      const page = await ctx.app.inject({ method: 'GET', url: `/a/${token}` });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('name="rememberRule"');
      expect(page.body).toContain('准奏并记住规则');

      const accepted = await ctx.app.inject({
        method: 'POST',
        url: `/a/${token}/resolve`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'selectedOption=B&rememberRule=true',
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.body).toContain('已准奏');

      const candidate = await acceptedOf(ctx, ticket.id);
      expect(candidate.content).toBe(RULE);
      expect(readRules(ctx)).toContain(RULE_LINE);
    } finally {
      await ctx.close();
    }
  });

  it('R4b: the plain 准奏 button on the same page does not remember', async () => {
    const ctx = await createCtx();
    try {
      const ticket = await createTicket(ctx, 'plain-page');
      const token = tokenFor(ticket.id);

      const accepted = await ctx.app.inject({
        method: 'POST',
        url: `/a/${token}/resolve`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'selectedOption=B',
      });
      expect(accepted.statusCode).toBe(200);

      const candidate = await candidateOf(ctx, ticket.id);
      expect(candidate.status).toBe('PENDING');
      expect(readRules(ctx)).toBe('');
    } finally {
      await ctx.close();
    }
  });

  it('R5: a rules document that cannot be written does not undo the approval', async () => {
    const ctx = await createCtx({ unwritableRules: true });
    try {
      const ticket = await createTicket(ctx, 'broken-rules');
      await resolveByApi(ctx, ticket, { selectedOption: 'B', rememberRule: true });

      // The ruling is already decided and on its way back to the agent.
      expect(ctx.app.repo.get(Number(ticket.id))?.status).toBe('HUMAN_RESOLVED');

      const candidate = await candidateOf(ctx, ticket.id);
      expect(candidate.status).toBe('PENDING');
      expect(readFileSync(join(ctx.dir, 'blocker'), 'utf8')).toBe('not a directory');
    } finally {
      await ctx.close();
    }
  });

  it('R6: remembering feeds the judge document, it does not grant an L1 pass', async () => {
    const ctx = await createCtx();
    try {
      const ticket = await createTicket(ctx, 'l1-untouched');
      await resolveByApi(ctx, ticket, { selectedOption: 'B', rememberRule: true });

      await acceptedOf(ctx, ticket.id);
      expect(ctx.app.repo.listLearnedRules()).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });
});
