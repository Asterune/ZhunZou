import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { z, ZodError } from 'zod';

import type {
  DecisionTicket,
  FleetBrowseCurrent,
  FleetBrowseEntry,
  FleetBrowseStatus,
  FleetWorkspace,
  SyncState,
} from '@zhunzou/shared';
import {
  appendChatEventSchema,
  appendTaskLogSchema,
  adoptChatProposalSchema,
  batchResolveTicketsSchema,
  bindWorkspaceProjectSchema,
  bridgeReleaseManifestSchema,
  completeChatMessageSchema,
  completeTaskSchema,
  createAgentSchema,
  createChatSessionSchema,
  createEnrollmentSchema,
  createFleetBrowseSchema,
  createFleetWorkspaceSchema,
  createLearnedRuleSchema,
  createLocalTaskSchema,
  createTaskSchema,
  createTerminalSchema,
  createTicketSchema,
  decisionRequestSchema,
  dispatchTaskSchema,
  fleetBrowseResultInputSchema,
  fleetWorkspaceStatusInputSchema,
  extendTicketSchema,
  editChatMessageSchema,
  formatTicketId,
  heartbeatSchema,
  isResolvedStatus,
  isTerminalStatus,
  listAgentsQuerySchema,
  listChatEventsQuerySchema,
  listChatSessionsQuerySchema,
  listExchangesQuerySchema,
  listFleetQuerySchema,
  listLearnedRulesQuerySchema,
  listRuleCandidatesQuerySchema,
  listTaskEventsQuerySchema,
  listTaskLogsQuerySchema,
  listTasksQuerySchema,
  listTerminalAuditQuerySchema,
  listTerminalEventsQuerySchema,
  listTerminalsQuerySchema,
  listTicketsQuerySchema,
  listWorkspaceProjectsQuerySchema,
  ENROLLMENT_CODE_MAX_USES,
  ENROLLMENT_CODE_TTL_MS,
  NODE_HEARTBEAT_TIMEOUT_MS,
  nextChatMessageQuerySchema,
  nextTaskQuerySchema,
  proposeChatReplySchema,
  redeemEnrollmentSchema,
  releaseTaskSchema,
  reportExchangeSchema,
  reportTaskEventsSchema,
  reportFleetCandidatesSchema,
  resolveTicketSchema,
  resumeQuerySchema,
  sendChatMessageSchema,
  syncQuerySchema,
  takeoverTaskSchema,
  terminalAuditExportQuerySchema,
  terminalCloseSchema,
  ticketIdSchema,
  updateAgentSchema,
  updateLearnedRuleSchema,
  updateRulesSchema,
  waitQuerySchema,
} from '@zhunzou/shared';

import {
  buildApprovalToken,
  buildApprovalUrl,
  renderApprovalPage,
  renderApprovalResultPage,
  verifyApprovalToken,
} from './approval-link.js';
import { createAuthHook, hashToken, requireAdmin, requireEnvAccess } from './auth.js';
import type { ServerConfig } from './config.js';
import { createDatabase } from './db/client.js';
import {
  clientPrefix,
  createEnrollmentRateLimiter,
  generateEnrollmentCode,
  hashEnrollmentCode,
  renderInstallScript,
  slugifyHost,
} from './enrollment.js';
import {
  evaluateDecision,
  syntheticTicket,
} from './decision-policy.js';
import {
  approveOptionFor,
  evaluateL1,
  selectPermissionAction,
} from './supervisor/guard.js';
import { allocateEnv } from './env-allocator.js';
import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from './errors.js';
import { SyncEventBus, TaskEventBus, SessionEventBus, TicketEventBus } from './events.js';
import { createMetaAgent, type MetaAgent } from './meta-agent.js';
import {
  createNotifiers,
  notifyTicketPendingHuman,
  type Notifier,
} from './notifications.js';
import {
  closePlugins,
  emitPluginEvent,
  loadPlugins,
  readyPlugins,
  type HubPlugin,
} from './plugins.js';
import { parseTicketId, TicketRepository, type TicketStore } from './repository.js';
import {
  createRuleDistiller,
  type RuleDistiller,
} from './rule-distiller.js';
import {
  attachRealtimeGateway,
  type RealtimeGateway,
} from './realtime/gateway.js';
import {
  attachDeviceRouter,
  type DeviceRouter,
} from './realtime/device-router.js';
import {
  createTerminalManager,
  type TerminalManager,
} from './realtime/terminal-manager.js';
import { buildRealtimeTicket } from './realtime/ticket.js';
import { RulesStore } from './rules-store.js';
import { routeTask, toRouteCandidates } from './scheduler.js';
import { SERVER_VERSION, STARTED_AT } from './version.js';

declare module 'fastify' {
  interface FastifyInstance {
    repo: TicketStore;
    bus: TicketEventBus;
    taskBus: TaskEventBus;
    sessionBus: SessionEventBus;
    rulesStore: RulesStore;
  }
}

const paramsSchema = z.object({ id: ticketIdSchema });
/** Learned rule ids are opaque (`lr-…`), not ticket numbers. */
const learnedRuleParamsSchema = z.object({ id: z.string().trim().min(1).max(64) });
const chatMessageParamsSchema = z.object({
  id: ticketIdSchema,
  messageId: ticketIdSchema,
});
const agentParamsSchema = z.object({
  env: z.string().trim().min(1).max(64),
});
const approvalParamsSchema = z.object({
  token: z.string().min(1).max(512),
});
const approvalResolveSchema = z.object({
  selectedOption: z.string().trim().min(1).max(8),
  customInstruction: z.string().trim().max(2000).optional(),
  confirmDestructive: z.union([z.string(), z.boolean()]).optional(),
});

