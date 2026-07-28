import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DIR_MODE, sessionRadarHome } from '../paths.js';
import { backupFile } from './claude-hooks.js';

/**
 * Codex integration.
 *
 * Codex supports exactly ONE notify program. Victor already has one wired to
 * Codex Computer Use, so "install our notify" would silently break a working
 * integration — precisely the destructive edit the boundaries forbid.
 *
 * Instead we install a DISPATCHER: a tiny shell script that
 *   1. runs the original program first, with its original arguments, and
 *   2. then reports to session-radar in the background.
 *
 * The original keeps working with unchanged argv and unchanged exit code, and a
 * stopped daemon cannot delay it. Uninstall restores the original line verbatim.
 */
export function codexConfigPath(): string {
  const home = process.env['SESSION_RADAR_CODEX_HOME'] ?? join(homedir(), '.codex');
  return join(home, 'config.toml');
}

export function dispatcherPath(): string {
  return join(sessionRadarHome(), 'hooks', 'codex-notify-dispatch.sh');
}

export type CodexPlanKind =
  /** No notify key at all — we can add ours cleanly. */
  | 'add'
  /** An existing notify program will be wrapped by the dispatcher. */
  | 'wrap'
  /** Our dispatcher is already installed. */
  | 'already-installed'
  /** We refuse to touch it; the shape is not one we can safely rewrite. */
  | 'manual';

export interface CodexNotifyPlan {
  configPath: string;
  configExists: boolean;
  kind: CodexPlanKind;
  /** The notify line as it exists today, verbatim. */
  existingLine: string | undefined;
  /** Parsed argv of the existing notify program, when we could read it. */
  existingArgv: string[] | undefined;
  /** Why we refused, when kind is 'manual'. */
  reason?: string;
}

/**
 * Finds a top-level `notify = [...]` line.
 *
 * Deliberately line-oriented rather than a TOML round-trip: a parser would
 * reformat the whole file and lose comments. We only accept the simple,
 * single-line array form and refuse everything else — refusing loudly beats
 * corrupting a config.
 */
export function findNotifyLine(
  content: string,
): { index: number; line: string; inTopLevel: boolean } | undefined {
  const lines = content.split('\n');
  let inTable = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inTable = true;
      continue;
    }
    if (/^notify\s*=/.test(trimmed)) {
      return { index: i, line, inTopLevel: !inTable };
    }
  }
  return undefined;
}

/** Parses `notify = ["a", "b"]` into `["a", "b"]`. Undefined if not that shape. */
export function parseNotifyArray(line: string): string[] | undefined {
  const match = /^\s*notify\s*=\s*(\[.*\])\s*(#.*)?$/.exec(line);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1] as string) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) return undefined;
    return parsed as string[];
  } catch {
    return undefined;
  }
}

export function planCodexNotify(port: number, path = codexConfigPath()): CodexNotifyPlan {
  const configExists = existsSync(path);
  if (!configExists) {
    return {
      configPath: path,
      configExists: false,
      kind: 'add',
      existingLine: undefined,
      existingArgv: undefined,
    };
  }

  const content = readFileSync(path, 'utf8');
  const found = findNotifyLine(content);

  if (!found) {
    return {
      configPath: path,
      configExists: true,
      kind: 'add',
      existingLine: undefined,
      existingArgv: undefined,
    };
  }

  if (!found.inTopLevel) {
    return {
      configPath: path,
      configExists: true,
      kind: 'manual',
      existingLine: found.line,
      existingArgv: undefined,
      reason: 'the notify key is inside a [table]; session-radar only rewrites a top-level notify',
    };
  }

  const argv = parseNotifyArray(found.line);
  if (!argv) {
    return {
      configPath: path,
      configExists: true,
      kind: 'manual',
      existingLine: found.line,
      existingArgv: undefined,
      reason:
        'notify is not a single-line array of strings; rewriting it automatically could corrupt your config',
    };
  }

  if (argv[0] === dispatcherPath()) {
    return {
      configPath: path,
      configExists: true,
      kind: 'already-installed',
      existingLine: found.line,
      existingArgv: argv,
    };
  }

  return {
    configPath: path,
    configExists: true,
    kind: 'wrap',
    existingLine: found.line,
    existingArgv: argv,
    ...(port === 0 ? { reason: 'port must be non-zero' } : {}),
  };
}

/**
 * Writes the dispatcher.
 *
 * `"$@"` forwarding preserves the JSON payload argument exactly. The original
 * program's arguments are embedded already-quoted, so a path containing spaces
 * (like "Codex Computer Use.app") survives.
 */
