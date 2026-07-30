import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const MAX_SUMMARY_BYTES = 1024 * 1024;
const MAX_REGISTRY_BYTES = 1024 * 1024;

const sourceTimeSchema = z.union([z.string(), z.number()]);

const summarySchema = z.object({
  info: z.object({
    id: z.string().min(1),
    cwd: z.string().optional(),
  }),
  session_summary: z.string().optional(),
  created_at: sourceTimeSchema.optional(),
  updated_at: sourceTimeSchema.optional(),
  last_active_at: sourceTimeSchema.nullable().optional(),
  num_messages: z.number().int().nonnegative().optional(),
  num_chat_messages: z.number().int().nonnegative().optional(),
  current_model_id: z.string().optional(),
  generated_title: z.string().optional(),
  session_kind: z.string().optional(),
  hidden: z.boolean().optional(),
});

const activeSessionSchema = z.object({
  session_id: z.string().min(1),
  pid: z.number().int().positive(),
  cwd: z.string().optional(),
  opened_at: sourceTimeSchema.optional(),
});

const versionSchema = z.object({
  version: z.string().min(1),
});

export interface GrokSummaryFile {
  sessionId: string;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface GrokSummary {
  sessionId: string;
  cwd: string | undefined;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number | undefined;
  generatedTitle: string | undefined;
  sessionSummary: string | undefined;
  modelId: string | undefined;
  sessionKind: string | undefined;
  hidden: boolean;
  numMessages: number | undefined;
  numChatMessages: number | undefined;
}

export interface GrokActiveSession {
  sessionId: string;
  pid: number;
  cwd: string | undefined;
  openedAt: number | undefined;
}

export function grokHome(): string {
  return process.env['SESSION_RADAR_GROK_HOME'] ?? join(homedir(), '.grok');
}

export function grokSessionsDir(home = grokHome()): string {
  return join(home, 'sessions');
}

export function grokActiveSessionsPath(home = grokHome()): string {
  return join(home, 'active_sessions.json');
}

/**
 * Grok stores one summary at:
 * `~/.grok/sessions/<encoded-cwd>/<session-id>/summary.json`.
 *
 * The walk is intentionally exactly two directories deep and never follows
 * symlinks. Conversation streams next to the summary are never opened.
 */
export function listGrokSummaries(home = grokHome()): GrokSummaryFile[] {
  const root = grokSessionsDir(home);
  if (!existsSync(root)) return [];

  const files: GrokSummaryFile[] = [];
  for (const workspace of safeDirectories(root)) {
    const workspacePath = join(root, workspace);
    for (const sessionId of safeDirectories(workspacePath)) {
      const path = join(workspacePath, sessionId, 'summary.json');
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        files.push({
          sessionId,
          path,
          sizeBytes: stat.size,
          modifiedAt: Math.floor(stat.mtimeMs),
        });
      } catch (error) {
        // A concurrent session cleanup is harmless. Permissions and other I/O
        // failures are coverage incidents and must reach the registry.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
  }
  return files;
}

export function readGrokSummary(file: GrokSummaryFile): GrokSummary {
  if (file.sizeBytes > MAX_SUMMARY_BYTES) {
    throw new Error(`summary exceeds ${MAX_SUMMARY_BYTES} bytes`);
  }
  const parsed = summarySchema.parse(JSON.parse(readFileSync(file.path, 'utf8')));
  if (parsed.info.id !== file.sessionId) {
    throw new Error(
      `summary id ${parsed.info.id} does not match directory ${file.sessionId}`,
    );
  }

  const createdAt = sourceTime(parsed.created_at) ?? file.modifiedAt;
  const updatedAt = sourceTime(parsed.updated_at) ?? file.modifiedAt;
  const lastActiveAt =
    parsed.last_active_at === null ? undefined : sourceTime(parsed.last_active_at);

  return {
    sessionId: parsed.info.id,
    cwd: parsed.info.cwd,
    createdAt,
    updatedAt,
    lastActiveAt,
    generatedTitle: nonEmpty(parsed.generated_title),
    sessionSummary: nonEmpty(parsed.session_summary),
    modelId: nonEmpty(parsed.current_model_id),
    sessionKind: nonEmpty(parsed.session_kind),
    hidden: parsed.hidden ?? false,
    numMessages: parsed.num_messages,
    numChatMessages: parsed.num_chat_messages,
  };
}

export function readGrokActiveSessions(home = grokHome()): GrokActiveSession[] {
  const path = grokActiveSessionsPath(home);
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('active session registry is not a regular file');
  }
  if (stat.size > MAX_REGISTRY_BYTES) {
    throw new Error(`active session registry exceeds ${MAX_REGISTRY_BYTES} bytes`);
  }
  const parsed = z.array(activeSessionSchema).parse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.map((entry) => ({
    sessionId: entry.session_id,
    pid: entry.pid,
    cwd: entry.cwd,
    openedAt: sourceTime(entry.opened_at),
  }));
}

export function readGrokVersion(home = grokHome()): string | undefined {
  const path = join(home, 'version.json');
  if (!existsSync(path)) return undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined;
    return versionSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).version;
  } catch {
    return undefined;
  }
}

function safeDirectories(path: string): string[] {
  // Do not swallow EACCES/EPERM: an unreadable inventory is not an empty one.
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name);
}

function sourceTime(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.floor(value < 1_000_000_000_000 ? value * 1_000 : value);
  }
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
