import { existsSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, extname, join } from 'node:path';
import {
  DEFAULT_HISTORY_WINDOW_MS,
  canonicalKey,
  fallbackLabel,
} from '@session-radar/shared';
import type {
  Provider,
  SignalName,
  Source,
} from '@session-radar/shared';
import type { StatusEngine } from '../../engine.js';
import type {
  Connector,
  ConnectorContext,
  ConnectorScanResult,
} from '../../registry.js';
import { ConnectorUnsupportedError } from '../../registry.js';

const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface OpaqueSessionFile {
  externalId: string;
  modifiedAt: number;
  sizeBytes: number;
}

export interface OpaqueSessionFilesConnectorOptions {
  engine: StatusEngine;
  id: string;
  displayName: string;
  provider: Provider;
  appPath: string;
  sessionDir: string;
  productLabel: string;
  locatePrefix: string;
  inventorySignal:
    | 'windsurf.cascade_inventory_seen'
    | 'antigravity.conversation_inventory_seen';
  fileExtension?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  device?: string;
  now?: () => number;
}

/**
 * Enumerate a directory of UUID-named session files without opening them.
 *
 * Windsurf and Antigravity currently keep conversation bodies in protobuf
 * files. Until a separately verified metadata index or schema exists, filename,
 * size and mtime are the entire trust boundary. This still prevents forgotten
 * sessions from being invisible while making the missing title/lifecycle
 * coverage impossible to mistake for completeness.
 */
export class OpaqueSessionFilesConnector implements Connector {
  readonly id: string;
  readonly displayName: string;
  readonly provider: Provider;
  readonly surface = 'desktop' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly appPath: string;
  private readonly sessionDir: string;
  private readonly productLabel: string;
  private readonly locatePrefix: string;
  private readonly inventorySignal: SignalName;
  private readonly fileExtension: string;
  private readonly historyWindowMs: number;
  private readonly now: () => number;
  private readonly source: Source;
  private readonly lastSeen = new Map<string, string>();

  constructor(options: OpaqueSessionFilesConnectorOptions) {
    this.engine = options.engine;
    this.id = options.id;
    this.displayName = options.displayName;
    this.provider = options.provider;
    this.appPath = options.appPath;
    this.sessionDir = options.sessionDir;
    this.productLabel = options.productLabel;
    this.locatePrefix = options.locatePrefix;
    this.inventorySignal = options.inventorySignal;
    this.fileExtension = options.fileExtension ?? '.pb';
    this.scanIntervalMs = options.scanIntervalMs ?? 30_000;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.source = {
      id: this.id,
      provider: this.provider,
      surface: 'desktop',
      device: options.device ?? hostname(),
    };
  }

  scan(ctx: ConnectorContext): ConnectorScanResult {
    const appExists = existsSync(this.appPath);
    if (!existsSync(this.sessionDir)) {
      if (!appExists) {
        throw new ConnectorUnsupportedError(
          `${this.displayName}: neither the application nor its session directory is present`,
        );
      }
      return {
        observedSessionCount: 0,
        archivedSessionCount: 0,
        permissionState: 'unknown',
        warnings: [`session directory not found: ${this.sessionDir}`],
      };
    }

    const warnings: string[] = [
      `${this.productLabel} conversation bodies are deliberately not read; source titles and live lifecycle are unavailable, so these rows remain status unknown`,
    ];
    if (!appExists) {
      warnings.push(
        `the default application path is absent (${this.appPath}); retained session inventory is indexed, but the return path may require reinstalling or locating the app`,
      );
    }

    const listed = listOpaqueSessionFiles(this.sessionDir, this.fileExtension);
    warnings.push(...listed.warnings);

    const now = this.now();
    const cutoff = now - this.historyWindowMs;
    const alreadyIndexed = ctx.store.externalIdsForSource(this.id);
    let observed = 0;
    let archived = 0;

    for (const file of listed.files) {
      if (ctx.signal.aborted) break;
      const activityAt = Math.min(file.modifiedAt, now);
      if (file.modifiedAt > now) {
        warnings.push(
          `${file.externalId} has a future modification timestamp; recency was clamped to scan time`,
        );
      }
      const inTriage = activityAt >= cutoff;
      if (inTriage) observed += 1;
      else archived += 1;
      if (!inTriage && alreadyIndexed.has(file.externalId)) continue;

      const stamp = `${activityAt}:${file.sizeBytes}`;
      if (this.lastSeen.get(file.externalId) === stamp) continue;

      const fallback = fallbackLabel(this.productLabel, file.externalId);
      this.engine.observe({
        identity: canonicalKey(this.provider, file.externalId),
        provider: this.provider,
        surface: 'desktop',
        title: '',
        titlePriority: 0,
        fallbackTitle: fallback,
        source: this.source,
        externalId: file.externalId,
        context: { conversationId: file.externalId },
        locateHint: `${this.locatePrefix} → ${fallback}`,
        observations: [
          {
            signal: this.inventorySignal,
            at: activityAt,
            raw: {
              sizeBytes: file.sizeBytes,
              metadataBoundary: 'filename-and-stat-only',
            },
            connectorId: this.id,
            surface: 'desktop',
          },
        ],
        sourceActivityAt: activityAt,
        connectorId: this.id,
      });
      this.lastSeen.set(file.externalId, stamp);
      alreadyIndexed.add(file.externalId);
    }

    return {
      observedSessionCount: observed,
      archivedSessionCount: archived,
      permissionState: 'granted',
      warnings,
    };
  }
}

export function listOpaqueSessionFiles(
  directory: string,
  extension = '.pb',
): { files: OpaqueSessionFile[]; warnings: string[] } {
  const files: OpaqueSessionFile[] = [];
  const warnings: string[] = [];
  let invalidNames = 0;
  let unreadable = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== extension) continue;
    const externalId = basename(entry.name, extension);
    if (!UUID_FILE.test(externalId)) {
      invalidNames += 1;
      continue;
    }
    try {
      const metadata = statSync(join(directory, entry.name));
      files.push({
        externalId,
        modifiedAt: Math.max(0, Math.trunc(metadata.mtimeMs)),
        sizeBytes: metadata.size,
      });
    } catch {
      unreadable += 1;
    }
  }

  if (invalidNames > 0) {
    warnings.push(
      `${invalidNames} ${extension} file(s) had an unrecognised session filename and were not ingested`,
    );
  }
  if (unreadable > 0) {
    warnings.push(`${unreadable} session file(s) could not be statted`);
  }

  files.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return { files, warnings };
}
