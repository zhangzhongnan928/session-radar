import { hostname } from 'node:os';
import type { Source } from '@session-radar/shared';
import {
  DEFAULT_HISTORY_WINDOW_MS,
  canonicalKey,
  fallbackLabel,
} from '@session-radar/shared';
import type { StatusEngine } from '../../engine.js';
import type { Connector, ConnectorContext, ConnectorScanResult } from '../../registry.js';
import type { StoredObservation } from '../../store.js';
import { CLAUDE_PROCESS_PATTERN, livenessByCwd } from '../process.js';
import type { TranscriptFile } from './transcript.js';
import {
  TranscriptDirMissingError,
  claudeProjectsDir,
  listTranscripts,
  readTranscriptMeta,
  repoNameFromCwd,
  titleFor,
} from './transcript.js';

export const CLAUDE_CODE_CONNECTOR_ID = 'claude-code-cli';

/**
 * Transcripts older than this are not re-read on every scan.
 */
const ACTIVE_WINDOW_MS = 6 * 60 * 60_000;

export interface ClaudeCodeConnectorOptions {
  engine: StatusEngine;
  projectsDir?: string;
  device?: string;
  scanIntervalMs?: number;
  /** Disable `ps`/`lsof` probing (tests). */
  probeProcesses?: boolean;
  historyWindowMs?: number;
}

/**
 * Claude Code CLI collector.
 *
 * Two independent signal paths, on purpose:
 *  - hooks POST to the daemon (fast, explicit, high confidence)
 *  - this poller reads transcripts and the process table (slower, observed)
 *
 * The poller is what makes coverage honest when hooks are not installed, or when
 * a session started before the daemon did. If hooks are missing entirely, we
 * still see every session — just with lower-confidence evidence.
 */
export class ClaudeCodeConnector implements Connector {
  readonly id = CLAUDE_CODE_CONNECTOR_ID;
  readonly displayName = 'Claude Code CLI';
  readonly provider = 'anthropic' as const;
  readonly surface = 'cli' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly projectsDir: string;
  private readonly source: Source;
  private readonly probeProcesses: boolean;
  private readonly historyWindowMs: number;
  /** sessionId -> last transcript size we turned into an activity signal. */
  private readonly lastSeenSize = new Map<string, number>();
  /** sessionIds we have already reported as dead, so we report once. */
  private readonly reportedDead = new Set<string>();

  constructor(options: ClaudeCodeConnectorOptions) {
    this.engine = options.engine;
    this.projectsDir = options.projectsDir ?? claudeProjectsDir();
    this.scanIntervalMs = options.scanIntervalMs ?? 15_000;
    this.probeProcesses = options.probeProcesses ?? true;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.source = {
      id: CLAUDE_CODE_CONNECTOR_ID,
      provider: 'anthropic',
      surface: 'cli',
      device: options.device ?? hostname(),
    };
  }

