import {
  existsSync,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import {
  DEFAULT_HISTORY_WINDOW_MS,
  canonicalKey,
  deriveTitle,
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
import type { StoredObservation } from '../../store.js';
import { listProcesses } from '../process.js';

export const CURSOR_CONNECTOR_ID = 'cursor-desktop';
export const CURSOR_AGENT_CLI_SOURCE_ID = 'cursor-agent-cli';
export const CURSOR_HEADERS_KEY = 'composer.composerHeaders';

const CURSOR_PROCESS_PATTERN = /\/Cursor\.app\/Contents\/MacOS\/Cursor(?:\s|$)/u;
const RUNNING_HEARTBEAT_MS = 5 * 60_000;
const SAFE_ID = /^[A-Za-z0-9._:-]{8,256}$/u;
const UUID_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type CursorPersistedStatus =
  | 'none'
  | 'generating'
  | 'completed'
  | 'aborted'
  | 'unknown';

export interface CursorComposerMetadata {
  composerId: string;
  name?: string;
  subtitle?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  status?: CursorPersistedStatus;
  generatingBubbleCount: number;
  isContinuationInProgress?: boolean;
  hasBlockingPendingActions?: boolean;
  hasPendingPlan?: boolean;
  hasUnreadMessages?: boolean;
  isArchived?: boolean;
  isDraft?: boolean;
  isBestOfNSubcomposer?: boolean;
  conversationHeaderCount: number;
  workspacePath?: string;
  parentComposerId?: string;
  backgroundAgentId?: string;
  currentHeader: boolean;
}

export interface CursorComposerInventory {
  composers: CursorComposerMetadata[];
  warnings: string[];
  headerDocumentPresent: boolean;
  headerDocumentValid: boolean;
  headerRowCount: number;
  historyRecordCount: number;
  validHistoryRecordCount: number;
}

export interface CursorAgentTranscriptFile {
  externalId: string;
  modifiedAt: number;
  sizeBytes: number;
}

export interface CursorAgentTranscriptInventory {
  sessions: CursorAgentTranscriptFile[];
  nestedSubagentCount: number;
  warnings: string[];
}

interface SafeCursorRow {
  keyId: string | null;
  composerId: string | null;
  name: string | null;
  subtitle: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  status: string | null;
  generatingBubbleCount: number | null;
  isContinuationInProgress: number | null;
  hasBlockingPendingActions: number | null;
  hasPendingPlan: number | null;
  hasUnreadMessages: number | null;
  isArchived: number | null;
  isDraft: number | null;
  isBestOfNSubcomposer: number | null;
  conversationHeaderCount: number | null;
  workspacePath: string | null;
  parentComposerId: string | null;
  backgroundAgentId: string | null;
}

interface CountRow {
  count: number;
  valid: number | null;
}

const SAFE_PROJECTION = `
  CASE
    WHEN json_type(document, '$.composerId') = 'text'
    THEN substr(json_extract(document, '$.composerId'), 1, 256)
  END AS composerId,
  CASE
    WHEN json_type(document, '$.name') = 'text'
    THEN substr(json_extract(document, '$.name'), 1, 1024)
  END AS name,
  CASE
    WHEN json_type(document, '$.subtitle') = 'text'
    THEN substr(json_extract(document, '$.subtitle'), 1, 1024)
  END AS subtitle,
  CASE
    WHEN json_type(document, '$.createdAt') IN ('integer', 'real')
    THEN CAST(json_extract(document, '$.createdAt') AS INTEGER)
  END AS createdAt,
  CASE
    WHEN json_type(document, '$.lastUpdatedAt') IN ('integer', 'real')
    THEN CAST(json_extract(document, '$.lastUpdatedAt') AS INTEGER)
  END AS lastUpdatedAt,
  CASE
    WHEN json_type(document, '$.status') IS NULL THEN NULL
    WHEN json_extract(document, '$.status') IN ('none', 'generating', 'completed', 'aborted')
      THEN json_extract(document, '$.status')
    ELSE 'unknown'
  END AS status,
  CASE
    WHEN json_type(document, '$.generatingBubbleIds') = 'array'
    THEN json_array_length(json_extract(document, '$.generatingBubbleIds'))
    ELSE 0
  END AS generatingBubbleCount,
  CASE
    WHEN json_type(document, '$.isContinuationInProgress') IN ('true', 'false')
    THEN json_extract(document, '$.isContinuationInProgress')
  END AS isContinuationInProgress,
  CASE
    WHEN json_type(document, '$.hasBlockingPendingActions') IN ('true', 'false')
    THEN json_extract(document, '$.hasBlockingPendingActions')
  END AS hasBlockingPendingActions,
  CASE
    WHEN json_type(document, '$.hasPendingPlan') IN ('true', 'false')
    THEN json_extract(document, '$.hasPendingPlan')
  END AS hasPendingPlan,
  CASE
    WHEN json_type(document, '$.hasUnreadMessages') IN ('true', 'false')
    THEN json_extract(document, '$.hasUnreadMessages')
  END AS hasUnreadMessages,
  CASE
    WHEN json_type(document, '$.isArchived') IN ('true', 'false')
    THEN json_extract(document, '$.isArchived')
  END AS isArchived,
  CASE
    WHEN json_type(document, '$.isDraft') IN ('true', 'false')
    THEN json_extract(document, '$.isDraft')
  END AS isDraft,
  CASE
    WHEN json_type(document, '$.isBestOfNSubcomposer') IN ('true', 'false')
    THEN json_extract(document, '$.isBestOfNSubcomposer')
  END AS isBestOfNSubcomposer,
  CASE
    WHEN json_type(document, '$.fullConversationHeadersOnly') = 'array'
    THEN json_array_length(json_extract(document, '$.fullConversationHeadersOnly'))
    ELSE 0
  END AS conversationHeaderCount,
  CASE
    WHEN json_type(document, '$.workspaceIdentifier.uri.fsPath') = 'text'
    THEN substr(json_extract(document, '$.workspaceIdentifier.uri.fsPath'), 1, 4096)
  END AS workspacePath,
  CASE
    WHEN json_type(document, '$.subagentInfo.parentComposerId') = 'text'
    THEN substr(json_extract(document, '$.subagentInfo.parentComposerId'), 1, 256)
  END AS parentComposerId,
  CASE
    WHEN json_type(document, '$.createdFromBackgroundAgent.bcId') = 'text'
    THEN substr(json_extract(document, '$.createdFromBackgroundAgent.bcId'), 1, 256)
  END AS backgroundAgentId
`;

function hasTable(db: SqliteDatabase, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(name) !== undefined
  );
}

function booleanOrUndefined(value: number | null): boolean | undefined {
  return value === null ? undefined : value !== 0;
}

function safeTimestamp(value: number | null): number | undefined {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function safeText(value: string | null, maxChars: number): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxChars ? trimmed : undefined;
}

function metadataFromRow(
  row: SafeCursorRow,
  currentHeader: boolean,
): CursorComposerMetadata | undefined {
  const rowId = safeText(row.keyId, 256);
  const documentId = safeText(row.composerId, 256);
  const composerId = documentId ?? rowId;
  if (!composerId || !SAFE_ID.test(composerId)) return undefined;
  if (rowId && documentId && rowId !== documentId) return undefined;

  const status =
    row.status === 'none' ||
    row.status === 'generating' ||
    row.status === 'completed' ||
    row.status === 'aborted' ||
    row.status === 'unknown'
      ? row.status
      : undefined;
  const metadata: CursorComposerMetadata = {
    composerId,
    generatingBubbleCount: Math.max(0, row.generatingBubbleCount ?? 0),
    conversationHeaderCount: Math.max(0, row.conversationHeaderCount ?? 0),
    currentHeader,
  };
  const name = safeText(row.name, 1024);
  const subtitle = safeText(row.subtitle, 1024);
  const createdAt = safeTimestamp(row.createdAt);
  const lastUpdatedAt = safeTimestamp(row.lastUpdatedAt);
  const workspacePath = safeText(row.workspacePath, 4096);
  const parentComposerId = safeText(row.parentComposerId, 256);
  const backgroundAgentId = safeText(row.backgroundAgentId, 256);
  if (name) metadata.name = name;
  if (subtitle) metadata.subtitle = subtitle;
  if (createdAt !== undefined) metadata.createdAt = createdAt;
  if (lastUpdatedAt !== undefined) metadata.lastUpdatedAt = lastUpdatedAt;
  if (status) metadata.status = status;
  if (workspacePath) metadata.workspacePath = workspacePath;
  if (parentComposerId && SAFE_ID.test(parentComposerId)) {
    metadata.parentComposerId = parentComposerId;
  }
  if (backgroundAgentId && SAFE_ID.test(backgroundAgentId)) {
    metadata.backgroundAgentId = backgroundAgentId;
  }

  const booleans: Array<
    [
      keyof Pick<
        CursorComposerMetadata,
        | 'isContinuationInProgress'
        | 'hasBlockingPendingActions'
        | 'hasPendingPlan'
        | 'hasUnreadMessages'
        | 'isArchived'
        | 'isDraft'
        | 'isBestOfNSubcomposer'
      >,
      number | null,
    ]
  > = [
    ['isContinuationInProgress', row.isContinuationInProgress],
    ['hasBlockingPendingActions', row.hasBlockingPendingActions],
    ['hasPendingPlan', row.hasPendingPlan],
    ['hasUnreadMessages', row.hasUnreadMessages],
    ['isArchived', row.isArchived],
    ['isDraft', row.isDraft],
    ['isBestOfNSubcomposer', row.isBestOfNSubcomposer],
  ];
  for (const [key, raw] of booleans) {
    const value = booleanOrUndefined(raw);
    if (value !== undefined) metadata[key] = value;
  }
  return metadata;
}

function preferMetadata(
  current: CursorComposerMetadata | undefined,
  incoming: CursorComposerMetadata,
): CursorComposerMetadata {
  if (!current) return incoming;
  const preferred =
    (incoming.lastUpdatedAt ?? incoming.createdAt ?? 0) >=
    (current.lastUpdatedAt ?? current.createdAt ?? 0)
      ? incoming
      : current;
  const fallback = preferred === incoming ? current : incoming;
  return {
    ...fallback,
    ...preferred,
    name: preferred.name ?? fallback.name,
    subtitle: preferred.subtitle ?? fallback.subtitle,
    createdAt: preferred.createdAt ?? fallback.createdAt,
    lastUpdatedAt: preferred.lastUpdatedAt ?? fallback.lastUpdatedAt,
    status: preferred.status ?? fallback.status,
    workspacePath: preferred.workspacePath ?? fallback.workspacePath,
    parentComposerId: preferred.parentComposerId ?? fallback.parentComposerId,
    backgroundAgentId:
      preferred.backgroundAgentId ?? fallback.backgroundAgentId,
    currentHeader: current.currentHeader || incoming.currentHeader,
  };
}

function overlayHeader(
  current: CursorComposerMetadata | undefined,
  header: CursorComposerMetadata,
): CursorComposerMetadata {
  if (!current) return header;
  return {
    ...current,
    name: header.name ?? current.name,
    subtitle: header.subtitle ?? current.subtitle,
    createdAt: header.createdAt ?? current.createdAt,
    lastUpdatedAt: header.lastUpdatedAt ?? current.lastUpdatedAt,
    status: header.status ?? current.status,
    generatingBubbleCount:
      header.generatingBubbleCount > 0
        ? header.generatingBubbleCount
        : current.generatingBubbleCount,
    isContinuationInProgress:
      header.isContinuationInProgress ?? current.isContinuationInProgress,
    hasBlockingPendingActions:
      header.hasBlockingPendingActions ?? current.hasBlockingPendingActions,
    hasPendingPlan: header.hasPendingPlan ?? current.hasPendingPlan,
    hasUnreadMessages:
      header.hasUnreadMessages ?? current.hasUnreadMessages,
    isArchived: header.isArchived ?? current.isArchived,
    isDraft: header.isDraft ?? current.isDraft,
    isBestOfNSubcomposer:
      header.isBestOfNSubcomposer ?? current.isBestOfNSubcomposer,
    conversationHeaderCount: Math.max(
      current.conversationHeaderCount,
      header.conversationHeaderCount,
    ),
    workspacePath: header.workspacePath ?? current.workspacePath,
    parentComposerId: header.parentComposerId ?? current.parentComposerId,
    backgroundAgentId:
      header.backgroundAgentId ?? current.backgroundAgentId,
    currentHeader: true,
  };
}

/**
 * Read Cursor's two metadata indexes through SQL allowlists.
 *
 * The SELECTs never materialise `conversation`, `conversationState`,
 * `bubbleId:*`, rich text, prompt text, code selections, context objects or
 * encryption-key fields in JavaScript.
 */
export function readCursorComposerInventory(
  databasePath: string,
): CursorComposerInventory {
  const db = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 5000');

    const hasItemTable = hasTable(db, 'ItemTable');
    const hasCursorDiskKv = hasTable(db, 'cursorDiskKV');
    const warnings: string[] = [];
    const merged = new Map<string, CursorComposerMetadata>();
    let rejectedIdentities = 0;

    let headerDocumentPresent = false;
    let headerDocumentValid = false;
    let headerRowCount = 0;
    if (!hasItemTable) {
      warnings.push('Cursor ItemTable is missing; the current composer header cache is unavailable');
    } else {
      const headerCounts = db
        .prepare(
          `SELECT COUNT(*) AS count,
                  COALESCE(SUM(json_valid(CAST(value AS TEXT))), 0) AS valid
           FROM ItemTable
           WHERE key = ?`,
        )
        .get(CURSOR_HEADERS_KEY) as CountRow;
      headerDocumentPresent = headerCounts.count > 0;
      headerDocumentValid = (headerCounts.valid ?? 0) > 0;
      if (!headerDocumentPresent) {
        warnings.push(`${CURSOR_HEADERS_KEY} is absent from Cursor's metadata store`);
      } else if (!headerDocumentValid) {
        warnings.push(`${CURSOR_HEADERS_KEY} uses an unrecognised encoding`);
      } else {
        const headerRows = db
          .prepare(
            `WITH header_store AS (
               SELECT CAST(value AS TEXT) AS root
               FROM ItemTable
               WHERE key = ? AND json_valid(CAST(value AS TEXT))
               LIMIT 1
             ),
             projected AS (
               SELECT NULL AS keyId, item.value AS document
               FROM header_store, json_each(header_store.root, '$.allComposers') AS item
               WHERE item.type = 'object'
             )
             SELECT keyId, ${SAFE_PROJECTION}
             FROM projected`,
          )
          .all(CURSOR_HEADERS_KEY) as SafeCursorRow[];
        for (const row of headerRows) {
          const metadata = metadataFromRow(row, true);
          if (!metadata) {
            rejectedIdentities += 1;
            continue;
          }
          headerRowCount += 1;
          merged.set(
            metadata.composerId,
            overlayHeader(merged.get(metadata.composerId), metadata),
          );
        }
      }
    }

    let historyRecordCount = 0;
    let validHistoryRecordCount = 0;
    if (!hasCursorDiskKv) {
      warnings.push('Cursor cursorDiskKV is missing; historical composer metadata is unavailable');
    } else {
      const historyCounts = db
        .prepare(
          `SELECT COUNT(*) AS count,
                  COALESCE(SUM(json_valid(CAST(value AS TEXT))), 0) AS valid
           FROM cursorDiskKV
           WHERE key LIKE 'composerData:%'`,
        )
        .get() as CountRow;
      historyRecordCount = historyCounts.count;
      validHistoryRecordCount = historyCounts.valid ?? 0;
      const invalid = historyRecordCount - validHistoryRecordCount;
      if (invalid > 0) {
        warnings.push(
          `${invalid} Cursor composerData record(s) use an unrecognised encoding and were not ingested`,
        );
      }

      const historyRows = db
        .prepare(
          `WITH projected AS (
             SELECT substr(key, length('composerData:') + 1) AS keyId,
                    CAST(value AS TEXT) AS document
             FROM cursorDiskKV
             WHERE key LIKE 'composerData:%'
               AND json_valid(CAST(value AS TEXT))
           )
           SELECT keyId, ${SAFE_PROJECTION}
           FROM projected`,
        )
        .all() as SafeCursorRow[];
      for (const row of historyRows) {
        const metadata = metadataFromRow(row, false);
        if (!metadata) {
          rejectedIdentities += 1;
          continue;
        }
        merged.set(
          metadata.composerId,
          preferMetadata(merged.get(metadata.composerId), metadata),
        );
      }

      // Re-apply the current headers after history merging so an older
      // composerData row cannot overwrite a fresher pending-action flag.
      if (headerDocumentValid) {
        const headerRows = db
          .prepare(
            `WITH header_store AS (
               SELECT CAST(value AS TEXT) AS root
               FROM ItemTable
               WHERE key = ? AND json_valid(CAST(value AS TEXT))
               LIMIT 1
             ),
             projected AS (
               SELECT NULL AS keyId, item.value AS document
               FROM header_store, json_each(header_store.root, '$.allComposers') AS item
               WHERE item.type = 'object'
             )
             SELECT keyId, ${SAFE_PROJECTION}
             FROM projected`,
          )
          .all(CURSOR_HEADERS_KEY) as SafeCursorRow[];
        for (const row of headerRows) {
          const metadata = metadataFromRow(row, true);
          if (metadata) {
            merged.set(
              metadata.composerId,
              overlayHeader(merged.get(metadata.composerId), metadata),
            );
          }
        }
      }
    }

    if (rejectedIdentities > 0) {
      warnings.push(
        `${rejectedIdentities} Cursor metadata row(s) had an invalid or conflicting composer id and were not ingested`,
      );
    }

    let draftCount = 0;
    let bestOfNCount = 0;
    let nonSessionCount = 0;
    let unknownStatusCount = 0;
    const composers: CursorComposerMetadata[] = [];
    for (const metadata of merged.values()) {
      if (metadata.isDraft === true) {
        draftCount += 1;
        continue;
      }
      if (metadata.isBestOfNSubcomposer === true) {
        bestOfNCount += 1;
        continue;
      }
      const sessionLike =
        metadata.currentHeader ||
        metadata.name !== undefined ||
        metadata.subtitle !== undefined ||
        metadata.conversationHeaderCount > 0;
      if (!sessionLike) {
        nonSessionCount += 1;
        continue;
      }
      if (metadata.status === 'unknown') unknownStatusCount += 1;
      composers.push(metadata);
    }
    if (draftCount > 0) {
      warnings.push(`${draftCount} unsent Cursor draft(s) were excluded`);
    }
    if (bestOfNCount > 0) {
      warnings.push(
        `${bestOfNCount} internal best-of-N candidate composer(s) were excluded`,
      );
    }
    if (nonSessionCount > 0) {
      warnings.push(
        `${nonSessionCount} composerData record(s) had no safe session metadata and were excluded`,
      );
    }
    if (unknownStatusCount > 0) {
      warnings.push(
        `${unknownStatusCount} Cursor composer status value(s) were unrecognised and not guessed`,
      );
    }

    composers.sort(
      (left, right) =>
        (right.lastUpdatedAt ?? right.createdAt ?? 0) -
        (left.lastUpdatedAt ?? left.createdAt ?? 0),
    );
    return {
      composers,
      warnings,
      headerDocumentPresent,
      headerDocumentValid,
      headerRowCount,
      historyRecordCount,
      validHistoryRecordCount,
    };
  } finally {
    db.close();
  }
}

