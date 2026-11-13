import {
  SUPERVISOR_PERMISSION_TIMEOUT_MS,
  type DecisionTicket,
  type LearnedRule,
  type PermissionAction,
  type SupervisorDecision,
  type TaskEvent,
} from '@zhunzou/shared';

/**
 * L1: the deterministic layer of the hub's judgment.
 *
 * It never calls a model and never waits for a person. It answers the two
 * ends of the permission spectrum from facts the hub already holds — the
 * structured action a run parked on, and the allowances a human granted
 * before — and stays silent about everything in between. Silence is the
 * safety property: the gray zone falls through to the judge that exists
 * today, so widening this table can never invent a new kind of refusal.
 */

export interface GuardContext {
  /** Enabled `learned_rules`, read once per review. */
  rules: LearnedRule[];
  /** `agent_tasks.workspace_path`: the hub's own record beats the node's claim. */
  taskWorkspaceRoot?: string;
  /** Called for a rule the database kept but the engine cannot use. */
  warn?: (message: string) => void;
}

/** How long a parked permission request stays worth answering. */
const PERMISSION_STALE_MS = SUPERVISOR_PERMISSION_TIMEOUT_MS;

/** A ticket may be answered as late as it likes; a second is enough slack. */
const TICKET_LINK_SLACK_MS = 1_000;

/** The option keys the three permission tickets use for "go ahead". */
const GO_OPTION_KEYS = ['approve', 'y', 'a'] as const;

