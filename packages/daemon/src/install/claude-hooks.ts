import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_HOOK_EVENTS } from '@session-radar/shared';
import type { ClaudeHookEvent } from '@session-radar/shared';
import { DIR_MODE, sessionRadarHome } from '../paths.js';

/**
 * Installs session-radar's Claude Code hooks.
 *
 * Two rules govern everything here:
 *  1. NEVER overwrite. Victor's existing hooks are appended to, not replaced.
 *  2. NEVER block. Hooks use a short timeout so a stopped daemon can only ever
 *     cost a moment, not wedge a session.
 *
 * We use `type: "http"` rather than shelling out to curl: no subprocess per
 * event, and no shell quoting to get wrong on a path with spaces.
 */
export function claudeSettingsPath(): string {
  const home = process.env['SESSION_RADAR_CLAUDE_HOME'] ?? join(homedir(), '.claude');
  return join(home, 'settings.json');
}

/** Seconds. Short on purpose — see rule 2 above. */
export const HOOK_TIMEOUT_SECONDS = 5;

export interface HookPlanEntry {
  event: ClaudeHookEvent;
  action: 'add' | 'already-installed';
}

export interface ClaudeHookPlan {
  settingsPath: string;
  settingsExists: boolean;
  entries: HookPlanEntry[];
  /** Hook events Victor already has, which we are leaving untouched. */
  preservedEvents: string[];
  changed: boolean;
}

interface HookHandler {
  type?: string;
  url?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}

interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export function hookUrl(port: number, connector: 'claude-code' | 'codex'): string {
  return `http://127.0.0.1:${port}/api/hooks/${connector}`;
}

/** Ours are recognised by URL, so uninstall never touches Victor's entries. */
function isSessionRadarHook(handler: HookHandler): boolean {
  return handler.type === 'http' && typeof handler.url === 'string' && handler.url.includes('/api/hooks/');
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw) as Settings;
}

export function planClaudeHooks(port: number, path = claudeSettingsPath()): ClaudeHookPlan {
  const settingsExists = existsSync(path);
  const settings = settingsExists ? readSettings(path) : {};
  const hooks = settings.hooks ?? {};
  const url = hookUrl(port, 'claude-code');

  const entries: HookPlanEntry[] = CLAUDE_HOOK_EVENTS.map((event) => {
    const groups = hooks[event] ?? [];
    const installed = groups.some((group) =>
      (group.hooks ?? []).some((handler) => isSessionRadarHook(handler) && handler.url === url),
    );
    return { event, action: installed ? 'already-installed' : 'add' };
  });

  const preserved: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    const foreign = groups.some((group) =>
      (group.hooks ?? []).some((handler) => !isSessionRadarHook(handler)),
    );
    if (foreign) preserved.push(event);
  }

  return {
    settingsPath: path,
    settingsExists,
    entries,
    preservedEvents: preserved.sort(),
    changed: entries.some((e) => e.action === 'add'),
  };
}

export interface ApplyResult {
  backupPath: string | undefined;
  added: ClaudeHookEvent[];
}

export function applyClaudeHooks(port: number, path = claudeSettingsPath()): ApplyResult {
  const plan = planClaudeHooks(port, path);
  if (!plan.changed) return { backupPath: undefined, added: [] };

  const backupPath = plan.settingsExists ? backupFile(path, 'claude-settings.json') : undefined;

  const settings = plan.settingsExists ? readSettings(path) : {};
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  const url = hookUrl(port, 'claude-code');
  const added: ClaudeHookEvent[] = [];

  for (const entry of plan.entries) {
    if (entry.action !== 'add') continue;
    const existing = hooks[entry.event] ?? [];
    // A NEW group, appended. Victor's groups are never opened or edited.
    hooks[entry.event] = [
      ...existing,
      { hooks: [{ type: 'http', url, timeout: HOOK_TIMEOUT_SECONDS }] },
    ];
    added.push(entry.event);
  }

  const next: Settings = { ...settings, hooks };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { backupPath, added };
}

export interface RemoveResult {
  backupPath: string | undefined;
  removed: string[];
}

/** Removes only our entries, leaving Victor's alone. */
export function removeClaudeHooks(path = claudeSettingsPath()): RemoveResult {
  if (!existsSync(path)) return { backupPath: undefined, removed: [] };

  const settings = readSettings(path);
  const hooks = settings.hooks;
  if (!hooks) return { backupPath: undefined, removed: [] };

  const removed: string[] = [];
  const next: Record<string, HookGroup[]> = {};

  for (const [event, groups] of Object.entries(hooks)) {
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const handlers = group.hooks ?? [];
      const remaining = handlers.filter((handler) => !isSessionRadarHook(handler));
      if (remaining.length !== handlers.length) removed.push(event);
      // Drop a group only if it is now empty AND it had handlers to begin with.
      if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
      else if (handlers.length === 0) kept.push(group);
    }
    if (kept.length > 0) next[event] = kept;
  }

  if (removed.length === 0) return { backupPath: undefined, removed: [] };

  const backupPath = backupFile(path, 'claude-settings.json');
  writeFileSync(path, `${JSON.stringify({ ...settings, hooks: next }, null, 2)}\n`, {
    mode: 0o600,
  });
  return { backupPath, removed: [...new Set(removed)].sort() };
}

/** Timestamped copies under ~/.session-radar/backups. Never overwritten. */
export function backupFile(source: string, label: string): string {
  const dir = join(sessionRadarHome(), 'backups');
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(dir, `${label}.${stamp}.bak`);
  copyFileSync(source, target);
  return target;
}
