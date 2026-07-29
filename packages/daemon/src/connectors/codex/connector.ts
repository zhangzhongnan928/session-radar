import { hostname } from 'node:os';
import type { Source, Surface } from '@session-radar/shared';
import {
  DEFAULT_HISTORY_WINDOW_MS,
  canonicalKey,
  fallbackLabel,
} from '@session-radar/shared';
import type { StatusEngine } from '../../engine.js';
import type { Connector, ConnectorContext, ConnectorScanResult } from '../../registry.js';
import type { StoredObservation } from '../../store.js';
import { CODEX_PROCESS_PATTERN, livenessByCwd } from '../process.js';
import { shellQuote } from '../claude-code/connector.js';
import type { RolloutFile } from './rollout.js';
import {
  RolloutDirMissingError,
  codexSessionsDir,
  listRollouts,
  readRolloutMeta,
  readRolloutTaskState,
  titleForRollout,
} from './rollout.js';

export const CODEX_CONNECTOR_ID = 'codex-cli';
export const CODEX_DESKTOP_SOURCE_ID = 'codex-desktop';
export const CODEX_CHROME_SOURCE_ID = 'codex-chrome-sidepanel';
export const CODEX_BUZZ_SOURCE_ID = 'codex-buzz';

const ACTIVE_WINDOW_MS = 6 * 60 * 60_000;

export interface CodexOriginProfile {
  sourceId: string;
  surface: Surface;
  locatePrefix: string | undefined;
  known: boolean;
}

/**
 * `session_meta.originator` is written by every current Codex client.
 *
 * Keep this mapping explicit: treating every rollout as CLI was the reason
 * hundreds of real Codex Desktop tasks were mislabelled and process-probed
 * against a CLI that never existed.
 */
export function classifyCodexOriginator(originator: string | undefined): CodexOriginProfile {
  if (originator === 'Codex Desktop') {
    return {
      sourceId: CODEX_DESKTOP_SOURCE_ID,
      surface: 'desktop',
      locatePrefix: 'Codex Desktop → Tasks',
      known: true,
    };
  }
  if (originator === 'codex-chrome-extension-sidepanel') {
    return {
      sourceId: CODEX_CHROME_SOURCE_ID,
      surface: 'extension',
      locatePrefix: 'Chrome → Codex side panel',
      known: true,
    };
  }
  if (originator === 'buzz-acp') {
    return {
      sourceId: CODEX_BUZZ_SOURCE_ID,
      surface: 'desktop',
      locatePrefix: 'Buzz → Codex task',
      known: true,
    };
  }
  if (
    originator === undefined ||
    originator === 'codex_cli_rs' ||
    originator === 'codex_exec'
  ) {
    return {
      sourceId: CODEX_CONNECTOR_ID,
      surface: 'cli',
      locatePrefix: undefined,
      known: true,
    };
  }
  return {
    sourceId: `codex-origin-${slug(originator)}`,
    surface: 'desktop',
    locatePrefix: `Codex client "${originator}"`,
    known: false,
  };
}

export interface CodexConnectorOptions {
  engine: StatusEngine;
  sessionsDir?: string;
  device?: string;
  scanIntervalMs?: number;
  probeProcesses?: boolean;
  historyWindowMs?: number;
}

/** Polls the rollout format shared by Codex Desktop, CLI and integrations. */
export class CodexConnector implements Connector {
  readonly id = CODEX_CONNECTOR_ID;
  readonly displayName = 'Codex sessions';
  readonly provider = 'openai' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly sessionsDir: string;
  private readonly device: string;
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
    this.device = options.device ?? hostname();
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

    // Keep the seven-day triage count, but incrementally backfill any old
    // rollout that is not represented in SQLite yet. Subsequent scans skip its
    // metadata entirely, so a long archive does not become recurring work.
    const cutoff = now - this.historyWindowMs;
    const alreadyIndexed = ctx.store.externalIdsForProvider('openai');
    let observed = 0;
    let archived = 0;

