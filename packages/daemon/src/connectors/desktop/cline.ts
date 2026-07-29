import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
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

export const CLINE_CONNECTOR_ID = 'cline-vscode';

const CLINE_EXTENSION_PREFIX = 'saoudrizwan.claude-dev-';
const TASK_ID = /^[0-9]{13}$/u;
const TASK_FILES = [
  'api_conversation_history.json',
  'ui_messages.json',
] as const;

export interface ClineTaskFile {
  externalId: string;
  createdAt: number;
  modifiedAt: number;
  sizeBytes: number;
}

export interface ClineTaskInventory {
  tasks: ClineTaskFile[];
  warnings: string[];
}

/**
 * Enumerate Cline task directories without opening either conversation file.
 *
 * Cline's directory name is its millisecond task id. The two JSON files contain
 * prompts, replies and tool output, so only their presence, size and mtime cross
 * this collector boundary.
 */
export function listClineTasks(tasksDirectory: string): ClineTaskInventory {
  const tasks: ClineTaskFile[] = [];
  const warnings: string[] = [];
  let invalidIds = 0;
  let missingConversationFiles = 0;
  let unreadableFiles = 0;

  for (const entry of readdirSync(tasksDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!TASK_ID.test(entry.name)) {
      invalidIds += 1;
      continue;
    }
    const createdAt = Number(entry.name);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      invalidIds += 1;
      continue;
    }

    let modifiedAt = 0;
    let sizeBytes = 0;
    let stattableFiles = 0;
    for (const filename of TASK_FILES) {
      const path = join(tasksDirectory, entry.name, filename);
      if (!existsSync(path)) continue;
      try {
        const metadata = statSync(path);
        if (!metadata.isFile()) continue;
        stattableFiles += 1;
        modifiedAt = Math.max(
          modifiedAt,
          Math.max(0, Math.trunc(metadata.mtimeMs)),
        );
        sizeBytes += metadata.size;
      } catch {
        unreadableFiles += 1;
      }
    }
    if (stattableFiles === 0) {
      missingConversationFiles += 1;
      continue;
    }
    tasks.push({
      externalId: entry.name,
      createdAt,
      modifiedAt: Math.max(createdAt, modifiedAt),
      sizeBytes,
    });
  }

  if (invalidIds > 0) {
    warnings.push(
      `${invalidIds} Cline task director${
        invalidIds === 1 ? 'y had' : 'ies had'
      } an unrecognised millisecond task id and were not ingested`,
    );
  }
  if (missingConversationFiles > 0) {
    warnings.push(
      `${missingConversationFiles} Cline task director${
        missingConversationFiles === 1 ? 'y had' : 'ies had'
      } no stattable conversation file and were not ingested`,
    );
  }
  if (unreadableFiles > 0) {
    warnings.push(
      `${unreadableFiles} Cline conversation file(s) could not be statted`,
    );
  }

  tasks.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return { tasks, warnings };
}

function clineExtensionInstalled(extensionRoot: string): boolean {
  if (!existsSync(extensionRoot)) return false;
  try {
    return readdirSync(extensionRoot, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(CLINE_EXTENSION_PREFIX),
    );
  } catch {
    return false;
  }
}

export interface ClineConnectorOptions {
  engine: StatusEngine;
  appPath?: string;
  extensionRoot?: string;
  tasksDir?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  device?: string;
  now?: () => number;
}

export class ClineConnector implements Connector {
  readonly id = CLINE_CONNECTOR_ID;
  readonly displayName = 'Cline tasks (VS Code)';
  readonly provider = 'cline' as const;
  readonly surface = 'desktop' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly appPath: string;
  private readonly extensionRoot: string;
  private readonly tasksDir: string;
  private readonly historyWindowMs: number;
  private readonly now: () => number;
  private readonly source: Source;
  private readonly lastSeen = new Map<string, string>();

  constructor(options: ClineConnectorOptions) {
    this.engine = options.engine;
    this.appPath = options.appPath ?? '/Applications/Visual Studio Code.app';
    this.extensionRoot =
      options.extensionRoot ?? join(homedir(), '.vscode', 'extensions');
    this.tasksDir =
      options.tasksDir ??
      join(
        homedir(),
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'tasks',
      );
    this.scanIntervalMs = options.scanIntervalMs ?? 30_000;
    this.historyWindowMs =
      options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.source = {
      id: CLINE_CONNECTOR_ID,
      provider: 'cline',
      surface: 'desktop',
      device: options.device ?? hostname(),
    };
  }

  scan(ctx: ConnectorContext): ConnectorScanResult {
    const appExists = existsSync(this.appPath);
    const extensionExists = clineExtensionInstalled(this.extensionRoot);
    if (!existsSync(this.tasksDir)) {
      if (!extensionExists) {
        throw new ConnectorUnsupportedError(
          'Cline is not installed and no retained Cline task directory is present',
        );
      }
      return {
        observedSessionCount: 0,
        archivedSessionCount: 0,
        permissionState: 'not_required',
      };
    }

    const inventory = listClineTasks(this.tasksDir);
    const warnings = [
      'Cline conversation JSON bodies are deliberately not read; source titles and live lifecycle are unavailable, so these rows remain status unknown',
      ...inventory.warnings,
    ];
    if (!extensionExists) {
      warnings.push(
        'the Cline VS Code extension is no longer installed; retained tasks remain indexed, but the return path requires reinstalling Cline',
      );
    }
    if (!appExists) {
      warnings.push(
        `the default Visual Studio Code application path is absent (${this.appPath}); retained Cline tasks remain indexed, but the return path may not open`,
      );
    }

    const now = this.now();
    const cutoff = now - this.historyWindowMs;
    const alreadyIndexed = ctx.store.externalIdsForSource(this.id);
    let observed = 0;
    let archived = 0;

    for (const task of inventory.tasks) {
      if (ctx.signal.aborted) break;
      const activityAt = Math.min(task.modifiedAt, now);
      if (task.modifiedAt > now) {
        warnings.push(
          `${task.externalId} has a future modification timestamp; recency was clamped to scan time`,
        );
      }
      const inTriage = activityAt >= cutoff;
      if (inTriage) observed += 1;
      else archived += 1;
      if (!inTriage && alreadyIndexed.has(task.externalId)) continue;

      const stamp = `${activityAt}:${task.sizeBytes}`;
      if (this.lastSeen.get(task.externalId) === stamp) continue;
      const fallback = fallbackLabel('Cline task', task.externalId);
      this.engine.observe({
        identity: canonicalKey('cline', task.externalId),
        provider: 'cline',
        surface: 'desktop',
        title: '',
        titlePriority: 0,
        fallbackTitle: fallback,
        source: this.source,
        externalId: task.externalId,
        context: { conversationId: task.externalId },
        locateHint: `Visual Studio Code → Cline → History → ${fallback}`,
        observations: [
          {
            signal: 'cline.task_inventory_seen',
            at: activityAt,
            raw: {
              createdAtFromTaskId: task.createdAt,
              sizeBytes: task.sizeBytes,
              metadataBoundary: 'directory-name-and-file-stat-only',
            },
            connectorId: this.id,
            surface: 'desktop',
          },
        ],
        sourceActivityAt: activityAt,
        connectorId: this.id,
      });
      this.lastSeen.set(task.externalId, stamp);
      alreadyIndexed.add(task.externalId);
    }

    return {
      observedSessionCount: observed,
      archivedSessionCount: archived,
      permissionState: 'granted',
      warnings,
    };
  }
}
