import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { GROK_HOOK_EVENTS } from '@session-radar/shared';
import type { GrokHookEvent } from '@session-radar/shared';
import { DIR_MODE } from '../paths.js';
import { HOOK_TIMEOUT_SECONDS, backupFile } from './claude-hooks.js';

type GrokHookAction = 'add' | 'update' | 'already-installed';

export interface GrokHookPlanEntry {
  event: GrokHookEvent;
  action: GrokHookAction;
}

export interface GrokHookPlan {
  hookPath: string;
  fileExists: boolean;
  kind: 'add' | 'update' | 'already-installed' | 'manual';
  entries: GrokHookPlanEntry[];
  reason?: string;
}

interface HookHandler {
  type?: unknown;
  url?: unknown;
  timeout?: unknown;
  [key: string]: unknown;
}

interface HookGroup {
  hooks?: unknown;
  [key: string]: unknown;
}

interface GrokHookFile {
  hooks: Record<string, HookGroup[]>;
}

export function grokHooksPath(home = grokHomePath()): string {
  return join(home, 'hooks', 'session-radar.json');
}

export function grokHookUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/hooks/grok-build`;
}

export function planGrokHooks(
  port: number,
  path?: string,
  home = grokHomePath(),
): GrokHookPlan {
  const hookPath = path ?? grokHooksPath(home);
  const fileExists = existsSync(hookPath);
  if (!fileExists) {
    return {
      hookPath,
      fileExists,
      kind: 'add',
      entries: GROK_HOOK_EVENTS.map((event) => ({ event, action: 'add' })),
    };
  }

  let parsed: GrokHookFile;
  try {
    parsed = readOwnedFile(hookPath);
  } catch (error) {
    return {
      hookPath,
      fileExists,
      kind: 'manual',
      entries: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const desiredUrl = grokHookUrl(port);
  const entries: GrokHookPlanEntry[] = GROK_HOOK_EVENTS.map((event) => {
    const groups = parsed.hooks[event] ?? [];
    if (groups.length === 0) return { event, action: 'add' };
    const handler = handlerFromOwnedGroup(groups[0]!);
    return {
      event,
      action:
        handler.url === desiredUrl && handler.timeout === HOOK_TIMEOUT_SECONDS
          ? 'already-installed'
          : 'update',
    };
  });
  const changed = entries.some((entry) => entry.action !== 'already-installed');
  return {
    hookPath,
    fileExists,
    kind: changed
      ? entries.some((entry) => entry.action === 'update')
        ? 'update'
        : 'add'
      : 'already-installed',
    entries,
  };
}

export interface ApplyGrokHooksResult {
  applied: boolean;
  backupPath: string | undefined;
  added: GrokHookEvent[];
  updated: GrokHookEvent[];
  reason?: string;
}

export function applyGrokHooks(
  port: number,
  path?: string,
  home = grokHomePath(),
): ApplyGrokHooksResult {
  const plan = planGrokHooks(port, path, home);
  if (plan.kind === 'manual') {
    return {
      applied: false,
      backupPath: undefined,
      added: [],
      updated: [],
      ...(plan.reason ? { reason: plan.reason } : {}),
    };
  }
  if (plan.kind === 'already-installed') {
    return { applied: false, backupPath: undefined, added: [], updated: [] };
  }

  const backupPath = plan.fileExists
    ? backupFile(plan.hookPath, 'grok-session-radar-hooks.json')
    : undefined;
  mkdirSync(dirname(plan.hookPath), { recursive: true, mode: DIR_MODE });
  writeFileSync(plan.hookPath, `${JSON.stringify(renderHooks(port), null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    applied: true,
    backupPath,
    added: plan.entries.filter((entry) => entry.action === 'add').map((entry) => entry.event),
    updated: plan.entries
      .filter((entry) => entry.action === 'update')
      .map((entry) => entry.event),
  };
}

export interface RemoveGrokHooksResult {
  removed: boolean;
  backupPath: string | undefined;
  reason?: string;
}

/**
 * Leaves a valid empty hook file instead of deleting anything. The prior file
 * is recoverable under session-radar's backups directory.
 */
export function removeGrokHooks(
  path?: string,
  home = grokHomePath(),
): RemoveGrokHooksResult {
  const hookPath = path ?? grokHooksPath(home);
  if (!existsSync(hookPath)) return { removed: false, backupPath: undefined };
  try {
    readOwnedFile(hookPath);
  } catch (error) {
    return {
      removed: false,
      backupPath: undefined,
      reason: `refused to alter non-session-radar Grok hook file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const backupPath = backupFile(hookPath, 'grok-session-radar-hooks.json');
  writeFileSync(hookPath, `${JSON.stringify({ hooks: {} }, null, 2)}\n`, { mode: 0o600 });
  return { removed: true, backupPath };
}

function renderHooks(port: number): GrokHookFile {
  const url = grokHookUrl(port);
  return {
    hooks: Object.fromEntries(
      GROK_HOOK_EVENTS.map((event) => [
        event,
        [{ hooks: [{ type: 'http', url, timeout: HOOK_TIMEOUT_SECONDS }] }],
      ]),
    ),
  };
}

function readOwnedFile(path: string): GrokHookFile {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isObject(value) || Object.keys(value).some((key) => key !== 'hooks')) {
    throw new Error('file contains keys not owned by session-radar');
  }
  if (!isObject(value['hooks'])) throw new Error('hooks must be an object');

  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(value['hooks'])) {
    if (!(GROK_HOOK_EVENTS as readonly string[]).includes(event)) {
      throw new Error(`file contains foreign event ${event}`);
    }
    if (!Array.isArray(groups) || groups.length > 1) {
      throw new Error(`event ${event} is not a single session-radar group`);
    }
    if (groups.length === 0) {
      hooks[event] = [];
      continue;
    }
    const group = groups[0];
    if (!isObject(group)) throw new Error(`event ${event} group is malformed`);
    handlerFromOwnedGroup(group);
    hooks[event] = [group];
  }
  return { hooks };
}

function handlerFromOwnedGroup(group: HookGroup): {
  url: string;
  timeout: number | undefined;
} {
  if (Object.keys(group).some((key) => key !== 'hooks') || !Array.isArray(group.hooks)) {
    throw new Error('hook group contains foreign configuration');
  }
  if (group.hooks.length !== 1 || !isObject(group.hooks[0])) {
    throw new Error('hook group must contain exactly one session-radar handler');
  }
  const handler = group.hooks[0] as HookHandler;
  if (Object.keys(handler).some((key) => !['type', 'url', 'timeout'].includes(key))) {
    throw new Error('hook handler contains foreign configuration');
  }
  if (
    handler.type !== 'http' ||
    typeof handler.url !== 'string' ||
    !handler.url.includes('/api/hooks/grok-build')
  ) {
    throw new Error('hook handler is not owned by session-radar');
  }
  if (handler.timeout !== undefined && typeof handler.timeout !== 'number') {
    throw new Error('hook timeout is malformed');
  }
  return { url: handler.url, timeout: handler.timeout as number | undefined };
}

function grokHomePath(): string {
  return process.env['SESSION_RADAR_GROK_HOME'] ?? join(homedir(), '.grok');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
