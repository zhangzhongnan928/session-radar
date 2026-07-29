import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import {
  DEFAULT_HISTORY_WINDOW_MS,
  canonicalKey,
  fallbackLabel,
} from '@session-radar/shared';
import type { Source } from '@session-radar/shared';
import type { StatusEngine } from '../../engine.js';
import type {
  Connector,
  ConnectorContext,
  ConnectorScanResult,
} from '../../registry.js';
import { ConnectorUnsupportedError } from '../../registry.js';

export const CHATGPT_ATLAS_CONNECTOR_ID = 'chatgpt-atlas';

const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface AtlasConversationFile {
  externalId: string;
  modifiedAt: number;
  sizeBytes: number;
}

export interface AtlasConversationInventory {
  files: AtlasConversationFile[];
  accountDirectoryCount: number;
  warnings: string[];
}

/**
 * Enumerate Atlas's local conversation cache by filename only.
 *
 * The `.data` bodies are not opened. Their format is content-bearing and does
 * not currently have a separately verified metadata projection.
 */
export function listAtlasConversationFiles(
  supportDir: string,
): AtlasConversationInventory {
  const warnings: string[] = [];
  const byId = new Map<string, AtlasConversationFile>();
  let accountDirectoryCount = 0;
  let invalidNames = 0;
  let unreadable = 0;
  let duplicateFiles = 0;

  for (const directory of readdirSync(supportDir, { withFileTypes: true })) {
    if (
      !directory.isDirectory() ||
      !directory.name.startsWith('conversations-v3-')
    ) {
      continue;
    }
    accountDirectoryCount += 1;
    const directoryPath = join(supportDir, directory.name);
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.data')) continue;
      const externalId = basename(entry.name, '.data');
      if (!UUID_FILE.test(externalId)) {
        invalidNames += 1;
        continue;
      }
      try {
        const metadata = statSync(join(directoryPath, entry.name));
        const incoming: AtlasConversationFile = {
          externalId,
          modifiedAt: Math.max(0, Math.trunc(metadata.mtimeMs)),
          sizeBytes: metadata.size,
        };
        const existing = byId.get(externalId);
        if (existing) duplicateFiles += 1;
        if (!existing || incoming.modifiedAt >= existing.modifiedAt) {
          byId.set(externalId, incoming);
        }
      } catch {
        unreadable += 1;
      }
    }
  }

  if (accountDirectoryCount === 0) {
    warnings.push('no conversations-v3-* directory was found in the Atlas support data');
  }
  if (invalidNames > 0) {
    warnings.push(
      `${invalidNames} Atlas .data file(s) had an unrecognised conversation filename and were not ingested`,
    );
  }
  if (unreadable > 0) {
    warnings.push(`${unreadable} Atlas conversation file(s) could not be statted`);
  }
  if (duplicateFiles > 0) {
    warnings.push(
      `${duplicateFiles} duplicate Atlas conversation file(s) across account directories were deduplicated by id`,
    );
  }

  const files = [...byId.values()].sort(
    (left, right) => right.modifiedAt - left.modifiedAt,
  );
  return { files, accountDirectoryCount, warnings };
}

export interface ChatGptAtlasConnectorOptions {
  engine: StatusEngine;
  appPath?: string;
  supportDir?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  device?: string;
  now?: () => number;
}

export class ChatGptAtlasConnector implements Connector {
  readonly id = CHATGPT_ATLAS_CONNECTOR_ID;
  readonly displayName = 'ChatGPT Atlas local conversations';
  readonly provider = 'openai' as const;
  readonly surface = 'desktop' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly appPath: string;
  private readonly supportDir: string;
  private readonly historyWindowMs: number;
  private readonly now: () => number;
  private readonly source: Source;
  private readonly lastSeen = new Map<string, string>();

  constructor(options: ChatGptAtlasConnectorOptions) {
    this.engine = options.engine;
    this.appPath = options.appPath ?? '/Applications/ChatGPT Atlas.app';
    this.supportDir =
      options.supportDir ??
      join(homedir(), 'Library', 'Application Support', 'com.openai.atlas');
    this.scanIntervalMs = options.scanIntervalMs ?? 30_000;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.source = {
      id: CHATGPT_ATLAS_CONNECTOR_ID,
      provider: 'openai',
      surface: 'desktop',
      device: options.device ?? hostname(),
    };
  }

  scan(ctx: ConnectorContext): ConnectorScanResult {
    const appExists = existsSync(this.appPath);
    if (!existsSync(this.supportDir)) {
      if (!appExists) {
        throw new ConnectorUnsupportedError(
          'ChatGPT Atlas is not installed and its local support directory is absent',
        );
      }
      return {
        observedSessionCount: 0,
        archivedSessionCount: 0,
        permissionState: 'unknown',
        warnings: [`ChatGPT Atlas support directory not found: ${this.supportDir}`],
      };
    }

    const inventory = listAtlasConversationFiles(this.supportDir);
    const warnings = [
      'ChatGPT Atlas .data conversation bodies are deliberately not read; source titles and live lifecycle are unavailable, so unique Atlas-only rows remain status unknown',
      ...inventory.warnings,
    ];
    if (!appExists) {
      warnings.push(
        `the default ChatGPT Atlas application path is absent (${this.appPath}); retained conversations remain indexed, but the return path may require locating the app`,
      );
    }

    const now = this.now();
    const cutoff = now - this.historyWindowMs;
    const alreadyIndexed = ctx.store.externalIdsForSource(this.id);
    let observed = 0;
    let archived = 0;

    for (const file of inventory.files) {
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
      const fallback = fallbackLabel('ChatGPT Atlas', file.externalId);
      this.engine.observe({
        identity: canonicalKey('openai', file.externalId),
        provider: 'openai',
        surface: 'desktop',
        title: '',
        titlePriority: 0,
        fallbackTitle: fallback,
        source: this.source,
        externalId: file.externalId,
        context: { conversationId: file.externalId },
        locateHint: `ChatGPT Atlas → conversation history → ${fallback}`,
        observations: [
          {
            signal: 'chatgpt.atlas_inventory_seen',
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
