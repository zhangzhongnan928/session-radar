import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import {
  DEFAULT_DAEMON_CONFIG,
  DEFAULT_HISTORY_WINDOW_MS,
  canonicalKey,
  deriveTitle,
  fallbackLabel,
} from '@session-radar/shared';
import type { Source } from '@session-radar/shared';
import { z } from 'zod';
import type { StatusEngine } from '../../engine.js';
import { planClaudeHooks } from '../../install/claude-hooks.js';
import type { Connector, ConnectorContext, ConnectorScanResult } from '../../registry.js';
import { ConnectorUnsupportedError } from '../../registry.js';
import type { StoredObservation } from '../../store.js';
import { repoNameFromCwd } from '../claude-code/transcript.js';

export const CLAUDE_CODE_DESKTOP_CONNECTOR_ID = 'claude-code-desktop';

/**
 * These files are an observed Desktop implementation detail, not a published
 * Anthropic contract. Keep the accepted shape deliberately small and validate it
 * on every read so a Desktop update becomes degraded coverage instead of silence.
 */
export const claudeDesktopSessionSchema = z.object({
  sessionId: z.string().min(1),
  cliSessionId: z.string().min(1).optional(),
  /** First-party cloud session ids used for Remote Control / cross-device joins. */
  bridgeSessionIds: z.array(z.string().min(1)).optional(),
  title: z.string().optional(),
  titleSource: z.string().optional(),
  cwd: z.string().optional(),
  originCwd: z.string().optional(),
  createdAt: z.number().int().nonnegative().optional(),
  lastActivityAt: z.number().int().nonnegative().optional(),
  lastFocusedAt: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  completedTurns: z.number().int().nonnegative().optional(),
  isArchived: z.boolean().optional(),
});

export type ClaudeDesktopSession = z.infer<typeof claudeDesktopSessionSchema>;

export interface ClaudeDesktopSessionFile {
  path: string;
  modifiedAt: number;
  sizeBytes: number;
}

export class ClaudeDesktopSessionsDirMissingError extends Error {
  constructor(path: string) {
    super(`Claude Code Desktop session metadata directory not found: ${path}`);
    this.name = 'ClaudeDesktopSessionsDirMissingError';
  }
}

export function claudeDesktopSessionsDir(): string {
  return join(
    homedir(),
    'Library',
    'Application Support',
    'Claude',
    'claude-code-sessions',
  );
}

/**
 * Find the plain-JSON local session records without following symlinks.
 *
 * The current layout is account/workspace/local_<id>.json, but recursion is
 * intentional: account and workspace directory shapes are not a public contract.
 */
export function listClaudeDesktopSessionFiles(root: string): ClaudeDesktopSessionFile[] {
  if (!existsSync(root)) throw new ClaudeDesktopSessionsDirMissingError(root);

  const files: ClaudeDesktopSessionFile[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && /^local_.*\.json$/u.test(entry.name)) {
        const stat = statSync(path);
        files.push({ path, modifiedAt: stat.mtimeMs, sizeBytes: stat.size });
      }
    }
  }

  return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function readClaudeDesktopSession(file: ClaudeDesktopSessionFile): ClaudeDesktopSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file.path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `invalid JSON in ${basename(file.path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = claudeDesktopSessionSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.')} ${issue.message}`)
      .join('; ');
    throw new Error(`unrecognised schema in ${basename(file.path)}: ${detail}`);
  }
  return result.data;
}

export interface ClaudeCodeDesktopConnectorOptions {
  engine: StatusEngine;
  sessionsDir?: string;
  appPath?: string;
  settingsPath?: string;
  hookPort?: number;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  device?: string;
  /** Tests can isolate file parsing from the real hook configuration. */
  checkHooks?: boolean;
}

/**
 * Claude Code Desktop collector.
 *
 * Metadata files provide inventory, titles and the `cliSessionId` join key.
 * Shared Claude hooks provide authoritative live state. Neither is silently
 * substituted for the other: missing hooks degrade coverage, while malformed
 * metadata degrades the inventory path.
 */
export class ClaudeCodeDesktopConnector implements Connector {
  readonly id = CLAUDE_CODE_DESKTOP_CONNECTOR_ID;
  readonly displayName = 'Claude Code Desktop';
  readonly provider = 'anthropic' as const;
  readonly surface = 'desktop' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly sessionsDir: string;
  private readonly appPath: string;
  private readonly settingsPath: string | undefined;
  private readonly hookPort: number;
  private readonly historyWindowMs: number;
  private readonly checkHooks: boolean;
  private readonly source: Source;
  /** sessionId -> file stamp already ingested during this daemon lifetime. */
  private readonly lastSeenFile = new Map<string, string>();

