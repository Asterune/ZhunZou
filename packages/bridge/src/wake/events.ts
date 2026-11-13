import type { AgentKind, EngineEventInput, PermissionActionInput } from '@zhunzou/shared';
import { isArgvSafeSessionId } from '@zhunzou/shared';

import type { WakeAdapterName } from './config.js';
import type { LogStream } from './log-sink.js';

/**
 * Engine output normalisation.
 *
 * A local CLI writes its work as a stream of JSON objects (NDJSON) while it
 * runs. This turns the three facts the hub acts on out of that stream — which
 * tool ran, whether the engine is asking for approval, and the session id
 * needed to resume it — without ever touching the bytes the dashboard reads.
 */

export type EngineProfileName = 'stream-json' | 'opencode' | 'none';

/**
 * One profile per output dialect. `none` is a decision, not a gap: a CLI whose
 * stream shape is not verified here gets no normalisation at all, which is
 * exactly what it had before this module existed.
 */
const PROFILES: Record<WakeAdapterName, EngineProfileName> = {
  auto: 'none',
  opencode: 'opencode',
  'opencode-run': 'stream-json',
  claude: 'stream-json',
  qoder: 'stream-json',
  'cursor-agent': 'stream-json',
  command: 'stream-json',
  codex: 'none',
  gemini: 'none',
  aider: 'none',
  goose: 'none',
  amp: 'none',
  notify: 'none',
};

export function profileForAdapter(name: WakeAdapterName): EngineProfileName {
  return PROFILES[name] ?? 'none';
}

/** A chunk boundary can land mid-line; an endless line must not eat memory. */
const MAX_LINE_BYTES = 64 * 1024;

export interface EventParser {
  push: (chunk: string) => EngineEventInput[];
  end: () => EngineEventInput[];
}

/**
 * Line-buffering NDJSON parser. It emits the session id once, because several
 * dialects repeat it on every line, and ignores anything it does not
 * recognise, because a profile that guesses wrong must cost one event and not
 * the run's output.
 */
export function createEventParser(profile: EngineProfileName): EventParser {
  let pending = '';
  let discarding = false;
  let lastSessionId: string | undefined;

  const collect = (flushTail: boolean): EngineEventInput[] => {
    const events: EngineEventInput[] = [];
    const take = (line: string): void => {
      for (const event of parseEngineLine(line, profile)) {
        if (event.kind === 'session') {
          if (!event.sessionId || event.sessionId === lastSessionId) continue;
          lastSessionId = event.sessionId;
        }
        events.push(event);
      }
    };

    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      // Everything up to and including the newline that ends an over-long
      // line belongs to that line, not to the one after it.
      if (discarding) {
        discarding = false;
        continue;
      }
      take(line);
    }

    if (flushTail && pending) {
      if (!discarding) take(pending);
      pending = '';
    } else if (pending.length > MAX_LINE_BYTES) {
      // Not a text stream (or a formatter that died mid-line): resynchronise.
      pending = '';
      discarding = true;
    }

    return events;
  };

  return {
    push: (chunk) => {
      if (!chunk) return [];
      pending += chunk;
      return collect(false);
    },
    end: () => collect(true),
  };
}

/** One line of engine output → zero or more normalised events. */
export function parseEngineLine(
  line: string,
  profile: EngineProfileName,
): EngineEventInput[] {
  const text = line.trim();
  if (profile === 'none') return [];
  if (!text.startsWith('{') || !text.endsWith('}')) return [];

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(value)) return [];

  const events: EngineEventInput[] = [];
  const sessionId = readSessionId(value, profile);
  if (sessionId) events.push({ kind: 'session', sessionId });

  const type = readString(value, 'type');
  if (type === 'control_request') {
    const request = isRecord(value.request) ? value.request : undefined;
    if (request && readString(request, 'subtype') === 'can_use_tool') {
      const permission = permissionEvent(request, readInput(request));
      if (permission) events.push(permission);
    }
    return events;
  }

  if (type === 'permission_required' || type === 'permission_request') {
    const permission = permissionEvent(value, readInput(value));
    if (permission) events.push(permission);
    return events;
  }

  for (const tool of toolNames(value, type, profile)) {
    events.push({ kind: 'tool_call', tool });
  }
  return events;
}

function toolNames(
  value: Record<string, unknown>,
  type: string | undefined,
  profile: EngineProfileName,
): string[] {
  if (type === 'assistant') {
    const message = isRecord(value.message) ? value.message : undefined;
    if (!Array.isArray(message?.content)) return [];
    return message!.content
      .filter(
        (item): item is Record<string, unknown> =>
          isRecord(item) && readString(item, 'type') === 'tool_use',
      )
      .map((item) => readString(item, 'name') ?? '')
      .filter(Boolean);
  }

  if (
    type === 'tool_use' ||
    type === 'tool_call' ||
    (profile === 'opencode' && type === 'tool')
  ) {
    const tool = readString(value, 'name') ?? readString(value, 'tool') ?? '';
    return tool ? [tool] : [];
  }

  return [];
}