/**
 * Enumerate Cursor Agent CLI's top-level transcript files without opening them.
 *
 * The CLI's `--resume <chatId>` accepts the UUID used by
 * `.cursor/projects/(project)/agent-transcripts/<chatId>/<chatId>.jsonl`. The JSONL
 * contains prompts and replies, so the collector's trust boundary stops at the
 * UUID filename and filesystem stat. Nested subagent JSONL files are counted but
 * are not presented as separate user work.
 */
export function listCursorAgentTranscripts(
  projectsDirectory: string,
): CursorAgentTranscriptInventory {
  const byId = new Map<string, CursorAgentTranscriptFile>();
  const warnings: string[] = [];
  let nestedSubagentCount = 0;
  let invalidSessionDirectories = 0;
  let missingPrimaryTranscripts = 0;
  let unreadableProjects = 0;
  let duplicateSessions = 0;

  if (!existsSync(projectsDirectory)) {
    return { sessions: [], nestedSubagentCount: 0, warnings: [] };
  }

  let projects: Dirent[];
  try {
    projects = readdirSync(projectsDirectory, { withFileTypes: true });
  } catch {
    return {
      sessions: [],
      nestedSubagentCount: 0,
      warnings: [
        `Cursor Agent projects directory could not be enumerated: ${projectsDirectory}`,
      ],
    };
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const transcriptRoot = join(
      projectsDirectory,
      project.name,
      'agent-transcripts',
    );
    if (!existsSync(transcriptRoot)) continue;

    let sessionDirectories: Dirent[];
    try {
      sessionDirectories = readdirSync(transcriptRoot, {
        withFileTypes: true,
      });
    } catch {
      unreadableProjects += 1;
      continue;
    }

    for (const sessionDirectory of sessionDirectories) {
      if (!sessionDirectory.isDirectory()) continue;
      const externalId = sessionDirectory.name;
      if (!UUID_ID.test(externalId)) {
        invalidSessionDirectories += 1;
        continue;
      }

      const sessionPath = join(transcriptRoot, externalId);
      const primaryPath = join(sessionPath, `${externalId}.jsonl`);
      try {
        const metadata = statSync(primaryPath);
        if (!metadata.isFile()) {
          missingPrimaryTranscripts += 1;
          continue;
        }
        const incoming = {
          externalId,
          modifiedAt: Math.max(0, Math.trunc(metadata.mtimeMs)),
          sizeBytes: metadata.size,
        };
        const existing = byId.get(externalId);
        if (existing) duplicateSessions += 1;
        if (!existing || incoming.modifiedAt >= existing.modifiedAt) {
          byId.set(externalId, incoming);
        }
      } catch {
        missingPrimaryTranscripts += 1;
      }

      const subagentDirectory = join(sessionPath, 'subagents');
      if (!existsSync(subagentDirectory)) continue;
      try {
        nestedSubagentCount += readdirSync(subagentDirectory, {
          withFileTypes: true,
        }).filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith('.jsonl') &&
            UUID_ID.test(basename(entry.name, '.jsonl')),
        ).length;
      } catch {
        unreadableProjects += 1;
      }
    }
  }

  if (invalidSessionDirectories > 0) {
    warnings.push(
      `${invalidSessionDirectories} Cursor Agent transcript director${
        invalidSessionDirectories === 1 ? 'y had' : 'ies had'
      } an unrecognised session id and were not ingested`,
    );
  }
  if (missingPrimaryTranscripts > 0) {
    warnings.push(
      `${missingPrimaryTranscripts} Cursor Agent session director${
        missingPrimaryTranscripts === 1 ? 'y had' : 'ies had'
      } no stattable matching top-level transcript`,
    );
  }
  if (unreadableProjects > 0) {
    warnings.push(
      `${unreadableProjects} Cursor Agent transcript director${
        unreadableProjects === 1 ? 'y was' : 'ies were'
      } not enumerable`,
    );
  }
  if (duplicateSessions > 0) {
    warnings.push(
      `${duplicateSessions} duplicate Cursor Agent top-level transcript location(s) shared a chat id; the newest stat was used`,
    );
  }

  const sessions = [...byId.values()].sort(
    (left, right) => right.modifiedAt - left.modifiedAt,
  );
  return { sessions, nestedSubagentCount, warnings };
}

