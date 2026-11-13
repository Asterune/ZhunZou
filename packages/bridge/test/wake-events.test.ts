import { describe, expect, it } from 'vitest';

import type { EngineEventInput } from '@zhunzou/shared';

import {
  createEventParser,
  createEventPipeline,
  parseEngineLine,
  profileForAdapter,
} from '../src/wake/events.js';
import type { LogStream } from '../src/wake/log-sink.js';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';

const INIT_LINE = `{"type":"system","subtype":"init","session_id":"${SESSION}","model":"claude-sonnet-4-5","cwd":"/repo"}`;
const ASSISTANT_LINE = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"let me check"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"pnpm test"}},{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/repo/x.ts"}}]}}`;
const RESULT_LINE = `{"type":"result","subtype":"success","result":"green","session_id":"${SESSION}"}`;
const CONTROL_LINE =
  '{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf dist"}}}';
const PLAIN_PERMISSION_LINE =
  '{"type":"permission_required","tool_name":"Write","input":{"file_path":"/repo/a.ts"}}';

function parseAll(lines: string[]): EngineEventInput[] {
  const parser = createEventParser('stream-json');
  const events = parser.push(`${lines.join('\n')}\n`);
  return [...events, ...parser.end()];
}

describe('profileForAdapter', () => {
  it('normalises the dialects this repo already drives and leaves the rest alone', () => {
    expect(profileForAdapter('claude')).toBe('stream-json');
    expect(profileForAdapter('qoder')).toBe('stream-json');
    expect(profileForAdapter('cursor-agent')).toBe('stream-json');
    expect(profileForAdapter('opencode-run')).toBe('stream-json');
    expect(profileForAdapter('opencode')).toBe('opencode');
    expect(profileForAdapter('command')).toBe('stream-json');
  });

  it('does not guess at engines whose stream shape is unverified', () => {
    for (const name of ['codex', 'gemini', 'aider', 'goose', 'amp', 'notify', 'auto'] as const) {
      expect(profileForAdapter(name)).toBe('none');
    }
  });
});

describe('parseEngineLine', () => {
  it('turns an init line into a session event', () => {
    expect(parseEngineLine(INIT_LINE, 'stream-json')).toEqual([
      { kind: 'session', sessionId: SESSION },
    ]);
  });

  it('names every tool in one assistant message', () => {
    const events = parseEngineLine(ASSISTANT_LINE, 'stream-json');
    expect(events).toEqual([
      { kind: 'tool_call', tool: 'Bash' },
      { kind: 'tool_call', tool: 'Read' },
    ]);
  });

  it('reads the session id off any line that carries one, whatever its type', () => {
    expect(
      parseEngineLine(`{"type":"result","session_id":"${SESSION}"}`, 'stream-json'),
    ).toEqual([{ kind: 'session', sessionId: SESSION }]);
    expect(
      parseEngineLine('{"tool_name":"Bash","session_id":"abc"}', 'stream-json'),
    ).toEqual([{ kind: 'session', sessionId: 'abc' }]);
  });

  it('reads a control request as a permission event with the command attached', () => {
    const events = parseEngineLine(CONTROL_LINE, 'stream-json');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'permission_required',
      tool: 'Bash',
      action: { kind: 'command', command: 'rm -rf dist' },
    });
  });

  it('reads a plain permission line, and falls back to a file action', () => {
    expect(parseEngineLine(PLAIN_PERMISSION_LINE, 'stream-json')).toEqual([
      {
        kind: 'permission_required',
        tool: 'Write',
        action: { kind: 'file_change', paths: ['/repo/a.ts'] },
      },
    ]);
  });

  it('still parks when the engine only names the tool', () => {
    expect(
      parseEngineLine('{"type":"permission_request","tool":"deploy"}', 'stream-json'),
    ).toEqual([{ kind: 'permission_required', tool: 'deploy' }]);
  });

  it('ignores anything it does not recognise', () => {
    for (const line of [
      '',
      '   ',
      'Building for production...',
      '{"type":"user","message":"hi"}',
      '{not json}',
      '{"type":"assistant","message":{"content":"not an array"}}',
      'null',
      '[{"type":"tool_use","name":"Bash"}]',
    ]) {
      expect(parseEngineLine(line, 'stream-json'), line).toEqual([]);
    }
  });

  it('rejects a session id that could smuggle in a CLI option', () => {
    for (const sessionId of ['-x', '--model=gpt', 'has space', '$(id)']) {
      expect(
        parseEngineLine(`{"type":"system","session_id":"${sessionId}"}`, 'stream-json'),
        sessionId,
      ).toEqual([]);
    }
  });

  it('reads OpenCode camelCase ids and its short tool type', () => {
    expect(
      parseEngineLine('{"type":"step_start","sessionID":"ses_1a2b"}', 'opencode'),
    ).toEqual([{ kind: 'session', sessionId: 'ses_1a2b' }]);
    expect(
      parseEngineLine('{"type":"tool","sessionID":"ses_1a2b","name":"bash"}', 'opencode'),
    ).toEqual([
      { kind: 'session', sessionId: 'ses_1a2b' },
      { kind: 'tool_call', tool: 'bash' },
    ]);
  });

  it('parses nothing for an engine without a profile', () => {
    expect(parseEngineLine(INIT_LINE, 'none')).toEqual([]);
  });
});

