import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HISTORY_WINDOW_MS,
  canonicalKey,
  deriveTitle,
  fallbackLabel,
} from '@session-radar/shared';
import type {
  ClaudeAgentInventory,
  Source,
  Surface,
} from '@session-radar/shared';
import { z } from 'zod';
import type { StatusEngine } from '../../engine.js';
import type { Connector, ConnectorContext, ConnectorScanResult } from '../../registry.js';
import { ConnectorUnsupportedError } from '../../registry.js';
import type { StoredObservation } from '../../store.js';
import {
  ClaudeDesktopSessionsDirMissingError,
  claudeDesktopSessionsDir,
  listClaudeDesktopSessionFiles,
  readClaudeDesktopSession,
} from './claude-code.js';
import {
  CLAUDE_REACT_QUERY_CACHE_KEY,
  jsonObjectContainingMarker,
} from './claude-chat.js';
import {
  decodeChromiumString,
  readChromiumLocalStorageRecords,
} from './chromium-local-storage.js';

export const CLAUDE_AGENT_SESSIONS_CONNECTOR_ID = 'claude-agent-sessions';
export const CLAUDE_AGENT_SESSIONS_QUERY = 'sessions_api_list_sessions';

const MAX_CACHE_AGE_MS = 5 * 60_000;
const REMOTE_ID = /^(?:session|cse)_[A-Za-z0-9._:-]+$/u;

function normalizeRemoteId(id: string): string {
  return id.replace(/^cse_/u, 'session_');
}

const postTurnSummarySchema = z
  .object({
    /**
     * The same object can contain content-bearing `needs_action`,
     * `status_detail`, and description fields. They are deliberately omitted
     * from this projection and stripped immediately.
     */
    status_category: z.string().max(64).optional(),
  })
  .strip();

const agentSessionSchema = z
  .object({
    id: z.string().regex(REMOTE_ID),
    title: z.string().nullable().optional(),
    session_status: z.string().max(64).optional(),
    worker_status: z.string().max(64).optional(),
    connection_status: z.string().max(64).optional(),
    environment_kind: z.string().max(64).optional(),
    origin: z.string().max(64).optional(),
    unread: z.boolean().optional(),
    created_at: z.string().datetime({ offset: true }).nullable().optional(),
    updated_at: z.string().datetime({ offset: true }).nullable().optional(),
    post_turn_summary: postTurnSummarySchema.nullable().optional(),
  })
  .strip();

const reactQuerySchema = z
  .object({
    queryKey: z.array(z.unknown()),
    state: z
      .object({
        data: z.unknown(),
        dataUpdatedAt: z.number().int().nonnegative().optional(),
      })
      .strip(),
  })
  .strip();

const sessionPageSchema = z
  .object({
    data: z.array(z.unknown()),
    has_more: z.boolean().optional(),
  })
  .strip();

const infiniteSessionDataSchema = z
  .object({
    pages: z.array(z.unknown()),
  })
  .strip();

export type ClaudeAgentSessionMetadata = z.infer<typeof agentSessionSchema> & {
  cacheUpdatedAt?: number;
  url?: string;
  sourceArchived?: boolean;
};

/**
 * The browser heartbeat owns persistence; the daemon only needs the newest
 * sanitized snapshot in memory. Monotonic replacement prevents a delayed tab
 * response from rolling account state backwards.
 */
export class ClaudeAgentAccountSnapshotStore {
  private inventory: ClaudeAgentInventory | undefined;
  private stamp: string | undefined;

  update(inventory: ClaudeAgentInventory): boolean {
    if (this.inventory && inventory.at < this.inventory.at) return false;
    const stamp = JSON.stringify(inventory);
    if (inventory.at === this.inventory?.at && stamp === this.stamp) {
      return false;
    }
    this.inventory = inventory;
    this.stamp = stamp;
    return true;
  }

  current(): ClaudeAgentInventory | undefined {
    return this.inventory;
  }
}

