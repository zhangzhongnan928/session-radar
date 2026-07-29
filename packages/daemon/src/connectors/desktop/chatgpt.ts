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

export const CHATGPT_DESKTOP_CONNECTOR_ID = 'chatgpt-desktop';
export const CHATGPT_RECENT_CACHE_KEY = 'codex.chatgpt-conversations';
export const CHATGPT_PINNED_CACHE_KEY = 'codex.chatgpt-pinned-conversations';

const chatGptConversationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().nullable().optional(),
    create_time: z.string().datetime({ offset: true }).nullable().optional(),
    update_time: z.string().datetime({ offset: true }).nullable().optional(),
    is_archived: z.boolean().optional(),
    /**
     * ChatGPT's first-party desktop bundle defines 3 as STREAMING and 4 as
     * UNREAD for persisted asynchronous work. Other integer values are accepted
     * so a source update degrades coverage instead of dropping the conversation,
     * but they are never guessed at.
     */
    async_status: z.number().int().min(1).max(7).nullable().optional(),
    /**
     * These fields can carry message content in other API shapes. The observed
     * desktop list cache stores null. Refuse the record if that changes rather
     * than accidentally widening the product's metadata-only boundary.
     */
    mapping: z.null().optional(),
    snippet: z.null().optional(),
  })
  .strip();

const recentCacheSchema = z
  .object({
    version: z.number().int().nonnegative(),
    pages: z.array(
      z
        .object({
          items: z.array(z.unknown()),
          total: z.number().int().nonnegative().optional(),
        })
        .strip(),
    ),
  })
  .strip();

const pinnedCacheSchema = z
  .object({
    version: z.number().int().nonnegative(),
    items: z.array(z.unknown()),
  })
  .strip();

export type ChatGptConversationMetadata = z.infer<typeof chatGptConversationSchema>;

export interface ChatGptDesktopCache {
  conversations: ChatGptConversationMetadata[];
  warnings: string[];
  advertisedTotal?: number;
  foundRecentKey: boolean;
  foundPinnedKey: boolean;
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'value'} ${issue.message}`)
    .join('; ');
}

function parseConversationList(
  items: readonly unknown[],
  cacheKey: string,
  warnings: string[],
): ChatGptConversationMetadata[] {
  const parsed: ChatGptConversationMetadata[] = [];
  for (const [index, item] of items.entries()) {
    const result = chatGptConversationSchema.safeParse(item);
    if (result.success) {
      parsed.push(result.data);
    } else {
      warnings.push(
        `${cacheKey} item ${index} was not ingested: ${describeZodError(result.error)}`,
      );
    }
  }
  return parsed;
}

function parseCacheValue(
  key: string,
  encoded: Buffer,
  result: ChatGptDesktopCache,
): void {
  const json = decodeChromiumString(encoded);
  if (json === undefined) {
    result.warnings.push(`${key} uses an unrecognised Chromium string encoding`);
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    result.warnings.push(
      `${key} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (key === CHATGPT_RECENT_CACHE_KEY) {
    result.foundRecentKey = true;
    const cache = recentCacheSchema.safeParse(value);
    if (!cache.success) {
      result.warnings.push(
        `${key} has an unrecognised schema: ${describeZodError(cache.error)}`,
      );
      return;
    }
    for (const page of cache.data.pages) {
      result.conversations.push(
        ...parseConversationList(page.items, key, result.warnings),
      );
      if (
        page.total !== undefined &&
        (result.advertisedTotal === undefined || page.total > result.advertisedTotal)
      ) {
        result.advertisedTotal = page.total;
      }
    }
    return;
  }

  result.foundPinnedKey = true;
  const cache = pinnedCacheSchema.safeParse(value);
  if (!cache.success) {
    result.warnings.push(
      `${key} has an unrecognised schema: ${describeZodError(cache.error)}`,
    );
    return;
  }
  result.conversations.push(
    ...parseConversationList(cache.data.items, key, result.warnings),
  );
}

/**
 * Read only the two ChatGPT list keys from a private copy of the live store.
 */
