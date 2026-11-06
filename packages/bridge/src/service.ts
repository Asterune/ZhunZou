import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, win32 } from 'node:path';

/**
 * Optional开机常驻: keep one `wake` loop running so a machine stays online
 * even when the editor is closed.
 *
 * This is deliberately small: one service per machine, config cached in
 * `~/.zhunzou/service.json`, and the platform's native supervisor does the
 * rest (launchd / systemd --user / Scheduled Task). Failures are reported but
 * never abort the MCP setup — a missing service only means "online while the
 * editor is open".
 */

export interface ServiceConfig {
  env: string;
  hubUrl: string;
  token: string;
  cwd: string;
  adapter: string;
  cliPath: string;
  nodePath: string;
  projectName?: string;
  /**
   * `wake` keeps one env online; `fleet` supervises one loop per client env
   * from `fleet.json`, which is what a machine with several editors needs.
   */
  mode?: 'wake' | 'fleet';
  /** fleet.json path, only used when mode is `fleet`. */
  fleetConfig?: string;
}

export interface ServiceInstallResult {
  platform: NodeJS.Platform;
  /** File written to disk, for `--print` / debugging. */
  file?: string;
  started: boolean;
  message: string;
}

const MAC_LABEL = 'com.zhunzou.bridge';
const SYSTEMD_UNIT = 'zhunzou-bridge.service';
const WINDOWS_TASK = 'ZhunzouBridge';

export function serviceConfigPath(): string {
  return join(homedir(), '.zhunzou', 'service.json');
}

export function readServiceConfig(): ServiceConfig | null {
  const path = serviceConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ServiceConfig;
  } catch {
    return null;
  }
}