export interface ClaudeAgentSessionsCache {
  sessions: ClaudeAgentSessionMetadata[];
  warnings: string[];
  foundCacheKey: boolean;
  foundSessionsQuery: boolean;
  hasMore: boolean;
  newestCacheUpdatedAt?: number;
}

export interface ClaudeBridgeIdentityMap {
  canonicalByBridgeId: Map<string, string>;
  warnings: string[];
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'value'} ${issue.message}`)
    .join('; ');
}

function projectSessions(
  items: readonly unknown[],
  cacheUpdatedAt: number | undefined,
  result: ClaudeAgentSessionsCache,
): void {
  for (const [index, item] of items.entries()) {
    const parsed = agentSessionSchema.safeParse(item);
    if (!parsed.success) {
      result.warnings.push(
        `Claude agent-session item ${index} was not ingested: ${describeZodError(parsed.error)}`,
      );
      continue;
    }
    result.sessions.push({
      ...parsed.data,
      id: normalizeRemoteId(parsed.data.id),
      ...(cacheUpdatedAt !== undefined ? { cacheUpdatedAt } : {}),
    });
  }
}

function projectSessionData(
  data: unknown,
  cacheUpdatedAt: number | undefined,
  result: ClaudeAgentSessionsCache,
): void {
  const finite = sessionPageSchema.safeParse(data);
  if (finite.success) {
    projectSessions(finite.data.data, cacheUpdatedAt, result);
    if (finite.data.has_more === true) result.hasMore = true;
    return;
  }

  const infinite = infiniteSessionDataSchema.safeParse(data);
  if (!infinite.success) {
    result.warnings.push(
      `Claude agent-session data has an unrecognised schema: ${describeZodError(
        infinite.error,
      )}`,
    );
    return;
  }

  for (const rawPage of infinite.data.pages) {
    const page = sessionPageSchema.safeParse(rawPage);
    if (!page.success) {
      result.warnings.push(
        `Claude agent-session page has an unrecognised schema: ${describeZodError(
          page.error,
        )}`,
      );
      continue;
    }
    projectSessions(page.data.data, cacheUpdatedAt, result);
    if (page.data.has_more === true) result.hasMore = true;
  }
}

/**
 * Parse only the persisted React Query object whose query key is the first-party
 * cross-device session list. Other cached queries are not materialised.
 */
function parseAgentSessionsCache(
  encoded: Buffer,
  result: ClaudeAgentSessionsCache,
): void {
  const json = decodeChromiumString(encoded);
  if (json === undefined) {
    result.warnings.push(
      `${CLAUDE_REACT_QUERY_CACHE_KEY} uses an unrecognised Chromium string encoding`,
    );
    return;
  }

  const marker = `"queryKey":["${CLAUDE_AGENT_SESSIONS_QUERY}"`;
  let cursor = 0;
  while ((cursor = json.indexOf(marker, cursor)) >= 0) {
    const objectJson = jsonObjectContainingMarker(json, cursor);
    cursor += marker.length;
    if (!objectJson) {
      result.warnings.push('could not isolate the persisted Claude agent-session query');
      continue;
    }

    let rawQuery: unknown;
    try {
      rawQuery = JSON.parse(objectJson) as unknown;
    } catch (error) {
      result.warnings.push(
        `persisted Claude agent-session query contains invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    const query = reactQuerySchema.safeParse(rawQuery);
    if (
      !query.success ||
      query.data.queryKey[0] !== CLAUDE_AGENT_SESSIONS_QUERY
    ) {
      result.warnings.push('persisted Claude agent-session query has an unrecognised schema');
      continue;
    }

    result.foundSessionsQuery = true;
    const cacheUpdatedAt = query.data.state.dataUpdatedAt;
    if (
      cacheUpdatedAt !== undefined &&
      (result.newestCacheUpdatedAt === undefined ||
        cacheUpdatedAt > result.newestCacheUpdatedAt)
    ) {
      result.newestCacheUpdatedAt = cacheUpdatedAt;
    }
    projectSessionData(query.data.state.data, cacheUpdatedAt, result);
  }
}

