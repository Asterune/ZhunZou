import { createHmac, timingSafeEqual } from 'node:crypto';

export interface RealtimeTicketPayload {
  expiresAt: number;
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * A short-lived browser WebSocket ticket.
 *
 * Browsers cannot set an `Authorization` header on a WebSocket handshake, so
 * the dashboard exchanges its long-lived admin token for this capability URL.
 * The ticket only proves "an admin was here a minute ago"; it cannot approve
 * tickets or call the REST API.
 */
export function buildRealtimeTicket(
  expiresAt: number,
  secret: string,
): string {
  const payload = `realtime.${expiresAt}`;
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyRealtimeTicket(
  ticket: string,
  secret: string,
  now = Date.now(),
): RealtimeTicketPayload | null {
  const parts = ticket.split('.');
  if (parts.length !== 3) return null;

  const [scope, expiresRaw, provided] = parts;
  if (scope !== 'realtime' || !expiresRaw || !provided) return null;
  if (!/^\d+$/.test(expiresRaw)) return null;

  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;

  const expected = signature(`realtime.${expiresAt}`, secret);
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;

  return { expiresAt };
}