  constructor(options: ClaudeCodeDesktopConnectorOptions) {
    this.engine = options.engine;
    this.sessionsDir = options.sessionsDir ?? claudeDesktopSessionsDir();
    this.appPath = options.appPath ?? '/Applications/Claude.app';
    this.settingsPath = options.settingsPath;
    this.hookPort = options.hookPort ?? DEFAULT_DAEMON_CONFIG.port;
    this.scanIntervalMs = options.scanIntervalMs ?? 15_000;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.checkHooks = options.checkHooks ?? true;
    this.source = {
      id: CLAUDE_CODE_DESKTOP_CONNECTOR_ID,
      provider: 'anthropic',
      surface: 'desktop',
      device: options.device ?? hostname(),
    };
  }

  scan(ctx: ConnectorContext): ConnectorScanResult {
    if (!existsSync(this.appPath)) {
      throw new ConnectorUnsupportedError(
        'Claude Code Desktop is not installed — nothing to watch',
      );
    }

    const warnings = this.hookWarnings();
    let files: ClaudeDesktopSessionFile[];
    try {
      files = listClaudeDesktopSessionFiles(this.sessionsDir);
    } catch (error) {
      if (error instanceof ClaudeDesktopSessionsDirMissingError) {
        return {
          observedSessionCount: 0,
          archivedSessionCount: 0,
          permissionState: 'unknown',
          warnings: [
            ...warnings,
            `${error.message}; the Code tab may not have created a local session yet`,
          ],
        };
      }
      throw error;
    }

    const now = Date.now();
    const cutoff = now - this.historyWindowMs;
    const alreadyIndexed = ctx.store.externalIdsForSource(this.id);
    let observed = 0;
    let archived = 0;
    let missingJoinKey = 0;

    for (const file of files) {
      if (ctx.signal.aborted) break;

      let session: ClaudeDesktopSession;
      try {
        session = readClaudeDesktopSession(file);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
        continue;
      }

      const activityAt = session.lastActivityAt ?? session.createdAt ?? file.modifiedAt;
      const inTriage = session.isArchived !== true && activityAt >= cutoff;
      if (inTriage) observed += 1;
      else archived += 1;
      if (!inTriage && alreadyIndexed.has(session.sessionId)) continue;

      if (!session.cliSessionId) missingJoinKey += 1;

      const stamp = `${file.modifiedAt}:${file.sizeBytes}:${activityAt}`;
      if (this.lastSeenFile.get(session.sessionId) === stamp) continue;
      this.lastSeenFile.set(session.sessionId, stamp);
      this.ingestSession(session, file, activityAt);
      alreadyIndexed.add(session.sessionId);
    }

    if (missingJoinKey > 0) {
      warnings.push(
        `${missingJoinKey} Desktop session(s) have no cliSessionId; they are visible but may not deduplicate with CLI transcripts`,
      );
    }

    return {
      observedSessionCount: observed,
      archivedSessionCount: archived,
      permissionState: 'granted',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private ingestSession(
    session: ClaudeDesktopSession,
    file: ClaudeDesktopSessionFile,
    activityAt: number,
  ): void {
    const canonicalId = session.cliSessionId ?? session.sessionId;
    const cwd = session.cwd ?? session.originCwd;
    const repo = repoNameFromCwd(cwd);
    const fallbackTitle = fallbackLabel(repo, canonicalId);
    const title = deriveTitle(session.title, { fallback: '' });
    const observations: StoredObservation[] = [
      {
        signal: 'claude_code.desktop_metadata_write',
        at: activityAt,
        raw: {
          metadataFile: basename(file.path),
          ...(session.completedTurns !== undefined
            ? { completedTurns: session.completedTurns }
            : {}),
          ...(session.model ? { model: session.model } : {}),
          ...(session.effort ? { effort: session.effort } : {}),
          ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
        },
        connectorId: this.id,
        surface: 'desktop',
      },
    ];

    this.engine.observe({
      identity: canonicalKey('anthropic', canonicalId),
      provider: 'anthropic',
      surface: 'desktop',
      title,
      titlePriority: session.title ? 30 : 0,
      fallbackTitle,
      source: this.source,
      externalId: session.sessionId,
      context: {
        ...(cwd ? { cwd } : {}),
        ...(repo ? { repo } : {}),
      },
      locateHint: `Claude Desktop → Code → ${title || fallbackTitle}`,
      sourceArchived: session.isArchived === true,
      observations,
      connectorId: this.id,
    });
  }

  private hookWarnings(): string[] {
    if (!this.checkHooks) return [];
    try {
      const plan =
        this.settingsPath === undefined
          ? planClaudeHooks(this.hookPort)
          : planClaudeHooks(this.hookPort, this.settingsPath);
      const missing = plan.entries
        .filter((entry) => entry.action === 'add')
        .map((entry) => entry.event);
      if (missing.length === 0) return [];
      return [
        `shared Claude hooks are missing ${missing.join(', ')}; Desktop inventory is visible, but live running/blocked/done state is incomplete`,
      ];
    } catch (error) {
      return [
        `could not verify shared Claude hooks: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  }
}