export async function readClaudeAgentSessionsCache(
  levelDbPath: string,
): Promise<ClaudeAgentSessionsCache> {
  const result: ClaudeAgentSessionsCache = {
    sessions: [],
    warnings: [],
    foundCacheKey: false,
    foundSessionsQuery: false,
    hasMore: false,
  };
  const records = await readChromiumLocalStorageRecords(
    levelDbPath,
    new Set([CLAUDE_REACT_QUERY_CACHE_KEY]),
  );
  result.foundCacheKey = records.length > 0;
  for (const record of records) parseAgentSessionsCache(record.value, result);
  return result;
}

/**
 * Build the explicit server-session -> local-session join written by Claude
 * Desktop. Ambiguous mappings are discarded rather than guessed.
 */
export function readClaudeBridgeIdentityMap(
  sessionsDir: string,
): ClaudeBridgeIdentityMap {
  const result: ClaudeBridgeIdentityMap = {
    canonicalByBridgeId: new Map(),
    warnings: [],
  };
  let files;
  try {
    files = listClaudeDesktopSessionFiles(sessionsDir);
  } catch (error) {
    if (error instanceof ClaudeDesktopSessionsDirMissingError) {
      result.warnings.push(
        'local Claude Code join metadata is unavailable; cloud sessions remain visible but may duplicate local CLI rows',
      );
      return result;
    }
    throw error;
  }

  const conflicts = new Set<string>();
  let malformed = 0;
  let invalidBridgeIds = 0;
  for (const file of files) {
    let session;
    try {
      session = readClaudeDesktopSession(file);
    } catch {
      malformed += 1;
      continue;
    }
    const canonicalId = session.cliSessionId ?? session.sessionId;
    for (const rawBridgeId of session.bridgeSessionIds ?? []) {
      if (!REMOTE_ID.test(rawBridgeId)) {
        invalidBridgeIds += 1;
        continue;
      }
      const bridgeId = normalizeRemoteId(rawBridgeId);
      if (conflicts.has(bridgeId)) continue;
      const existing = result.canonicalByBridgeId.get(bridgeId);
      if (existing !== undefined && existing !== canonicalId) {
        conflicts.add(bridgeId);
        result.canonicalByBridgeId.delete(bridgeId);
      } else {
        result.canonicalByBridgeId.set(bridgeId, canonicalId);
      }
    }
  }

  if (malformed > 0) {
    result.warnings.push(
      `${malformed} local Claude Code metadata file(s) could not be used for cross-device identity joins`,
    );
  }
  if (invalidBridgeIds > 0) {
    result.warnings.push(
      `${invalidBridgeIds} local Claude Code bridge id(s) had an unrecognised format and were not joined`,
    );
  }
  if (conflicts.size > 0) {
    result.warnings.push(
      `${conflicts.size} Claude bridge id(s) mapped to multiple local sessions and were not joined`,
    );
  }
  return result;
}

function emptySessionsCache(): ClaudeAgentSessionsCache {
  return {
    sessions: [],
    warnings: [],
    foundCacheKey: false,
    foundSessionsQuery: false,
    hasMore: false,
  };
}

function sessionsFromAccountInventory(
  inventory: ClaudeAgentInventory,
): ClaudeAgentSessionMetadata[] {
  return inventory.items.map((item) => ({
    id: normalizeRemoteId(item.sessionId),
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.sessionStatus !== undefined
      ? { session_status: item.sessionStatus }
      : {}),
    ...(item.workerStatus !== undefined
      ? { worker_status: item.workerStatus }
      : {}),
    ...(item.connectionStatus !== undefined
      ? { connection_status: item.connectionStatus }
      : {}),
    ...(item.environmentKind !== undefined
      ? { environment_kind: item.environmentKind }
      : {}),
    ...(item.origin !== undefined ? { origin: item.origin } : {}),
    ...(item.unread !== undefined ? { unread: item.unread } : {}),
    ...(item.createdAt !== undefined
      ? { created_at: new Date(item.createdAt).toISOString() }
      : {}),
    ...(item.updatedAt !== undefined
      ? { updated_at: new Date(item.updatedAt).toISOString() }
      : {}),
    ...(item.statusCategory !== undefined
      ? { post_turn_summary: { status_category: item.statusCategory } }
      : {}),
    cacheUpdatedAt: inventory.at,
    url: item.url,
    sourceArchived: item.archived,
  }));
}