type CursorLifecycle =
  | 'blocked'
  | 'running'
  | 'completed'
  | 'aborted'
  | 'inventory';

function lifecycleOf(composer: CursorComposerMetadata): CursorLifecycle {
  if (
    composer.currentHeader &&
    (composer.hasBlockingPendingActions === true || composer.hasPendingPlan === true)
  ) {
    return 'blocked';
  }
  if (
    composer.currentHeader &&
    (composer.status === 'generating' ||
      composer.isContinuationInProgress === true ||
      composer.generatingBubbleCount > 0)
  ) {
    return 'running';
  }
  if (composer.status === 'completed') return 'completed';
  if (composer.status === 'aborted') return 'aborted';
  return 'inventory';
}

function explicitlyNonBlocking(composer: CursorComposerMetadata): boolean {
  return (
    composer.currentHeader &&
    composer.hasBlockingPendingActions !== true &&
    composer.hasPendingPlan !== true &&
    (composer.hasBlockingPendingActions === false ||
      composer.hasPendingPlan === false)
  );
}

function activityAtOf(
  composer: CursorComposerMetadata,
  now: number,
): { at: number; future: boolean; missing: boolean } {
  const sourceAt = composer.lastUpdatedAt ?? composer.createdAt;
  if (sourceAt === undefined) return { at: 0, future: false, missing: true };
  return {
    at: Math.min(sourceAt, now),
    future: sourceAt > now,
    missing: false,
  };
}

