import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalKey } from '@session-radar/shared';
import { ClassicLevel } from 'classic-level';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusEngine } from '../../engine.js';
import { createNullLogger } from '../../logger.js';
import { ConnectorRegistry } from '../../registry.js';
import type { TempStore } from '../../testing.js';
import { createTempStore } from '../../testing.js';
import {
  CLAUDE_DESKTOP_CHAT_CONNECTOR_ID,
  CLAUDE_REACT_QUERY_CACHE_KEY,
  ClaudeDesktopChatConnector,
  jsonObjectContainingMarker,
  readClaudeDesktopChatCache,
} from './claude-chat.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const CONVERSATION_A = 'a1000000-1111-4222-8333-000000000001';
const CONVERSATION_B = 'a1000000-1111-4222-8333-000000000002';

function encodeChromiumString(value: string, encoding: 'utf8' | 'utf16le'): Buffer {
  return Buffer.concat([
    Buffer.from([encoding === 'utf8' ? 1 : 0]),
    Buffer.from(value, encoding),
  ]);
}

function storageKey(name: string): Buffer {
  return Buffer.concat([
    Buffer.from('_https://claude.ai\0', 'utf8'),
    encodeChromiumString(name, 'utf8'),
  ]);
}

function conversation(
  uuid: string,
  name: string,
  activityAt: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid,
    name,
    summary: 'message-bearing summary that must never be persisted',
    model: 'claude-test',
    created_at: new Date(activityAt - HOUR).toISOString(),
    updated_at: new Date(activityAt).toISOString(),
    settings: {},
    is_starred: false,
    is_temporary: false,
    project_uuid: null,
    session_id: null,
    platform: 'CLAUDE_AI',
    ...overrides,
  };
}

function query(
  data: unknown,
  suffix: unknown = { limit: 30, starred: false },
): Record<string, unknown> {
  return {
    state: {
      data,
      dataUpdateCount: 1,
      dataUpdatedAt: NOW,
      status: 'success',
      fetchStatus: 'idle',
    },
    queryKey: [
      'chat_conversation_list',
      { orgUuid: 'org-test' },
      suffix,
    ],
    queryHash: JSON.stringify(['chat_conversation_list', suffix]),
  };
}

function persistedCache(queries: unknown[]): Record<string, unknown> {
  return {
    buster: '',
    timestamp: NOW,
    clientState: {
      mutations: [],
      queries,
    },
  };
}

async function writeCache(path: string, value: unknown): Promise<void> {
  const db = new ClassicLevel<Buffer, Buffer>(path, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
  });
  await db.open();
  try {
    await db.put(
      storageKey(CLAUDE_REACT_QUERY_CACHE_KEY),
      encodeChromiumString(JSON.stringify(value), 'utf16le'),
    );
  } finally {
    await db.close();
  }
}

