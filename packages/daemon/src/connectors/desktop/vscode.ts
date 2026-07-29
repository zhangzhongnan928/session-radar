import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export const VSCODE_COPILOT_CONNECTOR_ID = 'vscode-copilot';

const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const WORKSPACE_ID = /^[0-9a-f]{32}$/iu;
const MAX_WORKSPACE_JSON_BYTES = 32 * 1024;

export interface VsCodeChatFile {
  externalId: string;
  modifiedAt: number;
  sizeBytes: number;
  workspaceStorageId: string;
  workspacePath?: string;
}

export interface VsCodeChatInventory {
  files: VsCodeChatFile[];
  warnings: string[];
}

function workspacePathFromMetadata(
  workspaceDirectory: string,
): string | undefined {
  const path = join(workspaceDirectory, 'workspace.json');
  if (!existsSync(path)) return undefined;
  const metadata = statSync(path);
  if (metadata.size > MAX_WORKSPACE_JSON_BYTES) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('folder' in raw) ||
    typeof (raw as { folder?: unknown }).folder !== 'string'
  ) {
    return undefined;
  }
  const folder = (raw as { folder: string }).folder;
  try {
    const url = new URL(folder);
    if (url.protocol !== 'file:') return undefined;
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

/**
 * Enumerate VS Code's persisted chat-session files without reading them.
 *
 * `workspace.json` is a separate first-party location descriptor and is read
 * through a one-field allowlist. The chat JSON body itself is never opened.
 */
export function listVsCodeChatFiles(
  workspaceStorageDir: string,
): VsCodeChatInventory {
  const warnings: string[] = [];
  const files: VsCodeChatFile[] = [];
  let invalidNames = 0;
  let unreadable = 0;

  for (const workspace of readdirSync(workspaceStorageDir, {
    withFileTypes: true,
  })) {
    if (!workspace.isDirectory() || !WORKSPACE_ID.test(workspace.name)) continue;
    const workspaceDirectory = join(workspaceStorageDir, workspace.name);
    const chatDirectory = join(workspaceDirectory, 'chatSessions');
    if (!existsSync(chatDirectory)) continue;
    const workspacePath = workspacePathFromMetadata(workspaceDirectory);
    for (const entry of readdirSync(chatDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const externalId = basename(entry.name, '.json');
      if (!UUID_FILE.test(externalId)) {
        invalidNames += 1;
        continue;
      }
      try {
        const metadata = statSync(join(chatDirectory, entry.name));
        files.push({
          externalId,
          modifiedAt: Math.max(0, Math.trunc(metadata.mtimeMs)),
          sizeBytes: metadata.size,
          workspaceStorageId: workspace.name,
          ...(workspacePath ? { workspacePath } : {}),
        });
      } catch {
        unreadable += 1;
      }
    }
  }
  if (invalidNames > 0) {
    warnings.push(
      `${invalidNames} VS Code chat file(s) had an unrecognised session filename and were not ingested`,
    );
  }
  if (unreadable > 0) {
    warnings.push(`${unreadable} VS Code chat session file(s) could not be statted`);
  }
  files.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return { files, warnings };
}

export interface VsCodeCopilotConnectorOptions {
  engine: StatusEngine;
  appPath?: string;
  workspaceStorageDir?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  device?: string;
  now?: () => number;
}

export class VsCodeCopilotConnector implements Connector {
  readonly id = VSCODE_COPILOT_CONNECTOR_ID;
  readonly displayName = 'VS Code persisted chat sessions';
  readonly provider = 'github' as const;
  readonly surface = 'desktop' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly appPath: string;
  private readonly workspaceStorageDir: string;
  private readonly historyWindowMs: number;
  private readonly now: () => number;
  private readonly source: Source;
  private readonly lastSeen = new Map<string, string>();

  constructor(options: VsCodeCopilotConnectorOptions) {
    this.engine = options.engine;
    this.appPath = options.appPath ?? '/Applications/Visual Studio Code.app';
    this.workspaceStorageDir =
      options.workspaceStorageDir ??
      join(
        homedir(),
        'Library',
        'Application Support',
        'Code',
        'User',
        'workspaceStorage',
      );
    this.scanIntervalMs = options.scanIntervalMs ?? 30_000;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.source = {
      id: VSCODE_COPILOT_CONNECTOR_ID,
      provider: 'github',
      surface: 'desktop',
      device: options.device ?? hostname(),
    };
  }

  scan(ctx: ConnectorContext): ConnectorScanResult {
    const appExists = existsSync(this.appPath);
    if (!existsSync(this.workspaceStorageDir)) {
      if (!appExists) {
        throw new ConnectorUnsupportedError(
          'Visual Studio Code is not installed and its workspace storage is absent',
        );
      }
      return {
        observedSessionCount: 0,
        archivedSessionCount: 0,
        permissionState: 'unknown',
        warnings: [
          `VS Code workspace storage not found: ${this.workspaceStorageDir}`,
        ],
      };
    }

    const inventory = listVsCodeChatFiles(this.workspaceStorageDir);
    const warnings = [
      'VS Code chat-session JSON bodies are deliberately not read; source titles and live lifecycle are unavailable, so these rows remain status unknown',
      ...inventory.warnings,
    ];
    if (!appExists) {
      warnings.push(
        `the default Visual Studio Code application path is absent (${this.appPath}); retained chat sessions remain indexed, but return paths may not open`,
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

      const stamp = `${activityAt}:${file.sizeBytes}:${file.workspacePath ?? ''}`;
      if (this.lastSeen.get(file.externalId) === stamp) continue;
      const where = file.workspacePath
        ? basename(file.workspacePath)
        : 'VS Code chat';
      const fallback = fallbackLabel(where, file.externalId);
      this.engine.observe({
        identity: canonicalKey('github', file.externalId),
        provider: 'github',
        surface: 'desktop',
        title: '',
        titlePriority: 0,
        fallbackTitle: fallback,
        source: this.source,
        externalId: file.externalId,
        context: {
          ...(file.workspacePath ? { cwd: file.workspacePath } : {}),
          ...(file.workspacePath
            ? { repo: basename(file.workspacePath) }
            : {}),
          conversationId: file.externalId,
        },
        locateHint: `Visual Studio Code → Chat history → ${fallback}`,
        observations: [
          {
            signal: 'vscode.copilot_inventory_seen',
            at: activityAt,
            raw: {
              sizeBytes: file.sizeBytes,
              workspaceStorageId: file.workspaceStorageId,
              metadataBoundary: 'filename-stat-and-workspace-path-only',
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