/**
 * A request for approval. `tool_name`/`command`/`input` are where the
 * stream-json dialects put them; an engine that only names the tool still
 * parks, the human simply reads less.
 */
function permissionEvent(
  holder: Record<string, unknown>,
  input: Record<string, unknown>,
): EngineEventInput | undefined {
  const tool =
    readString(holder, 'tool_name') ??
    readString(holder, 'tool') ??
    readString(holder, 'name');
  const command = readString(holder, 'command') ?? readString(input, 'command');
  const path =
    readString(holder, 'path') ??
    readString(input, 'path') ??
    readString(input, 'file_path');
  const paths = Array.isArray(holder.paths)
    ? holder.paths.filter((entry): entry is string => typeof entry === 'string')
    : path
      ? [path]
      : undefined;

  const action = buildAction(command, paths);
  if (!tool && !action) return undefined;

  return {
    kind: 'permission_required',
    ...(tool ? { tool } : {}),
    ...(action ? { action } : {}),
  };
}

/** An action the engine cannot describe at all is not reportable as one. */
function buildAction(
  command: string | undefined,
  paths: string[] | undefined,
): PermissionActionInput | undefined {
  if (!command && !paths?.length) return undefined;
  // Containment is not this process's call: the hub re-derives it from `paths`
  // against the workspace root the pipeline attaches below.
  return {
    kind: command ? 'command' : 'file_change',
    ...(command ? { command } : {}),
    ...(paths?.length ? { paths } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export interface EventPipelineOptions {
  profile: EngineProfileName;
  /** Which client the child process is; the parser cannot know it. */
  engine?: AgentKind;
  /** The checkout the child runs in, so the hub re-derives workspace escapes. */
  workspaceRoot?: string;
  /** Every raw chunk, unchanged, before anything is parsed out of it. */
  forward: (stream: LogStream, chunk: string) => void;
  onEvent: (event: EngineEventInput) => void;
  /** Fires the moment the engine asks for approval; the adapter stops the run. */
  onPermission?: (event: EngineEventInput) => void;
}

export interface EventPipeline {
  push: (stream: LogStream, chunk: string) => void;
  end: () => void;
}

/**
 * Splits the child's output two ways: bytes carry on to the log sink exactly
 * as they arrived, structure branches off to the event sink. Only stdout is
 * parsed, because stderr keeps its own meaning.
 */
export function createEventPipeline(
  options: EventPipelineOptions,
): EventPipeline {
  const parser = createEventParser(options.profile);

  const emit = (events: EngineEventInput[]): void => {
    for (const event of events) {
      const enriched = enrich(event, options);
      // Drop a malformed event here rather than 400ing the whole batch.
      if (enriched.kind === 'session' && !isArgvSafeSessionId(enriched.sessionId)) {
        continue;
      }
      options.onEvent(enriched);
      if (enriched.kind === 'permission_required') options.onPermission?.(enriched);
    }
  };

  return {
    push(stream, chunk) {
      options.forward(stream, chunk);
      if (stream !== 'stdout') return;
      emit(parser.push(chunk));
    },
    end() {
      emit(parser.end());
    },
  };
}

function enrich(
  event: EngineEventInput,
  options: EventPipelineOptions,
): EngineEventInput {
  const next: EngineEventInput = {
    ...event,
    ...(options.engine ? { engine: options.engine } : {}),
  };
  // The checkout we spawned in is the only root worth reporting: whatever the
  // engine claims about its own containment is re-derived from these paths.
  if (!options.workspaceRoot || !event.action) return next;
  return { ...next, action: { ...event.action, workspaceRoot: options.workspaceRoot } };
}

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  holder: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = holder?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Every dialect spells it differently; all three spellings are recognised. */
function readSessionId(
  value: Record<string, unknown>,
  profile: EngineProfileName,
): string | undefined {
  const keys =
    profile === 'opencode'
      ? (['sessionID', 'sessionId', 'session_id'] as const)
      : (['session_id', 'sessionId', 'sessionID'] as const);
  for (const key of keys) {
    const candidate = readString(value, key);
    if (candidate && isArgvSafeSessionId(candidate)) return candidate;
  }
  return undefined;
}

function readInput(holder: Record<string, unknown>): Record<string, unknown> {
  return isRecord(holder.input) ? holder.input : {};
}
