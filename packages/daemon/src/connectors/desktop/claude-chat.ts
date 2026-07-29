import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HISTORY_WINDOW_MS,
  canonicalKey,
  deriveTitle,
  fallbackLabel,
} from '@session-radar/shared';
import type { Source } from '@session-radar/shared';
import { z } from 'zod';
import type { StatusEngine } from '../../engine.js';
import type { Connector, ConnectorContext, ConnectorScanResult } from '../../registry.js';
import { ConnectorUnsupportedError } from '../../registry.js';
import {
  decodeChromiumString,
  readChromiumLocalStorageRecords,
} from './chromium-local-storage.js';

export const CLAUDE_DESKTOP_CHAT_CONNECTOR_ID = 'claude-desktop';
export const CLAUDE_REACT_QUERY_CACHE_KEY = 'react-query-cache-ls';
const CLAUDE_CONVERSATION_QUERY = 'chat_conversation_list';

/**
 * This is deliberately narrower than the API record. In particular, the list
 * response also contains a multi-kilobyte `summary`; zod strips it immediately
 * and it is never returned, logged or persisted.
 */
const claudeConversationSchema = z
  .object({
    uuid: z.string().min(1),
    name: z.string().nullable().optional(),
    created_at: z.string().datetime({ offset: true }).nullable().optional(),
    updated_at: z.string().datetime({ offset: true }).nullable().optional(),
    is_starred: z.boolean().optional(),
    is_temporary: z.boolean().optional(),
    project_uuid: z.string().nullable().optional(),
    platform: z.string().optional(),
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

const conversationPageSchema = z
  .object({
    data: z.array(z.unknown()),
    has_more: z.boolean().optional(),
  })
  .strip();

const infiniteConversationDataSchema = z
  .object({
    pages: z.array(z.unknown()),
  })
  .strip();

export type ClaudeChatConversationMetadata = z.infer<typeof claudeConversationSchema>;

export interface ClaudeDesktopChatCache {
  conversations: ClaudeChatConversationMetadata[];
  warnings: string[];
  foundCacheKey: boolean;
  foundConversationQuery: boolean;
  hasMore: boolean;
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'value'} ${issue.message}`)
    .join('; ');
}

/**
 * Return the JSON object containing a marker without parsing unrelated cached
 * queries. String contents are skipped lexically; only the selected query
 * object is materialised with JSON.parse.
 */
export function jsonObjectContainingMarker(
  json: string,
  markerIndex: number,
): string | undefined {
  const stack: number[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < markerIndex; index += 1) {
    const char = json[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push(index);
    else if (char === '}') stack.pop();
  }

  const start = stack.at(-1);
  if (start === undefined) return undefined;

  let depth = 0;
  inString = false;
  escaped = false;
  for (let index = start; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return json.slice(start, index + 1);
    }
  }
  return undefined;
}

function projectConversationItems(
  items: readonly unknown[],
  warnings: string[],
): ClaudeChatConversationMetadata[] {
  const projected: ClaudeChatConversationMetadata[] = [];
  for (const [index, item] of items.entries()) {
    const parsed = claudeConversationSchema.safeParse(item);
    if (parsed.success) {
      projected.push(parsed.data);
    } else {
      warnings.push(
        `Claude conversation-list item ${index} was not ingested: ${describeZodError(parsed.error)}`,
      );
    }
  }
  return projected;
}

function projectConversationData(
  data: unknown,
  result: ClaudeDesktopChatCache,
): void {
  const finite = conversationPageSchema.safeParse(data);
  if (finite.success) {
    result.conversations.push(
      ...projectConversationItems(finite.data.data, result.warnings),
    );
    if (finite.data.has_more === true) result.hasMore = true;
    return;
  }

  const infinite = infiniteConversationDataSchema.safeParse(data);
  if (!infinite.success) {
    result.warnings.push(
      `Claude conversation-list data has an unrecognised schema: ${describeZodError(
        infinite.error,
      )}`,
    );
    return;
  }
  for (const rawPage of infinite.data.pages) {
    const page = conversationPageSchema.safeParse(rawPage);
    if (!page.success) {
      result.warnings.push(
        `Claude conversation-list page has an unrecognised schema: ${describeZodError(
          page.error,
        )}`,
      );
      continue;
    }
    result.conversations.push(
      ...projectConversationItems(page.data.data, result.warnings),
    );
    if (page.data.has_more === true) result.hasMore = true;
  }
}

function parseReactQueryCache(
  encoded: Buffer,
  result: ClaudeDesktopChatCache,
): void {
  const json = decodeChromiumString(encoded);
  if (json === undefined) {
    result.warnings.push(
      `${CLAUDE_REACT_QUERY_CACHE_KEY} uses an unrecognised Chromium string encoding`,
    );
    return;
  }

  const marker = `"queryKey":["${CLAUDE_CONVERSATION_QUERY}"`;
  let cursor = 0;
  while ((cursor = json.indexOf(marker, cursor)) >= 0) {
    const objectJson = jsonObjectContainingMarker(json, cursor);
    cursor += marker.length;
    if (!objectJson) {
      result.warnings.push('could not isolate one persisted React Query record');
      continue;
    }

    let rawQuery: unknown;
    try {
      rawQuery = JSON.parse(objectJson) as unknown;
    } catch (error) {
      result.warnings.push(
        `persisted React Query record contains invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    const query = reactQuerySchema.safeParse(rawQuery);
    if (!query.success || query.data.queryKey[0] !== CLAUDE_CONVERSATION_QUERY) {
      continue;
    }
    result.foundConversationQuery = true;
    projectConversationData(query.data.state.data, result);
  }
}

export async function readClaudeDesktopChatCache(
  levelDbPath: string,
): Promise<ClaudeDesktopChatCache> {
  const result: ClaudeDesktopChatCache = {
    conversations: [],
    warnings: [],
    foundCacheKey: false,
    foundConversationQuery: false,
    hasMore: false,
  };
  const records = await readChromiumLocalStorageRecords(
    levelDbPath,
    new Set([CLAUDE_REACT_QUERY_CACHE_KEY]),
  );
  result.foundCacheKey = records.length > 0;
  for (const record of records) parseReactQueryCache(record.value, result);
  return result;
}

function timestampOf(conversation: ClaudeChatConversationMetadata): number | undefined {
  const raw = conversation.updated_at ?? conversation.created_at;
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

function preferConversation(
  current: ClaudeChatConversationMetadata | undefined,
  incoming: ClaudeChatConversationMetadata,
): ClaudeChatConversationMetadata {
  if (!current) return incoming;
  const currentAt = timestampOf(current) ?? 0;
  const incomingAt = timestampOf(incoming) ?? 0;
  if (incomingAt > currentAt) return incoming;
  if (incomingAt < currentAt) return current;
  return incoming.name && !current.name ? incoming : current;
}

export interface ClaudeDesktopChatConnectorOptions {
  engine: StatusEngine;
  appPath?: string;
  levelDbPath?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  device?: string;
  now?: () => number;
}

/**
 * Ordinary Claude Desktop chat inventory.
 *
 * React Query persists the recent conversation-list API response, including
 * stable ids, names and timestamps. It does not persist generating/blocked/done
 * lifecycle, so these are inventory signals unless the browser extension has
 * stronger evidence for the same canonical id.
 */
export class ClaudeDesktopChatConnector implements Connector {
  readonly id = CLAUDE_DESKTOP_CHAT_CONNECTOR_ID;
  readonly displayName = 'Claude Desktop chat history';
  readonly provider = 'anthropic' as const;
  readonly surface = 'desktop' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly appPath: string;
  private readonly levelDbPath: string;
  private readonly historyWindowMs: number;
  private readonly now: () => number;
  private readonly source: Source;
  private readonly lastSeen = new Map<string, string>();

  constructor(options: ClaudeDesktopChatConnectorOptions) {
    this.engine = options.engine;
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
    this.scanIntervalMs = options.scanIntervalMs ?? 60_000;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.source = {
      id: CLAUDE_DESKTOP_CHAT_CONNECTOR_ID,
      provider: 'anthropic',
      surface: 'desktop',
      device: options.device ?? hostname(),
    };
  }

  async scan(ctx: ConnectorContext): Promise<ConnectorScanResult> {
    if (!existsSync(this.appPath)) {
      throw new ConnectorUnsupportedError(
        'Claude Desktop is not installed — nothing to watch',
      );
    }
    if (!existsSync(this.levelDbPath)) {
      return {
        observedSessionCount: 0,
        archivedSessionCount: 0,
        permissionState: 'unknown',
        warnings: [
          `Claude Desktop Local Storage cache not found: ${this.levelDbPath}`,
        ],
      };
    }

    const cache = await readClaudeDesktopChatCache(this.levelDbPath);
    const warnings = [...cache.warnings];
    if (!cache.foundCacheKey) {
      warnings.push(
        `${CLAUDE_REACT_QUERY_CACHE_KEY} was not present in Claude Desktop Local Storage`,
      );
    } else if (!cache.foundConversationQuery) {
      warnings.push(
        `${CLAUDE_CONVERSATION_QUERY} was not present in the persisted React Query cache`,
      );
    }

    const merged = new Map<string, ClaudeChatConversationMetadata>();
    for (const conversation of cache.conversations) {
      merged.set(
        conversation.uuid,
        preferConversation(merged.get(conversation.uuid), conversation),
      );
    }
    if (cache.hasMore) {
      warnings.push(
        `the Claude Desktop cache enumerates ${merged.size} recent conversation(s) and reports has_more=true; older conversations are not locally enumerated`,
      );
    }
    warnings.push(
      'conversation history is visible, but the desktop cache does not expose live running/blocked/done state; inventory-only rows are status unknown',
    );

    const now = this.now();
    const cutoff = now - this.historyWindowMs;
    const alreadyIndexed = ctx.store.externalIdsForSource(this.id);
    let observed = 0;
    let archived = 0;

    for (const conversation of merged.values()) {
      if (ctx.signal.aborted) break;
      const sourceActivityAt = timestampOf(conversation);
      if (sourceActivityAt === undefined) {
        warnings.push(
          `conversation ${conversation.uuid} has no valid created_at or updated_at`,
        );
        continue;
      }
      const activityAt = Math.min(sourceActivityAt, now);
      if (sourceActivityAt > now) {
        warnings.push(
          `conversation ${conversation.uuid} has a future update timestamp; recency was clamped to scan time`,
        );
      }
      const inTriage = activityAt >= cutoff;
      if (inTriage) observed += 1;
      else archived += 1;
      if (!inTriage && alreadyIndexed.has(conversation.uuid)) continue;

      const title = deriveTitle(conversation.name, { fallback: '' });
      const stamp = `${activityAt}:${title}`;
      if (this.lastSeen.get(conversation.uuid) === stamp) continue;
      const url = `https://claude.ai/chat/${encodeURIComponent(conversation.uuid)}`;

      this.engine.observe({
        identity: canonicalKey('anthropic', conversation.uuid),
        provider: 'anthropic',
        surface: 'desktop',
        title,
        titlePriority: title ? 30 : 0,
        fallbackTitle: fallbackLabel(undefined, conversation.uuid),
        source: this.source,
        externalId: conversation.uuid,
        context: { conversationId: conversation.uuid, url },
        url,
        locateHint: `Claude Desktop → recent chats → ${
          title || fallbackLabel(undefined, conversation.uuid)
        }`,
        observations: [
          {
            signal: 'claude.desktop_history_seen',
            at: activityAt,
            raw: {
              cache: CLAUDE_REACT_QUERY_CACHE_KEY,
              ...(conversation.platform ? { platform: conversation.platform } : {}),
              ...(conversation.project_uuid
                ? { projectUuid: conversation.project_uuid }
                : {}),
            },
            connectorId: this.id,
            surface: 'desktop',
          },
        ],
        sourceActivityAt: activityAt,
        connectorId: this.id,
      });
      this.lastSeen.set(conversation.uuid, stamp);
      alreadyIndexed.add(conversation.uuid);
    }

    return {
      observedSessionCount: observed,
      archivedSessionCount: archived,
      permissionState: 'granted',
      warnings,
    };
  }
}
