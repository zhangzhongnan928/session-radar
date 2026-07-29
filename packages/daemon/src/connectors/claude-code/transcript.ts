import { readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import {
  TITLE_MAX_CHARS,
  deriveTitle,
  extractUserAuthoredText,
  isInjectedContext,
} from '@session-radar/shared';
import { ConnectorDownError } from '../../registry.js';

/**
 * Claude Code transcript layout (verified July 2026 on this machine):
 *
 *   ~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl
 *
 * The FILENAME is the session id. Records are one JSON object per line with
 * `type`, `timestamp` (ISO), `sessionId`, and — on most records — `cwd`,
 * `gitBranch` and `version`.
 *
 * Record types seen in the wild: queue-operation, attachment, user, assistant,
 * system, last-prompt, custom-title.
 */
export function claudeProjectsDir(): string {
  return process.env['SESSION_RADAR_CLAUDE_HOME']
    ? join(process.env['SESSION_RADAR_CLAUDE_HOME'], 'projects')
    : join(homedir(), '.claude', 'projects');
}

export interface TranscriptFile {
  sessionId: string;
  path: string;
  /** Slugified cwd, i.e. the directory name under projects/. */
  projectSlug: string;
  sizeBytes: number;
  modifiedAt: number;
}

export class TranscriptDirMissingError extends ConnectorDownError {
  constructor(public readonly dir: string) {
    super(`Claude Code transcript directory not found: ${dir}`);
    this.name = 'TranscriptDirMissingError';
  }
}

/**
 * Lists every transcript. Throws `TranscriptDirMissingError` if the projects
 * directory is gone — the caller turns that into a `down` connector, never into
 * an empty result, because "no sessions" and "cannot look" must never look alike.
 */
export function listTranscripts(dir = claudeProjectsDir()): TranscriptFile[] {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      throw new TranscriptDirMissingError(dir);
    }
    throw error;
  }

  const files: TranscriptFile[] = [];
  for (const slug of projectDirs) {
    const projectDir = join(dir, slug);
    let entries: string[];
    try {
      entries = readdirSync(projectDir);
    } catch {
      // One unreadable project directory must not blind us to the others.
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(projectDir, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        files.push({
          sessionId: basename(name, '.jsonl'),
          path,
          projectSlug: slug,
          sizeBytes: stat.size,
          modifiedAt: Math.floor(stat.mtimeMs),
        });
      } catch {
        continue;
      }
    }
  }
  return files;
}

export interface TranscriptMeta {
  sessionId: string;
  cwd: string | undefined;
  gitBranch: string | undefined;
  version: string | undefined;
  /** From a `custom-title` record when present — needs no message content. */
  customTitle: string | undefined;
  /** Truncated first user message. Only read when there is no custom title. */
  firstUserMessage: string | undefined;
  firstTimestamp: number | undefined;
  lastTimestamp: number | undefined;
}

/** How much of a transcript we read from each end. Transcripts reach many MB. */
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;

/**
 * Reads session metadata without loading the whole file.
 *
 * PRIVACY: the only message content this may return is `firstUserMessage`, and
 * it is truncated to TITLE_MAX_CHARS before it leaves this function. `custom-title`
 * is preferred precisely because it needs no message content at all.
 */
export async function readTranscriptMeta(file: TranscriptFile): Promise<TranscriptMeta> {
  const meta: TranscriptMeta = {
    sessionId: file.sessionId,
    cwd: undefined,
    gitBranch: undefined,
    version: undefined,
    customTitle: undefined,
    firstUserMessage: undefined,
    firstTimestamp: undefined,
    lastTimestamp: undefined,
  };

  const handle = await open(file.path, 'r');
  try {
    const headLength = Math.min(HEAD_BYTES, file.sizeBytes);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    applyRecords(meta, splitLines(head.toString('utf8'), headLength < file.sizeBytes));

    if (file.sizeBytes > HEAD_BYTES) {
      const tailLength = Math.min(TAIL_BYTES, file.sizeBytes);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, file.sizeBytes - tailLength);
      // The first line of the tail is almost certainly cut in half.
      applyRecords(meta, splitLines(tail.toString('utf8'), false).slice(1));
    }
  } finally {
    await handle.close();
  }

  return meta;
}

function splitLines(chunk: string, dropLast: boolean): string[] {
  const lines = chunk.split('\n');
  if (dropLast) lines.pop();
  return lines.filter((line) => line.trim().length > 0);
}

function applyRecords(meta: TranscriptMeta, lines: string[]): void {
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof record['cwd'] === 'string' && meta.cwd === undefined) meta.cwd = record['cwd'];
    if (typeof record['gitBranch'] === 'string' && meta.gitBranch === undefined) {
      meta.gitBranch = record['gitBranch'];
    }
    if (typeof record['version'] === 'string' && meta.version === undefined) {
      meta.version = record['version'];
    }

    const timestamp = typeof record['timestamp'] === 'string' ? Date.parse(record['timestamp']) : NaN;
    if (!Number.isNaN(timestamp)) {
      if (meta.firstTimestamp === undefined || timestamp < meta.firstTimestamp) {
        meta.firstTimestamp = timestamp;
      }
      if (meta.lastTimestamp === undefined || timestamp > meta.lastTimestamp) {
        meta.lastTimestamp = timestamp;
      }
    }

    // A custom title is the best title we can get, and costs no message content.
    // Later records win: the title is refined as the session goes on.
    if (record['type'] === 'custom-title' && typeof record['customTitle'] === 'string') {
      meta.customTitle = record['customTitle'];
    }

    if (
      record['type'] === 'user' &&
      meta.firstUserMessage === undefined &&
      isRealUserTurn(record)
    ) {
      const text = extractText(record['message']);
      const authored = text ? extractUserAuthoredText(text) : undefined;
      // Claude Code injects <system-reminder> and similar blocks as user turns.
      if (authored && !isInjectedContext(authored)) {
        meta.firstUserMessage = authored.slice(0, TITLE_MAX_CHARS);
      }
    }
  }
}

/** Skips sidechain (subagent) turns and tool-result echoes. */
function isRealUserTurn(record: Record<string, unknown>): boolean {
  if (record['isSidechain'] === true) return false;
  const message = record['message'];
  if (typeof message !== 'object' || message === null) return false;
  return (message as { role?: unknown }).role === 'user';
}

function extractText(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (typeof block === 'string') return block;
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return undefined;
}

/** Title priority: custom title -> first user message -> repo/cwd -> session id. */
export function titleFor(meta: TranscriptMeta, fallback: string): string {
  // A custom title costs no message content at all, so it always wins.
  if (meta.customTitle && meta.customTitle.trim().length > 0) {
    return deriveTitle(meta.customTitle, { fallback });
  }
  return deriveTitle(meta.firstUserMessage, { fallback });
}

/** `/Users/v/code/billing` -> `billing`. Used for the context column. */
export function repoNameFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1);
}