function rawLifecycle(
  composer: CursorComposerMetadata,
): Record<string, unknown> {
  return {
    ...(composer.status !== undefined ? { status: composer.status } : {}),
    generatingBubbleCount: composer.generatingBubbleCount,
    ...(composer.isContinuationInProgress !== undefined
      ? { isContinuationInProgress: composer.isContinuationInProgress }
      : {}),
    ...(composer.hasBlockingPendingActions !== undefined
      ? { hasBlockingPendingActions: composer.hasBlockingPendingActions }
      : {}),
    ...(composer.hasPendingPlan !== undefined
      ? { hasPendingPlan: composer.hasPendingPlan }
      : {}),
    ...(composer.hasUnreadMessages !== undefined
      ? { hasUnreadMessages: composer.hasUnreadMessages }
      : {}),
    currentHeader: composer.currentHeader,
    ...(composer.parentComposerId
      ? { parentComposerId: composer.parentComposerId }
      : {}),
    ...(composer.backgroundAgentId
      ? { backgroundAgentId: composer.backgroundAgentId }
      : {}),
  };
}

function hasStoredCursorBlock(ctx: ConnectorContext, composerId: string): boolean {
  const observations = ctx.store.listObservations(
    canonicalKey('cursor', composerId).key,
    undefined,
    50,
  );
  const block = observations.find(
    (observation) => observation.signal === 'cursor.agent_needs_attention',
  );
  if (!block) return false;
  const clear = observations.find(
    (observation) =>
      observation.signal === 'cursor.agent_resumed' ||
      observation.signal === 'cursor.agent_completed' ||
      observation.signal === 'cursor.agent_aborted' ||
      observation.signal === 'cursor.process_dead',
  );
  return !clear || clear.at <= block.at;
}

