import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
} from 'node:os';
import { delimiter, join } from 'node:path';

import type {
  DeviceCapabilities,
  DevicePty,
  DeviceStats,
  DeviceTool,
} from '@zhunzou/shared';
import { DEVICE_PROTOCOL_VERSION } from '@zhunzou/shared';

import { machineId } from './machine-id.js';

const require = createRequire(import.meta.url);

/** Tools worth advertising to the dashboard / terminal launcher. */
const TOOL_CANDIDATES = [
  'claude',
  'cursor-agent',
  'agent',
  'opencode',
  'codex',
  'gemini',
  'qoder',
  'qodercli',
  'qcode',
  'aider',
  'goose',
  'amp',
  'git',
  'node',
  'pnpm',
  'npm',
  'python3',
  'docker',
  'tmux',
  'zsh',
  'bash',
] as const;

/** Locate an executable on PATH without spawning a shell. */
export function whichSync(binary: string): string | undefined {
  const pathValue = process.env.PATH ?? '';
  if (!pathValue) return undefined;

  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${binary}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

function readVersion(binary: string): string | undefined {
  try {
    const output = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_500,
      windowsHide: true,
    });
    const first = output.trim().split(/\r?\n/, 1)[0]?.trim();
    return first ? first.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

export function detectTools(
  candidates: readonly string[] = TOOL_CANDIDATES,
): DeviceTool[] {
  const tools: DeviceTool[] = [];
  const seen = new Set<string>();

  for (const name of candidates) {
    const path = whichSync(name);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const version = readVersion(path);
    tools.push({
      name,
      path,
      ...(version ? { version } : {}),
    });
    if (tools.length >= 50) break;
  }

  return tools;
}

function detectPty(): DevicePty {
  const shell =
    process.env.SHELL ||
    (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');

  try {
    // `resolve` alone is not enough: a failed native build leaves the package
    // installed but its .node binding missing. Require it to be honest.
    const loaded = require('node-pty') as { spawn?: unknown };
    if (typeof loaded.spawn !== 'function') throw new Error('no spawn');
    return {
      available: true,
      backend: process.platform === 'win32' ? 'conpty' : 'forkpty',
      shell,
    };
  } catch {
    return {
      available: false,
      backend: 'none',
      shell,
    };
  }
}

export function detectStats(): DeviceStats {
  const loads = loadavg();
  return {
    cpuCount: cpus().length,
    load1: loads[0],
    load5: loads[1],
    load15: loads[2],
    totalMemBytes: totalmem(),
    freeMemBytes: freemem(),
    uptimeSec: Math.floor(uptime()),
  };
}

/**
 * Collect the capability document the hub stores on every hello.
 *
 * Version probing is bounded (1.5s per tool) and only runs when the daemon
 * starts, so it never delays heartbeats.
 */
export function detectCapabilities(): DeviceCapabilities {
  const pty = detectPty();
  const mid = machineId();

  return {
    protocol: DEVICE_PROTOCOL_VERSION,
    os: platform(),
    arch: arch(),
    hostname: hostname(),
    ...(mid ? { machineId: mid } : {}),
    release: release(),
    ...(pty.shell ? { shell: pty.shell } : {}),
    pty,
    tools: detectTools(),
    features: [
      'ws',
      'heartbeat',
      ...(pty.available ? ['pty'] : []),
    ],
  };
}
