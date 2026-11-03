import { timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { UnauthorizedError } from './errors.js';

export function createAuthHook(token: string) {
  const expected = Buffer.from(token, 'utf8');

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization ?? '';
    const actual = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const provided = Buffer.from(actual, 'utf8');

    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedError();
    }
  };
}