function timestampOf(session: ClaudeAgentSessionMetadata): number | undefined {
  const raw = session.updated_at ?? session.created_at;
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

function preferSession(
  current: ClaudeAgentSessionMetadata | undefined,
  incoming: ClaudeAgentSessionMetadata,
): ClaudeAgentSessionMetadata {
  if (!current) return incoming;
  const currentAt = timestampOf(current) ?? 0;
  const incomingAt = timestampOf(incoming) ?? 0;
  if (incomingAt > currentAt) return incoming;
  if (incomingAt < currentAt) return current;
  const currentCacheAt = current.cacheUpdatedAt ?? 0;
  const incomingCacheAt = incoming.cacheUpdatedAt ?? 0;
  if (incomingCacheAt > currentCacheAt) return incoming;
  if (incomingCacheAt < currentCacheAt) return current;
  return incoming.title && !current.title ? incoming : current;
}

const RUNNING_STATES = new Set(['running']);
const KNOWN_SESSION_STATES = new Set([
  'running',
  'idle',
  'paused',
  'archived',
  'pending',
  'requires_action',
]);
const KNOWN_WORKER_STATES = new Set(['running', 'idle', 'requires_action']);
const BLOCKING_CATEGORIES = new Set(['need_input', 'blocked', 'failed']);
const COMPLETION_CATEGORIES = new Set(['review_ready']);
const KNOWN_CATEGORIES = new Set([
  ...BLOCKING_CATEGORIES,
  ...COMPLETION_CATEGORIES,
]);
const KNOWN_CONNECTION_STATES = new Set(['connected', 'disconnected']);
const KNOWN_ENVIRONMENT_KINDS = new Set(['bridge', 'anthropic_cloud']);

type Lifecycle = 'running' | 'needs_input' | 'review_ready' | 'inventory';

function lifecycleOf(session: ClaudeAgentSessionMetadata): Lifecycle {
  if (
    session.session_status !== undefined &&
    RUNNING_STATES.has(session.session_status)
  ) {
    return 'running';
  }
  if (
    session.session_status === undefined &&
    session.worker_status !== undefined &&
    RUNNING_STATES.has(session.worker_status)
  ) {
    return 'running';
  }
  const category = session.post_turn_summary?.status_category;
  if (category !== undefined && BLOCKING_CATEGORIES.has(category)) {
    return 'needs_input';
  }
  if (category !== undefined && COMPLETION_CATEGORIES.has(category)) {
    return 'review_ready';
  }
  return 'inventory';
}

interface OriginInfo {
  sourceId: string;
  surface: Surface;
  locatePrefix: string;
}

function originInfo(session: ClaudeAgentSessionMetadata): OriginInfo {
  switch (session.origin) {
    case 'claude_code_cli':
      return {
        sourceId: 'claude-agent-cli',
        surface: 'cli',
        locatePrefix: 'Claude → Code sessions',
      };
    case 'desktop_app':
      return {
        sourceId: 'claude-agent-desktop',
        surface: 'desktop',
        locatePrefix: 'Claude Desktop → Home → Cowork',
      };
    case 'web_claude_ai':
      return {
        sourceId: 'claude-agent-web',
        surface: 'web',
        locatePrefix: 'claude.ai → Home → Cowork',
      };
    case 'ios':
      return {
        sourceId: 'claude-agent-ios',
        surface: 'mobile',
        locatePrefix: 'Claude for iOS → Home → Cowork',
      };
    case 'android':
      return {
        sourceId: 'claude-agent-android',
        surface: 'mobile',
        locatePrefix: 'Claude for Android → Home → Cowork',
      };
    default:
      return session.environment_kind === 'bridge'
        ? {
            sourceId: 'claude-agent-cli',
            surface: 'cli',
            locatePrefix: 'Claude → Code sessions',
          }
        : {
            sourceId: 'claude-agent-unknown',
            surface: 'web',
            locatePrefix: 'Claude → Home → Cowork',
          };
  }
}

function safeRaw(
  session: ClaudeAgentSessionMetadata,
  cacheUpdatedAt: number | undefined,
  mappedToLocal: boolean,
): Record<string, unknown> {
  const category = session.post_turn_summary?.status_category;
  return {
    ...(session.session_status !== undefined &&
    KNOWN_SESSION_STATES.has(session.session_status)
      ? { sessionStatus: session.session_status }
      : {}),
    ...(session.worker_status !== undefined &&
    KNOWN_WORKER_STATES.has(session.worker_status)
      ? { workerStatus: session.worker_status }
      : {}),
    ...(category !== undefined && KNOWN_CATEGORIES.has(category)
      ? { statusCategory: category }
      : {}),
    ...(session.connection_status !== undefined &&
    KNOWN_CONNECTION_STATES.has(session.connection_status)
      ? { connectionStatus: session.connection_status }
      : {}),
    ...(session.environment_kind !== undefined &&
    KNOWN_ENVIRONMENT_KINDS.has(session.environment_kind)
      ? { environmentKind: session.environment_kind }
      : {}),
    ...(session.origin !== undefined &&
    ['claude_code_cli', 'desktop_app', 'web_claude_ai', 'ios', 'android'].includes(
      session.origin,
    )
      ? { origin: session.origin }
      : {}),
    ...(session.unread !== undefined ? { unread: session.unread } : {}),
    ...(cacheUpdatedAt !== undefined ? { cacheUpdatedAt } : {}),
    mappedToLocal,
  };
}

function observationsFor(
  lifecycle: Lifecycle,
  at: number,
  raw: Record<string, unknown>,
  connectorId: string,
  surface: Surface,
): StoredObservation[] {
  switch (lifecycle) {
    case 'running':
      return [
        {
          signal: 'claude.agent_resumed',
          at,
          raw,
          connectorId,
          surface,
        },
        {
          signal: 'claude.agent_running',
          at,
          raw,
          connectorId,
          surface,
        },
      ];
    case 'needs_input':
      return [
        {
          signal: 'claude.agent_needs_input',
          at,
          raw,
          connectorId,
          surface,
        },
      ];
    case 'review_ready':
      return [
        {
          signal: 'claude.agent_review_ready',
          at,
          raw,
          connectorId,
          surface,
        },
      ];
    case 'inventory':
      return [
        {
          signal: 'claude.agent_inventory_seen',
          at,
          raw,
          connectorId,
          surface,
        },
      ];
  }
}

export interface ClaudeAgentSessionsConnectorOptions {
  engine: StatusEngine;
  accountSnapshots?: ClaudeAgentAccountSnapshotStore;
  appPath?: string;
  levelDbPath?: string;
  sessionsDir?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  device?: string;
  now?: () => number;
}

/**
 * Claude's persisted account-level agent-session inventory.
 *
 * This is distinct from ordinary Claude chat history. It covers Cowork and
 * Claude Code sessions created from CLI, desktop, web, and mobile. The source
 * reports running/idle and post-turn categories; local `bridgeSessionIds`
 * provide a first-party join back to CLI UUIDs so those rows merge rather than
 * duplicate.
 */
export class ClaudeAgentSessionsConnector implements Connector {
  readonly id = CLAUDE_AGENT_SESSIONS_CONNECTOR_ID;
  readonly displayName = 'Claude cross-device agent sessions';
  readonly provider = 'anthropic' as const;
  readonly surface = 'desktop' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly accountSnapshots: ClaudeAgentAccountSnapshotStore;
  private readonly appPath: string;
  private readonly levelDbPath: string;
  private readonly sessionsDir: string;
  private readonly historyWindowMs: number;
  private readonly device: string;
  private readonly now: () => number;
  private readonly lastSeen = new Map<string, string>();

  constructor(options: ClaudeAgentSessionsConnectorOptions) {
    this.engine = options.engine;
    this.accountSnapshots =
      options.accountSnapshots ?? new ClaudeAgentAccountSnapshotStore();
    this.appPath = options.appPath ?? '/Applications/Claude.app';
    this.levelDbPath =
      options.levelDbPath ??
      join(
        homedir(),
        'Library',
        'Application Support',
        'Claude',
        'Local Storage',
        'leveldb',
      );
    this.sessionsDir = options.sessionsDir ?? claudeDesktopSessionsDir();
    this.scanIntervalMs = options.scanIntervalMs ?? 30_000;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.device = options.device ?? hostname();
    this.now = options.now ?? (() => Date.now());
  }

  async scan(ctx: ConnectorContext): Promise<ConnectorScanResult> {
    const now = this.now();
    const accountInventory = this.accountSnapshots.current();
    const accountInventoryFresh =
      accountInventory !== undefined &&
      accountInventory.at <= now &&
      now - accountInventory.at <= MAX_CACHE_AGE_MS;
    const completeFreshAccountInventory =
      accountInventoryFresh &&
      accountInventory?.completeness === 'complete' &&
      (accountInventory.rejectedItems ?? 0) === 0 &&
      (accountInventory.unknownEnumValues ?? 0) === 0 &&
      accountInventory.error === undefined;
    const appExists = existsSync(this.appPath);
    const cacheExists = existsSync(this.levelDbPath);

    if (!appExists && accountInventory === undefined) {
      throw new ConnectorUnsupportedError(
        'Claude Desktop is not installed and no claude.ai agent inventory has arrived',
      );
    }

    let cache = emptySessionsCache();
    const warnings: string[] = [];
    if (accountInventory) {
      if (accountInventory.at > now) {
        warnings.push(
          'the claude.ai agent inventory has a future timestamp and cannot prove current completeness',
        );
      } else if (!accountInventoryFresh) {
        warnings.push(
          `the claude.ai agent inventory has not refreshed for ${Math.round(
            (now - accountInventory.at) / 60_000,
          )} minutes; current cross-device state may be stale`,
        );
      }
      if (accountInventory.completeness !== 'complete') {
        warnings.push(
          `the claude.ai agent inventory is ${accountInventory.completeness}: ${
            accountInventory.error ?? accountInventory.basis
          }`,
        );
      }
      if ((accountInventory.rejectedItems ?? 0) > 0) {
        warnings.push(
          `${accountInventory.rejectedItems} claude.ai agent row(s) were rejected by the metadata contract`,
        );
      }
      if ((accountInventory.unknownEnumValues ?? 0) > 0) {
        warnings.push(
          `${accountInventory.unknownEnumValues} claude.ai agent enum value(s) were unrecognised and not guessed`,
        );
      }
    }

    // A fresh, complete account snapshot is authoritative for the session set.
    // The desktop cache is only a fallback and is often a single stale page.
    if (!completeFreshAccountInventory) {
      if (!appExists) {
        warnings.push(
          'Claude Desktop is not installed; only the incomplete claude.ai agent inventory is available',
        );
      } else if (!cacheExists) {
        warnings.push(
          `Claude cross-device session cache not found: ${this.levelDbPath}`,
        );
      } else {
        cache = await readClaudeAgentSessionsCache(this.levelDbPath);
        warnings.push(...cache.warnings);
        if (!cache.foundCacheKey) {
          warnings.push(
            `${CLAUDE_REACT_QUERY_CACHE_KEY} was not present in the desktop cache`,
          );
        }
        if (!cache.foundSessionsQuery) {
          warnings.push(
            `${CLAUDE_AGENT_SESSIONS_QUERY} was not present; the desktop cache cannot enumerate cross-device agent sessions`,
          );
        }
        if (cache.hasMore) {
          warnings.push(
            'the active/paused Claude agent-session cache reports has_more=true; the complete account inventory cannot be proven from this page',
          );
        }
        if (
          cache.newestCacheUpdatedAt !== undefined &&
          now - cache.newestCacheUpdatedAt > MAX_CACHE_AGE_MS
        ) {
          warnings.push(
            `the Claude agent-session cache has not refreshed for ${Math.round(
              (now - cache.newestCacheUpdatedAt) / 60_000,
            )} minutes; current cross-device state may be stale`,
          );
        }
        if (
          cache.newestCacheUpdatedAt !== undefined &&
          cache.newestCacheUpdatedAt > now
        ) {
          warnings.push(
            'the Claude agent-session cache has a future refresh timestamp; lifecycle recency was clamped to scan time',
          );
        }
      }
    }

    const bridgeMap = readClaudeBridgeIdentityMap(this.sessionsDir);
    warnings.push(...bridgeMap.warnings);

    const merged = new Map<string, ClaudeAgentSessionMetadata>();
    for (const session of cache.sessions) {
      merged.set(session.id, preferSession(merged.get(session.id), session));
    }
    for (const session of accountInventory
      ? sessionsFromAccountInventory(accountInventory)
      : []) {
      merged.set(session.id, preferSession(merged.get(session.id), session));
    }

    let unknownSessionStates = 0;
    let unknownWorkerStates = 0;
    let unknownCategories = 0;
    let unknownOrigins = 0;
    for (const session of merged.values()) {
      if (
        session.session_status !== undefined &&
        !KNOWN_SESSION_STATES.has(session.session_status)
      ) {
        unknownSessionStates += 1;
      }
      if (
        session.worker_status !== undefined &&
        !KNOWN_WORKER_STATES.has(session.worker_status)
      ) {
        unknownWorkerStates += 1;
      }
      const category = session.post_turn_summary?.status_category;
      if (category !== undefined && !KNOWN_CATEGORIES.has(category)) {
        unknownCategories += 1;
      }
      if (
        session.origin !== undefined &&
        !['claude_code_cli', 'desktop_app', 'web_claude_ai', 'ios', 'android'].includes(
          session.origin,
        )
      ) {
        unknownOrigins += 1;
      }
    }
    if (unknownSessionStates > 0) {
      warnings.push(
        `${unknownSessionStates} Claude agent session status value(s) were unrecognised and not guessed`,
      );
    }
    if (unknownWorkerStates > 0) {
      warnings.push(
        `${unknownWorkerStates} Claude agent worker status value(s) were unrecognised and not guessed`,
      );
    }
    if (unknownCategories > 0) {
      warnings.push(
        `${unknownCategories} Claude post-turn status category value(s) were unrecognised and not guessed`,
      );
    }
    if (unknownOrigins > 0) {
      warnings.push(
        `${unknownOrigins} Claude agent origin value(s) were unrecognised and shown as a generic account session`,
      );
    }

    const cutoff = now - this.historyWindowMs;
    const indexedBySource = new Map<string, Set<string>>();
    const externalIdsForSource = (sourceId: string): Set<string> => {
      const existing = indexedBySource.get(sourceId);
      if (existing) return existing;
      const loaded = ctx.store.externalIdsForSource(sourceId);
      indexedBySource.set(sourceId, loaded);
      return loaded;
    };
    let observed = 0;
    let archived = 0;
    let untimedSessions = 0;
    let futureTimestamps = 0;

    for (const session of merged.values()) {
      if (ctx.signal.aborted) break;
      const sourceActivityAt = timestampOf(session);
      if (sourceActivityAt === undefined) untimedSessions += 1;
      const activityAt =
        sourceActivityAt === undefined ? 0 : Math.min(sourceActivityAt, now);
      if (sourceActivityAt !== undefined && sourceActivityAt > now) {
        futureTimestamps += 1;
      }
      const sourceArchived =
        session.sourceArchived ?? session.session_status === 'archived';
      const inTriage = !sourceArchived && activityAt >= cutoff;
      if (inTriage) observed += 1;
      else archived += 1;

      const canonicalId =
        bridgeMap.canonicalByBridgeId.get(session.id) ?? session.id;
      const mappedToLocal = canonicalId !== session.id;
      const lifecycle = lifecycleOf(session);
      const title = deriveTitle(session.title, { fallback: '' });
      const info = originInfo(session);
      const alreadyIndexed = externalIdsForSource(info.sourceId);
      const metadataOnlyArchiveRefresh =
        !inTriage &&
        alreadyIndexed.has(session.id);
      const identity = canonicalKey('anthropic', canonicalId);
      if (mappedToLocal) {
        this.engine.mergeCanonicalIdentity(
          canonicalKey('anthropic', session.id),
          identity,
          info.surface,
          this.id,
        );
      }
      const cacheObservedAt = Math.min(
        Math.max(activityAt, session.cacheUpdatedAt ?? activityAt),
        now,
      );
      const lifecycleAt = lifecycle === 'running' ? cacheObservedAt : activityAt;
      const url =
        session.url ??
        `https://claude.ai/cowork/${encodeURIComponent(
          normalizeRemoteId(session.id),
        )}`;
      const stamp = [
        canonicalId,
        title,
        activityAt,
        lifecycle,
        session.session_status ?? '',
        session.worker_status ?? '',
        session.post_turn_summary?.status_category ?? '',
        lifecycle === 'running' ? cacheObservedAt : '',
        sourceArchived ? 'archived' : 'active',
        url,
      ].join(':');
      if (this.lastSeen.get(session.id) === stamp) continue;
      this.lastSeen.set(session.id, stamp);

      const raw = safeRaw(
        session,
        lifecycle === 'running' ? session.cacheUpdatedAt : undefined,
        mappedToLocal,
      );
      const source: Source = {
        id: info.sourceId,
        provider: 'anthropic',
        surface: info.surface,
        device: this.device,
      };
      const fallback = fallbackLabel(undefined, canonicalId);

      this.engine.observe({
        identity,
        provider: 'anthropic',
        surface: info.surface,
        title,
        titlePriority: title ? 30 : 0,
        fallbackTitle: fallback,
        source,
        externalId: session.id,
        context: { conversationId: session.id, url },
        url,
        locateHint: `${info.locatePrefix} → ${title || fallback}`,
        sourceArchived,
        // Joined idle inventory must not overwrite stronger local completion,
        // but its return path is still valuable as an entry point.
        observations:
          metadataOnlyArchiveRefresh ||
          (mappedToLocal && lifecycle === 'inventory')
            ? []
            : observationsFor(
                lifecycle,
                lifecycleAt,
                raw,
                this.id,
                info.surface,
              ),
        sourceActivityAt: activityAt,
        connectorId: this.id,
      });
      alreadyIndexed.add(session.id);
    }
    if (untimedSessions > 0) {
      warnings.push(
        `${untimedSessions} Claude agent session(s) had no valid created_at or updated_at timestamp`,
      );
    }
    if (futureTimestamps > 0) {
      warnings.push(
        `${futureTimestamps} Claude agent session timestamp(s) were in the future and clamped to scan time`,
      );
    }

    return {
      observedSessionCount: observed,
      archivedSessionCount: archived,
      permissionState:
        completeFreshAccountInventory ||
        cache.foundSessionsQuery ||
        (accountInventory?.items.length ?? 0) > 0
          ? 'granted'
          : 'unknown',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