export async function readChatGptDesktopCache(
  levelDbPath: string,
): Promise<ChatGptDesktopCache> {
  const result: ChatGptDesktopCache = {
    conversations: [],
    warnings: [],
    foundRecentKey: false,
    foundPinnedKey: false,
  };
  const records = await readChromiumLocalStorageRecords(
    levelDbPath,
    new Set([CHATGPT_RECENT_CACHE_KEY, CHATGPT_PINNED_CACHE_KEY]),
  );
  for (const record of records) {
    parseCacheValue(record.key, record.value, result);
  }

  return result;
}

function timestampOf(conversation: ChatGptConversationMetadata): number | undefined {
  const raw = conversation.update_time ?? conversation.create_time;
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

function preferConversation(
  current: ChatGptConversationMetadata | undefined,
  incoming: ChatGptConversationMetadata,
): ChatGptConversationMetadata {
  if (!current) return incoming;
  const currentAt = timestampOf(current) ?? 0;
  const incomingAt = timestampOf(incoming) ?? 0;
  if (incomingAt > currentAt) return incoming;
  if (incomingAt < currentAt) return current;
  if (incoming.async_status !== null && incoming.async_status !== undefined) {
    if (current.async_status === null || current.async_status === undefined) return incoming;
  }
  return incoming.title && !current.title ? incoming : current;
}

export interface ChatGptDesktopConnectorOptions {
  engine: StatusEngine;
  appPath?: string;
  levelDbPath?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  device?: string;
  now?: () => number;
}

/**
 * Ordinary ChatGPT Desktop conversation inventory.
 *
 * The persisted list gives us stable ids, titles and update times. It also
 * exposes a narrow asynchronous-work lifecycle: STREAMING (3) and UNREAD (4).
 * Ordinary renderer state (idle/streaming/error), blocking prompts, and the
 * complete archive remain unavailable. Rows without one of those two verified
 * async values therefore stay explicit inventory-only sightings.
 */
export class ChatGptDesktopConnector implements Connector {
  readonly id = CHATGPT_DESKTOP_CONNECTOR_ID;
  readonly displayName = 'ChatGPT Desktop history';
  readonly provider = 'openai' as const;
  readonly surface = 'desktop' as const;
  readonly scanIntervalMs: number;

  private readonly engine: StatusEngine;
  private readonly appPath: string;
  private readonly levelDbPath: string;
  private readonly historyWindowMs: number;
  private readonly now: () => number;
  private readonly source: Source;
  private readonly lastSeen = new Map<
    string,
    { stamp: string; asyncStatus: number | null | undefined }
  >();

  constructor(options: ChatGptDesktopConnectorOptions) {
    this.engine = options.engine;
    this.appPath = options.appPath ?? '/Applications/ChatGPT.app';
    this.levelDbPath =
      options.levelDbPath ??
      join(
        homedir(),
        'Library',
        'Application Support',
        'Codex',
        'Default',
        'Local Storage',
        'leveldb',
      );
    this.scanIntervalMs = options.scanIntervalMs ?? 30_000;
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.source = {
      id: CHATGPT_DESKTOP_CONNECTOR_ID,
      provider: 'openai',
      surface: 'desktop',
      device: options.device ?? hostname(),
    };
  }

  async scan(ctx: ConnectorContext): Promise<ConnectorScanResult> {
    if (!existsSync(this.appPath)) {
      throw new ConnectorUnsupportedError(
        'ChatGPT Desktop is not installed — nothing to watch',
      );
    }

    if (!existsSync(this.levelDbPath)) {
      return {
        observedSessionCount: 0,
        archivedSessionCount: 0,
        permissionState: 'unknown',
        warnings: [
          `ChatGPT Desktop conversation cache not found: ${this.levelDbPath}`,
        ],
      };
    }

    const cache = await readChatGptDesktopCache(this.levelDbPath);
    const warnings = [...cache.warnings];
    if (!cache.foundRecentKey) {
      warnings.push(`${CHATGPT_RECENT_CACHE_KEY} was not present in the desktop cache`);
    }
    if (!cache.foundPinnedKey) {
      warnings.push(`${CHATGPT_PINNED_CACHE_KEY} was not present in the desktop cache`);
    }

    const merged = new Map<string, ChatGptConversationMetadata>();
    for (const conversation of cache.conversations) {
      merged.set(
        conversation.id,
        preferConversation(merged.get(conversation.id), conversation),
      );
    }

    if (cache.advertisedTotal !== undefined && cache.advertisedTotal > merged.size) {
      warnings.push(
        `the desktop recent-list cache contains ${merged.size} of ${cache.advertisedTotal} account conversations; older conversations are not locally enumerated`,
      );
    }
    warnings.push(
      'ordinary chat lifecycle is unavailable; only persisted async background-task STREAMING (3) and ready/unread (4) are classified, and all other rows remain status unknown',
    );
    const unknownAsyncStatuses = [...merged.values()].filter(
      (conversation) =>
        conversation.async_status !== null &&
        conversation.async_status !== undefined &&
        conversation.async_status !== 3 &&
        conversation.async_status !== 4,
    ).length;
    if (unknownAsyncStatuses > 0) {
      warnings.push(
        `${unknownAsyncStatuses} conversation(s) have an unrecognised non-null async status and remain status unknown`,
      );
    }

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
          `conversation ${conversation.id} has no valid create_time or update_time`,
        );
        continue;
      }
      const activityAt = Math.min(sourceActivityAt, now);
      if (sourceActivityAt > now) {
        warnings.push(
          `conversation ${conversation.id} has a future update timestamp; recency was clamped to scan time`,
        );
      }
      const inTriage = conversation.is_archived !== true && activityAt >= cutoff;
      if (inTriage) observed += 1;
      else archived += 1;
      if (!inTriage && alreadyIndexed.has(conversation.id)) continue;

      const title = deriveTitle(conversation.title, { fallback: '' });
      const asyncStatus = conversation.async_status;
      const stamp = `${activityAt}:${title}:${asyncStatus ?? 'null'}`;
      const previous = this.lastSeen.get(conversation.id);
      if (previous?.stamp === stamp) continue;
      const statusChanged =
        previous !== undefined && previous.asyncStatus !== asyncStatus;
      // A change observed during this daemon lifetime is itself current
      // evidence. On first sight, retain the source timestamp so an old cached
      // STREAMING value cannot be refreshed merely because the radar restarted.
      const lifecycleAt = statusChanged ? now : activityAt;
      const observation =
        asyncStatus === 3
          ? {
              signal: 'chatgpt.desktop_async_streaming' as const,
              at: lifecycleAt,
              raw: { asyncStatus },
              connectorId: this.id,
              surface: 'desktop' as const,
            }
          : asyncStatus === 4
            ? {
                signal: 'chatgpt.desktop_async_unread' as const,
                at: lifecycleAt,
                raw: { asyncStatus },
                connectorId: this.id,
                surface: 'desktop' as const,
              }
            : {
                signal: 'chatgpt.desktop_history_seen' as const,
                at: lifecycleAt,
                raw: {
                  cache: CHATGPT_RECENT_CACHE_KEY,
                  ...(asyncStatus !== null && asyncStatus !== undefined
                    ? { asyncStatus }
                    : {}),
                },
                connectorId: this.id,
                surface: 'desktop' as const,
              };

      this.engine.observe({
        identity: canonicalKey('openai', conversation.id),
        provider: 'openai',
        surface: 'desktop',
        title,
        titlePriority: title ? 30 : 0,
        fallbackTitle: fallbackLabel(undefined, conversation.id),
        source: this.source,
        externalId: conversation.id,
        context: { conversationId: conversation.id },
        url: `codex://threads/${encodeURIComponent(conversation.id)}`,
        locateHint: `ChatGPT Desktop → recent chats → ${
          title || fallbackLabel(undefined, conversation.id)
        }`,
        sourceArchived: conversation.is_archived === true,
        observations: [observation],
        sourceActivityAt: activityAt,
        connectorId: this.id,
      });
      this.lastSeen.set(conversation.id, { stamp, asyncStatus });
      alreadyIndexed.add(conversation.id);
    }

    return {
      observedSessionCount: observed,
      archivedSessionCount: archived,
      permissionState: 'granted',
      warnings,
    };
  }
}