export interface CursorConnectorOptions {
  engine: StatusEngine;
  appPath?: string;
  databasePath?: string;
  cursorAgentProjectsDir?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  probeProcesses?: boolean;
  device?: string;
  now?: () => number;
}

interface CursorSeenState {
  stamp: string;
  lifecycle: CursorLifecycle;
  lastRunningHeartbeatAt?: number;
}

/**
 * Cursor Agent composer inventory and lifecycle.
 *
 * This connector reads only safe JSON projections from Cursor's SQLite indexes.
 * It never selects the content-bearing composer document, bubble rows, agent KV
 * rows, conversation state, prompt text or code selections into JavaScript.
 */
export class CursorConnector implements Connector {
  readonly id = CURSOR_CONNECTOR_ID;
  readonly displayName = 'Cursor Agent desktop + CLI';
  readonly provider = 'cursor' as const;
  readonly surface = 'desktop' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly appPath: string;
  private readonly databasePath: string;
  private readonly cursorAgentProjectsDir: string;
  private readonly historyWindowMs: number;
  private readonly probeProcesses: boolean;
  private readonly now: () => number;
  private readonly source: Source;
  private readonly cliSource: Source;
  private readonly lastSeen = new Map<string, CursorSeenState>();

  constructor(options: CursorConnectorOptions) {
    this.engine = options.engine;
    this.appPath = options.appPath ?? '/Applications/Cursor.app';
    this.databasePath =
      options.databasePath ??
      join(
        homedir(),
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb',
      );
    this.cursorAgentProjectsDir =
      options.cursorAgentProjectsDir ??
      join(homedir(), '.cursor', 'projects');
    this.scanIntervalMs = options.scanIntervalMs ?? 15_000;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.probeProcesses = options.probeProcesses ?? true;
    this.now = options.now ?? (() => Date.now());
    this.source = {
      id: CURSOR_CONNECTOR_ID,
      provider: 'cursor',
      surface: 'desktop',
      device: options.device ?? hostname(),
    };
    this.cliSource = {
      id: CURSOR_AGENT_CLI_SOURCE_ID,
      provider: 'cursor',
      surface: 'cli',
      device: options.device ?? hostname(),
    };
  }

