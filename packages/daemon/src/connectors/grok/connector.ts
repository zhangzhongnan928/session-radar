import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { Source } from '@session-radar/shared';
import {
  DEFAULT_DAEMON_CONFIG,
  DEFAULT_HISTORY_WINDOW_MS,
  canonicalKey,
  deriveTitle,
  fallbackLabel,
} from '@session-radar/shared';
import type { StatusEngine } from '../../engine.js';
import type {
  Connector,
  ConnectorContext,
  ConnectorScanResult,
} from '../../registry.js';
import { ConnectorUnsupportedError } from '../../registry.js';
import type { StoredObservation } from '../../store.js';
import { planGrokHooks } from '../../install/grok-hooks.js';
import { shellQuote } from '../claude-code/connector.js';
import {
  grokHome,
  listGrokSummaries,
  readGrokActiveSessions,
  readGrokSummary,
  readGrokVersion,
} from './summary.js';

export const GROK_CONNECTOR_ID = 'grok-build-cli';

export interface GrokBuildConnectorOptions {
  engine: StatusEngine;
  home?: string;
  binaryPath?: string;
  device?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  hookPort?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** Metadata inventory plus documented HTTP-hook lifecycle for Grok Build. */
export class GrokBuildConnector implements Connector {
  readonly id = GROK_CONNECTOR_ID;
  readonly displayName = 'Grok Build';
  readonly provider = 'xai' as const;
  readonly surface = 'cli' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly home: string;
  private readonly binaryPath: string;
  private readonly device: string;
  private readonly historyWindowMs: number;
  private readonly hookPort: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly fingerprints = new Map<string, string>();
  private readonly previousActiveIds = new Set<string>();
  private readonly reportedDead = new Set<string>();

  constructor(options: GrokBuildConnectorOptions) {
    this.engine = options.engine;
    this.home = options.home ?? grokHome();
    this.binaryPath = options.binaryPath ?? defaultGrokBinary();
    this.device = options.device ?? hostname();
    this.scanIntervalMs = options.scanIntervalMs ?? 15_000;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.hookPort = options.hookPort ?? daemonPort();
    this.isPidAlive = options.isPidAlive ?? pidIsAlive;
  }