const MAX_REASON_CHARS = 400;

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function decide(
  verdict: 'APPROVE' | 'DENY',
  rule: string,
  subject: string,
  ruleId?: string,
): SupervisorDecision {
  const detail = subject ? `：${clip(subject, 80)}` : '';
  return {
    decision: verdict,
    layer: 'L1',
    reason: `${rule}${detail}`.slice(0, MAX_REASON_CHARS),
    ...(ruleId ? { ruleId } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* What may never be allowed                                           */
/* ------------------------------------------------------------------ */

interface Signature {
  rule: string;
  test: RegExp;
}

/**
 * Irreversible or out-of-band shapes. Matched against the whole command so a
 * payload buried in a substitution still lands, and re-checked per segment so
 * `ls; rm -rf /` cannot borrow the first half's good name.
 */
const DESTRUCTIVE: readonly Signature[] = [
  { rule: '提权执行', test: /(?:^|[\s;&|(`])(?:sudo|doas)\s+\S/ },
  { rule: '裸设备写入', test: /(?:^|[\s;&|(`])dd\s+[^\n]*\bof=|\b(?:mkfs|fdisk)\b[^\n]*\/dev\// },
  { rule: '权限全开', test: /(?:^|[\s;&|(`])chmod\b[^\n]*\b777\b[^\n]*(?:\s\/(?:\s|$)|$)/ },
  { rule: 'fork bomb', test: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/ },
  { rule: '强推分支', test: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|(?:^|\s)-\w*f\w*(?:\s|$))/i },
  { rule: '硬重置', test: /\bgit\s+reset\b[^\n]*--hard/i },
  {
    rule: '丢弃工作区',
    test: /\bgit\s+clean\b[^\n]*-\w*f|\bgit\s+(?:checkout|restore)\b[^\n]*(?:--hard|\s\.(?:\s|$))/i,
  },
  { rule: '删除分支', test: /\bgit\s+branch\b[^\n]*(?:\s-D\b|\s--delete\b)/ },
  { rule: '重写历史', test: /\bgit\s+filter-branch\b|\bgit\s+gc\b[^\n]*--prune=now/ },
  { rule: '发布产物', test: /(?:^|[\s;&|(`])(?:npm|pnpm|yarn|bun|cargo|twine)\s+publish\b/ },
  { rule: '下载后直接执行', test: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|node|perl|ruby|python3?)\b/ },
  { rule: '容器整体清理', test: /\bdocker\b[^\n]*\bprune\b|\bdocker\b[^\n]*\brm\b[^\n]*-\w*f/ },
  { rule: '删除数据库对象', test: /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i },
  { rule: '回滚迁移', test: /\b(?:artisan|knex|prisma|django-admin)\b[^\n]*\bmigration(?:s)?(?::| )down\b/i },
  { rule: '删除线上资源', test: /(?:^|[\s;&|(`])(?:kubectl|helm)\s+(?:delete|uninstall)\b/ },
];

/**
 * Credential and host files. A token boundary rather than a path separator,
 * because these appear inside commands (`cat .env.production`) as much as
 * inside path lists.
 */
const SENSITIVE: readonly Signature[] = [
  { rule: '环境变量文件', test: /(?:^|[^A-Za-z0-9._-])\.env(?:\.[A-Za-z0-9._-]+)?(?![A-Za-z0-9._-])/i },
  { rule: 'SSH 目录', test: /(?:^|[^A-Za-z0-9._-])\.ssh(?=$|[/\\])/ },
  { rule: '云厂商凭据', test: /(?:^|[^A-Za-z0-9._-])\.(?:aws|gnupg|kube)(?=$|[/\\])/ },
  { rule: 'Git 凭据', test: /(?:^|[^A-Za-z0-9._-])\.git-credentials(?![A-Za-z0-9._-])/i },
  { rule: '包管理令牌', test: /(?:^|[^A-Za-z0-9._-])\.(?:npmrc|netrc|pypirc)(?![A-Za-z0-9._-])/i },
  { rule: '私钥文件', test: /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/i },
  { rule: '系统配置目录', test: /(?:^|[\s"'`(=])\/etc(?=$|[/\\])/ },
  { rule: '客户端配置', test: /(?:^|[^A-Za-z0-9._-])\.cursor[/\\]mcp\.json$/i },
];

/** Templates exist to be committed; refusing them would train nobody. */
const ENV_TEMPLATE = /(?:^|[^A-Za-z0-9._-])\.env\.(?:example|sample|template|dist)(?![A-Za-z0-9._-])/gi;

/** Files a task owns the right to rewrite inside its own checkout. */
const SOURCE_FILE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|css|scss|sass|less|html|vue|svelte|py|go|rs|java|kt|kts|c|h|cpp|hpp|cc|rb|php|sh|bash|zsh|yaml|yml|toml|ini|xml|sql|graphql|prisma|exs|swift|tf|lock|txt|example|sample|template)$/i;

/* ------------------------------------------------------------------ */
/* Shell shape                                                         */
/* ------------------------------------------------------------------ */

const SEGMENT_BREAK = /&&|\|\||[;\n|]/;
const SUBSTITUTION = /`|\$\(|\$\{/;
const QUOTED = /'[^']*'|"[^"]*"/g;

/** `>` writes files and `<` feeds them; neither is a read. */
function hasRedirect(segment: string): boolean {
  return /[<>]/.test(segment.replace(QUOTED, ''));
}

/** Split into executable segments; quoting keeps arguments together. */
function segments(command: string): string[] {
  return command
    .split(SEGMENT_BREAK)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function tokenize(segment: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let touched = false;

  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      touched = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (current || touched) tokens.push(current);
      current = '';
      touched = false;
      continue;
    }
    current += char;
  }
  if (quote) return null;
  if (current || touched) tokens.push(current);
  return tokens;
}

/** `FOO=1 ls` and `env ls` still run `ls`. */
function binOf(tokens: readonly string[]): string | undefined {
  for (const token of tokens) {
    if (/^[\w.]+=/.test(token)) continue;
    if (token === 'env' || token === 'command') continue;
    return token.split(/[/\\]/).pop();
  }
  return undefined;
}

const RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const RUNNER_PASSTHROUGH = new Set(['exec', 'dlx', 'x']);
const READONLY_TOOLS = new Set([
  'ls', 'll', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'which', 'whereis', 'type',
  'pwd', 'echo', 'printf', 'date', 'uptime', 'uname', 'hostname', 'id', 'whoami',
  'ps', 'df', 'du', 'tree', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd',
  'locate', 'sort', 'uniq', 'cut', 'diff', 'cmp', 'od', 'hexdump', 'strings',
  'basename', 'dirname', 'realpath', 'readlink', 'seq', 'tac', 'nl',
  'jq', 'yq', 'column', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'tr',
]);
/** Flags that turn a lookup into a mutation or an exec. */
const FIND_WRITING = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fls']);
const VERSION_FLAGS = new Set(['-v', '--version', '-h', '--help']);
const TEST_SCRIPTS = /^(?:test|typecheck|lint|check|checks|verify|cov|coverage|e2e:smoke)$/i;
const STATIC_ANALYSERS = new Set([
  'vitest', 'jest', 'pytest', 'mocha', 'rspec', 'phpunit', 'mypy', 'eslint',
  'golangci-lint', 'rubocop', 'flake8', 'pylint', 'biome', 'deno',
]);

/** Read-only git: the plumbing and porcelain that cannot lose anybody's work. */
function isReadOnlyGit(tokens: readonly string[]): boolean {
  const args = tokens.slice(1).filter((token) => token !== '');
  // A global option (`-C`, `--git-dir`, `--work-tree`) moves the repo elsewhere,
  // so the containment the guard reasons about is no longer the one in hand.
  if (args[0]?.startsWith('-')) return false;

  const [sub, ...rest] = args;
  switch (sub) {
    case 'status':
    case 'log':
    case 'diff':
    case 'show':
    case 'blame':
    case 'rev-parse':
    case 'rev-list':
    case 'describe':
    case 'ls-files':
    case 'ls-tree':
    case 'cat-file':
    case 'show-ref':
    case 'shortlog':
    case 'merge-base':
    case 'annotate':
      return true;
    case 'branch':
    case 'tag':
      return rest.every((token) => !/^(?:-d|-D|--delete|-m|-c|--move|--copy|--edit-description)$/.test(token));
    case 'config':
      return rest.some((token) => /^(?:--get|--get-regexp|--list|-l)$/.test(token));
    case 'remote':
      return rest.length === 0 || rest.every((token) => /^(-v|--verbose|show)$/.test(token));
    default:
      return false;
  }
}

/** True when every segment is something that only reads or only reports. */
function isReadOnlyCommand(command: string): boolean {
  if (SUBSTITUTION.test(command)) return false;
  const parts = segments(command);
  if (parts.length === 0) return false;

  return parts.every((segment) => {
    if (hasRedirect(segment)) return false;
    const tokens = tokenize(segment);
    if (!tokens || tokens.length === 0) return false;

    const bin = binOf(tokens);
    if (!bin) return false;
    const args = tokens.slice(tokens.indexOf(bin) + 1);

    if (bin === 'git') return isReadOnlyGit([bin, ...args]);
    if (bin === 'npx' || bin === 'bunx') {
      // `npx --no-install tsc --noEmit` still only runs tsc.
      let start = 0;
      while (start < args.length && args[start]?.startsWith('-')) start += 1;
      return start < args.length && isReadOnlyCommand(args.slice(start).join(' '));
    }
    if (RUNNERS.has(bin) && args[0] && RUNNER_PASSTHROUGH.has(args[0])) {
      return isReadOnlyCommand(args.slice(1).join(' '));
    }
    if (bin === 'node' || bin === 'python' || bin === 'python3' || bin === 'ruby') {
      return args.length > 0 && args.every((arg) => VERSION_FLAGS.has(arg));
    }
    if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn' || bin === 'bun') {
      if (args[0] === 'test' || args[0] === 'typecheck' || args[0] === 'lint') return true;
      return args[0] === 'run' && Boolean(args[1] && TEST_SCRIPTS.test(args[1]));
    }
    if (bin === 'make') return args.every((arg) => TEST_SCRIPTS.test(arg)) && args.length > 0;
    if (bin === 'tsc' || bin === 'vue-tsc') return args.includes('--noEmit');
    if (bin === 'prettier') return args.some((arg) => /^(?:--check|--list-different)$/.test(arg));
    if (bin === 'eslint') return !args.some((arg) => /^--fix$/.test(arg));
    if (bin === 'ruff') return args[0] === 'check' || (args[0] === 'format' && args.includes('--check'));
    if (bin === 'go') return args[0] === 'test';
    if (bin === 'cargo') return args[0] === 'test';
    if (bin === 'find') return !args.some((arg) => FIND_WRITING.has(arg));
    return READONLY_TOOLS.has(bin) || STATIC_ANALYSERS.has(bin);
  });
}

/** `rm -r` plus `rm -f` in any spelling, and `--no-preserve-root`. */
function isForcedRemoval(segment: string): boolean {
  const tokens = tokenize(segment);
  if (!tokens || binOf(tokens) !== 'rm') return false;

  let recursive = false;
  let forced = false;
  for (const token of tokens) {
    if (token === '--recursive' || token === '-r' || token === '-R') recursive = true;
    if (token === '--force' || token === '-f') forced = true;
    if (token === '--no-preserve-root') return true;
    if (/^--[a-z]/.test(token)) continue;
    if (/^-[a-z]+$/.test(token)) {
      recursive ||= /[rR]/.test(token);
      forced ||= /[fF]/.test(token);
    }
  }
  return recursive && forced;
}

/* ------------------------------------------------------------------ */
/* Workspace containment                                               */
/* ------------------------------------------------------------------ */

function normalizeRoot(path: string): string {
  return path.replace(/[/\\]+$/, '');
}

function isAbsolute(path: string): boolean {
  return /^[/\\]/.test(path) || /^[A-Za-z]:[/\\]/.test(path);
}

function isUnder(path: string, root: string): boolean {
  const base = normalizeRoot(root);
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

interface Roots {
  /** The root the guard is allowed to reason with. */
  root?: string;
  /** The node named a checkout the task never ran in. */
  conflicting: boolean;
}

function rootsFor(action: PermissionAction, ctx: GuardContext): Roots {
  const hub = ctx.taskWorkspaceRoot;
  const claimed = action.workspaceRoot;
  if (hub && claimed) {
    return { root: hub, conflicting: !isUnder(claimed, hub) };
  }
  return { root: hub ?? claimed, conflicting: false };
}

/* ------------------------------------------------------------------ */
/* Learned rules                                                       */
/* ------------------------------------------------------------------ */

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function matcherFor(rule: LearnedRule, warn?: (message: string) => void) {
  const wanted = rule.pattern.replace(/\s+/g, ' ').trim();
  if (rule.patternType === 'exact') {
    return (subject: string) => subject.replace(/\s+/g, ' ').trim() === wanted;
  }
  if (rule.patternType === 'glob') {
    const compiled = globToRegExp(wanted);
    return (subject: string) => compiled.test(subject);
  }
  try {
    const compiled = new RegExp(rule.pattern);
    return (subject: string) => compiled.test(subject);
  } catch (error) {
    // A rule that stopped compiling must not take the whole layer with it.
    warn?.(`规则 ${rule.id} 的正则无法编译，已跳过：${(error as Error).message}`);
    return undefined;
  }
}

function subjectsFor(action: PermissionAction): string[] {
  return [...(action.command ? [action.command] : []), ...(action.paths ?? [])];
}

function ruleMatches(rule: LearnedRule, action: PermissionAction, warn?: (m: string) => void): boolean {
  if (rule.kind && rule.kind !== action.kind) return false;
  const matches = matcherFor(rule, warn);
  if (!matches) return false;
  return subjectsFor(action).some((subject) => matches(subject));
}

/* ------------------------------------------------------------------ */
/* The verdict                                                         */
/* ------------------------------------------------------------------ */

/** A human-readable subject for the reason line. */
function subjectOf(action: PermissionAction): string {
  return action.command ?? (action.paths ?? []).join(' ');
}

function sensitiveHit(action: PermissionAction): string | undefined {
  const texts = [
    ...(action.command ? [action.command] : []),
    ...(action.paths ?? []),
  ].map((text) => text.replace(ENV_TEMPLATE, ' '));
  for (const signature of SENSITIVE) {
    if (texts.some((text) => signature.test.test(text))) return signature.rule;
  }
  return undefined;
}

/**
 * The deterministic layer's answer, or undefined when it has none.
 *
 * Order is the whole design: irreversibility outranks any allowance, a
 * refusal a human recorded outranks an allowance they recorded earlier, and
 * anything the layer cannot name is left for the model to judge.
 */
export function evaluateL1(
  action: PermissionAction,
  ctx: GuardContext,
): SupervisorDecision | undefined {
  const subject = subjectOf(action);
  const warn = ctx.warn;

  const sensitive = sensitiveHit(action);
  if (sensitive) return decide('DENY', `${sensitive}属凭据，必须人工确认`, subject);

  const text = action.command ?? '';
  if (text) {
    for (const signature of DESTRUCTIVE) {
      if (signature.test.test(text)) {
        return decide('DENY', signature.rule, subject);
      }
    }
    if (segments(text).some(isForcedRemoval)) {
      return decide('DENY', '递归强制删除', subject);
    }
  }

  const { root, conflicting } = rootsFor(action, ctx);
  if (conflicting) {
    return decide('DENY', '节点自报的工作区与任务工作区不一致', subject);
  }
  const paths = action.paths ?? [];
  // `outsideWorkspace` counts a relative path as escaping, which is right for
  // a flag and wrong for a verdict: only an absolute path can be *proved* to
  // have left the checkout. The rest stays a question for the model rather
  // than becoming a refusal of the most ordinary edit there is.
  if (root && paths.some((path) => isAbsolute(path) && !isUnder(path, root))) {
    return decide('DENY', '目标越出任务工作区', subject);
  }

  for (const rule of ctx.rules) {
    if (rule.action === 'DENY' && rule.enabled && ruleMatches(rule, action, warn)) {
      return decide('DENY', `命中人工禁令 ${rule.pattern}`, subject, rule.id);
    }
  }
  for (const rule of ctx.rules) {
    if (rule.action === 'ALLOW' && rule.enabled && ruleMatches(rule, action, warn)) {
      return decide('APPROVE', `命中人工授权 ${rule.pattern}`, subject, rule.id);
    }
  }

  if (action.kind === 'command' && text && isReadOnlyCommand(text)) {
    return decide('APPROVE', '只读命令', subject);
  }
  if (
    action.kind === 'file_change' &&
    root &&
    paths.length > 0 &&
    paths.every((path) => isAbsolute(path) && isUnder(path, root) && SOURCE_FILE.test(path))
  ) {
    return decide('APPROVE', '工作区内的源码文件变更', subject);
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Wiring helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * The permission request this ticket was raised for.
 *
 * Both halves matter: the request has to precede the ticket, and it has to be
 * recent, otherwise the layer would be ruling on some earlier step the run
 * already moved past.
 */
export function selectPermissionAction(
  events: readonly TaskEvent[],
  at: { ticketCreatedAt: number; now: number },
): PermissionAction | undefined {
  const latest = [...events]
    .reverse()
    .find((event) => event.kind === 'permission_required' && event.action);
  const action = latest?.action;
  if (!action || !latest) return undefined;
  if (latest.createdAt > at.ticketCreatedAt + TICKET_LINK_SLACK_MS) return undefined;
  if (at.now - latest.createdAt > PERMISSION_STALE_MS) return undefined;
  return action;
}

/**
 * Which option on this ticket means "go ahead".
 *
 * Only the three permission tickets the hub itself raises are recognised. An
 * option set nobody standardised returns undefined rather than a guess, so an
 * auto-approval can never land on the wrong button.
 */
export function approveOptionFor(ticket: DecisionTicket): string | undefined {
  for (const option of ticket.options) {
    const key = option.key.trim().toLowerCase();
    if (!(GO_OPTION_KEYS as readonly string[]).includes(key)) continue;
    if (option.risk === 'destructive') return undefined;
    return option.key;
  }
  return undefined;
}
