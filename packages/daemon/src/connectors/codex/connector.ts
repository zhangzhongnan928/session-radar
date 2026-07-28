import { hostname } from 'node:os';
import type { Source } from '@session-radar/shared';
import { canonicalKey, fallbackLabel } from '@session-radar/shared';
import type { StatusEngine } from '../../engine.js';
import type { Connector, ConnectorContext, ConnectorScanResult } from '../../registry.js';
import type { StoredObservation } from '../../store.js';
import { CODEX_PROCESS_PATTERN, livenessByCwd } from '../process.js';
import { DEFAULT_HISTORY_WINDOW_MS, shellQuote } from '../claude-code/connector.js';
import type { RolloutFile } from './rollout.js';
import {
  RolloutDirMissingError,
  codexSessionsDir,
  listRollouts,
  readRolloutMeta,
  titleForRollout,
} from './rollout.js';

export const CODEX_CONNECTOR_ID = 'codex-cli';

const ACTIVE_WINDOW_MS = 6 * 60 * 60_000;

export interface CodexConnectorOptions {
  engine: StatusEngine;
  sessionsDir?: string;
  device?: string;
  scanIntervalMs?: number;
  probeProcesses?: boolean;
  historyWindowMs?: number;
}

/** Codex CLI collector. Mirrors the Claude Code connector's two-path design. */
export class CodexConnector implements Connector {
  readonly id = CODEX_CONNECTOR_ID;
  readonly displayName = 'Codex CLI';
  readonly provider = 'openai' as const;
  readonly surface = 'cli' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly sessionsDir: string;
  private readonly source: Source;
  private readonly probeProcesses: boolean;
  private readonly historyWindowMs: number;
  private readonly lastSeenSize = new Map<string, number>();
  private readonly reportedDead = new Set<string>();

  constructor(options: CodexConnectorOptions) {
    this.engine = options.engine;
    this.sessionsDir = options.sessionsDir ?? codexSessionsDir();
    this.scanIntervalMs = options.scanIntervalMs ?? 15_000;
    this.probeProcesses = options.probeProcesses ?? true;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.source = {
      id: CODEX_CONNECTOR_ID,
      provider: 'openai',
      surface: 'cli',
      device: options.device ?? hostname(),
    };
  }

  async scan(ctx: ConnectorContext): Promise<ConnectorScanResult> {
    // A missing sessions directory is a coverage incident, not an empty result.
    const rollouts: RolloutFile[] = listRollouts(this.sessionsDir);
    const warnings: string[] = [];
    const now = Date.now();

    let liveCwds = new Set<string>();
    if (this.probeProcesses) {
      try {
        const liveness = await livenessByCwd(CODEX_PROCESS_PATTERN);
        liveCwds = liveness.cwds;
        if (liveness.cwdResolutionDegraded) {
          warnings.push(
            `found ${liveness.count} codex process(es) but could not resolve any working directory — liveness is degraded`,
          );
        }
      } catch (error) {
        warnings.push(
          `process liveness unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Sessions older than the history window are counted but not ingested.
    // Codex keeps years of rollouts; parsing them all would make a scan take
    // longer than the scan interval.
    const cutoff = now - this.historyWindowMs;
    const inWindow = rollouts.filter((file) => file.modifiedAt >= cutoff);
    const archived = rollouts.length - inWindow.length;

    for (const file of inWindow) {
      if (ctx.signal.aborted) break;
      try {
        await this.ingestRollout(file, liveCwds, now);
      } catch (error) {
        warnings.push(
          `could not read ${file.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      observedSessionCount: inWindow.length,
      archivedSessionCount: archived,
      permissionState: 'granted',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private async ingestRollout(
    file: RolloutFile,
    liveCwds: Set<string>,
    now: number,
  ): Promise<void> {
    const previousSize = this.lastSeenSize.get(file.sessionId);
    const firstSight = previousSize === undefined;
    const grew = previousSize !== undefined && file.sizeBytes > previousSize;
    const isActive = now - file.modifiedAt < ACTIVE_WINDOW_MS;

    if (!firstSight && !grew) return;
    this.lastSeenSize.set(file.sessionId, file.sizeBytes);

    const meta = await readRolloutMeta(file);
    const cwd = meta.cwd;
    const repo = cwd?.split('/').filter(Boolean).at(-1);
    const observations: StoredObservation[] = [
      {
        signal: 'codex.rollout_write',
        at: file.modifiedAt,
        raw: { sizeBytes: file.sizeBytes },
        connectorId: this.id,
      },
    ];

    if (this.probeProcesses && cwd) {
      if (liveCwds.has(cwd)) {
        this.reportedDead.delete(file.sessionId);
        observations.push({
          signal: 'codex.process_alive',
          at: now,
          raw: { cwd },
          connectorId: this.id,
        });
      } else if (isActive && !this.reportedDead.has(file.sessionId)) {
        this.reportedDead.add(file.sessionId);
        observations.push({
          signal: 'codex.process_dead',
          at: now,
          raw: { cwd },
          connectorId: this.id,
        });
      }
    }

    this.engine.observe({
      identity: canonicalKey('openai', file.sessionId),
      provider: 'openai',
      surface: 'cli',
      title: titleForRollout(meta, fallbackLabel(repo, file.sessionId)),
      source: { ...this.source, ...(meta.cliVersion ? { version: meta.cliVersion } : {}) },
      externalId: file.sessionId,
      context: {
        ...(cwd ? { cwd } : {}),
        ...(repo ? { repo } : {}),
      },
      resumeCommand: codexResumeCommand(file.sessionId, cwd),
      observations,
      connectorId: this.id,
    });
  }
}

/** Verified syntax: `codex resume <SESSION_ID>` (codex-cli 0.144.1). */
export function codexResumeCommand(sessionId: string, cwd: string | undefined): string {
  const resume = `codex resume ${sessionId}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

export { RolloutDirMissingError };