function writeServiceConfig(config: ServiceConfig): void {
  const path = serviceConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** systemd Environment= handling: quote anything with whitespace/quotes. */
function systemdValue(value: string): string {
  if (/[\s"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function run(command: string, args: string[], allowFailure = false): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (allowFailure) return false;
    throw error;
  }
}

/**
 * CLI arguments after `node <cliPath>`. `wake` is one env; `fleet` reads a
 * generated fleet.json and keeps every client env online at once.
 */
function serviceCommand(config: ServiceConfig): string[] {
  if (config.mode === 'fleet') {
    return [
      config.cliPath,
      'fleet',
      '--config',
      config.fleetConfig ?? join(homedir(), '.zhunzou', 'fleet.json'),
    ];
  }
  return [config.cliPath, 'wake', '--cwd', config.cwd];
}

function serviceCwd(config: ServiceConfig): string {
  return config.mode === 'fleet' ? homedir() : config.cwd;
}

/** Human hint so a fleet install is distinguishable from a single wake loop. */
function modeSuffix(config: ServiceConfig): string {
  return config.mode === 'fleet' ? '，fleet 多客户端' : '';
}

function macPlist(config: ServiceConfig): string {
  const logs = join(homedir(), 'Library', 'Logs');
  const command = serviceCommand(config);
  const environment: Array<[string, string]> = [
    ['HUB_URL', config.hubUrl],
    ['HUB_TOKEN', config.token],
    ['AGENT_ENV', config.env],
    ['ZHUNZOU_WAKE_ADAPTER', config.adapter],
    ...(config.projectName
      ? ([['ZHUNZOU_PROJECT', config.projectName]] as Array<[string, string]>)
      : []),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(config.nodePath)}</string>
${command.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(serviceCwd(config))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environment
  .map(
    ([key, value]) =>
      `    <key>${key}</key><string>${xmlEscape(value)}</string>`,
  )
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(join(logs, 'zhunzou-bridge.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(logs, 'zhunzou-bridge.err.log'))}</string>
</dict>
</plist>
`;
}

function systemdUnit(config: ServiceConfig): string {
  const environment = [
    `Environment=HUB_URL=${systemdValue(config.hubUrl)}`,
    `Environment=HUB_TOKEN=${systemdValue(config.token)}`,
    `Environment=AGENT_ENV=${systemdValue(config.env)}`,
    `Environment=ZHUNZOU_WAKE_ADAPTER=${systemdValue(config.adapter)}`,
    ...(config.projectName
      ? [`Environment=ZHUNZOU_PROJECT=${systemdValue(config.projectName)}`]
      : []),
  ].join('\n');

  return `[Unit]
Description=Zhunzou bridge (${config.env})
After=network-online.target

[Service]
Type=simple
${environment}
WorkingDirectory=${serviceCwd(config)}
ExecStart=${[config.nodePath, ...serviceCommand(config)]
    .map(systemdValue)
    .join(' ')}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** Per-user Startup shortcut, used when schtasks is unavailable. */
export function windowsStartupPath(
  appData = process.env.APPDATA,
): string | null {
  if (!appData) return null;
  // Always Windows separators: this path only exists on win32, and win32.join
  // keeps the function testable from macOS/Linux CI.
  return win32.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'zhunzou-bridge.cmd',
  );
}

export function renderWindowsServiceCommand(config: ServiceConfig): string {
  const node = `"${config.nodePath}"`;
  const cli = `"${config.cliPath}"`;
  const run =
    config.mode === 'fleet'
      ? `${node} ${cli} fleet --config "${config.fleetConfig ?? join(homedir(), '.zhunzou', 'fleet.json')}"`
      : `${node} ${cli} wake --cwd "${config.cwd}"`;
  const lines = [
    '@echo off',
    `set "HUB_URL=${config.hubUrl}"`,
    `set "HUB_TOKEN=${config.token}"`,
    `set "AGENT_ENV=${config.env}"`,
    `set "ZHUNZOU_WAKE_ADAPTER=${config.adapter}"`,
    ...(config.projectName
      ? [`set "ZHUNZOU_PROJECT=${config.projectName}"`]
      : []),
    `cd /d "${serviceCwd(config)}"`,
    run,
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export function installService(config: ServiceConfig): ServiceInstallResult {
  writeServiceConfig(config);
  const os = platform();

  if (os === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, macPlist(config), 'utf8');
    run('launchctl', ['unload', '-w', file], true);
    const started = run('launchctl', ['load', '-w', file], true);
    return {
      platform: os,
      file,
      started,
      message: started
        ? `已注册开机自启（launchd: ${MAC_LABEL}${modeSuffix(config)}）`
        : `已写入 ${file}，但 launchctl 加载失败；可手动执行 launchctl load -w "${file}"`,
    };
  }

  if (os === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const file = join(configHome, 'systemd', 'user', SYSTEMD_UNIT);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, systemdUnit(config), 'utf8');

    const hasSystemd = run('systemctl', ['--user', 'daemon-reload'], true);
    if (!hasSystemd) {
      return {
        platform: os,
        file,
        started: false,
        message: `已写入 ${file}，但当前环境没有 systemd --user；可手动用 systemctl --user enable --now ${SYSTEMD_UNIT} 启动`,
      };
    }
    run('systemctl', ['--user', 'enable', SYSTEMD_UNIT], true);
    const started = run('systemctl', ['--user', 'restart', SYSTEMD_UNIT], true);
    return {
      platform: os,
      file,
      started,
      message: started
        ? `已注册开机自启（systemd --user${modeSuffix(config)}）`
        : `已启用 ${SYSTEMD_UNIT}，但启动失败；查看 journalctl --user -u ${SYSTEMD_UNIT}`,
    };
  }

  if (os === 'win32') {
    const file = join(homedir(), '.zhunzou', 'bridge-service.cmd');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderWindowsServiceCommand(config), 'utf8');
    run('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F'], true);
    const started = run(
      'schtasks',
      ['/Create', '/F', '/SC', 'ONLOGON', '/TN', WINDOWS_TASK, '/TR', `"${file}"`],
      true,
    );
    if (started) {
      return {
        platform: os,
        file,
        started,
        message: `已注册登录时自启（计划任务 ZhunzouBridge${modeSuffix(config)}）`,
      };
    }

    // Locked-down machines (or non-admin sessions) reject schtasks. The
    // per-user Startup folder needs no elevation and is the next best thing.
    const shortcut = windowsStartupPath();
    if (shortcut) {
      try {
        mkdirSync(dirname(shortcut), { recursive: true });
        copyFileSync(file, shortcut);
        return {
          platform: os,
          file: shortcut,
          started: true,
          message: `计划任务不可用，已加入启动文件夹（下次登录生效；立即启动：start "" "${file}"${modeSuffix(config)}）`,
        };
      } catch {
        // Fall through to the manual instruction below.
      }
    }

    return {
      platform: os,
      file,
      started: false,
      message: `已写入 ${file}，但 schtasks 创建失败；可在“运行”里执行 shell:startup，把该文件放进启动文件夹`,
    };
  }

  return {
    platform: os,
    started: false,
    message: `当前系统 ${os} 暂不支持自动常驻；设备只在编辑器打开时在线。`,
  };
}

export function uninstallService(): ServiceInstallResult {
  const os = platform();
  if (os === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
    if (existsSync(file)) {
      run('launchctl', ['unload', '-w', file], true);
      rmSync(file, { force: true });
    }
    return { platform: os, file, started: false, message: '已移除开机自启（launchd）' };
  }
  if (os === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const file = join(configHome, 'systemd', 'user', SYSTEMD_UNIT);
    run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], true);
    rmSync(file, { force: true });
    run('systemctl', ['--user', 'daemon-reload'], true);
    return { platform: os, file, started: false, message: '已移除开机自启（systemd）' };
  }
  if (os === 'win32') {
    const file = join(homedir(), '.zhunzou', 'bridge-service.cmd');
    run('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F'], true);
    rmSync(file, { force: true });
    const startup = windowsStartupPath();
    if (startup) rmSync(startup, { force: true });
    return { platform: os, file, started: false, message: '已移除登录自启（计划任务 / 启动文件夹）' };
  }
  return { platform: os, started: false, message: '当前系统没有可移除的常驻服务。' };
}

export function serviceStatus(): string {
  const config = readServiceConfig();
  if (!config) return '未安装常驻服务（仅编辑器打开时在线）。';
  const os = platform();
  if (os === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
    return existsSync(file)
      ? `已安装：launchd ${MAC_LABEL}（env=${config.env}）`
      : '配置存在但未找到 launchd plist。';
  }
  if (os === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const file = join(configHome, 'systemd', 'user', SYSTEMD_UNIT);
    return existsSync(file)
      ? `已安装：systemd --user ${SYSTEMD_UNIT}（env=${config.env}）`
      : '配置存在但未找到 systemd unit。';
  }
  if (os === 'win32') {
    const file = join(homedir(), '.zhunzou', 'bridge-service.cmd');
    if (!existsSync(file)) return '配置存在但未找到启动脚本。';
    const startup = windowsStartupPath();
    const viaStartup = startup ? existsSync(startup) : false;
    return viaStartup
      ? `已安装：启动文件夹 zhunzou-bridge.cmd（env=${config.env}）`
      : `已安装：计划任务 ${WINDOWS_TASK}（env=${config.env}）`;
  }
  return `配置存在，但 ${os} 不支持自动常驻。`;
}


