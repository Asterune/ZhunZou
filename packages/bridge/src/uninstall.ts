import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { vscodeUserDir } from './init.js';
import { uninstallService } from './service.js';

/**
 * Reverse of `init`: drop the `zhunzou` MCP entries and the login service.
 *
 * Only our own entry is touched; every other server in the file stays exactly
 * as it was. `~/.zhunzou` (bridge versions, fleet.json, tokens) is kept unless
 * `--purge`, so a reinstall does not re-download everything.
 */

export interface UninstallOptions {
  purge?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `mcpServers.zhunzou` — Cursor, Claude, Qoder, Gemini, Windsurf. */
export function removeMcpServer(existing: unknown): {
  next: unknown;
  changed: boolean;
} {
  if (!isRecord(existing) || !isRecord(existing.mcpServers)) {
    return { next: existing, changed: false };
  }
  if (!('zhunzou' in existing.mcpServers)) {
    return { next: existing, changed: false };
  }

  const servers = { ...existing.mcpServers };
  delete servers.zhunzou;
  return { next: { ...existing, mcpServers: servers }, changed: true };
}

/** OpenCode V2: `mcp.servers.zhunzou`; legacy: `mcp.zhunzou`. */
export function removeOpenCodeServer(existing: unknown): {
  next: unknown;
  changed: boolean;
} {
  if (!isRecord(existing) || !isRecord(existing.mcp)) {
    return { next: existing, changed: false };
  }

  const mcp = { ...existing.mcp };
  let changed = false;
  if ('zhunzou' in mcp) {
    delete mcp.zhunzou;
    changed = true;
  }
  if (isRecord(mcp.servers) && 'zhunzou' in mcp.servers) {
    const servers = { ...mcp.servers };
    delete servers.zhunzou;
    mcp.servers = servers;
    changed = true;
  }

  return changed ? { next: { ...existing, mcp }, changed } : { next: existing, changed };
}

/** VS Code: `servers.zhunzou`. */
export function removeVscodeServer(existing: unknown): {
  next: unknown;
  changed: boolean;
} {
  if (!isRecord(existing) || !isRecord(existing.servers)) {
    return { next: existing, changed: false };
  }
  if (!('zhunzou' in existing.servers)) {
    return { next: existing, changed: false };
  }

  const servers = { ...existing.servers };
  delete servers.zhunzou;
  return { next: { ...existing, servers }, changed: true };
}

const CODEX_SECTION = /^\s*\[mcp_servers\.zhunzou\]\s*$/;

/** Remove only the `[mcp_servers.zhunzou]` block from Codex's TOML. */
export function removeCodexSection(existing: string): {
  next: string;
  changed: boolean;
} {
  const kept: string[] = [];
  let skipping = false;
  let changed = false;

  for (const line of existing.split(/\r?\n/)) {
    if (CODEX_SECTION.test(line)) {
      skipping = true;
      changed = true;
      continue;
    }
    if (skipping) {
      if (/^\s*\[/.test(line)) skipping = false;
      else continue;
    }
    kept.push(line);
  }

  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  return { next: kept.join('\n'), changed };
}

interface JsonTarget {
  label: string;
  path: () => string;
  remove: (existing: unknown) => { next: unknown; changed: boolean };
}

const JSON_TARGETS: JsonTarget[] = [
  {
    label: 'Cursor',
    path: () => join(homedir(), '.cursor', 'mcp.json'),
    remove: removeMcpServer,
  },
  {
    label: 'OpenCode',
    path: () => {
      const configHome =
        process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
      return join(configHome, 'opencode', 'opencode.json');
    },
    remove: removeOpenCodeServer,
  },
  {
    label: 'Claude Code',
    path: () => join(homedir(), '.claude.json'),
    remove: removeMcpServer,
  },
  {
    label: 'Qoder',
    path: () =>
      join(
        (process.env.QODER_HOME ?? join(homedir(), '.qoder')).trim(),
        'settings.json',
      ),
    remove: removeMcpServer,
  },
  {
    label: 'Gemini CLI',
    path: () => join(homedir(), '.gemini', 'settings.json'),
    remove: removeMcpServer,
  },
  {
    label: 'Windsurf',
    path: () => join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    remove: removeMcpServer,
  },
  {
    label: 'VS Code',
    path: () => join(vscodeUserDir(), 'mcp.json'),
    remove: removeVscodeServer,
  },
];

export function runUninstall(options: UninstallOptions = {}): number {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const dryRun = options.dryRun === true;
  let touched = 0;

  for (const target of JSON_TARGETS) {
    const path = target.path();
    if (!existsSync(path)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      log(`! ${target.label}：${path} 不是合法 JSON，已跳过`);
      continue;
    }

    const { next, changed } = target.remove(parsed);
    if (!changed) continue;

    if (!dryRun) {
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    }
    touched += 1;
    log(`✓ 已从 ${path} 移除准奏 MCP（${target.label}）`);
  }

  const codexPath = join(homedir(), '.codex', 'config.toml');
  if (existsSync(codexPath)) {
    try {
      const { next, changed } = removeCodexSection(readFileSync(codexPath, 'utf8'));
      if (changed) {
        if (!dryRun) writeFileSync(codexPath, `${next}\n`, 'utf8');
        touched += 1;
        log(`✓ 已从 ${codexPath} 移除准奏 MCP（Codex）`);
      }
    } catch {
      log(`! Codex：${codexPath} 读取失败，已跳过`);
    }
  }

  if (dryRun) {
    log('（dry-run：没有写入任何文件，也没有卸载服务）');
    return 0;
  }

  const service = uninstallService();
  log(`✓ ${service.message}`);

  if (options.purge) {
    rmSync(join(homedir(), '.zhunzou'), { recursive: true, force: true });
    log('✓ 已删除 ~/.zhunzou（bridge 版本、fleet.json、设备 token）');
  } else {
    log('· 已保留 ~/.zhunzou；加 --purge 可一并删除');
  }

  if (touched === 0) log('· 没有找到需要移除的 MCP 配置');
  log('完成。如需重新接入，用看板「添加设备」生成的新命令即可。');
  return 0;
}
