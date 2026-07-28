import { readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TITLE_MAX_CHARS, deriveTitle, isInjectedContext } from '@session-radar/shared';
import { ConnectorDownError } from '../../registry.js';

/**
 * Codex rollout layout (verified July 2026 against codex-cli 0.144.1):
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl
 *
 * The trailing UUID in the filename is the session id — the same id
 * `codex resume <SESSION_ID>` accepts. Records are
 * `{ timestamp, type, payload }`; the first is `session_meta`, whose payload
 * carries `id`, `cwd`, `originator`, `cli_version` and `git`.
 */
export function codexSessionsDir(): string {
  return process.env['SESSION_RADAR_CODEX_HOME']
    ? join(process.env['SESSION_RADAR_CODEX_HOME'], 'sessions')
    : join(homedir(), '.codex', 'sessions');
}

export interface RolloutFile {
  sessionId: string;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
}

export class RolloutDirMissingError extends ConnectorDownError {
  constructor(public readonly dir: string) {
    super(`Codex sessions directory not found: ${dir}`);
    this.name = 'RolloutDirMissingError';
  }
}

/** `rollout-2026-07-28T17-44-00-019fa7ae-3778-7671-ba66-b2fd928d7156.jsonl` */
const ROLLOUT_NAME = /^rollout-.+?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function sessionIdFromRolloutName(name: string): string | undefined {
  return ROLLOUT_NAME.exec(name)?.[1];
}

/**
 * Walks the YYYY/MM/DD tree. Throws `RolloutDirMissingError` when the sessions
 * directory is unreadable so the caller can report `down` rather than "none".
 */
export function listRollouts(dir = codexSessionsDir(), maxDepth = 4): RolloutFile[] {
  try {
    statSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      throw new RolloutDirMissingError(dir);
    }
    throw error;
  }

  const files: RolloutFile[] = [];
  walk(dir, 0);
  return files;

  function walk(current: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      const sessionId = sessionIdFromRolloutName(entry.name);
      if (!sessionId) continue;
      try {
        const stat = statSync(path);
        files.push({
          sessionId,
          path,
          sizeBytes: stat.size,
          modifiedAt: Math.floor(stat.mtimeMs),
        });
      } catch {
        continue;
      }
    }
  }
}

export interface RolloutMeta {
  sessionId: string;
  cwd: string | undefined;
  cliVersion: string | undefined;
  originator: string | undefined;
  firstUserMessage: string | undefined;
  startedAt: number | undefined;
}

const HEAD_BYTES = 128 * 1024;

/**
 * Reads the session_meta header plus, if needed, the first user message.
 *
 * PRIVACY: `firstUserMessage` is truncated to TITLE_MAX_CHARS here. Codex rollouts
 * contain the full conversation; nothing beyond the title budget is returned.
 */
export async function readRolloutMeta(file: RolloutFile): Promise<RolloutMeta> {
  const meta: RolloutMeta = {
    sessionId: file.sessionId,
    cwd: undefined,
    cliVersion: undefined,
    originator: undefined,
    firstUserMessage: undefined,
    startedAt: undefined,
  };

  const handle = await open(file.path, 'r');
  try {
    const length = Math.min(HEAD_BYTES, file.sizeBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const lines = buffer.toString('utf8').split('\n');
    if (length < file.sizeBytes) lines.pop();

    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let record: { timestamp?: unknown; type?: unknown; payload?: unknown };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }

      if (record.type === 'session_meta' && isObject(record.payload)) {
        const payload = record.payload;
        if (typeof payload['cwd'] === 'string') meta.cwd = payload['cwd'];
        if (typeof payload['cli_version'] === 'string') meta.cliVersion = payload['cli_version'];
        if (typeof payload['originator'] === 'string') meta.originator = payload['originator'];
        if (typeof payload['timestamp'] === 'string') {
          const parsed = Date.parse(payload['timestamp']);
          if (!Number.isNaN(parsed)) meta.startedAt = parsed;
        }
      }

      // `event_msg/user_message` is what Victor actually typed. The
      // `response_item` stream also carries user-role messages, but those
      // include tool-injected context (<recommended_plugins>, file dumps,
      // plugin system prompts), which made for pages of identical titles.
      // Prefer the event; fall back to the response_item only if absent.
      if (meta.firstUserMessage === undefined && isObject(record.payload)) {
        const text = userMessageEvent(record.type, record.payload) ?? firstUserText(record.payload);
        if (text && !isInjectedContext(text)) {
          meta.firstUserMessage = text.slice(0, TITLE_MAX_CHARS);
        }
      }

      if (meta.cwd !== undefined && meta.firstUserMessage !== undefined) break;
    }
  } finally {
    await handle.close();
  }

  return meta;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The clean signal: `{type:'event_msg', payload:{type:'user_message', message}}`.
 * Verified against codex-cli 0.144.1 rollouts.
 */
function userMessageEvent(
  recordType: unknown,
  payload: Record<string, unknown>,
): string | undefined {
  if (recordType !== 'event_msg') return undefined;
  if (payload['type'] !== 'user_message') return undefined;
  const message = payload['message'];
  return typeof message === 'string' ? message : undefined;
}

/** Pulls user text out of a `response_item` payload. */
function firstUserText(payload: Record<string, unknown>): string | undefined {
  if (payload['role'] !== 'user') return undefined;
  const content = payload['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!isObject(block)) continue;
    const type = block['type'];
    if ((type === 'input_text' || type === 'text') && typeof block['text'] === 'string') {
      return block['text'];
    }
  }
  return undefined;
}

export function titleForRollout(meta: RolloutMeta, fallbackLabel: string): string {
  return deriveTitle(meta.firstUserMessage, { fallback: fallbackLabel });
}