  async scan(ctx: ConnectorContext): Promise<ConnectorScanResult> {
    let transcripts: TranscriptFile[];
    try {
      transcripts = listTranscripts(this.projectsDir);
    } catch (error) {
      if (error instanceof TranscriptDirMissingError) {
        // Rethrow so the registry marks this connector down with the real reason.
        // Returning zero sessions here would be the exact silent-miss this
        // product exists to prevent.
        throw error;
      }
      throw error;
    }

    const warnings: string[] = [];
    const now = Date.now();

    let liveCwds = new Set<string>();
    if (this.probeProcesses) {
      try {
        const liveness = await livenessByCwd(CLAUDE_PROCESS_PATTERN);
        liveCwds = liveness.cwds;
        if (liveness.cwdResolutionDegraded) {
          warnings.push(
            `found ${liveness.count} claude process(es) but could not resolve any working directory (lsof blocked?) — liveness is degraded`,
          );
        }
      } catch (error) {
        warnings.push(
          `process liveness unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const cutoff = now - this.historyWindowMs;
    const alreadyIndexed = ctx.store.externalIdsForSource(this.id);
    let observed = 0;
    let archived = 0;

    for (const file of transcripts) {
      if (ctx.signal.aborted) break;
      const inWindow = file.modifiedAt >= cutoff;
      if (inWindow) observed += 1;
      else archived += 1;

      // Archive discovery is incremental: ingest a missing old transcript once,
      // then leave it in SQLite and keep recurring scans fast.
      if (!inWindow && alreadyIndexed.has(file.sessionId)) continue;
      try {
        await this.ingestTranscript(file, liveCwds, now);
        alreadyIndexed.add(file.sessionId);
      } catch (error) {
        // One malformed transcript degrades coverage; it does not stop the scan.
        warnings.push(
          `could not read ${file.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      observedSessionCount: observed,
      archivedSessionCount: archived,
      permissionState: 'granted',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private async ingestTranscript(
    file: TranscriptFile,
    liveCwds: Set<string>,
    now: number,
  ): Promise<void> {
    const isActive = now - file.modifiedAt < ACTIVE_WINDOW_MS;
    const previousSize = this.lastSeenSize.get(file.sessionId);
    const grew = previousSize !== undefined && file.sizeBytes > previousSize;
    const firstSight = previousSize === undefined;

    // Nothing changed and we already know about it: skip the expensive parse.
    if (!firstSight && !grew && !isActive) return;

    this.lastSeenSize.set(file.sessionId, file.sizeBytes);

    const meta = await readTranscriptMeta(file);
    const cwd = meta.cwd;
    const repo = repoNameFromCwd(cwd);
    const identity = canonicalKey('anthropic', file.sessionId);
    const observations: StoredObservation[] = [];

    if (grew || firstSight) {
      observations.push({
        signal: 'claude_code.transcript_write',
        at: file.modifiedAt,
        raw: { sizeBytes: file.sizeBytes, projectSlug: file.projectSlug },
        connectorId: this.id,
      });
    }

    // Liveness qualifies; it never counts as progress. A `claude` process in this
    // cwd means the session *could* still be alive — not that it did anything.
    if (this.probeProcesses && cwd) {
      if (liveCwds.has(cwd)) {
        this.reportedDead.delete(file.sessionId);
        observations.push({
          signal: 'claude_code.process_alive',
          at: now,
          raw: { cwd },
          connectorId: this.id,
        });
      } else if (isActive && !this.reportedDead.has(file.sessionId)) {
        // Only claim death for sessions recent enough that a process should
        // still exist. Ancient transcripts are stale by time, not by death.
        this.reportedDead.add(file.sessionId);
        observations.push({
          signal: 'claude_code.process_dead',
          at: now,
          raw: { cwd },
          connectorId: this.id,
        });
      }
    }

    if (observations.length === 0) return;

    this.engine.observe({
      identity,
      provider: 'anthropic',
      surface: 'cli',
      title: titleFor(meta, ''),
      titlePriority: meta.customTitle ? 30 : meta.firstUserMessage ? 20 : 0,
      fallbackTitle: fallbackLabel(repo, file.sessionId),
      source: { ...this.source, ...(meta.version ? { version: meta.version } : {}) },
      externalId: file.sessionId,
      context: {
        ...(cwd ? { cwd } : {}),
        ...(repo ? { repo } : {}),
      },
      resumeCommand: resumeCommand(file.sessionId, cwd),
      observations,
      connectorId: this.id,
    });
  }
}

/**
 * The command that gets Victor back into this session.
 * `--resume <id>` only lands in the right project when run from the session's
 * cwd, so the cd is part of the copyable command rather than a footnote.
 */
export function resumeCommand(sessionId: string, cwd: string | undefined): string {
  const resume = `claude --resume ${sessionId}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

/** Single-quote for POSIX shells. Paths here routinely contain spaces. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