describe('Claude Desktop chat history', () => {
  let ctx: TempStore;
  let registry: ConnectorRegistry;
  let appPath: string;
  let levelDbPath: string;

  beforeEach(() => {
    ctx = createTempStore();
    appPath = join(ctx.home, 'Claude.app');
    levelDbPath = join(ctx.home, 'leveldb');
    mkdirSync(appPath, { recursive: true });
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
    });
  });

  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  function connector(): ClaudeDesktopChatConnector {
    return new ClaudeDesktopChatConnector({
      engine: new StatusEngine(ctx.store, () => NOW),
      appPath,
      levelDbPath,
      now: () => NOW,
      device: 'test-mac',
    });
  }

  it('isolates a query object while ignoring braces and markers inside strings', () => {
    const value = {
      state: { data: { text: 'quoted "queryKey": and } braces' } },
      queryKey: ['chat_conversation_list'],
    };
    const json = JSON.stringify({ queries: [value] });
    const marker = json.lastIndexOf('"queryKey":');
    expect(JSON.parse(jsonObjectContainingMarker(json, marker) ?? '')).toEqual(value);
  });

  it('reads list metadata while stripping summaries and unrelated cached queries', async () => {
    const privateSummary = 'private conversation summary';
    await writeCache(
      levelDbPath,
      persistedCache([
        {
          state: { data: { privateAccountField: 'must not be selected' } },
          queryKey: ['account_profile'],
          queryHash: 'account_profile',
        },
        query({
          pages: [
            {
              data: [
                conversation(CONVERSATION_A, 'Dashboard help', NOW - HOUR, {
                  summary: privateSummary,
                }),
              ],
              has_more: true,
            },
          ],
          pageParams: [null],
        }, 'infinite'),
      ]),
    );

    const cache = await readClaudeDesktopChatCache(levelDbPath);
    expect(cache.foundCacheKey).toBe(true);
    expect(cache.foundConversationQuery).toBe(true);
    expect(cache.hasMore).toBe(true);
    expect(cache.conversations).toHaveLength(1);
    expect(cache.conversations[0]).toMatchObject({
      uuid: CONVERSATION_A,
      name: 'Dashboard help',
      platform: 'CLAUDE_AI',
    });
    expect('summary' in (cache.conversations[0] ?? {})).toBe(false);
    expect(JSON.stringify(cache)).not.toContain(privateSummary);
    expect(JSON.stringify(cache)).not.toContain('privateAccountField');
  });

  it('ingests recent chats with accurate recency and explicit unknown lifecycle', async () => {
    const activityAt = NOW - 2 * HOUR;
    await writeCache(
      levelDbPath,
      persistedCache([
        query({
          pages: [
            {
              data: [conversation(CONVERSATION_A, 'Ordinary Claude chat', activityAt)],
              has_more: true,
            },
          ],
          pageParams: [null],
        }, 'infinite'),
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    const items = ctx.store.listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      canonicalKey: canonicalKey('anthropic', CONVERSATION_A).key,
      title: 'Ordinary Claude chat',
      status: 'stale',
      lastActivityAt: activityAt,
      context: {
        conversationId: CONVERSATION_A,
        url: `https://claude.ai/chat/${CONVERSATION_A}`,
      },
      currentEvidence: {
        rule: 'stale.inventory-only',
        confidence: 'low',
        signal: 'claude.desktop_history_seen',
      },
    });
    expect(items[0]?.entryPoints[0]).toMatchObject({
      externalId: CONVERSATION_A,
      url: `https://claude.ai/chat/${CONVERSATION_A}`,
      source: {
        id: CLAUDE_DESKTOP_CHAT_CONNECTOR_ID,
        provider: 'anthropic',
        surface: 'desktop',
      },
    });
    expect(ctx.store.getCoverage(CLAUDE_DESKTOP_CHAT_CONNECTOR_ID)).toMatchObject({
      state: 'degraded',
      observedSessionCount: 1,
      permissionState: 'granted',
    });
  });

  it('deduplicates finite and infinite list queries and prefers newer metadata', async () => {
    await writeCache(
      levelDbPath,
      persistedCache([
        query({
          data: [conversation(CONVERSATION_A, 'Older name', NOW - 3 * HOUR)],
          has_more: false,
        }),
        query({
          pages: [
            {
              data: [conversation(CONVERSATION_A, 'Newer name', NOW - HOUR)],
              has_more: false,
            },
          ],
          pageParams: [null],
        }, 'infinite'),
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    const items = ctx.store.listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Newer name');
    expect(items[0]?.lastActivityAt).toBe(NOW - HOUR);
  });

  it('backfills cached conversations outside the seven-day triage window', async () => {
    await writeCache(
      levelDbPath,
      persistedCache([
        query({
          data: [
            conversation(CONVERSATION_A, 'Recent', NOW - HOUR),
            conversation(CONVERSATION_B, 'Old', NOW - 8 * DAY),
          ],
          has_more: false,
        }),
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    expect(ctx.store.listWorkItems()).toHaveLength(2);
    expect(ctx.store.listWorkItems(NOW - 7 * DAY).map((item) => item.title)).toEqual([
      'Recent',
    ]);
    expect(ctx.store.getCoverage(CLAUDE_DESKTOP_CHAT_CONNECTOR_ID)).toMatchObject({
      observedSessionCount: 1,
      archivedSessionCount: 1,
    });
  });

  it('makes incomplete history and unavailable lifecycle visible in coverage', async () => {
    await writeCache(
      levelDbPath,
      persistedCache([
        query({
          data: [conversation(CONVERSATION_A, 'Cached chat', NOW - HOUR)],
          has_more: true,
        }),
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    const health = ctx.store.getCoverage(CLAUDE_DESKTOP_CHAT_CONNECTOR_ID);
    expect(health?.state).toBe('degraded');
    expect(health?.lastError).toMatch(/has_more=true/);
    expect(health?.lastError).toMatch(/does not expose live running\/blocked\/done/);
  });

  it('degrades loudly when the cache contains no conversation-list query', async () => {
    await writeCache(
      levelDbPath,
      persistedCache([
        {
          state: { data: { profile: true }, dataUpdatedAt: NOW },
          queryKey: ['account_profile'],
          queryHash: 'account_profile',
        },
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    const health = ctx.store.getCoverage(CLAUDE_DESKTOP_CHAT_CONNECTOR_ID);
    expect(health?.state).toBe('degraded');
    expect(health?.observedSessionCount).toBe(0);
    expect(health?.lastError).toMatch(/chat_conversation_list was not present/);
  });
});