  scan(ctx: ConnectorContext): ConnectorScanResult {
    if (!existsSync(this.home) && !existsSync(this.binaryPath)) {
      throw new ConnectorUnsupportedError(
        `Grok Build is not installed (looked for ${this.home} and ${this.binaryPath})`,
      );
    }

    const warnings: string[] = [];
    const files = listGrokSummaries(this.home);
    const now = Date.now();
    const cutoff = now - this.historyWindowMs;
    const alreadyIndexed = ctx.store.externalIdsForProvider('xai');
    const version = readGrokVersion(this.home);

    let activeSessions: ReturnType<typeof readGrokActiveSessions> = [];
    try {
      activeSessions = readGrokActiveSessions(this.home);
    } catch (error) {
      warnings.push(`could not read Grok Build active session registry: ${describe(error)}`);
    }
    const activeById = new Map(activeSessions.map((entry) => [entry.sessionId, entry]));
    const currentActiveIds = new Set(activeById.keys());

    let observed = 0;
    let archived = 0;
    for (const file of files) {
      if (ctx.signal.aborted) break;
      let summary;
      try {
        summary = readGrokSummary(file);
      } catch (error) {
        warnings.push(`could not read Grok Build session ${file.sessionId}: ${describe(error)}`);
        continue;
      }

      const sourceActivityAt = summary.lastActiveAt ?? summary.updatedAt;
      const inWindow = sourceActivityAt >= cutoff;
      if (inWindow) observed += 1;
      else archived += 1;

      const active = activeById.get(summary.sessionId);
      const wasActive = this.previousActiveIds.has(summary.sessionId);
      if (!inWindow && !alreadyIndexed.has(summary.sessionId) && !active) {
        // Old entries still get one incremental backfill below.
      } else if (!inWindow && alreadyIndexed.has(summary.sessionId) && !active && !wasActive) {
        continue;
      }

      const fingerprint = [
        summary.updatedAt,
        summary.lastActiveAt ?? '',
        file.sizeBytes,
        file.modifiedAt,
      ].join(':');
      const observations: StoredObservation[] = [];
      if (this.fingerprints.get(summary.sessionId) !== fingerprint) {
        this.fingerprints.set(summary.sessionId, fingerprint);
        observations.push({
          signal: 'grok.inventory_seen',
          at: sourceActivityAt,
          raw: {
            ...(summary.modelId ? { model: summary.modelId } : {}),
            ...(summary.sessionKind ? { sessionKind: summary.sessionKind } : {}),
            ...(summary.hidden ? { hidden: true } : {}),
            ...(summary.numMessages !== undefined
              ? { messageCount: summary.numMessages }
              : {}),
            ...(summary.numChatMessages !== undefined
              ? { chatMessageCount: summary.numChatMessages }
              : {}),
          },
          connectorId: this.id,
          surface: this.surface,
        });
      }

      if (active) {
        if (this.isPidAlive(active.pid)) {
          this.reportedDead.delete(summary.sessionId);
          observations.push({
            signal: 'grok.process_alive',
            at: now,
            raw: { pid: active.pid },
            connectorId: this.id,
            surface: this.surface,
          });
        } else if (!this.reportedDead.has(summary.sessionId)) {
          this.reportedDead.add(summary.sessionId);
          observations.push({
            signal: 'grok.process_dead',
            at: now,
            raw: { pid: active.pid, reason: 'registered Grok Build process is not alive' },
            connectorId: this.id,
            surface: this.surface,
          });
        }
      } else if (wasActive && !this.reportedDead.has(summary.sessionId)) {
        this.reportedDead.add(summary.sessionId);
        observations.push({
          signal: 'grok.process_dead',
          at: now,
          raw: { reason: 'session disappeared from Grok Build active registry' },
          connectorId: this.id,
          surface: this.surface,
        });
      }

      this.observe(summary, observations, sourceActivityAt, version);
      alreadyIndexed.add(summary.sessionId);
    }

    this.previousActiveIds.clear();
    for (const id of currentActiveIds) this.previousActiveIds.add(id);

    const hookPlan = planGrokHooks(this.hookPort, undefined, this.home);
    if (hookPlan.kind !== 'already-installed') {
      warnings.push(
        hookPlan.kind === 'manual'
          ? `Grok Build lifecycle hooks require manual attention: ${hookPlan.reason ?? 'configuration is not safely editable'}`
          : 'Grok Build metadata inventory is available, but live lifecycle hooks are missing or outdated — run `pnpm radar install-hooks --apply`, then restart or reload Grok Build sessions',
      );
    }

    return {
      observedSessionCount: observed,
      archivedSessionCount: archived,
      permissionState: 'granted',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private observe(
    summary: ReturnType<typeof readGrokSummary>,
    observations: StoredObservation[],
    sourceActivityAt: number,
    version: string | undefined,
  ): void {
    const cwd = summary.cwd;
    const repo = cwd?.split('/').filter(Boolean).at(-1);
    const candidate = summary.generatedTitle ?? summary.sessionSummary ?? '';
    const title = deriveTitle(candidate, { fallback: '' });
    const source: Source = {
      id: this.id,
      provider: 'xai',
      surface: this.surface,
      device: this.device,
      ...(version ? { version } : {}),
    };

    this.engine.observe({
      identity: canonicalKey('xai', summary.sessionId),
      provider: 'xai',
      surface: this.surface,
      title,
      titlePriority: summary.generatedTitle ? 30 : summary.sessionSummary ? 20 : 0,
      fallbackTitle: fallbackLabel(repo, summary.sessionId),
      source,
      externalId: summary.sessionId,
      context: {
        ...(cwd ? { cwd } : {}),
        ...(repo ? { repo } : {}),
      },
      resumeCommand: grokResumeCommand(summary.sessionId, cwd, this.binaryPath),
      observations,
      sourceActivityAt,
      connectorId: this.id,
    });
  }
}

/** Verified Grok Build syntax: `grok --resume <SESSION_ID>`. */
export function grokResumeCommand(
  sessionId: string,
  cwd: string | undefined,
  binaryPath = defaultGrokBinary(),
): string {
  const binary = binaryPath.includes('/') ? shellQuote(binaryPath) : binaryPath;
  const resume = `${binary} --resume ${shellQuote(sessionId)}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

export function defaultGrokBinary(): string {
  const configured = process.env['SESSION_RADAR_GROK_BINARY'];
  if (configured) return configured;
  const local = join(homedir(), '.local', 'bin', 'grok');
  return existsSync(local) ? local : 'grok';
}

function daemonPort(): number {
  const parsed = Number.parseInt(process.env['SESSION_RADAR_PORT'] ?? '', 10);
  return Number.isNaN(parsed) ? DEFAULT_DAEMON_CONFIG.port : parsed;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