export interface BuildAppOptions {
  config: ServerConfig;
  /** Optional storage adapter; defaults to SQLite via TicketRepository. */
  repo?: TicketStore;
  metaAgent?: MetaAgent;
  ruleDistiller?: RuleDistiller;
  notifiers?: Notifier[];
  plugins?: HubPlugin[];
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;

  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    bodyLimit: 256 * 1024,
  });

  // Body-less POSTs (cancel / accept / dismiss) are common from simple HTTP
  // clients that still set Content-Type: application/json. Treat an empty body
  // as `undefined` instead of Fastify's default 400 EMPTY_JSON_BODY.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
      if (!raw) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(
          new BadRequestError('request body is not valid JSON', 'INVALID_JSON'),
          undefined,
        );
      }
    },
  );

  // The signed mobile approval page uses a plain HTML form so it works
  // without JavaScript (and without exposing the dashboard token).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      const params = new URLSearchParams(
        typeof body === 'string' ? body : '',
      );
      done(null, Object.fromEntries(params.entries()));
    },
  );

  const { sqlite, db } = createDatabase(config.dbPath);
  const repo: TicketStore =
    options.repo ??
    new TicketRepository(db, {
      onIdentityConflict: (conflict) =>
        app.log.warn(conflict, 'refused machine claim on an env it does not own'),
    });
  const bus = new TicketEventBus();
  const taskBus = new TaskEventBus();
  const sessionBus = new SessionEventBus();

  // -----------------------------------------------------------------
  // Dashboard sync (long poll)
  // -----------------------------------------------------------------
  // One fingerprint per second is shared by every connected dashboard;
  // `rev` only advances when something the UI renders actually changed.
  const syncBus = new SyncEventBus();
  let syncTicker: ReturnType<typeof setInterval> | null = null;
  let syncFingerprint = '';
  let syncBroadcast: ((rev: number) => void) | null = null;

  const refreshSyncFingerprint = (): void => {
    let next: string;
    try {
      next = repo.syncFingerprint();
    } catch (error) {
      app.log.error(
        { err: (error as Error).message },
        'sync fingerprint failed',
      );
      return;
    }

    if (syncFingerprint === '') {
      syncFingerprint = next;
      return;
    }
    if (next === syncFingerprint) return;

    syncFingerprint = next;
    syncBroadcast?.(syncBus.bump());
  };

  const ensureSyncTicker = (): void => {
    if (syncTicker !== null) return;
    syncTicker = setInterval(refreshSyncFingerprint, 1_000);
    syncTicker.unref?.();
  };

  const stopSyncTickerIfIdle = (): void => {
    // With the realtime gateway enabled the ticker also feeds WebSocket
    // dashboards, so it must stay alive even when no HTTP long poll is held.
    if (config.realtimeEnabled) return;
    if (syncTicker !== null && syncBus.waiters === 0) {
      clearInterval(syncTicker);
      syncTicker = null;
    }
  };

  // Establish the baseline before the first mutation so a ticket created
  // between build and the first ticker tick still produces a change frame.
  refreshSyncFingerprint();

  const syncSnapshot = (): SyncState => ({
    envs: repo.listHeartbeats(),
    tickets: repo.list({ limit: 200 }).tickets,
    tasks: repo.listTasks({ limit: 200 }).tasks,
    projects: repo.listWorkspaceProjects({}).projects,
    agents: repo.listAgents({}),
    devices: repo.listDevices(),
    exchanges: repo.listExchanges({ limit: 100 }),
    fleetCandidates: repo.listFleetCandidates().candidates,
    fleetWorkspaces: repo.listFleetWorkspaces().workspaces,
  });

  /* ------------------------------------------------------------------ */
  /* Ephemeral dashboard directory-browser requests                      */
  /* ------------------------------------------------------------------ */

  interface FleetBrowseState {
    id: number;
    host: string;
    path: string;
    status: FleetBrowseStatus;
    current?: FleetBrowseCurrent;
    entries: FleetBrowseEntry[];
    error?: string;
    createdAt: number;
    updatedAt: number;
  }

  const FLEET_BROWSE_TTL_MS = 5 * 60 * 1000;
  const FLEET_BROWSE_MAX = 200;
  const fleetBrowseRequests = new Map<number, FleetBrowseState>();
  let fleetBrowseSequence = 1;

  const pruneFleetBrowse = (now = Date.now()): void => {
    for (const [id, request] of fleetBrowseRequests) {
      if (now - request.createdAt > FLEET_BROWSE_TTL_MS) {
        fleetBrowseRequests.delete(id);
      }
    }
    if (fleetBrowseRequests.size <= FLEET_BROWSE_MAX) return;
    const oldest = [...fleetBrowseRequests.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, fleetBrowseRequests.size - FLEET_BROWSE_MAX);
    for (const request of oldest) fleetBrowseRequests.delete(request.id);
  };

  const toBrowseResponse = (request: FleetBrowseState) => ({
    ...request,
    id: String(request.id),
  });

  const rulesStore = new RulesStore(config.rulesPath);
  const metaAgent =
    options.metaAgent ?? createMetaAgent(config.metaAgent, fetch);
  const ruleDistiller =
    options.ruleDistiller ??
    createRuleDistiller(config.metaAgent, fetch, app.log);
  const notifiers = options.notifiers ?? createNotifiers(config.notifications, app.log);
  let plugins: HubPlugin[] = [];
  let sweeper: ReturnType<typeof setInterval> | null = null;
  let realtime: RealtimeGateway | null = null;
  let terminals: TerminalManager | null = null;
  let deviceRouter: DeviceRouter | null = null;
  let closing = false;

  app.decorate('repo', repo);
  app.decorate('bus', bus);
  app.decorate('taskBus', taskBus);
  app.decorate('sessionBus', sessionBus);
  app.decorate('rulesStore', rulesStore);

  // Fastify closes the HTTP server before its `onClose` hooks run, and it
  // waits for busy connections: held polls must be answered and streaming
  // sockets ended here, or a restart waits out every one of their windows.
  // The released polls resume on a later timer, so they still finish against
  // an open database.
  app.addHook('preClose', async () => {
    closing = true;
    if (sweeper !== null) {
      clearInterval(sweeper);
      sweeper = null;
    }
    if (syncTicker !== null) {
      clearInterval(syncTicker);
      syncTicker = null;
    }
    bus.releaseAll();
    taskBus.releaseAll();
    sessionBus.releaseAll();
    syncBus.releaseAll();
    deviceRouter?.close();
    terminals?.closeAll();
    realtime?.close();
    await closePlugins(plugins, app.log);
  });

  app.addHook('onClose', async () => {
    sqlite.close();
  });

  const indexHtmlPath = join(config.webDistPath, 'index.html');
  const hasWebBuild = config.serveWeb && existsSync(indexHtmlPath);
  const indexHtml = hasWebBuild ? readFileSync(indexHtmlPath) : null;

  // Error/not-found handlers must be installed before child route contexts
  // are created, otherwise encapsulated routes fall back to Fastify defaults.
  app.setNotFoundHandler(async (request, reply) => {
    const isApi =
      request.url.startsWith('/api') || request.url.startsWith('/releases/');

    // SPA fallback: unknown non-API GETs render the dashboard shell.
    if (!isApi && indexHtml && (request.method === 'GET' || request.method === 'HEAD')) {
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(indexHtml);
    }

    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'route not found' },
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'request payload failed validation',
          details: error.issues,
        },
      });
    }

    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error }, 'api error');
      }
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }

    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;

    if (statusCode < 500) {
      return reply.code(statusCode).send({
        error: {
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'bad request',
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'internal server error' },
    });
  });

  // -----------------------------------------------------------------
  // Static web dashboard (single-port deployment)
  // -----------------------------------------------------------------
  if (hasWebBuild) {
    await app.register(fastifyStatic, {
      root: config.webDistPath,
      prefix: '/',
      index: ['index.html'],
      setHeaders(response, filePath) {
        const name = basename(filePath);
        // Shell + service worker files must revalidate, otherwise a deploy
        // leaves clients pinned to an old build (or an old SW).
        if (
          name === 'index.html' ||
          name === 'sw.js' ||
          name === 'offline.html' ||
          name === 'manifest.webmanifest'
        ) {
          response.header('cache-control', 'no-cache');
          return;
        }
        if (basename(dirname(filePath)) === 'assets') {
          response.header(
            'cache-control',
            'public, max-age=31536000, immutable',
          );
          return;
        }
        // Unhashed public files (PWA icons): cache for a day.
        response.header('cache-control', 'public, max-age=86400');
      },
    });
    app.log.info({ root: config.webDistPath }, 'serving web dashboard');
  }

  // -----------------------------------------------------------------
  // Published bridge releases (public: clients self-update without a token)
  // -----------------------------------------------------------------
  const bridgeManifestPath = join(config.bridgeReleasesPath, 'latest.json');
  if (existsSync(bridgeManifestPath)) {
    await app.register(fastifyStatic, {
      root: config.bridgeReleasesPath,
      prefix: '/releases/bridge/',
      decorateReply: false,
      cacheControl: false,
      setHeaders(response, filePath) {
        response.header(
          'cache-control',
          filePath.endsWith('latest.json')
            ? 'no-cache'
            : 'public, max-age=300',
        );
      },
    });
    app.log.info(
      { root: config.bridgeReleasesPath },
      'serving bridge releases',
    );
  }

  // -----------------------------------------------------------------
  // Meta-Agent pipeline (runs after the create response has been sent)
  // -----------------------------------------------------------------

  /**
   * L1: answer a parked permission request from rules, not from a model.
   *
   * Returns true when the ticket left the pipeline here. Anything the
   * deterministic layer cannot name — no linked task, no recent request, a
   * ticket shape it does not recognise — is reported as "not mine" and the
   * meta review below runs exactly as it always has.
   */
  const rulePermission = (ticket: DecisionTicket): boolean => {
    if (!ticket.taskId) return false;
    const taskId = parseTicketId(ticket.taskId);
    const task = repo.getTask(taskId);
    if (!task) return false;

    const events = repo.listTaskEvents(taskId, { after: 0, limit: 500 }).events;
    const action = selectPermissionAction(events, {
      ticketCreatedAt: ticket.createdAt,
      now: Date.now(),
    });
    if (!action) return false;

    const ruling = evaluateL1(action, {
      rules: repo.listLearnedRules({ enabledOnly: true }),
      ...(task.workspacePath ? { taskWorkspaceRoot: task.workspacePath } : {}),
      warn: (message) =>
        app.log.warn({ ticket: formatTicketId(ticket.id) }, message),
    });
    if (!ruling) return false;

    const reason = `[L1] ${ruling.reason}`;
    if (ruling.decision !== 'APPROVE') {
      const parked = repo.markPendingHuman(Number(ticket.id), reason);
      if (parked) {
        app.log.info(
          { ticket: formatTicketId(parked.id), reason: ruling.reason },
          'supervisor L1 parked a request for a human',
        );
        notifyTicketPendingHuman(notifiers, parked, app.log, approvalUrlFor(parked));
        emitPluginEvent(plugins, 'onTicketPendingHuman', parked, app.log);
      }
      return true;
    }

    const option = approveOptionFor(ticket);
    if (!option) {
      // Approved, but nobody has offered us a button to press. Guessing which
      // option means "yes" would be the one way this layer could do harm.
      app.log.info(
        { ticket: formatTicketId(ticket.id), action: ruling.reason },
        'supervisor L1 approved a ticket with options it does not recognise',
      );
      return false;
    }
    if (ruling.ruleId) repo.recordLearnedRuleHit(ruling.ruleId);

    const resolved = repo.markAutoResolved(Number(ticket.id), option, reason);
    if (resolved) {
      bus.publish(resolved);
      emitPluginEvent(plugins, 'onTicketResolved', resolved, app.log);
      app.log.info(
        { ticket: formatTicketId(resolved.id), option, reason: ruling.reason },
        'supervisor L1 auto-resolved a permission ticket',
      );
    }
    return true;
  };

  const runMetaReview = async (ticketId: number): Promise<void> => {
    if (closing) return;
    const ticket = repo.get(ticketId);
    if (!ticket || ticket.status !== 'PENDING_META') return;

    if (rulePermission(ticket)) return;

    try {
      const { content: rules } = rulesStore.read();
      const precedents = repo.findSimilarTickets({
        projectName: ticket.projectName,
        blockerQuestion: ticket.blockerQuestion,
        excludeId: Number(ticket.id),
        limit: 5,
      });
      const review = await metaAgent.review(ticket, rules, precedents);

      if (precedents.length > 0) {
        app.log.info(
          {
            ticket: formatTicketId(ticket.id),
            precedents: precedents.map((item) => formatTicketId(item.id)),
          },
          'meta-agent using historical precedents',
        );
      }

      if (review.canResolve && review.selectedOption) {
        const selected = ticket.options.find(
          (option) => option.key === review.selectedOption,
        );
        if (selected?.risk === 'destructive') {
          const escalated = repo.markPendingHuman(
            ticketId,
            `选项 ${review.selectedOption} 标记为 destructive，必须人工确认`,
          );
          if (escalated) {
            notifyTicketPendingHuman(
              notifiers,
              escalated,
              app.log,
              approvalUrlFor(escalated),
            );
            emitPluginEvent(plugins, 'onTicketPendingHuman', escalated, app.log);
          }
          return;
        }

        const updated = repo.markAutoResolved(
          ticketId,
          review.selectedOption,
          review.reason,
        );
        if (updated) {
          bus.publish(updated);
          emitPluginEvent(plugins, 'onTicketResolved', updated, app.log);
          app.log.info(
            { ticket: formatTicketId(updated.id), option: review.selectedOption },
            'meta-agent auto-resolved ticket',
          );
        }
        return;
      }

      const updated = repo.markPendingHuman(ticketId, review.reason);
      if (updated) {
        app.log.info(
          { ticket: formatTicketId(updated.id), reason: review.reason },
          'meta-agent escalated ticket to human',
        );
        notifyTicketPendingHuman(
          notifiers,
          updated,
          app.log,
          approvalUrlFor(updated),
        );
        emitPluginEvent(plugins, 'onTicketPendingHuman', updated, app.log);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      app.log.error({ err: message, ticket: formatTicketId(ticketId) }, 'meta-agent review failed');

      const updated = repo.markPendingHuman(
        ticketId,
        `Meta-Agent 预审失败，已转人工：${message}`,
      );
      if (updated) {
        notifyTicketPendingHuman(
          notifiers,
          updated,
          app.log,
          approvalUrlFor(updated),
        );
        emitPluginEvent(plugins, 'onTicketPendingHuman', updated, app.log);
      }
    }
  };

  // -----------------------------------------------------------------
  // Rule distillation: turn a human approval into a candidate rule.
  // Runs after the approval response, so the human never waits on the LLM.
  // -----------------------------------------------------------------
  const distillRule = async (ticket: DecisionTicket): Promise<void> => {
    if (ticket.status !== 'HUMAN_RESOLVED') return;

    try {
      const content = await ruleDistiller.distill(ticket);
      if (!content) return;

      const candidate = repo.createRuleCandidate(Number(ticket.id), content);
      if (!candidate) return;

      app.log.info(
        {
          candidate: formatTicketId(candidate.id),
          ticket: formatTicketId(ticket.id),
        },
        'rule candidate distilled from human approval',
      );
    } catch (error) {
      app.log.warn(
        {
          err: (error as Error).message,
          ticket: formatTicketId(ticket.id),
        },
        'rule candidate distillation failed',
      );
    }
  };

  const approvalUrlFor = (ticket: DecisionTicket): string | undefined => {
    if (!config.publicBaseUrl) return undefined;
    const expiresAt = Date.now() + config.approvalLinkTtlMs;
    const token = buildApprovalToken(
      ticket.id,
      expiresAt,
      config.approvalLinkSecret,
    );
    return buildApprovalUrl(config.publicBaseUrl, token);
  };

  const autoResolveEligible = (projectName: string): boolean => {
    if (config.autoResolveTimeoutMs <= 0) return false;
    if (config.autoResolveProjects.length === 0) return true;
    return config.autoResolveProjects.includes(projectName);
  };

  const sweepDueTickets = async (): Promise<void> => {
    const now = Date.now();

    for (const ticket of repo.findDueTickets(now)) {
      const option = ticket.options.find(
        (item) => item.key === ticket.recommendedOption,
      );

      // Hard safety rule: never auto-approve a destructive option, even if
      // the agent marked it as the recommendation.
      if (option?.risk === 'destructive') {
        repo.clearExpiry(Number(ticket.id), now);
        app.log.warn(
          { ticket: formatTicketId(ticket.id) },
          'skipped timeout auto-resolve for destructive option',
        );
        continue;
      }

      const updated = repo.markTimedOut(
        Number(ticket.id),
        ticket.recommendedOption,
        `超过自动裁决时限，默认采纳推荐方案 ${ticket.recommendedOption}`,
        now,
      );

      if (updated) {
        bus.publish(updated);
        emitPluginEvent(plugins, 'onTicketResolved', updated, app.log);
        app.log.info(
          {
            ticket: formatTicketId(updated.id),
            option: updated.selectedOption,
          },
          'ticket auto-resolved by timeout policy',
        );
      }
    }
  };

  const sweepStaleTasks = async (): Promise<void> => {
    const now = Date.now();
    const onlineEnvs = new Set(
      repo
        .listHeartbeats(now)
        .filter((heartbeat) => heartbeat.online)
        .map((heartbeat) => heartbeat.env),
    );

    for (const task of repo.listClaimedTasks()) {
      const claimedAt = task.claimedAt ?? task.updatedAt;
      const leaseAt = task.leaseAt ?? claimedAt;
      const hardExpired =
        config.taskHardTimeoutMs > 0 &&
        claimedAt <= now - config.taskHardTimeoutMs;
      const offlineExpired =
        !onlineEnvs.has(task.env) &&
        leaseAt <= now - config.taskClaimTimeoutMs;

      if (!hardExpired && !offlineExpired) continue;

      const requeue =
        !hardExpired && task.attempts < config.taskMaxAttempts;
      const reason = hardExpired
        ? '任务执行超时，已自动失败'
        : requeue
          ? `端侧 ${task.env} 离线，任务已重新排队`
          : `端侧 ${task.env} 多次离线，任务已自动失败`;

      const updated = repo.releaseTask(
        Number(task.id),
        requeue,
        reason,
        now,
      );

      if (updated) {
        taskBus.publish(updated);
        app.log.warn(
          {
            task: formatTicketId(updated.id),
            env: updated.env,
            attempts: updated.attempts,
            requeued: requeue,
          },
          'released stale claimed task',
        );
      }
    }
  };

  const sweepStaleChatMessages = async (): Promise<void> => {
    if (config.chatMessageTimeoutMs <= 0) return;

    const now = Date.now();
    const onlineEnvs = new Set(
      repo
        .listHeartbeats(now)
        .filter((heartbeat) => heartbeat.online)
        .map((heartbeat) => heartbeat.env),
    );
    const failed = repo.failStaleChatMessages(
      onlineEnvs,
      now - config.chatMessageTimeoutMs,
      now,
    );

    if (failed > 0) {
      app.log.warn(
        { count: failed },
        'failed chat messages left RUNNING by an offline runner',
      );
    }
  };

  // -----------------------------------------------------------------
  // Public health check (no auth)
  // -----------------------------------------------------------------
  app.get('/healthz', async () => ({
    ok: true,
    version: SERVER_VERSION,
    startedAt: STARTED_AT,
    now: Date.now(),
  }));

  // -----------------------------------------------------------------
  // Bridge release manifest (no auth) — feeds `cli.mjs upgrade`
  // -----------------------------------------------------------------
  app.get('/api/bridge/latest', async (request, reply) => {
    if (!existsSync(bridgeManifestPath)) {
      return reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'no bridge release published yet',
        },
      });
    }

    let manifest;
    try {
      manifest = bridgeReleaseManifestSchema.parse(
        JSON.parse(readFileSync(bridgeManifestPath, 'utf8')),
      );
    } catch (error) {
      request.log.error({ err: error }, 'invalid bridge release manifest');
      return reply.code(500).send({
        error: {
          code: 'INVALID_MANIFEST',
          message: 'latest.json is not a valid bridge release manifest',
        },
      });
    }

    const origin =
      config.publicBaseUrl ||
      `${request.protocol}://${request.headers.host ?? 'localhost'}`;

    return reply.header('cache-control', 'no-cache').send({
      ...manifest,
      baseUrl:
        manifest.baseUrl ?? `${origin}/releases/bridge/${manifest.version}`,
    });
  });

  // -----------------------------------------------------------------
  // One-click enrollment (public: the one-time code is the capability)
  // -----------------------------------------------------------------
  const enrollmentLimiter = createEnrollmentRateLimiter();
  const publicOrigin = (request: {
    protocol: string;
    headers: { host?: string };
  }) =>
    (
      config.publicBaseUrl ||
      `${request.protocol}://${request.headers.host ?? 'localhost'}`
    ).replace(/\/+$/, '');

  // Install scripts are served from the hub so `curl … | bash` and
  // `irm … | iex` are the only commands a new user has to run.
  for (const [path, kind] of [
    ['/install.sh', 'sh'],
    ['/install.ps1', 'ps1'],
  ] as const) {
    app.get(path, async (request, reply) => {
      const query = z
        .object({ code: z.string().trim().max(64).optional() })
        .parse(request.query);
      return reply
        .type(kind === 'sh' ? 'application/x-sh' : 'text/plain')
        .header('cache-control', 'no-store')
        .send(
          renderInstallScript(kind, {
            hubUrl: publicOrigin(request),
            code: query.code ?? '',
          }),
        );
    });
  }

  // Exchange a code for a scoped agent token. Public by design: end users
  // must not need HUB_SECRET_TOKEN to connect a machine.
  app.post('/api/enroll', async (request, reply) => {
    const input = redeemEnrollmentSchema.parse(request.body);
    const codeHash = hashEnrollmentCode(input.code);

    if (!enrollmentLimiter.allow(codeHash)) {
      return reply.code(429).send({
        error: {
          code: 'ENROLL_RATE_LIMITED',
          message: '接入码尝试次数过多，请稍后再试或重新生成。',
        },
      });
    }

    const enrollment = repo.findEnrollmentByHash(codeHash);
    const now = Date.now();
    if (!enrollment || enrollment.expiresAt <= now) {
      throw new NotFoundError(
        '接入码无效或已过期，请重新生成。',
        'ENROLLMENT_INVALID',
      );
    }
    if (enrollment.useCount >= enrollment.maxUses) {
      throw new GoneError(
        '这个接入码已经用完了；请在控制台重新生成。',
        'ENROLLMENT_USED',
      );
    }
    // A code belongs to one machine. Host names are case-insensitive in
    // practice (`QideMacBook-Pro.local` vs `qidemacbook-pro.local`), so
    // compare them normalized.
    if (
      enrollment.usedHost &&
      input.host &&
      enrollment.usedHost.trim().toLowerCase() !== input.host.trim().toLowerCase()
    ) {
      throw new ForbiddenError(
        `这个接入码已绑定到 ${enrollment.usedHost}，不能在其他电脑上使用。`,
        'ENROLLMENT_HOST_MISMATCH',
      );
    }

    const kind = input.kind ?? enrollment.kind ?? 'other';
    const projectName = input.projectName ?? enrollment.projectName;

    // A code with a bound env ("公司") is the machine's display name, not an
    // identity shared by every client. With several slots each client gets
    // `<env>-<client>`; single-use codes keep the exact name for compatibility.
    const boundEnv = enrollment.env;
    const baseEnv = (
      boundEnv
        ? enrollment.maxUses > 1
          ? `${boundEnv}-${clientPrefix(kind)}`
          : boundEnv
        : input.env ?? `${kind}-${slugifyHost(input.host) || 'device'}`
    ).slice(0, 64);

    // Re-running the installer on the same machine should refresh the existing
    // card, not create `cursor-host-2` ghosts. An env this code already
    // produced is safe to reuse; everything else goes through the allocator so
    // a leaked code cannot take over another machine's identity.
    const env = enrollment.usedEnvs.includes(baseEnv)
      ? baseEnv
      : allocateEnv(
          (candidate) => repo.getAgentMachine(candidate),
          baseEnv,
          { host: input.host, machineId: input.machineId },
          // Two codes bound to one label are two identities on the same box.
          { reuseOwned: false },
        );

    if (!repo.consumeEnrollmentCode(enrollment.id, env, input.host, now)) {
      throw new NotFoundError(
        '接入码无效或已过期，请重新生成。',
        'ENROLLMENT_INVALID',
      );
    }

    const agent = repo.registerAgent({
      env,
      kind,
      name: env,
      ...(input.host ? { host: input.host } : {}),
      ...(input.os ? { os: input.os } : {}),
      ...(input.machineId ? { machineId: input.machineId } : {}),
    });
    const token = `zz_${randomBytes(32).toString('base64url')}`;
    repo.setAgentToken(env, hashToken(token), token.slice(0, 10), now);
    if (projectName) repo.bindWorkspaceProject(env, projectName, now);

    enrollmentLimiter.reset(codeHash);
    return {
      hubUrl: publicOrigin(request),
      token,
      env,
      agent: repo.getAgent(env, now) ?? agent,
      ...(projectName ? { projectName } : {}),
    };
  });

  // -----------------------------------------------------------------
  // Signed one-click approval page (no Bearer token; the URL is the
  // capability). Rendered server-side so it works from any notification.
  // -----------------------------------------------------------------
  app.get('/a/:token', async (request, reply) => {
    const { token } = approvalParamsSchema.parse(request.params);
    const payload = verifyApprovalToken(token, config.approvalLinkSecret);

    if (!payload) {
      return reply
        .code(410)
        .type('text/html; charset=utf-8')
        .send(
          renderApprovalResultPage(
            '链接已失效',
            '该审批链接已过期或无效，请打开看板重新审批。',
            false,
            config.publicBaseUrl,
          ),
        );
    }

    const ticket = repo.get(Number(payload.ticketId));
    if (!ticket) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(
          renderApprovalResultPage(
            '工单不存在',
            '这封奏折可能已被清理，请打开看板确认。',
            false,
            config.publicBaseUrl,
          ),
        );
    }

    if (!['PENDING_META', 'PENDING_HUMAN'].includes(ticket.status)) {
      return reply
        .type('text/html; charset=utf-8')
        .send(
          renderApprovalResultPage(
            '这封奏折已处理',
            `当前状态：${ticket.status}`,
            false,
            config.publicBaseUrl,
          ),
        );
    }

    return reply
      .type('text/html; charset=utf-8')
      .send(renderApprovalPage(ticket, token, config.publicBaseUrl));
  });

  app.post('/a/:token/resolve', async (request, reply) => {
    const { token } = approvalParamsSchema.parse(request.params);
    const payload = verifyApprovalToken(token, config.approvalLinkSecret);

    if (!payload) {
      return reply
        .code(410)
        .type('text/html; charset=utf-8')
        .send(
          renderApprovalResultPage(
            '链接已失效',
            '该审批链接已过期或无效，请打开看板重新审批。',
            false,
            config.publicBaseUrl,
          ),
        );
    }

    const input = approvalResolveSchema.parse(request.body ?? {});
    const ticketId = Number(payload.ticketId);
    const ticket = repo.get(ticketId);

    if (!ticket) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(
          renderApprovalResultPage(
            '工单不存在',
            '这封奏折可能已被清理，请打开看板确认。',
            false,
            config.publicBaseUrl,
          ),
        );
    }

    if (!['PENDING_META', 'PENDING_HUMAN'].includes(ticket.status)) {
      return reply
        .code(409)
        .type('text/html; charset=utf-8')
        .send(
          renderApprovalResultPage(
            '这封奏折已处理',
            `当前状态：${ticket.status}`,
            false,
            config.publicBaseUrl,
          ),
        );
    }

    const option = ticket.options.find(
      (item) => item.key === input.selectedOption,
    );
    if (!option) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          renderApprovalPage(
            ticket,
            token,
            config.publicBaseUrl,
            `选项 ${input.selectedOption} 不存在，请重新选择。`,
          ),
        );
    }

    const confirmed =
      input.confirmDestructive === true ||
      input.confirmDestructive === 'true';

    if (option.risk === 'destructive' && !confirmed) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          renderApprovalPage(
            ticket,
            token,
            config.publicBaseUrl,
            '这是高风险 / 不可逆选项，请勾选确认后再提交。',
            input.selectedOption,
            input.customInstruction ?? '',
          ),
        );
    }

    try {
      const resolved = repo.resolve(ticketId, {
        selectedOption: input.selectedOption,
        confirmDestructive: true,
        ...(input.customInstruction
          ? { customInstruction: input.customInstruction }
          : {}),
      });
      bus.publish(resolved);
      emitPluginEvent(plugins, 'onTicketResolved', resolved, app.log);
      void distillRule(resolved);

      return reply
        .type('text/html; charset=utf-8')
        .send(
          renderApprovalResultPage(
            '已准奏',
            `方案 ${option.key}「${option.label}」已生效，Agent 将立即恢复执行。`,
            true,
            config.publicBaseUrl,
          ),
        );
    } catch (error) {
      return reply
        .code(error instanceof ConflictError ? 409 : 500)
        .type('text/html; charset=utf-8')
        .send(
          renderApprovalResultPage(
            '未能提交',
            error instanceof Error ? error.message : '未知错误',
            false,
            config.publicBaseUrl,
          ),
        );
    }
  });

  // -----------------------------------------------------------------
  // Authenticated API
  // -----------------------------------------------------------------
  await app.register(
    async (api) => {
      api.addHook(
        'preHandler',
        createAuthHook({
          adminToken: config.token,
          resolveAgent: (tokenHash) => {
            const agent = repo.findAgentByTokenHash(tokenHash);
            return agent ? { env: agent.env, status: agent.status } : null;
          },
        }),
      );

      /**
       * Resolve the machine a fleet request belongs to.
       *
       * Agent tokens are pinned to the host registered on their heartbeat, so
       * one machine cannot read or claim another machine's pending
       * directories. The admin token may pass an explicit `host` (tests and
       * manual recovery).
       */
      const fleetHostFor = (
        request: FastifyRequest,
        explicit?: string,
      ): string => {
        const principal = request.principal;
        if (principal?.role === 'agent') {
          const agent = repo.getAgent(principal.env);
          const registered = agent?.host?.trim() ?? '';
          if (registered && explicit && explicit !== registered) {
            throw new ForbiddenError(
              `agent token belongs to ${registered}, not ${explicit}`,
              'HOST_FORBIDDEN',
            );
          }
          // Never trust a host supplied by an unbound token.
          return registered;
        }
        return explicit?.trim() ?? '';
      };

      const fleetKindOf = (adapter?: string): 'cursor' | 'opencode' | 'claude-code' | 'codex' | 'gemini' | 'qoder' | 'other' => {
        switch (adapter) {
          case 'cursor':
          case 'cursor-agent':
            return 'cursor';
          case 'opencode':
          case 'opencode-run':
            return 'opencode';
          case 'claude':
            return 'claude-code';
          case 'codex':
            return 'codex';
          case 'gemini':
            return 'gemini';
          case 'qoder':
            return 'qoder';
          default:
            return 'other';
        }
      };

      /** Mint a scoped token for a fleet-created workspace. */
      const mintFleetToken = (workspace: FleetWorkspace): string => {
        const agent =
          repo.getAgent(workspace.env) ??
          repo.registerAgent({
            env: workspace.env,
            name: workspace.projectName,
            kind: fleetKindOf(workspace.adapter),
            host: workspace.host,
          });
        if (agent.status !== 'active') {
          throw new ConflictError(
            `agent ${workspace.env} is disabled; enable it before associating a directory`,
            'AGENT_DISABLED',
          );
        }

        const token = `zz_${randomBytes(32).toString('base64url')}`;
        repo.setAgentToken(workspace.env, hashToken(token), token.slice(0, 10));
        return token;
      };

      /**
       * Fleet workspaces are unique per env as well as per host+path, and two
       * directories on ONE host share a basename often enough that a label held
       * by any workspace must move on, regardless of which machine holds it.
       */
      const uniqueFleetEnv = (base: string, host: string): string => {
        const taken = (env: string): boolean =>
          repo.getAgent(env) !== null || repo.getFleetWorkspaceByEnv(env) !== null;
        const allocated = allocateEnv(
          (env) => (taken(env) ? repo.getAgentMachine(env) : null),
          base,
          { host },
        );
        if (!taken(allocated)) return allocated;

        for (let index = 2; index < 100; index += 1) {
          const candidate = `${base.slice(0, 60)}-${index}`;
          if (!taken(candidate)) return candidate;
        }
        return `${base.slice(0, 55)}-${randomBytes(3).toString('hex')}`;
      };

      const fleetEnvPrefix: Record<string, string> = {
        opencode: 'opencode',
        'opencode-run': 'opencode',
        claude: 'claude',
        codex: 'codex',
        gemini: 'gemini',
        'cursor-agent': 'cursor',
      };

      const fleetEnvFor = (adapter: string | undefined, project: string): string => {
        const prefix = fleetEnvPrefix[adapter ?? ''] ?? 'agent';
        const slug =
          project
            .trim()
            .toLowerCase()
            .replace(/[\s/\\]+/g, '-')
            .replace(/[^\p{L}\p{N}._-]+/gu, '')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64) || 'project';
        return `${prefix}-${slug}`;
      };

      /** Works for both POSIX and Windows paths on any server OS. */
      const basenameAny = (path: string): string =>
        path.split(/[\\/]+/).filter(Boolean).pop() ?? 'project';

      // Create a ticket; Meta-Agent pre-review is scheduled immediately after.
      api.post('/tickets', async (request, reply) => {
        const input = createTicketSchema.parse(request.body);
        requireEnvAccess(request, input.env);
        const now = Date.now();
        const expiresAt = autoResolveEligible(input.projectName)
          ? now + config.autoResolveTimeoutMs
          : undefined;
        const ticket = repo.create(input, now, expiresAt);
        emitPluginEvent(plugins, 'onTicketCreated', ticket, app.log);

        setImmediate(() => {
          void runMetaReview(Number(ticket.id));
        });

        return reply.code(201).send({ ticket });
      });

      // Batch approval: resolve each ticket with its own recommended option
      // unless the caller pins one. Destructive options require an explicit
      // confirmDestructive=true and are skipped otherwise.
      api.post('/tickets/batch-resolve', async (request) => {
        requireAdmin(request);
        const input = batchResolveTicketsSchema.parse(request.body);
        const resolved: DecisionTicket[] = [];
        const skipped: Array<{ id: string; reason: string }> = [];

        for (const id of input.ticketIds) {
          const ticketId = parseTicketId(id);
          const current = repo.get(ticketId);
          if (!current) {
            skipped.push({ id, reason: '工单不存在' });
            continue;
          }
          if (!['PENDING_META', 'PENDING_HUMAN'].includes(current.status)) {
            skipped.push({ id, reason: `已处于 ${current.status}` });
            continue;
          }

          const optionKey = input.selectedOption ?? current.recommendedOption;
          const option = current.options.find(
            (item) => item.key === optionKey,
          );
          if (!option) {
            skipped.push({ id, reason: `选项 ${optionKey} 不存在` });
            continue;
          }
          if (
            option.risk === 'destructive' &&
            input.confirmDestructive !== true
          ) {
            skipped.push({ id, reason: '破坏性选项需要单独确认' });
            continue;
          }

          try {
            const ticket = repo.resolve(ticketId, {
              selectedOption: optionKey,
              ...(input.customInstruction
                ? { customInstruction: input.customInstruction }
                : {}),
              confirmDestructive: true,
            });
            bus.publish(ticket);
            emitPluginEvent(plugins, 'onTicketResolved', ticket, app.log);
            void distillRule(ticket);
            resolved.push(ticket);
          } catch (error) {
            skipped.push({
              id,
              reason: error instanceof Error ? error.message : '审批失败',
            });
          }
        }

        return { tickets: resolved, skipped };
      });

      // Long polling: hold the request until resolved, cancelled, or timeout.
      api.get('/tickets/:id/wait', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const ticketId = parseTicketId(id);
        const rawQuery = (request.query ?? {}) as Record<string, unknown>;
        const timeout =
          rawQuery.timeout === undefined
            ? config.waitTimeoutMs
            : waitQuerySchema.parse(rawQuery).timeout;

        const existing = repo.get(ticketId);
        if (!existing) throw new NotFoundError(`ticket ${formatTicketId(id)} not found`);
        requireEnvAccess(request, existing.env);

        if (isTerminalStatus(existing.status)) {
          return {
            resolved: isResolvedStatus(existing.status),
            timedOut: false,
            ticket: existing,
          };
        }

        const result = await bus.wait(existing.id, timeout);
        // A poll released by a restart may resume after the database is
        // already closed, so answering from the copy read before the wait is
        // the only safe fallback while closing.
        const ticket = result.ticket ?? (closing ? existing : repo.get(ticketId));

        if (!ticket) throw new NotFoundError(`ticket ${formatTicketId(id)} not found`);

        return {
          resolved: isResolvedStatus(ticket.status),
          timedOut: result.timedOut && !isTerminalStatus(ticket.status),
          ticket,
        };
      });

      api.get('/tickets/:id', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const ticket = repo.get(parseTicketId(id));
        if (!ticket) throw new NotFoundError(`ticket ${formatTicketId(id)} not found`);
        requireEnvAccess(request, ticket.env);
        return { ticket };
      });

      api.get('/tickets', async (request) => {
        const query = listTicketsQuerySchema.parse(request.query);
        // Agent tokens only see their own environment.
        const scoped =
          request.principal?.role === 'agent'
            ? { ...query, env: request.principal.env }
            : query;
        return repo.list(scoped);
      });

      // Human approval from the web console.
      api.post('/tickets/:id/resolve', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const input = resolveTicketSchema.parse(request.body);
        const ticket = repo.resolve(parseTicketId(id), input);

        bus.publish(ticket);
        emitPluginEvent(plugins, 'onTicketResolved', ticket, app.log);
        void distillRule(ticket);
        return { ticket };
      });

      // Snooze the timeout SLA. Useful when the human is away but does not
      // want the recommended option to be applied automatically yet.
      api.post('/tickets/:id/extend', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const input = extendTicketSchema.parse(request.body ?? {});
        const ticketId = parseTicketId(id);
        const current = repo.get(ticketId);
        if (!current) {
          throw new NotFoundError(`ticket ${formatTicketId(id)} not found`);
        }

        const ticket = repo.extend(ticketId, input.minutes);
        if (!ticket) {
          throw new ConflictError(
            `ticket ${formatTicketId(id)} is already ${current.status}`,
            'ALREADY_FINALIZED',
          );
        }

        return { ticket };
      });

      // Explicit cancellation (bridge timeout / user abort).
      api.post('/tickets/:id/cancel', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const ticketId = parseTicketId(id);
        const current = repo.get(ticketId);
        if (!current) throw new NotFoundError(`ticket ${formatTicketId(id)} not found`);
        requireEnvAccess(request, current.env);

        const cancelled = repo.cancel(ticketId);
        if (!cancelled) {
          throw new ConflictError(
            `ticket ${formatTicketId(id)} is already ${current.status}`,
            'ALREADY_FINALIZED',
          );
        }

        bus.publish(cancelled);
        emitPluginEvent(plugins, 'onTicketCancelled', cancelled, app.log);
        return { ticket: cancelled };
      });

      // -----------------------------------------------------------------
      // Human → Agent task dispatch
      // -----------------------------------------------------------------

      // Human dispatches a task from the dashboard.
      api.post('/tasks', async (request, reply) => {
        requireAdmin(request);
        const input = createTaskSchema.parse(request.body);
        const task = repo.createTask(input);
        taskBus.publish(task);
        return reply.code(201).send({ task });
      });

      /**
       * A wrapped local terminal (`zz run`) registers the command it is already
       * executing. Scoped to the agent's own env, and the hub — not the caller —
       * decides the origin and the status, so a node cannot fake a dispatch.
       */
      api.post('/tasks/local', async (request, reply) => {
        const input = createLocalTaskSchema.parse(request.body);
        requireEnvAccess(request, input.env);
        const task = repo.createWrappedTask(input);
        taskBus.publish(task);
        return reply.code(201).send({ task });
      });

      api.get('/tasks', async (request) => {
        requireAdmin(request);
        const query = listTasksQuerySchema.parse(request.query);
        return repo.listTasks(query);
      });

      /**
       * Routing facts for every identity that may take work: the agent says
       * which CLI it runs, its machine card says what the box has.
       */
      const routeCandidates = () =>
        toRouteCandidates(
          repo.listAgents().filter((agent) => agent.status === 'active'),
          repo.listDevices(),
          repo.activeTaskCountsByEnv(),
        );

      // Resource-aware dispatch: the human says what the work is and which
      // repository it lives in, the hub decides which machine runs it.
      api.post('/tasks/dispatch', async (request, reply) => {
        requireAdmin(request);
        const input = dispatchTaskSchema.parse(request.body);
        const now = Date.now();

        let target: string;
        let route: Record<string, unknown>;

        if (input.env) {
          // An explicit pin is a human decision, not a hint: honour it even
          // when that node looks loaded, and say so in the audit trail.
          if (!repo.getAgent(input.env, now)) {
            throw new ConflictError(
              `env ${input.env} is not registered with this hub`,
              'UNKNOWN_TARGET',
            );
          }
          target = input.env;
          route = { env: input.env, pinned: true };
        } else {
          const decision = routeTask(routeCandidates(), {
            ...(input.repoName ? { repoName: input.repoName } : {}),
            ...(input.engine ? { engine: input.engine } : {}),
            ...(input.tags.length ? { tags: input.tags } : {}),
          });

          if (!decision.env) {
            throw new ConflictError(decision.reason, 'NO_ROUTE_TARGET');
          }

          target = decision.env;
          route = {
            env: decision.env,
            reason: decision.reason,
            assessed: decision.assessed,
          };
        }

        const task = repo.createTask(
          {
            env: target,
            title: input.title,
            instruction: input.instruction,
            ...(input.repoName ? { repoName: input.repoName } : {}),
            ...(input.engine ? { engine: input.engine } : {}),
            ...(input.managedBySupervisor === undefined
              ? {}
              : { managedBySupervisor: input.managedBySupervisor }),
          },
          now,
        );

        taskBus.publish(task);
        return reply.code(201).send({ task, route });
      });

      // Bridge long-polls for the next task assigned to its env.
      api.get('/tasks/next', async (request) => {
        const query = nextTaskQuerySchema.parse(request.query);
        requireEnvAccess(request, query.env);
        const deadline = Date.now() + query.timeout;

        for (;;) {
          const task = repo.claimNextTask(query.env);
          if (task) return { task, timedOut: false };

          const remaining = deadline - Date.now();
          if (remaining <= 0) return { task: null, timedOut: true };

          const wake = await taskBus.wait(query.env, remaining, () =>
            repo.claimNextTask(query.env),
          );
          if (wake.task) return { task: wake.task, timedOut: false };
          if (wake.timedOut) return { task: null, timedOut: true };
          // Another waiter may have claimed the published task; loop.
        }
      });

      api.get('/tasks/:id', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const task = repo.getTask(parseTicketId(id));
        if (!task) throw new NotFoundError(`task ${formatTicketId(id)} not found`);
        requireEnvAccess(request, task.env);
        return { task };
      });

      // Agent reports completion / failure.
      api.post('/tasks/:id/complete', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const taskId = parseTicketId(id);
        const current = repo.getTask(taskId);
        if (!current) throw new NotFoundError(`task ${formatTicketId(id)} not found`);
        requireEnvAccess(request, current.env);
        const input = completeTaskSchema.parse(request.body);
        const task = repo.completeTask(taskId, input);
        return { task };
      });

      // Live output from a running task. The bridge batches stdout/stderr and
      // posts chunks here; the dashboard tails them while the task is active.
      api.post('/tasks/:id/log', async (request, reply) => {
        const { id } = paramsSchema.parse(request.params);
        const taskId = parseTicketId(id);
        const task = repo.getTask(taskId);
        if (!task) throw new NotFoundError(`task ${formatTicketId(id)} not found`);
        requireEnvAccess(request, task.env);
        if (task.status !== 'CLAIMED') {
          throw new ConflictError(
            `task ${formatTicketId(id)} is ${task.status}, expected CLAIMED`,
            'INVALID_TASK_STATUS',
          );
        }

        const input = appendTaskLogSchema.parse(request.body);
        const log = repo.appendTaskLog(taskId, input);
        return reply.code(201).send({ log });
      });

      api.get('/tasks/:id/logs', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const taskId = parseTicketId(id);
        const task = repo.getTask(taskId);
        if (!task) throw new NotFoundError(`task ${formatTicketId(id)} not found`);
        requireEnvAccess(request, task.env);
        const query = listTaskLogsQuerySchema.parse(request.query);
        return repo.listTaskLogs(taskId, query);
      });

      // Normalised engine events: which tool ran, whether the engine is
      // waiting for approval, and the session id a later claim resumes from.
      // The bridge batches these; refusing an unclaimed task keeps a late
      // flush from rewriting a run that already ended.
      api.post('/tasks/:id/events', async (request, reply) => {
        const { id } = paramsSchema.parse(request.params);
        const taskId = parseTicketId(id);
        const task = repo.getTask(taskId);
        if (!task) throw new NotFoundError(`task ${formatTicketId(id)} not found`);
        requireEnvAccess(request, task.env);
        if (task.status !== 'CLAIMED') {
          throw new ConflictError(
            `task ${formatTicketId(id)} is ${task.status}, expected CLAIMED`,
            'INVALID_TASK_STATUS',
          );
        }

        const input = reportTaskEventsSchema.parse(request.body);
        const stored = repo.reportTaskEvents(taskId, input.events);
        return reply.code(201).send({ stored });
      });

      api.get('/tasks/:id/events', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const taskId = parseTicketId(id);
        const task = repo.getTask(taskId);
        if (!task) throw new NotFoundError(`task ${formatTicketId(id)} not found`);
        requireEnvAccess(request, task.env);
        const query = listTaskEventsQuerySchema.parse(request.query);
        return repo.listTaskEvents(taskId, query);
      });

      // -----------------------------------------------------------------
      // Interactive sessions (human ↔ project agent)
      // -----------------------------------------------------------------

      api.post('/sessions', async (request, reply) => {
        requireAdmin(request);
        const input = createChatSessionSchema.parse(request.body);
        const session = repo.createChatSession(input);
        return reply.code(201).send({ session, messages: [] });
      });

      // Draft mode (L1): an agent proposes the next reply, but the draft stays
      // PROPOSED and therefore invisible to the bridge long-poll until a human
      // adopts it. Session is resolved from the env so the MCP tool does not
      // need to know which conversation it woke up in.
      api.post('/sessions/proposals', async (request, reply) => {
        const input = proposeChatReplySchema.parse(request.body);
        requireEnvAccess(request, input.env);

        const session = input.sessionId
          ? repo.getChatSession(parseTicketId(input.sessionId))
          : repo.findLatestActiveChatSession(input.env);
        if (!session) {
          throw new NotFoundError(`no active session for env ${input.env}`);
        }
        if (session.env !== input.env) {
          throw new BadRequestError(
            `session ${formatTicketId(session.id)} belongs to ${session.env}`,
            'SESSION_ENV_MISMATCH',
          );
        }
        if (session.status !== 'ACTIVE') {
          throw new ConflictError(
            `session ${formatTicketId(session.id)} is ${session.status}`,
            'SESSION_CLOSED',
          );
        }

        const message = repo.createChatProposal(Number(session.id), {
          content: input.content,
          ...(input.rationale ? { rationale: input.rationale } : {}),
        });
        sessionBus.publish(session);
        return reply.code(201).send({ session, message });
      });

      // -----------------------------------------------------------------
      // Hub-side judgment: one entry for every non-trivial agent move.
      //
      // Agents no longer choose between acting and asking. They submit the
      // exact thing they want to do plus the facts, and the hub answers
      // APPROVED (go ahead) or opens a ticket for a human. The same rules,
      // precedents and destructive guardrails back tickets and replies.
      // -----------------------------------------------------------------
      api.post('/decisions', async (request, reply) => {
        const input = decisionRequestSchema.parse(request.body);
        requireEnvAccess(request, input.env);

        const outcome = await evaluateDecision(input, {
          mode: config.decisionPolicy,
          metaAgent,
          readRules: () => rulesStore.read().content,
          precedentsFor: (req) => {
            const ticket = syntheticTicket(req);
            return repo.findSimilarTickets({
              projectName: req.projectName,
              blockerQuestion: ticket.blockerQuestion,
              limit: 5,
            });
          },
        });

        if (outcome.verdict === 'APPROVED') {
          // Only replies have a delivery target; other kinds are a permit, and
          // get an AUTO_RESOLVED ticket so the ruling stays auditable.
          if (input.kind !== 'reply') {
            const now = Date.now();
            const expiresAt = autoResolveEligible(input.projectName)
              ? now + config.autoResolveTimeoutMs
              : undefined;
            const created = repo.create(syntheticTicket(input), now, expiresAt);
            const resolved =
              repo.markAutoResolved(
                Number(created.id),
                outcome.selectedOption ?? created.recommendedOption,
                outcome.reason,
              ) ?? created;
            bus.publish(resolved);
            emitPluginEvent(plugins, 'onTicketResolved', resolved, app.log);
            return {
              verdict: outcome.verdict,
              reason: outcome.reason,
              ...(outcome.selectedOption
                ? { selectedOption: outcome.selectedOption }
                : {}),
              ticket: resolved,
            };
          }

          const session = input.sessionId
            ? repo.getChatSession(parseTicketId(input.sessionId))
            : repo.findLatestActiveChatSession(input.env);
          if (!session) {
            throw new NotFoundError(`no active session for env ${input.env}`);
          }
          if (session.env !== input.env) {
            throw new BadRequestError(
              `session ${formatTicketId(session.id)} belongs to ${session.env}`,
              'SESSION_ENV_MISMATCH',
            );
          }
          if (session.status !== 'ACTIVE') {
            throw new ConflictError(
              `session ${formatTicketId(session.id)} is ${session.status}`,
              'SESSION_CLOSED',
            );
          }

          const message = repo.queueChatReply(Number(session.id), {
            content: input.proposal,
            rationale: input.rationale ?? outcome.reason,
            decision: 'AUTO',
          });
          sessionBus.publish(session);
          app.log.info(
            { session: formatTicketId(session.id), message: formatTicketId(message.id) },
            'hub auto-adopted agent reply',
          );
          return reply.code(201).send({
            verdict: outcome.verdict,
            reason: outcome.reason,
            session,
            message,
          });
        }

        // PENDING: the same submission becomes a ticket on the dashboard.
        const now = Date.now();
        const expiresAt = autoResolveEligible(input.projectName)
          ? now + config.autoResolveTimeoutMs
          : undefined;
        const created = repo.create(syntheticTicket(input), now, expiresAt);
        emitPluginEvent(plugins, 'onTicketCreated', created, app.log);

        const pending =
          repo.markPendingHuman(Number(created.id), outcome.reason) ?? created;
        bus.publish(pending);
        notifyTicketPendingHuman(
          notifiers,
          pending,
          app.log,
          approvalUrlFor(pending),
        );
        emitPluginEvent(plugins, 'onTicketPendingHuman', pending, app.log);

        return reply.code(201).send({
          verdict: outcome.verdict,
          reason: outcome.reason,
          ticket: pending,
        });
      });

      api.get('/sessions', async (request) => {
        requireAdmin(request);
        const query = listChatSessionsQuerySchema.parse(request.query);
        return { sessions: repo.listChatSessions(query) };
      });

      // The bridge long-polls for the next user message in its env.
      api.get('/sessions/next', async (request) => {
        const query = nextChatMessageQuerySchema.parse(request.query);
        requireEnvAccess(request, query.env);

        // A new session-loop instance means the previous one died. Anything it
        // left RUNNING can never be reported, so make it retryable now.
        if (query.runner) {
          const previous = repo.claimRunner(query.env, query.runner);
          if (previous && previous !== query.runner) {
            const failed = repo.failRunningChatMessages(query.env);
            if (failed > 0) {
              app.log.warn(
                { env: query.env, count: failed },
                'recovered chat messages left RUNNING by a replaced runner',
              );
            }
          }
        }

        const deadline = Date.now() + query.timeout;

        for (;;) {
          const claimed = repo.claimNextChatMessage(query.env);
          if (claimed) return { ...claimed, timedOut: false };

          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return { session: null, message: null, timedOut: true };
          }

          const wake = await sessionBus.wait(query.env, remaining, () =>
            repo.claimNextChatMessage(query.env),
          );
          if (wake.claim) return { ...wake.claim, timedOut: false };
          if (wake.timedOut) {
            return { session: null, message: null, timedOut: true };
          }
        }
      });

      api.get('/sessions/:id', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const session = repo.getChatSession(parseTicketId(id));
        if (!session) {
          throw new NotFoundError(`session ${formatTicketId(id)} not found`);
        }
        requireEnvAccess(request, session.env);
        return {
          session,
          messages: repo.listChatMessages(Number(session.id)),
        };
      });

      api.post('/sessions/:id/messages', async (request, reply) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const session = repo.getChatSession(parseTicketId(id));
        if (!session) {
          throw new NotFoundError(`session ${formatTicketId(id)} not found`);
        }
        if (session.status !== 'ACTIVE') {
          throw new ConflictError(
            `session ${formatTicketId(id)} is ${session.status}`,
            'SESSION_CLOSED',
          );
        }

        const input = sendChatMessageSchema.parse(request.body);
        const message = repo.sendChatMessage(Number(session.id), input);
        sessionBus.publish(session);
        return reply.code(201).send({ session, message });
      });

      // Adopting a draft is the only path that turns agent-authored text into
      // a queued user message; the human may edit it on the way through.
      api.post(
        '/sessions/:id/proposals/:messageId/adopt',
        async (request, reply) => {
          requireAdmin(request);
          const { id, messageId } = chatMessageParamsSchema.parse(request.params);
          const session = repo.getChatSession(parseTicketId(id));
          if (!session) {
            throw new NotFoundError(`session ${formatTicketId(id)} not found`);
          }
          if (session.status !== 'ACTIVE') {
            throw new ConflictError(
              `session ${formatTicketId(id)} is ${session.status}`,
              'SESSION_CLOSED',
            );
          }

          const input = adoptChatProposalSchema.parse(request.body ?? {});
          const message = repo.adoptChatProposal(
            Number(session.id),
            parseTicketId(messageId),
            input,
          );
          if (!message) {
            throw new ConflictError(
              `proposal ${formatTicketId(messageId)} is not pending`,
              'INVALID_PROPOSAL_STATUS',
            );
          }

          sessionBus.publish(session);
          return reply.code(201).send({ session, message });
        },
      );

      api.post(
        '/sessions/:id/proposals/:messageId/discard',
        async (request, reply) => {
          requireAdmin(request);
          const { id, messageId } = chatMessageParamsSchema.parse(request.params);
          const session = repo.getChatSession(parseTicketId(id));
          if (!session) {
            throw new NotFoundError(`session ${formatTicketId(id)} not found`);
          }

          const message = repo.discardChatProposal(
            Number(session.id),
            parseTicketId(messageId),
          );
          if (!message) {
            throw new ConflictError(
              `proposal ${formatTicketId(messageId)} is not pending`,
              'INVALID_PROPOSAL_STATUS',
            );
          }

          sessionBus.publish(session);
          return { session, message };
        },
      );

      api.post('/sessions/:id/close', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const session = repo.getChatSession(parseTicketId(id));
        if (!session) {
          throw new NotFoundError(`session ${formatTicketId(id)} not found`);
        }

        const closed = repo.closeChatSession(Number(session.id));
        if (!closed) {
          throw new ConflictError(
            `session ${formatTicketId(id)} is already ${session.status}`,
            'ALREADY_FINALIZED',
          );
        }
        return { session: closed };
      });

      // Permanently removes the session, its transcript and streamed output.
      api.delete('/sessions/:id', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const session = repo.getChatSession(parseTicketId(id));
        if (!session) {
          throw new NotFoundError(`session ${formatTicketId(id)} not found`);
        }
        const running = repo
          .listChatMessages(Number(session.id))
          .some((message) => message.status === 'RUNNING');
        if (running) {
          throw new ConflictError(
            `session ${formatTicketId(id)} has a running message`,
            'SESSION_BUSY',
          );
        }
        repo.deleteChatSession(Number(session.id));
        sessionBus.publish(session);
        return { deleted: true, id: session.id };
      });

      api.post('/sessions/:id/messages/:messageId/events', async (request, reply) => {
        const { id, messageId } = chatMessageParamsSchema.parse(request.params);
        const session = repo.getChatSession(parseTicketId(id));
        if (!session) {
          throw new NotFoundError(`session ${formatTicketId(id)} not found`);
        }
        requireEnvAccess(request, session.env);

        const message = repo.getChatMessage(parseTicketId(messageId));
        if (!message || message.sessionId !== session.id) {
          throw new NotFoundError(
            `message ${formatTicketId(messageId)} not found in session ${formatTicketId(id)}`,
          );
        }
        if (message.status !== 'RUNNING') {
          throw new ConflictError(
            `message ${formatTicketId(messageId)} is ${message.status}, expected RUNNING`,
            'INVALID_MESSAGE_STATUS',
          );
        }

        const input = appendChatEventSchema.parse(request.body);
        const event = repo.appendChatEvent(
          Number(session.id),
          Number(message.id),
          input,
        );
        return reply.code(201).send({ event });
      });

      api.get('/sessions/:id/events', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const session = repo.getChatSession(parseTicketId(id));
        if (!session) {
          throw new NotFoundError(`session ${formatTicketId(id)} not found`);
        }
        requireEnvAccess(request, session.env);
        const query = listChatEventsQuerySchema.parse(request.query);
        return repo.listChatEvents(Number(session.id), query);
      });

      api.post('/sessions/:id/messages/:messageId/complete', async (request) => {
        const { id, messageId } = chatMessageParamsSchema.parse(request.params);
        const session = repo.getChatSession(parseTicketId(id));
        if (!session) {
          throw new NotFoundError(`session ${formatTicketId(id)} not found`);
        }
        requireEnvAccess(request, session.env);

        const message = repo.getChatMessage(parseTicketId(messageId));
        if (!message || message.sessionId !== session.id) {
          throw new NotFoundError(
            `message ${formatTicketId(messageId)} not found in session ${formatTicketId(id)}`,
          );
        }

        const input = completeChatMessageSchema.parse(request.body);
        return repo.completeChatMessage(
          Number(session.id),
          Number(message.id),
          input,
          Date.now(),
          input.force === true,
        );
      });

      // Human retries a failed turn in place; the runner claims it again.
      api.post('/sessions/:id/messages/:messageId/retry', async (request) => {
        requireAdmin(request);
        const { id, messageId } = chatMessageParamsSchema.parse(request.params);
        const session = repo.getChatSession(parseTicketId(id));
        if (!session) {
          throw new NotFoundError(`session ${formatTicketId(id)} not found`);
        }
        if (session.status !== 'ACTIVE') {
          throw new ConflictError(
            `session ${formatTicketId(id)} is ${session.status}`,
            'SESSION_CLOSED',
          );
        }

        const message = repo.retryChatMessage(
          Number(session.id),
          parseTicketId(messageId),
        );
        if (!message) {
          throw new ConflictError(
            `message ${formatTicketId(messageId)} is not FAILED`,
            'INVALID_MESSAGE_STATUS',
          );
        }

        sessionBus.publish(session);
        return { session, message };
      });

      // A queued message is still the human's draft until the runner claims
      // it, so let them rewrite it without losing its place in the queue.
      api.patch('/sessions/:id/messages/:messageId', async (request) => {
        requireAdmin(request);
        const { id, messageId } = chatMessageParamsSchema.parse(request.params);
        const session = repo.getChatSession(parseTicketId(id));
        if (!session) {
          throw new NotFoundError(`session ${formatTicketId(id)} not found`);
        }
        if (session.status !== 'ACTIVE') {
          throw new ConflictError(
            `session ${formatTicketId(id)} is ${session.status}`,
            'SESSION_CLOSED',
          );
        }

        const input = editChatMessageSchema.parse(request.body);
        const message = repo.editQueuedChatMessage(
          Number(session.id),
          parseTicketId(messageId),
          input,
        );
        if (!message) {
          throw new ConflictError(
            `message ${formatTicketId(messageId)} is not an editable queued message`,
            'INVALID_MESSAGE_STATUS',
          );
        }

        sessionBus.publish(session);
        return { session, message };
      });

      // Withdraw a queued message. It stays in the transcript as CANCELLED so
      // the audit trail still shows what was pulled back.
      api.post(
        '/sessions/:id/messages/:messageId/cancel',
        async (request) => {
          requireAdmin(request);
          const { id, messageId } = chatMessageParamsSchema.parse(request.params);
          const session = repo.getChatSession(parseTicketId(id));
          if (!session) {
            throw new NotFoundError(`session ${formatTicketId(id)} not found`);
          }
          if (session.status !== 'ACTIVE') {
            throw new ConflictError(
              `session ${formatTicketId(id)} is ${session.status}`,
              'SESSION_CLOSED',
            );
          }

          const message = repo.cancelQueuedChatMessage(
            Number(session.id),
            parseTicketId(messageId),
          );
          if (!message) {
            throw new ConflictError(
              `message ${formatTicketId(messageId)} is not a queued message`,
              'INVALID_MESSAGE_STATUS',
            );
          }

          sessionBus.publish(session);
          return { session, message };
        },
      );

      // Bridge hands a claimed task back when no local agent could be woken.
      // Requeueing lets the next bridge / wake adapter retry it immediately
      // instead of waiting for the stale-task sweeper.
      api.post('/tasks/:id/release', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const input = releaseTaskSchema.parse(request.body ?? {});
        const taskId = parseTicketId(id);
        const current = repo.getTask(taskId);
        if (!current) throw new NotFoundError(`task ${formatTicketId(id)} not found`);
        requireEnvAccess(request, current.env);
        const reason =
          input.reason ??
          (input.requeue
            ? '端侧未能唤醒，任务已重新排队'
            : '端侧未能唤醒，任务已失败');

        const task = repo.releaseTask(taskId, input.requeue, reason);
        if (!task) {
          const current = repo.getTask(taskId);
          if (!current) {
            throw new NotFoundError(
              `task ${formatTicketId(id)} not found`,
            );
          }
          throw new ConflictError(
            `task ${formatTicketId(id)} is ${current.status}, expected CLAIMED`,
            'ALREADY_FINALIZED',
          );
        }

        taskBus.publish(task);
        return { task };
      });

      /**
       * The edge declares a live run unattended, so the hub supervisor may rule
       * on its requests without waiting for a human (Step 2.3 auto-handover).
       * One-way and idempotent: taking a task over is easy, and only a human
       * resolves the ticket that follows.
       */
      api.post('/tasks/:id/takeover', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const taskId = parseTicketId(id);
        const current = repo.getTask(taskId);
        if (!current) throw new NotFoundError(`task ${formatTicketId(id)} not found`);
        requireEnvAccess(request, current.env);
        const input = takeoverTaskSchema.parse(request.body ?? {});

        const { task, changed } = repo.markTaskManaged(taskId, input.reason);
        if (changed) taskBus.publish(task);
        return { task, changed };
      });

      // Human cancels a task that has not finished.
      api.post('/tasks/:id/cancel', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const taskId = parseTicketId(id);
        const current = repo.getTask(taskId);
        if (!current) throw new NotFoundError(`task ${formatTicketId(id)} not found`);

        const cancelled = repo.cancelTask(taskId);
        if (!cancelled) {
          throw new ConflictError(
            `task ${formatTicketId(id)} is already ${current.status}`,
            'ALREADY_FINALIZED',
          );
        }

        return { task: cancelled };
      });

      // Agent mirrors the human's question and its conclusion for one turn.
      api.post('/exchanges', async (request, reply) => {
        const input = reportExchangeSchema.parse(request.body);
        requireEnvAccess(request, input.env);
        const exchange = repo.createExchange(input.env, input);
        return reply.code(201).send({ exchange });
      });

      api.get('/exchanges', async (request) => {
        requireAdmin(request);
        const query = listExchangesQuerySchema.parse(request.query);
        return { exchanges: repo.listExchanges(query) };
      });

      // Bridge heartbeat: Running / Blocked / Idle.
      api.post('/status/heartbeat', async (request) => {
        const input = heartbeatSchema.parse(request.body);
        requireEnvAccess(request, input.env);
        return { heartbeat: repo.recordHeartbeat(input) };
      });

      api.get('/status', async (request) => {
        requireAdmin(request);
        return { envs: repo.listHeartbeats() };
      });

      // Browsers cannot set an Authorization header on a WebSocket handshake.
      // The dashboard exchanges its admin token for this short-lived ticket.
      api.post('/realtime/ticket', async (request) => {
        requireAdmin(request);
        if (!config.realtimeEnabled) {
          throw new ConflictError(
            'realtime gateway is disabled',
            'REALTIME_DISABLED',
          );
        }
        const expiresAt = Date.now() + config.realtimeTicketTtlMs;
        return {
          ticket: buildRealtimeTicket(expiresAt, config.approvalLinkSecret),
          expiresAt,
        };
      });

      api.get('/realtime/status', async (request) => {
        requireAdmin(request);
        return {
          enabled: config.realtimeEnabled,
          devices: realtime?.deviceCount() ?? 0,
          dashboards: realtime?.dashboardCount() ?? 0,
          bridges: realtime?.bridgeCount() ?? 0,
          heartbeatMs: config.realtimeHeartbeatMs,
        };
      });

      // -----------------------------------------------------------------
      // Interactive PTY terminals
      // -----------------------------------------------------------------

      const requireTerminals = (): TerminalManager => {
        if (!terminals) {
          throw new ConflictError(
            'terminal sessions are disabled',
            'TERMINAL_DISABLED',
          );
        }
        return terminals;
      };

      api.post('/terminals', async (request, reply) => {
        requireAdmin(request);
        const input = createTerminalSchema.parse(request.body);
        const session = requireTerminals().create(input);
        return reply.code(201).send({ session });
      });

      api.get('/terminals', async (request) => {
        requireAdmin(request);
        const query = listTerminalsQuerySchema.parse(request.query);
        return requireTerminals().list(query);
      });

      api.get('/terminals/stats', async (request) => {
        requireAdmin(request);
        return requireTerminals().stats();
      });

      api.get('/terminals/:id', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const session = requireTerminals().get(parseTicketId(id));
        if (!session) {
          throw new NotFoundError(`terminal ${formatTicketId(id)} not found`);
        }
        return { session };
      });

      api.post('/terminals/:id/close', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const input = terminalCloseSchema.parse(request.body ?? {});
        return { session: requireTerminals().close(parseTicketId(id), input.reason) };
      });

      api.get('/terminals/:id/events', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const query = listTerminalEventsQuerySchema.parse(request.query);
        return requireTerminals().events(parseTicketId(id), query);
      });

      api.get('/terminals/:id/audit', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const query = listTerminalAuditQuerySchema.parse(request.query);
        return requireTerminals().audit(parseTicketId(id), query);
      });

      api.get('/terminals/:id/audit/export', async (request, reply) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const terminalId = parseTicketId(id);
        const session = repo.getTerminalSession(terminalId);
        if (!session) {
          throw new NotFoundError(`terminal ${formatTicketId(id)} not found`);
        }
        const { format } = terminalAuditExportQuerySchema.parse(request.query);
        const { entries } = repo.listTerminalAudit(terminalId, {
          after: 0,
          limit: 5_000,
        });

        if (format === 'csv') {
          const escape = (value: string | undefined): string => {
            const raw = value ?? '';
            // Prevent spreadsheet formula injection in exported CSVs.
            const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
            return `"${safe.replace(/"/g, '""')}"`;
          };
          const rows = [
            ['id', 'createdAt', 'kind', 'viewerId', 'data'].join(','),
            ...entries.map((entry) =>
              [
                escape(entry.id),
                escape(String(entry.createdAt)),
                escape(entry.kind),
                escape(entry.viewerId),
                escape(entry.data),
              ].join(','),
            ),
          ];
          return reply
            .type('text/csv; charset=utf-8')
            .header(
              'content-disposition',
              `attachment; filename="terminal-${terminalId}-audit.csv"`,
            )
            .send(rows.join('\n'));
        }

        return reply
          .type('application/x-ndjson; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="terminal-${terminalId}-audit.jsonl"`,
          )
          .send(entries.map((entry) => JSON.stringify(entry)).join('\n'));
      });

      // Dashboard long poll: returns the whole snapshot once, then stays
      // silent until anything changes. `after=0` always gets a snapshot.
      api.get('/sync', async (request) => {
        requireAdmin(request);
        const query = syncQuerySchema.parse(request.query);

        // Catch changes that happened while no dashboard was waiting (the
        // ticker is stopped when idle, so the stored fingerprint may be old).
        refreshSyncFingerprint();

        let rev = syncBus.revision;
        if (rev === query.after && query.timeout > 0) {
          ensureSyncTicker();
          const wake = await syncBus.wait(query.after, query.timeout);
          stopSyncTickerIfIdle();
          rev = wake.rev;
          if (wake.timedOut) return { rev, changed: false };
        }

        if (rev === query.after) return { rev, changed: false };

        return {
          // Re-read after building the snapshot in case another change
          // landed while the queries were running.
          rev: syncBus.revision,
          changed: true,
          state: syncSnapshot(),
        };
      });

      // Bridge restart recovery: pending decisions plus recently terminal
      // tickets and still-active tasks for this env.
      api.get('/resume', async (request) => {
        const query = resumeQuerySchema.parse(request.query);
        requireEnvAccess(request, query.env);
        const since = query.since ?? Date.now() - 24 * 60 * 60 * 1000;

        return {
          tickets: repo.listResumeTickets(query.env, since, query.limit),
          tasks: repo.listActiveTasks(query.env, query.limit),
        };
      });

      // -----------------------------------------------------------------
      // One-time enrollment links
      // -----------------------------------------------------------------

      // The dashboard mints a code and shows the matching one-line command;
      // the plaintext code is returned exactly once.
      api.post('/enrollments', async (request, reply) => {
        requireAdmin(request);
        const input = createEnrollmentSchema.parse(request.body);
        const code = generateEnrollmentCode();
        const ttlMs = input.ttlMinutes
          ? input.ttlMinutes * 60 * 1000
          : ENROLLMENT_CODE_TTL_MS;
        const enrollment = repo.createEnrollmentCode({
          codeHash: hashEnrollmentCode(code),
          codePrefix: code.slice(0, 5),
          ttlMs,
          maxUses: input.maxUses ?? ENROLLMENT_CODE_MAX_USES,
          ...(input.env ? { env: input.env } : {}),
          ...(input.label ? { label: input.label } : {}),
          ...(input.projectName ? { projectName: input.projectName } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
        });
        const origin = publicOrigin(request);

        return reply.code(201).send({
          enrollment: {
            code,
            ...(enrollment.env ? { env: enrollment.env } : {}),
            ...(enrollment.label ? { label: enrollment.label } : {}),
            ...(enrollment.projectName
              ? { projectName: enrollment.projectName }
              : {}),
            ...(enrollment.kind ? { kind: enrollment.kind } : {}),
            expiresAt: enrollment.expiresAt,
            createdAt: enrollment.createdAt,
            maxUses: enrollment.maxUses,
            useCount: enrollment.useCount,
          },
          commands: {
            unix: `curl -fsSL '${origin}/install.sh?code=${code}' | bash`,
            windows: `irm '${origin}/install.ps1?code=${code}' | iex`,
          },
        });
      });

      // -----------------------------------------------------------------
      // Agent registry & per-agent tokens
      // -----------------------------------------------------------------

      api.get('/agents', async (request) => {
        requireAdmin(request);
        const query = listAgentsQuerySchema.parse(request.query);
        return { agents: repo.listAgents(query) };
      });

      /**
       * Machines rather than processes: one card per box, with the agent
       * identities running on it.
       */
      api.get('/devices', async (request) => {
        requireAdmin(request);
        return { devices: repo.listDevices() };
      });

      /**
       * The fleet as the scheduler sees it: one row per dispatchable identity,
       * aged out on the node heartbeat window rather than the 90s display
       * window, because a box that has not beaten in half a minute may be
       * asleep and must not be handed work.
       */
      api.get('/nodes', async (request) => {
        requireAdmin(request);
        const now = Date.now();
        const nodes = routeCandidates().map((candidate) => ({
          ...candidate,
          online:
            candidate.lastSeenAt !== undefined &&
            now - candidate.lastSeenAt <= NODE_HEARTBEAT_TIMEOUT_MS,
        }));
        return { nodes };
      });

      /**
       * The other axis of the same question: which repositories the hub has
       * work in, and which machines and identities touch each of them.
       */
      api.get('/projects', async (request) => {
        requireAdmin(request);
        return { projects: repo.listProjects() };
      });

      // Explicit registration. Heartbeats alone never create an agent row, so
      // a bridge that only sends heartbeats stays under "未注册" until it registers.
      // The caller gets the env the hub actually allocated, which differs from
      // the requested one only when another machine already holds that label.
      api.post('/agents', async (request, reply) => {
        requireAdmin(request);
        const input = createAgentSchema.parse(request.body);
        const env = allocateEnv(
          (candidate) => repo.getAgentMachine(candidate),
          input.env,
          { host: input.host, machineId: input.machineId },
        );
        const existed = repo.getAgent(env) !== null;
        const agent = repo.registerAgent({ ...input, env });
        return reply.code(existed ? 200 : 201).send({ agent });
      });

      api.patch('/agents/:env', async (request) => {
        requireAdmin(request);
        const { env } = agentParamsSchema.parse(request.params);
        const input = updateAgentSchema.parse(request.body);
        const agent = repo.updateAgent(env, input);
        if (!agent) throw new NotFoundError(`agent ${env} not found`);
        return { agent };
      });

      api.delete('/agents/:env', async (request) => {
        requireAdmin(request);
        const { env } = agentParamsSchema.parse(request.params);
        if (!repo.deleteAgent(env)) {
          throw new NotFoundError(`agent ${env} not found`);
        }
        // Kick any live socket so the client notices immediately instead of
        // keep-alive pings holding a zombie connection for a removed env.
        realtime?.disconnectEnv(env);
        refreshSyncFingerprint();
        return { deleted: true, env };
      });

      // Issue or rotate a scoped token. The plaintext value is returned once
      // and never stored; only a sha256 hash stays in the database.
      api.post('/agents/:env/token', async (request) => {
        requireAdmin(request);
        const { env } = agentParamsSchema.parse(request.params);
        const agent = repo.getAgent(env) ?? repo.registerAgent({ env });
        if (agent.status !== 'active') {
          throw new ConflictError(
            `agent ${env} is disabled; enable it before issuing a token`,
            'AGENT_DISABLED',
          );
        }

        const token = `zz_${randomBytes(32).toString('base64url')}`;
        const updated = repo.setAgentToken(
          env,
          hashToken(token),
          token.slice(0, 10),
        );
        if (!updated) throw new NotFoundError(`agent ${env} not found`);
        return { agent: updated, token };
      });

      api.delete('/agents/:env/token', async (request) => {
        requireAdmin(request);
        const { env } = agentParamsSchema.parse(request.params);
        const agent = repo.clearAgentToken(env);
        if (!agent) throw new NotFoundError(`agent ${env} not found`);
        return { agent };
      });

      // -----------------------------------------------------------------
      // Workspace ↔ project bindings
      // -----------------------------------------------------------------

      // Projects a workspace has worked on; feeds the dispatch dropdown.
      api.get('/workspace-projects', async (request) => {
        requireAdmin(request);
        const query = listWorkspaceProjectsQuerySchema.parse(request.query);
        return repo.listWorkspaceProjects(query);
      });

      // Explicit bind from the dashboard (idempotent).
      api.post('/workspace-projects', async (request, reply) => {
        requireAdmin(request);
        const input = bindWorkspaceProjectSchema.parse(request.body);
        const project = repo.bindWorkspaceProject(
          input.env,
          input.projectName,
        );
        return reply.code(201).send({ project });
      });

      api.delete('/workspace-projects/:id', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const project = repo.unbindWorkspaceProject(parseTicketId(id));
        if (!project) {
          throw new NotFoundError(
            `workspace project ${formatTicketId(id)} not found`,
          );
        }
        return { project };
      });

      // -----------------------------------------------------------------
      // Fleet directory association (one-click workspace add)
      // -----------------------------------------------------------------

      // Bridge reports the directories it can host; replaces its previous list.
      api.post('/fleet/candidates', async (request) => {
        const input = reportFleetCandidatesSchema.parse(request.body ?? {});
        const host = fleetHostFor(request, input.host);
        if (!host) {
          throw new BadRequestError(
            'host is required (send a heartbeat or register the agent first)',
            'HOST_REQUIRED',
          );
        }

        const byPath = new Map<string, (typeof input.candidates)[number]>();
        for (const candidate of input.candidates) {
          byPath.set(candidate.path, candidate);
        }
        const candidates = repo.replaceFleetCandidates(host, [
          ...byPath.values(),
        ]);
        return { candidates, total: candidates.length };
      });

      api.get('/fleet/candidates', async (request) => {
        requireAdmin(request);
        const query = listFleetQuerySchema.parse(request.query);
        return repo.listFleetCandidates(query.host);
      });

      // Ask the bridge to list one directory for the dashboard picker.
      api.post('/fleet/browse', async (request, reply) => {
        requireAdmin(request);
        const input = createFleetBrowseSchema.parse(request.body ?? {});
        pruneFleetBrowse();

        const now = Date.now();
        const record: FleetBrowseState = {
          id: fleetBrowseSequence,
          host: input.host,
          path: input.path ?? '',
          status: 'PENDING',
          entries: [],
          createdAt: now,
          updatedAt: now,
        };
        fleetBrowseSequence += 1;
        fleetBrowseRequests.set(record.id, record);

        return reply.code(201).send({ request: toBrowseResponse(record) });
      });

      api.get('/fleet/browse/:id', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const record = fleetBrowseRequests.get(parseTicketId(id));
        if (!record) {
          throw new NotFoundError(`fleet browse request ${id} not found`);
        }
        return { request: toBrowseResponse(record) };
      });

      api.post('/fleet/browse/:id/result', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const record = fleetBrowseRequests.get(parseTicketId(id));
        if (!record) {
          throw new NotFoundError(`fleet browse request ${id} not found`);
        }

        const principal = request.principal;
        if (principal?.role === 'agent') {
          const host = fleetHostFor(request);
          if (!host || host !== record.host) {
            throw new ForbiddenError(
              'agent token cannot answer another host',
              'HOST_FORBIDDEN',
            );
          }
        }

        const input = fleetBrowseResultInputSchema.parse(request.body ?? {});
        record.status = input.error ? 'ERROR' : 'DONE';
        record.current = input.current;
        record.entries = input.entries;
        record.error = input.error;
        record.updatedAt = Date.now();
        return { request: toBrowseResponse(record) };
      });

      // Bridge polls the directories the human associated with this machine.
      // Tokens stay in the row until the bridge reports APPLIED, so a retry
      // after a local write failure does not lose the scoped credential.
      api.get('/fleet/desired', async (request) => {
        const query = listFleetQuerySchema.parse(request.query);
        const host = fleetHostFor(request, query.host);
        if (!host) {
          throw new BadRequestError('host is required', 'HOST_REQUIRED');
        }

        const { workspaces } = repo.listFleetWorkspaces(host);
        const desired = workspaces.map((workspace) => {
          if (workspace.status !== 'PENDING' && workspace.status !== 'ISSUED') {
            return workspace;
          }

          const workspaceId = parseTicketId(workspace.id);
          let token = repo.getFleetWorkspaceToken(workspaceId);
          if (!token) {
            token = mintFleetToken(workspace);
          }
          const status =
            workspace.status === 'PENDING' ? 'ISSUED' : workspace.status;
          if (workspace.status === 'PENDING') {
            repo.updateFleetWorkspace(workspaceId, { status: 'ISSUED' });
          }
          return { ...workspace, status, token };
        });

        const browse = [...fleetBrowseRequests.values()]
          .filter(
            (request) => request.host === host && request.status === 'PENDING',
          )
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(0, 10)
          .map((request) => ({
            id: String(request.id),
            host: request.host,
            path: request.path,
            requestedAt: request.createdAt,
          }));

        return { workspaces: desired, browse };
      });

      api.get('/fleet/workspaces', async (request) => {
        requireAdmin(request);
        const query = listFleetQuerySchema.parse(request.query);
        return repo.listFleetWorkspaces(query.host);
      });

      api.post('/fleet/workspaces', async (request, reply) => {
        requireAdmin(request);
        const input = createFleetWorkspaceSchema.parse(request.body);

        let host: string;
        let path: string;
        let projectName: string;
        let adapter: string | undefined;
        let suggestedEnv: string | undefined;

        if ('candidateId' in input) {
          const candidate = repo.getFleetCandidate(
            parseTicketId(input.candidateId),
          );
          if (!candidate) {
            throw new NotFoundError(
              `fleet candidate ${formatTicketId(input.candidateId)} not found`,
            );
          }
          host = candidate.host;
          path = candidate.path;
          projectName = candidate.projectName;
          adapter = candidate.adapter;
          suggestedEnv = candidate.env;
        } else {
          host = input.host;
          path = input.path;
          projectName = (input.projectName ?? basenameAny(path)).slice(0, 128);
          adapter = input.adapter;
        }

        const existing = repo.getFleetWorkspaceByHostPath(host, path);
        if (existing) return reply.code(200).send({ workspace: existing });

        const workspace = repo.createFleetWorkspace({
          host,
          env: uniqueFleetEnv(
            suggestedEnv ?? fleetEnvFor(adapter, projectName),
            host,
          ),
          path,
          projectName,
          ...(adapter ? { adapter } : {}),
        });
        return reply.code(201).send({ workspace });
      });

      // Bridge confirms the directory is now hosted (or why it failed).
      api.post('/fleet/desired/:id/status', async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const workspace = repo.getFleetWorkspace(parseTicketId(id));
        if (!workspace) {
          throw new NotFoundError(`fleet workspace ${formatTicketId(id)} not found`);
        }

        const principal = request.principal;
        if (principal?.role === 'agent') {
          const host = fleetHostFor(request);
          if (!host || host !== workspace.host) {
            throw new ForbiddenError(
              'agent token cannot update another host',
              'HOST_FORBIDDEN',
            );
          }
        }

        const input = fleetWorkspaceStatusInputSchema.parse(request.body ?? {});
        const updated = repo.updateFleetWorkspace(parseTicketId(workspace.id), {
          status: input.status,
          error: input.status === 'APPLIED' ? null : (input.error ?? '未知错误'),
          // The bridge has already written a working token (or failed before
          // receiving one); never keep the plaintext copy in the hub.
          token: null,
        });
        return { workspace: updated };
      });

      api.post('/fleet/workspaces/:id/retry', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const workspace = repo.updateFleetWorkspace(parseTicketId(id), {
          status: 'PENDING',
          error: null,
          token: null,
        });
        if (!workspace) {
          throw new NotFoundError(`fleet workspace ${formatTicketId(id)} not found`);
        }
        return { workspace };
      });

      api.delete('/fleet/workspaces/:id', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const workspace = repo.deleteFleetWorkspace(parseTicketId(id));
        if (!workspace) {
          throw new NotFoundError(`fleet workspace ${formatTicketId(id)} not found`);
        }
        // The env was provisioned for this association; free it so the same
        // directory can be re-associated without a `-2` suffix.
        repo.deleteAgent(workspace.env);
        realtime?.disconnectEnv(workspace.env);
        refreshSyncFingerprint();
        return { workspace };
      });

      // GLOBAL_RULES.md online editing.
      api.get('/rules', async (request) => {
        requireAdmin(request);
        return rulesStore.read();
      });

      api.put('/rules', async (request) => {
        requireAdmin(request);
        const { content } = updateRulesSchema.parse(request.body);
        return rulesStore.write(content);
      });

      // Candidate rules distilled from past human approvals.
      api.get('/rules/candidates', async (request) => {
        requireAdmin(request);
        const query = listRuleCandidatesQuerySchema.parse(request.query);
        return repo.listRuleCandidates(query);
      });

      api.post('/rules/candidates/:id/accept', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const candidateId = parseTicketId(id);
        const candidate = repo.getRuleCandidate(candidateId);
        if (!candidate) {
          throw new NotFoundError(
            `rule candidate ${formatTicketId(id)} not found`,
          );
        }
        if (candidate.status !== 'PENDING') {
          throw new ConflictError(
            `rule candidate ${formatTicketId(id)} is already ${candidate.status}`,
            'ALREADY_FINALIZED',
          );
        }

        const rules = rulesStore.append(candidate.content);
        const updated = repo.markRuleCandidate(candidateId, 'ACCEPTED');

        if (!updated) {
          throw new ConflictError(
            `rule candidate ${formatTicketId(id)} changed while accepting`,
            'RACE_LOST',
          );
        }

        return { candidate: updated, rules };
      });

      api.post('/rules/candidates/:id/dismiss', async (request) => {
        requireAdmin(request);
        const { id } = paramsSchema.parse(request.params);
        const candidateId = parseTicketId(id);
        const candidate = repo.getRuleCandidate(candidateId);
        if (!candidate) {
          throw new NotFoundError(
            `rule candidate ${formatTicketId(id)} not found`,
          );
        }

        const updated = repo.markRuleCandidate(candidateId, 'DISMISSED');
        if (!updated) {
          throw new ConflictError(
            `rule candidate ${formatTicketId(id)} is already ${candidate.status}`,
            'ALREADY_FINALIZED',
          );
        }

        return { candidate: updated };
      });

      // -----------------------------------------------------------------
      // Allowances the L1 layer spends on behalf of a human.
      //
      // Distinct from /rules above: those are prose the meta-agent reads,
      // these are patterns the deterministic layer matches against a live
      // permission request. Because one match now means a run resumes
      // unattended, the table has to be readable and switchable at will.
      // -----------------------------------------------------------------
      api.get('/learned-rules', async (request) => {
        requireAdmin(request);
        const query = listLearnedRulesQuerySchema.parse(request.query ?? {});
        return { rules: repo.listLearnedRules(query) };
      });

      api.post('/learned-rules', async (request, reply) => {
        requireAdmin(request);
        const input = createLearnedRuleSchema.parse(request.body);
        const rule = repo.addLearnedRule(input);
        app.log.info(
          { rule: rule.id, pattern: rule.pattern, action: rule.action },
          'learned rule granted',
        );
        return reply.code(201).send(rule);
      });

      api.patch('/learned-rules/:id', async (request) => {
        requireAdmin(request);
        const { id } = learnedRuleParamsSchema.parse(request.params);
        const input = updateLearnedRuleSchema.parse(request.body);
        const updated = repo.setEnabledLearnedRule(id, input.enabled);
        if (!updated) throw new NotFoundError(`learned rule ${id} not found`);
        app.log.info(
          { rule: id, enabled: updated.enabled },
          'learned rule switched',
        );
        return updated;
      });
    },
    { prefix: '/api' },
  );

  // -----------------------------------------------------------------
  // Realtime gateway (device reverse connections + dashboard presence)
  // -----------------------------------------------------------------
  realtime = attachRealtimeGateway({
    app,
    config,
    repo,
    getSyncState: syncSnapshot,
    getRevision: () => syncBus.revision,
  });
  if (realtime) {
    syncBroadcast = (rev) => realtime?.broadcast({ type: 'sync.changed', rev });
    ensureSyncTicker();
    terminals = createTerminalManager({
      config,
      repo,
      gateway: realtime,
      log: app.log,
    });
    deviceRouter = attachDeviceRouter({
      config,
      repo,
      gateway: realtime,
      ticketBus: bus,
      taskBus,
      sessionBus,
      onChanged: refreshSyncFingerprint,
    });
  }

  // -----------------------------------------------------------------
  // Operator plugins (optional): loaded after routes are registered.
  // -----------------------------------------------------------------
  plugins =
    options.plugins ??
    (await loadPlugins(config.plugins, {
      config,
      logger: app.log,
      version: SERVER_VERSION,
    }));

  for (const notifier of notifiers) {
    app.log.info({ channel: notifier.name }, 'notification channel enabled');
  }
  for (const plugin of plugins) {
    app.log.info({ plugin: plugin.name }, 'plugin loaded');
  }

  await readyPlugins(plugins, app, app.log);

  // Single background loop for SLA auto-resolution and stale task cleanup.
  // unref() keeps tests and one-shot CLI usage from being held open.
  sweeper = setInterval(() => {
    void sweepDueTickets().catch((error: unknown) => {
      app.log.error({ err: (error as Error).message }, 'timeout sweep failed');
    });
    void sweepStaleTasks().catch((error: unknown) => {
      app.log.error(
        { err: (error as Error).message },
        'stale task sweep failed',
      );
    });
    void sweepStaleChatMessages().catch((error: unknown) => {
      app.log.error(
        { err: (error as Error).message },
        'stale chat sweep failed',
      );
    });
  }, config.sweepIntervalMs);
  sweeper.unref?.();

  return app;
}
