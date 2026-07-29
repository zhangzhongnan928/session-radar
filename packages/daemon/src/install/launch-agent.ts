import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DEFAULT_DAEMON_CONFIG } from '@session-radar/shared';
import { DIR_MODE, FILE_MODE, sessionRadarHome } from '../paths.js';
import { backupFile } from './claude-hooks.js';

export const LAUNCH_AGENT_LABEL = 'com.session-radar.daemon';

export interface LaunchAgentPaths {
  plistPath: string;
  nodePath: string;
  daemonPath: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  port: number;
  radarHome: string;
}

export interface LaunchAgentPlan extends LaunchAgentPaths {
  action: 'add' | 'update' | 'already-installed';
  plist: string;
}

export interface LaunchCommandResult {
  status: number;
  stderr: string;
}

export type LaunchCommandRunner = (
  command: string,
  args: readonly string[],
) => LaunchCommandResult;

export interface LaunchAgentOptions {
  plistPath?: string;
  nodePath?: string;
  daemonPath?: string;
  workingDirectory?: string;
  stdoutPath?: string;
  stderrPath?: string;
  port?: number;
  radarHome?: string;
  uid?: number;
  run?: LaunchCommandRunner;
}

export interface LaunchAgentApplyResult {
  plan: LaunchAgentPlan;
  backupPath: string | undefined;
  service: string;
}

/**
 * Resolve explicit absolute paths for launchd. A login agent gets a minimal
 * environment, so relying on PATH, pnpm, a shell, or the current directory
 * would make startup fragile.
 */
export function launchAgentPaths(options: LaunchAgentOptions = {}): LaunchAgentPaths {
  const here = dirname(fileURLToPath(import.meta.url));
  const daemonPath =
    options.daemonPath ?? resolve(here, '..', '..', 'dist', 'index.js');
  const workingDirectory =
    options.workingDirectory ?? resolve(dirname(daemonPath), '..', '..', '..');
  const radarHome = options.radarHome ?? sessionRadarHome();
  const logs = join(radarHome, 'logs');

  return {
    plistPath:
      options.plistPath ??
      join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
    nodePath: options.nodePath ?? process.execPath,
    daemonPath,
    workingDirectory,
    stdoutPath: options.stdoutPath ?? join(logs, 'daemon.stdout.log'),
    stderrPath: options.stderrPath ?? join(logs, 'daemon.stderr.log'),
    port: options.port ?? DEFAULT_DAEMON_CONFIG.port,
    radarHome,
  };
}

export function renderLaunchAgent(paths: LaunchAgentPaths): string {
  const environment = [
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>SESSION_RADAR_PORT</key><string>${paths.port}</string>`,
    `    <key>SESSION_RADAR_HOME</key><string>${xml(paths.radarHome)}</string>`,
    '  </dict>',
  ].join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(paths.nodePath)}</string>`,
    `    <string>${xml(paths.daemonPath)}</string>`,
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xml(paths.workingDirectory)}</string>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    // launchd otherwise creates stdout/stderr with a process-default 0644 mode.
    '  <key>Umask</key><integer>63</integer>',
    '  <key>ThrottleInterval</key><integer>5</integer>',
    `  <key>StandardOutPath</key><string>${xml(paths.stdoutPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(paths.stderrPath)}</string>`,
    environment,
    '</dict>',
    '</plist>',
    '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export function planLaunchAgent(options: LaunchAgentOptions = {}): LaunchAgentPlan {
  const paths = launchAgentPaths(options);
  const plist = renderLaunchAgent(paths);
  let action: LaunchAgentPlan['action'] = 'add';
  if (existsSync(paths.plistPath)) {
    action =
      readFileSync(paths.plistPath, 'utf8') === plist ? 'already-installed' : 'update';
  }
  return { ...paths, action, plist };
}

/**
 * Writes the LaunchAgent and loads it into this user's GUI domain.
 *
 * Existing plists are backed up before replacement. `bootout` is intentionally
 * best-effort because "not currently loaded" is a normal first-install state;
 * `bootstrap` and `kickstart` must succeed.
 */
export function applyLaunchAgent(
  options: LaunchAgentOptions = {},
): LaunchAgentApplyResult {
  const plan = planLaunchAgent(options);
  if (!existsSync(plan.nodePath)) throw new Error(`Node executable not found: ${plan.nodePath}`);
  if (!existsSync(plan.daemonPath)) {
    throw new Error(`built daemon not found: ${plan.daemonPath} — run pnpm build first`);
  }

  mkdirSync(plan.radarHome, { recursive: true, mode: DIR_MODE });
  chmodSync(plan.radarHome, DIR_MODE);
  mkdirSync(dirname(plan.stdoutPath), { recursive: true, mode: DIR_MODE });
  mkdirSync(dirname(plan.plistPath), { recursive: true });

  const backupPath =
    plan.action === 'update' ? backupFile(plan.plistPath, 'launch-agent.plist') : undefined;
  if (plan.action !== 'already-installed') {
    writeFileSync(plan.plistPath, plan.plist, { mode: FILE_MODE });
    chmodSync(plan.plistPath, FILE_MODE);
  }

  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error('cannot determine the current user id for launchd');
  const domain = `gui/${uid}`;
  const service = `${domain}/${LAUNCH_AGENT_LABEL}`;
  const run = options.run ?? runLaunchCommand;

  // Ignore bootout's exit status: the service may not be loaded yet.
  run('/bin/launchctl', ['bootout', domain, plan.plistPath]);
  checked(run, '/bin/launchctl', ['bootstrap', domain, plan.plistPath]);
  checked(run, '/bin/launchctl', ['kickstart', '-k', service]);
  for (const logPath of [plan.stdoutPath, plan.stderrPath]) {
    if (existsSync(logPath)) chmodSync(logPath, FILE_MODE);
  }

  return { plan, backupPath, service };
}

/** Removes only session-radar's LaunchAgent and keeps a recoverable backup. */
export function removeLaunchAgent(
  options: LaunchAgentOptions = {},
): { removed: boolean; backupPath: string | undefined } {
  const paths = launchAgentPaths(options);
  if (!existsSync(paths.plistPath)) return { removed: false, backupPath: undefined };

  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error('cannot determine the current user id for launchd');
  const run = options.run ?? runLaunchCommand;
  run('/bin/launchctl', ['bootout', `gui/${uid}`, paths.plistPath]);

  const backupPath = backupFile(paths.plistPath, 'launch-agent.plist.removed');
  unlinkSync(paths.plistPath);
  return { removed: true, backupPath };
}

function checked(
  run: LaunchCommandRunner,
  command: string,
  args: readonly string[],
): void {
  const result = run(command, args);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || 'no error text'}`,
    );
  }
}

function runLaunchCommand(command: string, args: readonly string[]): LaunchCommandResult {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stderr: result.stderr?.trim() ?? result.error?.message ?? '',
  };
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
