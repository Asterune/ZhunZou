import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CompleteChatMessageInput } from '@zhunzou/shared';

/**
 * Durable state for one chat session loop.
 *
 * A hub deploy restarts the server for a few seconds while a turn is in
 * flight. Two things must survive that:
 * - the runner identity: a fresh id tells the hub "the old loop died", which
 *   fails the turn it is still working on. The id is therefore reused when the
 *   previous loop shut down cleanly and rotated when it did not.
 * - the finished turn: the reply is written to disk before it is POSTed, so a
 *   hub that is down (or a loop killed right after the CLI returned) replays
 *   it instead of losing the answer.
 */

/** A ledger younger than this belongs to a loop that is still running. */
const LEDGER_LIVE_MS = 30_000;

export interface PendingCompletion {
  sessionId: string;
  messageId: string;
  completion: CompleteChatMessageInput;
}

interface Ledger {
  runnerId: string;
  stoppedAt: number | null;
  /** Ids this loop had claimed and not finished — it died if any remain. */
  turns: string[];
  writtenAt: number;
}

export interface RunnerStateOptions {
  /** Directory holding the state; defaults to `~/.zhunzou`. */
  dir?: string;
  now?: () => number;
}

/** Env names reach the filesystem here, so keep them path-safe. */
function stateKey(env: string): string {
  const cleaned = env
    .trim()
    .slice(0, 32)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+$/g, '');
  return cleaned || 'default';
}

function isTicketId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,19}$/.test(value);
}

function isCompletion(value: unknown): value is CompleteChatMessageInput {
  if (typeof value !== 'object' || value === null) return false;
  const status = (value as { status?: unknown }).status;
  return status === 'DONE' || status === 'FAILED';
}

function normalizeLedger(raw: unknown): Ledger | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Partial<Ledger>;
  if (typeof value.runnerId !== 'string' || value.runnerId === '') return null;

  const stoppedAt =
    typeof value.stoppedAt === 'number' && Number.isFinite(value.stoppedAt)
      ? value.stoppedAt
      : null;
  const writtenAt =
    typeof value.writtenAt === 'number' && Number.isFinite(value.writtenAt)
      ? value.writtenAt
      : 0;
  const turns = Array.isArray(value.turns)
    ? value.turns.filter((turn): turn is string => typeof turn === 'string')
    : [];

  return { runnerId: value.runnerId, stoppedAt, turns, writtenAt };
}

export class RunnerState {
  readonly runnerId: string;

  private readonly ledgerFile: string;
  private readonly journalFile: string;
  private readonly now: () => number;
  private readonly turns = new Set<string>();
  private closed = false;

  constructor(env: string, options: RunnerStateOptions = {}) {
    const dir = options.dir ?? join(homedir(), '.zhunzou');
    const key = stateKey(env);
    this.ledgerFile = join(dir, `chat-runner-${key}.json`);
    this.journalFile = join(dir, `chat-pending-${key}.json`);
    this.now = options.now ?? (() => Date.now());

    mkdirSync(dir, { recursive: true });
    this.runnerId = this.reusableRunnerId() ?? randomUUID();
    this.sync();
  }

  /**
   * Reuse the previous id only when that loop could not have been working:
   * either it said goodbye, or it was idle and is still alive. A loop that
   * died holding a turn must present a new id so the hub reaps that turn.
   */
  private reusableRunnerId(): string | null {
    const ledger = this.readLedger();
    if (!ledger) return null;
    if (ledger.stoppedAt !== null) return ledger.turns.length ? null : ledger.runnerId;
    if (ledger.turns.length > 0) return null;
    return this.now() - ledger.writtenAt < LEDGER_LIVE_MS ? ledger.runnerId : null;
  }

  private readLedger(): Ledger | null {
    try {
      return normalizeLedger(JSON.parse(readFileSync(this.ledgerFile, 'utf8')));
    } catch {
      return null;
    }
  }

  private sync(): void {
    this.commit(this.ledgerFile, {
      runnerId: this.runnerId,
      stoppedAt: null,
      turns: [...this.turns],
      writtenAt: this.now(),
    } satisfies Ledger);
  }

  /** Rewrites the ledger so the next start can tell "alive" from "crashed". */
  heartbeat(): void {
    this.sync();
  }

  /** Marks a clean exit; the next start then keeps this runner id. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.commit(this.ledgerFile, {
      runnerId: this.runnerId,
      stoppedAt: this.now(),
      turns: [...this.turns],
      writtenAt: this.now(),
    } satisfies Ledger);
  }

  beginTurn(messageId: string): void {
    this.turns.add(messageId);
    this.sync();
  }

  endTurn(messageId: string): void {
    if (!this.turns.delete(messageId)) return;
    this.sync();
  }

  /** Turns this loop still owns, i.e. work in flight right now. */
  pendingTurns(): string[] {
    return [...this.turns];
  }

  recordCompletion(
    sessionId: string,
    messageId: string,
    completion: CompleteChatMessageInput,
  ): void {
    const entries = this.readJournal().filter(
      (entry) => entry.messageId !== messageId,
    );
    this.commit(this.journalFile, entries.concat({ sessionId, messageId, completion }));
  }

  pendingCompletions(): PendingCompletion[] {
    return this.readJournal();
  }

  clearCompletion(messageId: string): void {
    const entries = this.readJournal().filter(
      (entry) => entry.messageId !== messageId,
    );
    if (entries.length === 0) {
      try {
        unlinkSync(this.journalFile);
      } catch {
        // Already gone.
      }
      return;
    }
    this.commit(this.journalFile, entries);
  }

  private readJournal(): PendingCompletion[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.journalFile, 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];

    return raw.filter(
      (entry): entry is PendingCompletion =>
        typeof entry === 'object' &&
        entry !== null &&
        isTicketId((entry as PendingCompletion).sessionId) &&
        isTicketId((entry as PendingCompletion).messageId) &&
        isCompletion((entry as PendingCompletion).completion),
    );
  }

  /** Write-then-rename: a crash mid-write cannot corrupt the file. */
  private commit(file: string, value: unknown): void {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch {
      // State is best-effort; a read-only home must not break the loop.
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing to clean up.
      }
    }
  }
}