    for (const file of rollouts) {
      if (ctx.signal.aborted) break;
      const inWindow = file.modifiedAt >= cutoff;
      if (inWindow) observed += 1;
      else archived += 1;
      if (!inWindow && alreadyIndexed.has(file.sessionId)) continue;
      try {
        const unknownOriginator = await this.ingestRollout(file, liveCwds, now);
        alreadyIndexed.add(file.sessionId);
        if (unknownOriginator) {
          warnings.push(
            `unrecognised Codex originator "${unknownOriginator}" — shown as a generic desktop client`,
          );
        }
      } catch (error) {
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

  private async ingestRollout(
    file: RolloutFile,
    liveCwds: Set<string>,
    now: number,
  ): Promise<string | undefined> {
    const previousSize = this.lastSeenSize.get(file.sessionId);
    const firstSight = previousSize === undefined;
    const grew = previousSize !== undefined && file.sizeBytes > previousSize;
    const isActive = now - file.modifiedAt < ACTIVE_WINDOW_MS;

    if (!firstSight && !grew) return undefined;
    this.lastSeenSize.set(file.sessionId, file.sizeBytes);

    const meta = await readRolloutMeta(file);
    const taskState = await readRolloutTaskState(file);
    const origin = classifyCodexOriginator(meta.originator);
    const cwd = meta.cwd;
    const repo = cwd?.split('/').filter(Boolean).at(-1);
    const fallbackTitle = fallbackLabel(repo, file.sessionId);
    const title = titleForRollout(meta, '');
    const source: Source = {
      id: origin.sourceId,
      provider: 'openai',
      surface: origin.surface,
      device: this.device,
      ...(meta.cliVersion ? { version: meta.cliVersion } : {}),
    };
    const observations: StoredObservation[] = [
      {
        signal: 'codex.rollout_write',
        at: file.modifiedAt,
        raw: {
          sizeBytes: file.sizeBytes,
          ...(meta.originator ? { originator: meta.originator } : {}),
        },
        connectorId: this.id,
        surface: origin.surface,
      },
    ];

    if (taskState) {
      const signal =
        taskState.event === 'task_started'
          ? 'codex.task_started'
          : taskState.event === 'task_complete'
            ? 'codex.task_complete'
            : 'codex.turn_aborted';
      observations.push({
        signal,
        // Terminal events are the state of the completed file write. Matching
        // the mtime makes the explicit event win a same-scan rollout_write tie.
        at:
          taskState.event === 'task_started'
            ? taskState.at
            : Math.max(taskState.at, file.modifiedAt),
        raw: {
          event: taskState.event,
          ...(taskState.turnId ? { turnId: taskState.turnId } : {}),
        },
        connectorId: this.id,
        surface: origin.surface,
      });
    }

    // A Desktop/Chrome/Buzz rollout has no matching `codex` CLI process.
    // Probing it as CLI used to manufacture process-dead evidence.
    if (origin.surface === 'cli' && this.probeProcesses && cwd) {
      if (liveCwds.has(cwd)) {
        this.reportedDead.delete(file.sessionId);
        observations.push({
          signal: 'codex.process_alive',
          at: now,
          raw: { cwd },
          connectorId: this.id,
          surface: origin.surface,
        });
      } else if (isActive && !this.reportedDead.has(file.sessionId)) {
        this.reportedDead.add(file.sessionId);
        observations.push({
          signal: 'codex.process_dead',
          at: now,
          raw: { cwd },
          connectorId: this.id,
          surface: origin.surface,
        });
      }
    }

    this.engine.observe({
      identity: canonicalKey('openai', file.sessionId),
      provider: 'openai',
      surface: origin.surface,
      title,
      titlePriority: meta.firstUserMessage ? 20 : 0,
      fallbackTitle,
      source,
      externalId: file.sessionId,
      context: {
        ...(cwd ? { cwd } : {}),
        ...(repo ? { repo } : {}),
      },
      ...(origin.locatePrefix
        ? {
            locateHint: `${origin.locatePrefix} → ${title || fallbackTitle} (${file.sessionId.slice(-8)})`,
            replacesSourceIds: [CODEX_CONNECTOR_ID],
          }
        : { resumeCommand: codexResumeCommand(file.sessionId, cwd) }),
      observations,
      connectorId: this.id,
    });
    return origin.known ? undefined : meta.originator;
  }
}

/** Verified syntax: `codex resume <SESSION_ID>` (codex-cli 0.144.1). */
export function codexResumeCommand(sessionId: string, cwd: string | undefined): string {
  const resume = `codex resume ${sessionId}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'unknown';
}

export { RolloutDirMissingError };