export function renderDispatcher(originalArgv: string[], port: number): string {
  const original = originalArgv.map(shellQuote).join(' ');
  const lines = [
    '#!/bin/sh',
    '# Generated by session-radar. Do not edit.',
    '#',
    '# Codex allows only one notify program, so this dispatcher chains them:',
    '# the original notify runs first and unchanged; session-radar is told after,',
    '# in the background, so it can never delay or fail your notification.',
    '',
    'set -u',
    '',
  ];

  if (originalArgv.length > 0) {
    lines.push('# --- original notify program (runs first, exit code preserved) ---');
    lines.push(`${original} "$@"`);
    lines.push('ORIGINAL_STATUS=$?');
    lines.push('');
  } else {
    lines.push('ORIGINAL_STATUS=0');
    lines.push('');
  }

  lines.push('# --- session-radar (fire and forget) ---');
  lines.push('# The last argument is Codex\'s JSON payload.');
  lines.push('if [ "$#" -gt 0 ]; then');
  lines.push('  eval "PAYLOAD=\\${$#}"');
  lines.push('  curl --silent --show-error --max-time 2 \\');
  lines.push('    --header "Content-Type: application/json" \\');
  lines.push('    --data "$PAYLOAD" \\');
  lines.push(`    http://127.0.0.1:${port}/api/hooks/codex >/dev/null 2>&1 &`);
  lines.push('fi');
  lines.push('');
  lines.push('exit "$ORIGINAL_STATUS"');
  lines.push('');
  return lines.join('\n');
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface CodexApplyResult {
  applied: boolean;
  kind: CodexPlanKind;
  backupPath: string | undefined;
  dispatcherPath: string | undefined;
  reason?: string;
}

export function applyCodexNotify(port: number, path = codexConfigPath()): CodexApplyResult {
  const plan = planCodexNotify(port, path);

  if (plan.kind === 'manual') {
    return {
      applied: false,
      kind: plan.kind,
      backupPath: undefined,
      dispatcherPath: undefined,
      ...(plan.reason ? { reason: plan.reason } : {}),
    };
  }
  if (plan.kind === 'already-installed') {
    return { applied: false, kind: plan.kind, backupPath: undefined, dispatcherPath: dispatcherPath() };
  }

  const script = dispatcherPath();
  mkdirSync(join(sessionRadarHome(), 'hooks'), { recursive: true, mode: DIR_MODE });
  writeFileSync(script, renderDispatcher(plan.existingArgv ?? [], port), { mode: 0o700 });
  chmodSync(script, 0o700);

  // Record the original so uninstall can restore it byte-for-byte.
  const stateFile = join(sessionRadarHome(), 'hooks', 'codex-notify-original.json');
  writeFileSync(
    stateFile,
    `${JSON.stringify({ originalLine: plan.existingLine ?? null, originalArgv: plan.existingArgv ?? null }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const backupPath = plan.configExists ? backupFile(path, 'codex-config.toml') : undefined;
  const notifyLine = `notify = ${JSON.stringify([script])}`;

  let content = plan.configExists ? readFileSync(path, 'utf8') : '';
  const found = findNotifyLine(content);
  if (found) {
    const lines = content.split('\n');
    lines[found.index] = notifyLine;
    content = lines.join('\n');
  } else {
    // No notify yet: it must go above any [table] header to stay top-level.
    const lines = content.split('\n');
    const firstTable = lines.findIndex((l) => l.trim().startsWith('['));
    if (firstTable === -1) content = `${content.replace(/\n*$/, '')}\n${notifyLine}\n`;
    else {
      lines.splice(firstTable, 0, notifyLine, '');
      content = lines.join('\n');
    }
  }

  writeFileSync(path, content);
  return { applied: true, kind: plan.kind, backupPath, dispatcherPath: script };
}

export function removeCodexNotify(path = codexConfigPath()): {
  restored: boolean;
  backupPath: string | undefined;
} {
  if (!existsSync(path)) return { restored: false, backupPath: undefined };

  const content = readFileSync(path, 'utf8');
  const found = findNotifyLine(content);
  if (!found) return { restored: false, backupPath: undefined };

  const argv = parseNotifyArray(found.line);
  if (!argv || argv[0] !== dispatcherPath()) return { restored: false, backupPath: undefined };

  const stateFile = join(sessionRadarHome(), 'hooks', 'codex-notify-original.json');
  let originalLine: string | null = null;
  if (existsSync(stateFile)) {
    try {
      originalLine = (
        JSON.parse(readFileSync(stateFile, 'utf8')) as { originalLine: string | null }
      ).originalLine;
    } catch {
      originalLine = null;
    }
  }

  const backupPath = backupFile(path, 'codex-config.toml');
  const lines = content.split('\n');
  if (originalLine === null) lines.splice(found.index, 1);
  else lines[found.index] = originalLine;
  writeFileSync(path, lines.join('\n'));
  return { restored: true, backupPath };
}
