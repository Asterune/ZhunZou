import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { ForbiddenError, UnauthorizedError } from './errors.js';

export type AuthPrincipal =
  | { role: 'admin' }
  | { role: 'agent'; env: string };

/** Tokens are high-entropy; a plain sha256 is enough for at-rest storage. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface AuthOptions {
  /** The human/dashboard token. Always has full access. */
  adminToken: string;
  /** Look up an agent by sha256(token); null when unknown. */
  resolveAgent: (tokenHash: string) => {
    env: string;
    status: 'active' | 'disabled';
  } | null;
}

/**
 * Authenticate a bearer token as either the admin token or a per-agent token.
 *
 * Keeping the admin token valid preserves every existing deployment: an agent
 * can keep using HUB_SECRET_TOKEN without a migration, while new agents get a
 * scoped token that cannot approve tickets or read other environments.
 */
export function createAuthHook(options: AuthOptions) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token) throw new UnauthorizedError();

    if (safeEqual(token, options.adminToken)) {
      request.principal = { role: 'admin' };
      return;
    }

    const agent = options.resolveAgent(hashToken(token));
    if (!agent) throw new UnauthorizedError();

    if (agent.status !== 'active') {
      throw new ForbiddenError('agent is disabled; ask the admin for a new token', 'AGENT_DISABLED');
    }

    request.principal = { role: 'agent', env: agent.env };
  };
}

export function requireAdmin(request: FastifyRequest): void {
  if (request.principal?.role !== 'admin') {
    throw new ForbiddenError('this endpoint requires the admin token', 'ADMIN_ONLY');
  }
}

/** Admins may act on any env; an agent only on its own. */
export function requireEnvAccess(
  request: FastifyRequest,
  env: string,
  code = 'ENV_FORBIDDEN',
): void {
  const principal = request.principal;
  if (principal?.role === 'admin') return;
  if (principal?.role === 'agent' && principal.env === env) return;
  throw new ForbiddenError(
    `agent token is scoped to ${principal?.role === 'agent' ? principal.env : 'no env'}`,
    code,
  );
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthPrincipal;
  }
}