describe('createEventParser', () => {
  it('reassembles a line split across chunks', () => {
    const parser = createEventParser('stream-json');
    expect(parser.push(`{"type":"sys`)).toEqual([]);
    expect(parser.push('tem","session_id":"' + SESSION + '"}')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ kind: 'session', sessionId: SESSION }]);
  });

  it('emits each session id once, however often the engine repeats it', () => {
    const events = parseAll([INIT_LINE, ASSISTANT_LINE, RESULT_LINE]);
    expect(events.filter((event) => event.kind === 'session')).toEqual([
      { kind: 'session', sessionId: SESSION },
    ]);
    expect(events.filter((event) => event.kind === 'tool_call')).toHaveLength(2);
  });

  it('flushes a final line that never got a newline', () => {
    const parser = createEventParser('stream-json');
    expect(parser.push(ASSISTANT_LINE)).toEqual([]);
    expect(parser.end()).toHaveLength(2);
    expect(parser.end()).toEqual([]);
  });

  it('drops everything up to the newline that ends an over-long line', () => {
    const parser = createEventParser('stream-json');
    expect(parser.push(`${'x'.repeat(70 * 1024)}`)).toEqual([]);
    expect(parser.push(`${INIT_LINE}\n`)).toEqual([]);
    expect(parser.push(`${INIT_LINE}\n`)).toEqual([
      { kind: 'session', sessionId: SESSION },
    ]);
  });

  it('stays bounded while a child spews binary and still finds the next line', () => {
    const parser = createEventParser('stream-json');
    for (let index = 0; index < 40; index += 1) {
      expect(parser.push(`${'y'.repeat(8 * 1024)}`)).toEqual([]);
    }
    expect(parser.push('\n')).toEqual([]);
    expect(parser.push(`${INIT_LINE}\n`)).toEqual([
      { kind: 'session', sessionId: SESSION },
    ]);
  });

  it('produces nothing and holds nothing without a profile', () => {
    const parser = createEventParser('none');
    expect(parser.push(`${INIT_LINE}\n`)).toEqual([]);
    expect(parser.end()).toEqual([]);
  });
});

describe('createEventPipeline', () => {
  function collect(options?: {
    profile?: 'stream-json' | 'none';
    engine?: 'claude-code';
    workspaceRoot?: string;
  }) {
    const raw: Array<{ stream: LogStream; chunk: string }> = [];
    const events: EngineEventInput[] = [];
    const permissions: EngineEventInput[] = [];
    const pipeline = createEventPipeline({
      profile: options?.profile ?? 'stream-json',
      ...(options?.engine ? { engine: options.engine } : {}),
      ...(options?.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      forward: (stream, chunk) => raw.push({ stream, chunk }),
      onEvent: (event) => events.push(event),
      onPermission: (event) => permissions.push(event),
    });
    return { raw, events, permissions, pipeline };
  }

  it('forwards every raw byte unchanged while parsing structure out of it', () => {
    const { raw, events, pipeline } = collect();
    pipeline.push('stdout', `${ASSISTANT_LINE}\nnot json at all\n`);
    expect(raw).toEqual([{ stream: 'stdout', chunk: `${ASSISTANT_LINE}\nnot json at all\n` }]);
    expect(events).toEqual([
      { kind: 'tool_call', tool: 'Bash' },
      { kind: 'tool_call', tool: 'Read' },
    ]);
  });

  it('labels events with the engine that ran', () => {
    const { events, pipeline } = collect({ engine: 'claude-code' });
    pipeline.push('stdout', `${INIT_LINE}\n`);
    expect(events).toEqual([
      { kind: 'session', sessionId: SESSION, engine: 'claude-code' },
    ]);
  });

  it('parses only stdout, because stderr means something else', () => {
    const { events, pipeline } = collect();
    pipeline.push('stderr', `${CONTROL_LINE}\n`);
    expect(events).toEqual([]);
  });

  it('fills the checkout root into a permission action so the hub can re-derive escapes', () => {
    const { events, permissions, pipeline } = collect({ workspaceRoot: '/repo' });
    pipeline.push('stdout', `${CONTROL_LINE}\n`);
    expect(permissions).toEqual(events);
    expect(events[0]?.action?.workspaceRoot).toBe('/repo');
  });

  it('trusts the root the daemon spawned in, never one the engine claims', () => {
    const { events, pipeline } = collect({ workspaceRoot: '/repo' });
    pipeline.push(
      'stdout',
      '{"type":"permission_required","tool_name":"Bash","command":"ls","workspaceRoot":"/elsewhere"}\n',
    );
    expect(events[0]?.action?.workspaceRoot).toBe('/repo');
  });

  it('fires the permission hook exactly once per request', () => {
    const { permissions, pipeline } = collect();
    pipeline.push('stdout', `${CONTROL_LINE}\n${CONTROL_LINE}\n`);
    expect(permissions).toHaveLength(2);
  });

  it('is inert without a profile', () => {
    const { raw, events, pipeline } = collect({ profile: 'none' });
    pipeline.push('stdout', `${INIT_LINE}\n`);
    expect(events).toEqual([]);
    expect(raw).toHaveLength(1);
  });
});