  async scan(ctx: ConnectorContext): Promise<ConnectorScanResult> {
    const appExists = existsSync(this.appPath);
    if (!existsSync(this.databasePath)) {
      if (!appExists) {
        throw new ConnectorUnsupportedError(
          'Cursor is not installed and its composer database is absent',
        );
      }
      return {
        observedSessionCount: 0,
        archivedSessionCount: 0,
        permissionState: 'unknown',
        warnings: [`Cursor composer database not found: ${this.databasePath}`],
      };
    }

    const inventory = readCursorComposerInventory(this.databasePath);
    const cliInventory = listCursorAgentTranscripts(
      this.cursorAgentProjectsDir,
    );
    const cliTranscripts = new Map(
      cliInventory.sessions.map((session) => [session.externalId, session]),
    );
    const warnings = [...inventory.warnings, ...cliInventory.warnings];
    if (!appExists) {
      warnings.push(
        `the default Cursor application path is absent (${this.appPath}); retained composers remain indexed, but return paths may not open`,
      );
    }

    let appRunning: boolean | undefined;
    if (this.probeProcesses) {
      try {
        appRunning = (await listProcesses(CURSOR_PROCESS_PATTERN)).length > 0;
      } catch (error) {
        warnings.push(
          `Cursor process liveness is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const now = this.now();
    const cutoff = now - this.historyWindowMs;
    const alreadyIndexed = ctx.store.externalIdsForSource(this.id);
    const cliAlreadyIndexed = ctx.store.externalIdsForSource(
      CURSOR_AGENT_CLI_SOURCE_ID,
    );
    const composerIds = new Set(
      inventory.composers.map((composer) => composer.composerId),
    );
    let observed = 0;
    let archived = 0;
    let untimed = 0;
    let futureTimestamps = 0;
    let historicalLiveStates = 0;

    for (const composer of inventory.composers) {
      if (ctx.signal.aborted) break;
      const activity = activityAtOf(composer, now);
      if (activity.missing) untimed += 1;
      if (activity.future) futureTimestamps += 1;
      const sourceArchived = composer.isArchived === true;
      const inTriage = !sourceArchived && activity.at >= cutoff;
      if (inTriage) observed += 1;
      else archived += 1;

      const persistedLooksLive =
        composer.hasBlockingPendingActions === true ||
        composer.hasPendingPlan === true ||
        composer.status === 'generating' ||
        composer.isContinuationInProgress === true ||
        composer.generatingBubbleCount > 0;
      if (!composer.currentHeader && persistedLooksLive) {
        historicalLiveStates += 1;
      }
      const hasCliTranscript = cliTranscripts.has(composer.composerId);
      const needsCliBackfill =
        hasCliTranscript && !cliAlreadyIndexed.has(composer.composerId);

      if (
        !inTriage &&
        !composer.currentHeader &&
        alreadyIndexed.has(composer.composerId) &&
        !needsCliBackfill
      ) {
        continue;
      }

      const lifecycle = lifecycleOf(composer);
      const previous = this.lastSeen.get(composer.composerId);
      const livenessStamp =
        lifecycle === 'running'
          ? appRunning === undefined
            ? 'unknown'
            : appRunning
              ? 'alive'
              : 'dead'
          : '-';
      const stamp = [
        composer.name ?? '',
        composer.subtitle ?? '',
        composer.lastUpdatedAt ?? composer.createdAt ?? '',
        lifecycle,
        composer.status ?? '',
        composer.generatingBubbleCount,
        composer.isContinuationInProgress ?? '',
        composer.hasBlockingPendingActions ?? '',
        composer.hasPendingPlan ?? '',
        composer.hasUnreadMessages ?? '',
        sourceArchived ? 'archived' : 'active',
        composer.workspacePath ?? '',
        composer.parentComposerId ?? '',
        composer.backgroundAgentId ?? '',
        livenessStamp,
      ].join(':');
      const heartbeatDue =
        lifecycle === 'running' &&
        appRunning !== false &&
        (previous?.lastRunningHeartbeatAt === undefined ||
          now - previous.lastRunningHeartbeatAt >= RUNNING_HEARTBEAT_MS);
      if (previous?.stamp === stamp && !heartbeatDue) continue;

      const stateChanged =
        previous !== undefined && previous.lifecycle !== lifecycle;
      const raw = rawLifecycle(composer);
      const observations: StoredObservation[] = [];
      const mustClearStoredBlock =
        explicitlyNonBlocking(composer) &&
        (previous?.lifecycle === 'blocked' ||
          hasStoredCursorBlock(ctx, composer.composerId));
      if (mustClearStoredBlock) {
        observations.push({
          signal: 'cursor.agent_resumed',
          at: now,
          raw,
          connectorId: this.id,
          surface: 'desktop',
        });
      }

      if (lifecycle === 'blocked') {
        observations.push({
          signal: 'cursor.agent_needs_attention',
          at: stateChanged ? now : activity.at,
          raw,
          connectorId: this.id,
          surface: 'desktop',
        });
      } else if (lifecycle === 'running') {
        if (appRunning === false) {
          observations.push(
            {
              signal: 'cursor.agent_running',
              at: Math.min(activity.at, Math.max(0, now - 1)),
              raw,
              connectorId: this.id,
              surface: 'desktop',
            },
            {
              signal: 'cursor.process_dead',
              at: now,
              raw: { persistedStatus: composer.status ?? 'unknown' },
              connectorId: this.id,
              surface: 'desktop',
            },
          );
        } else {
          observations.push({
            signal: 'cursor.agent_running',
            at: appRunning === true || stateChanged ? now : activity.at,
            raw,
            connectorId: this.id,
            surface: 'desktop',
          });
        }
      } else if (lifecycle === 'completed') {
        observations.push({
          signal: 'cursor.agent_completed',
          at: stateChanged ? now : activity.at,
          raw,
          connectorId: this.id,
          surface: 'desktop',
        });
      } else if (lifecycle === 'aborted') {
        observations.push({
          signal: 'cursor.agent_aborted',
          at: stateChanged ? now : activity.at,
          raw,
          connectorId: this.id,
          surface: 'desktop',
        });
      } else {
        observations.push({
          signal: 'cursor.agent_inventory_seen',
          at: activity.at,
          raw,
          connectorId: this.id,
          surface: 'desktop',
        });
      }

      const title = deriveTitle(composer.name ?? composer.subtitle, {
        fallback: '',
      });
      const fallback = fallbackLabel(
        composer.workspacePath ? basename(composer.workspacePath) : 'Cursor',
        composer.composerId,
      );
      const backgroundUrl = composer.backgroundAgentId
        ? `cursor://anysphere.cursor-deeplink/background-agent?bcId=${encodeURIComponent(
            composer.backgroundAgentId,
          )}`
        : undefined;
      const subagentSuffix = composer.parentComposerId
        ? ` (subagent of ${fallbackLabel('composer', composer.parentComposerId)})`
        : '';

      this.engine.observe({
        identity: canonicalKey('cursor', composer.composerId),
        provider: 'cursor',
        surface: 'desktop',
        title,
        titlePriority: title ? 30 : 0,
        fallbackTitle: fallback,
        source: this.source,
        externalId: composer.composerId,
        context: {
          ...(composer.workspacePath ? { cwd: composer.workspacePath } : {}),
          ...(composer.workspacePath
            ? { repo: basename(composer.workspacePath) }
            : {}),
          conversationId: composer.composerId,
          ...(backgroundUrl ? { url: backgroundUrl } : {}),
        },
        ...(backgroundUrl ? { url: backgroundUrl } : {}),
        locateHint: `Cursor → Agent history → ${title || fallback}${subagentSuffix}`,
        sourceArchived,
        observations,
        sourceActivityAt: activity.at,
        connectorId: this.id,
      });
      if (hasCliTranscript) {
        this.engine.observe({
          identity: canonicalKey('cursor', composer.composerId),
          provider: 'cursor',
          // Lifecycle came from the desktop metadata observation immediately
          // above. Adding a CLI return path must not change its threshold.
          surface: 'desktop',
          title: '',
          titlePriority: 0,
          fallbackTitle: fallback,
          source: this.cliSource,
          externalId: composer.composerId,
          context: {
            ...(composer.workspacePath ? { cwd: composer.workspacePath } : {}),
            ...(composer.workspacePath
              ? { repo: basename(composer.workspacePath) }
              : {}),
            conversationId: composer.composerId,
          },
          resumeCommand: `cursor-agent --resume ${composer.composerId}`,
          locateHint: `Cursor Agent CLI → ${title || fallback}`,
          observations: [],
          sourceActivityAt: activity.at,
          connectorId: this.id,
        });
        cliAlreadyIndexed.add(composer.composerId);
      }
      this.lastSeen.set(composer.composerId, {
        stamp,
        lifecycle,
        ...(lifecycle === 'running' && appRunning !== false
          ? { lastRunningHeartbeatAt: now }
          : {}),
      });
      alreadyIndexed.add(composer.composerId);
    }

    let unmatchedCliTranscripts = 0;
    for (const transcript of cliInventory.sessions) {
      if (ctx.signal.aborted || composerIds.has(transcript.externalId)) continue;
      unmatchedCliTranscripts += 1;
      const activityAt = Math.min(transcript.modifiedAt, now);
      const inTriage = activityAt >= cutoff;
      if (inTriage) observed += 1;
      else archived += 1;
      if (!inTriage && cliAlreadyIndexed.has(transcript.externalId)) continue;

      const fallback = fallbackLabel('Cursor Agent', transcript.externalId);
      this.engine.observe({
        identity: canonicalKey('cursor', transcript.externalId),
        provider: 'cursor',
        surface: 'cli',
        title: '',
        titlePriority: 0,
        fallbackTitle: fallback,
        source: this.cliSource,
        externalId: transcript.externalId,
        context: { conversationId: transcript.externalId },
        resumeCommand: `cursor-agent --resume ${transcript.externalId}`,
        locateHint: `Cursor Agent CLI → ${fallback}`,
        observations: [
          {
            signal: 'cursor.agent_inventory_seen',
            at: activityAt,
            raw: {
              sizeBytes: transcript.sizeBytes,
              metadataBoundary: 'filename-and-stat-only',
            },
            connectorId: this.id,
            surface: 'cli',
          },
        ],
        sourceActivityAt: activityAt,
        connectorId: this.id,
      });
      cliAlreadyIndexed.add(transcript.externalId);
    }

    if (untimed > 0) {
      warnings.push(
        `${untimed} Cursor composer(s) had no valid createdAt or lastUpdatedAt timestamp`,
      );
    }
    if (futureTimestamps > 0) {
      warnings.push(
        `${futureTimestamps} Cursor composer timestamp(s) were in the future and clamped to scan time`,
      );
    }
    if (historicalLiveStates > 0) {
      warnings.push(
        `${historicalLiveStates} history-only Cursor composer(s) retain live-looking fields outside the current header cache; those fields were not trusted as current lifecycle`,
      );
    }
    if (unmatchedCliTranscripts > 0) {
      warnings.push(
        `${unmatchedCliTranscripts} top-level Cursor Agent CLI transcript(s) had no safe desktop composer metadata; they were indexed from filename and stat only, so title and lifecycle remain unknown`,
      );
    }

    return {
      observedSessionCount: observed,
      archivedSessionCount: archived,
      permissionState: 'granted',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
