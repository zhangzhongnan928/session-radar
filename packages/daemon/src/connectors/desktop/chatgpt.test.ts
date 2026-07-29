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
  CHATGPT_DESKTOP_CONNECTOR_ID,
  CHATGPT_PINNED_CACHE_KEY,
  CHATGPT_RECENT_CACHE_KEY,
  ChatGptDesktopConnector,
  readChatGptDesktopCache,
} from './chatgpt.js';
import {
  chromiumStorageKeyName,
  decodeChromiumString,
} from './chromium-local-storage.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const SESSION_A = '019fb000-1111-7000-8000-000000000001';
const SESSION_B = '019fb000-1111-7000-8000-000000000002';

function encodeChromiumString(value: string, encoding: 'utf8' | 'utf16le'): Buffer {
  return Buffer.concat([
    Buffer.from([encoding === 'utf8' ? 1 : 0]),
    Buffer.from(value, encoding),
  ]);
}

function storageKey(name: string): Buffer {
  return Buffer.concat([
    Buffer.from('_app://-\0', 'utf8'),
    encodeChromiumString(name, 'utf8'),
  ]);
}

function conversation(
  id: string,
  title: string,
  activityAt: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title,
    create_time: new Date(activityAt - HOUR).toISOString(),
    update_time: new Date(activityAt).toISOString(),
    is_archived: false,
    async_status: null,
    mapping: null,
    snippet: null,
    ...overrides,
  };
}

interface CacheOptions {
  recent?: unknown;
  pinned?: unknown;
}

async function writeCache(path: string, options: CacheOptions): Promise<void> {
  const db = new ClassicLevel<Buffer, Buffer>(path, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
  });
  await db.open();
  try {
    if (options.recent !== undefined) {
      await db.put(
        storageKey(CHATGPT_RECENT_CACHE_KEY),
        encodeChromiumString(JSON.stringify(options.recent), 'utf16le'),
      );
    }
    if (options.pinned !== undefined) {
      await db.put(
        storageKey(CHATGPT_PINNED_CACHE_KEY),
        encodeChromiumString(JSON.stringify(options.pinned), 'utf8'),
      );
    }
  } finally {
    await db.close();
  }
}

function recent(items: unknown[], total = items.length): Record<string, unknown> {
  return {
    pageParams: [0],
    pages: [{ items, total, limit: 20, offset: 0 }],
    version: 1,
  };
}

function pinned(items: unknown[]): Record<string, unknown> {
  return { items, version: 1 };
}

describe('ChatGPT Desktop history', () => {
  let ctx: TempStore;
  let registry: ConnectorRegistry;
  let appPath: string;
  let levelDbPath: string;

  beforeEach(() => {
    ctx = createTempStore();
    appPath = join(ctx.home, 'ChatGPT.app');
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

  function connector(): ChatGptDesktopConnector {
    return new ChatGptDesktopConnector({
      engine: new StatusEngine(ctx.store, () => NOW),
      appPath,
      levelDbPath,
      now: () => NOW,
      device: 'test-mac',
    });
  }

  it('decodes both Chromium string encodings and local-storage row keys', () => {
    expect(decodeChromiumString(encodeChromiumString('hello', 'utf8'))).toBe('hello');
    expect(decodeChromiumString(encodeChromiumString('hello', 'utf16le'))).toBe('hello');
    expect(chromiumStorageKeyName(storageKey(CHATGPT_RECENT_CACHE_KEY))).toBe(
      CHATGPT_RECENT_CACHE_KEY,
    );
    expect(decodeChromiumString(Buffer.from([7, 1, 2]))).toBeUndefined();
  });

  it('reads the two allowlisted cache records from a copied LevelDB', async () => {
    await writeCache(levelDbPath, {
      recent: recent([conversation(SESSION_A, 'Recent chat', NOW - HOUR)]),
      pinned: pinned([conversation(SESSION_B, 'Pinned chat', NOW - 2 * HOUR)]),
    });

    const cache = await readChatGptDesktopCache(levelDbPath);
    expect(cache.foundRecentKey).toBe(true);
    expect(cache.foundPinnedKey).toBe(true);
    expect(cache.conversations.map((item) => item.id).sort()).toEqual([
      SESSION_A,
      SESSION_B,
    ]);
  });

  it('shows recent ChatGPT rows with real recency but explicit unknown lifecycle', async () => {
    const activityAt = NOW - 2 * HOUR;
    await writeCache(levelDbPath, {
      recent: recent([
        conversation(SESSION_A, 'Help with the dashboard', activityAt, {
          safe_urls: ['metadata is ignored'],
        }),
      ]),
      pinned: pinned([]),
    });
    registry.register(connector());
    await registry.startAll();

    const items = ctx.store.listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      canonicalKey: canonicalKey('openai', SESSION_A).key,
      title: 'Help with the dashboard',
      status: 'stale',
      lastActivityAt: activityAt,
      context: { conversationId: SESSION_A },
      currentEvidence: {
        rule: 'stale.inventory-only',
        confidence: 'low',
        signal: 'chatgpt.desktop_history_seen',
      },
    });
    expect(items[0]?.entryPoints[0]).toMatchObject({
      externalId: SESSION_A,
      url: `codex://threads/${SESSION_A}`,
      source: {
        id: CHATGPT_DESKTOP_CONNECTOR_ID,
        provider: 'openai',
        surface: 'desktop',
      },
    });

    const health = ctx.store.getCoverage(CHATGPT_DESKTOP_CONNECTOR_ID);
    expect(health).toMatchObject({
      state: 'degraded',
      observedSessionCount: 1,
      archivedSessionCount: 0,
      permissionState: 'granted',
    });
    expect(health?.lastError).toMatch(/ordinary chat lifecycle is unavailable/);
  });

  it('classifies the verified persisted async STREAMING and UNREAD values', async () => {
    await writeCache(levelDbPath, {
      recent: recent([
        conversation(SESSION_A, 'Async work', NOW - 5 * 60_000, {
          async_status: 3,
        }),
        conversation(SESSION_B, 'Ready result', NOW - HOUR, {
          async_status: 4,
        }),
      ]),
      pinned: pinned([]),
    });
    registry.register(connector());
    await registry.startAll();

    const byKey = new Map(
      ctx.store.listWorkItems().map((item) => [item.canonicalKey, item]),
    );
    expect(byKey.get(canonicalKey('openai', SESSION_A).key)).toMatchObject({
      status: 'running',
      currentEvidence: {
        rule: 'running.live-activity',
        signal: 'chatgpt.desktop_async_streaming',
        confidence: 'med',
      },
    });
    expect(byKey.get(canonicalKey('openai', SESSION_B).key)).toMatchObject({
      status: 'done',
      currentEvidence: {
        rule: 'done.source-confirmed',
        signal: 'chatgpt.desktop_async_unread',
        confidence: 'med',
      },
    });
  });

  it('does not refresh an old cached STREAMING value merely by scanning it', async () => {
    await writeCache(levelDbPath, {
      recent: recent([
        conversation(SESSION_A, 'Old async work', NOW - HOUR, {
          async_status: 3,
        }),
      ]),
      pinned: pinned([]),
    });
    registry.register(connector());
    await registry.startAll();

    expect(ctx.store.listWorkItems()[0]).toMatchObject({
      status: 'stale',
      currentEvidence: {
        rule: 'stale.no-progress',
        signal: 'chatgpt.desktop_async_streaming',
      },
    });
  });

  it('re-ingests an async status transition even when title and update time do not change', async () => {
    const instance = connector();
    const unchangedAt = NOW - HOUR;
    await writeCache(levelDbPath, {
      recent: recent([
        conversation(SESSION_A, 'Same metadata', unchangedAt, {
          async_status: null,
        }),
      ]),
      pinned: pinned([]),
    });
    registry.register(instance);
    await registry.startAll();
    expect(ctx.store.listWorkItems()[0]?.status).toBe('stale');

    await writeCache(levelDbPath, {
      recent: recent([
        conversation(SESSION_A, 'Same metadata', unchangedAt, {
          async_status: 3,
        }),
      ]),
      pinned: pinned([]),
    });
    await registry.scanAllOnce();

    expect(ctx.store.listWorkItems()[0]).toMatchObject({
      status: 'running',
      currentEvidence: {
        signal: 'chatgpt.desktop_async_streaming',
        raw: {
          basisAt: NOW,
        },
      },
    });
  });

  it('keeps unrecognised async values unknown and reports the coverage gap', async () => {
    await writeCache(levelDbPath, {
      recent: recent([
        conversation(SESSION_A, 'Unknown async state', NOW - HOUR, {
          async_status: 7,
        }),
      ]),
      pinned: pinned([]),
    });
    registry.register(connector());
    await registry.startAll();

    expect(ctx.store.listWorkItems()[0]).toMatchObject({
      status: 'stale',
      currentEvidence: {
        rule: 'stale.inventory-only',
        signal: 'chatgpt.desktop_history_seen',
      },
    });
    expect(ctx.store.getCoverage(CHATGPT_DESKTOP_CONNECTOR_ID)?.lastError).toMatch(
      /unrecognised non-null async status/,
    );
  });

  it('deduplicates recent and pinned records and prefers the newer metadata', async () => {
    await writeCache(levelDbPath, {
      recent: recent([conversation(SESSION_A, 'Older title', NOW - 3 * HOUR)]),
      pinned: pinned([conversation(SESSION_A, 'Newer title', NOW - HOUR)]),
    });
    registry.register(connector());
    await registry.startAll();

    const items = ctx.store.listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Newer title');
    expect(items[0]?.lastActivityAt).toBe(NOW - HOUR);
    expect(ctx.store.getCoverage(CHATGPT_DESKTOP_CONNECTOR_ID)?.observedSessionCount).toBe(1);
  });

  it('backfills old and explicitly archived rows outside the triage inventory', async () => {
    await writeCache(levelDbPath, {
      recent: recent([
        conversation(SESSION_A, 'Old', NOW - 8 * DAY),
        conversation(SESSION_B, 'Archived', NOW - HOUR, { is_archived: true }),
      ]),
      pinned: pinned([]),
    });
    registry.register(connector());
    await registry.startAll();

    const all = ctx.store.listWorkItems();
    expect(all).toHaveLength(2);
    expect(ctx.store.listWorkItems(NOW - 7 * DAY)).toHaveLength(0);
    expect(
      all.find((item) => item.title === 'Archived')?.entryPoints[0]?.archived,
    ).toBe(true);
    expect(ctx.store.getCoverage(CHATGPT_DESKTOP_CONNECTOR_ID)).toMatchObject({
      observedSessionCount: 0,
      archivedSessionCount: 2,
    });
  });

  it('refuses message-bearing cache shapes and never persists their values', async () => {
    await writeCache(levelDbPath, {
      recent: recent([
        conversation(SESSION_A, 'Must not ingest', NOW - HOUR, {
          snippet: 'private reply text',
          mapping: { node: 'private prompt text' },
        }),
      ]),
      pinned: pinned([]),
    });
    registry.register(connector());
    await registry.startAll();

    expect(ctx.store.listWorkItems()).toHaveLength(0);
    const health = ctx.store.getCoverage(CHATGPT_DESKTOP_CONNECTOR_ID);
    expect(health?.state).toBe('degraded');
    expect(health?.lastError).toMatch(/was not ingested/);
    expect(health?.lastError).not.toContain('private reply text');
    expect(health?.lastError).not.toContain('private prompt text');
  });

  it('degrades loudly on missing keys or an unrecognised schema', async () => {
    await writeCache(levelDbPath, {
      recent: { version: 1, conversations: [] },
      pinned: pinned([]),
    });
    registry.register(connector());
    await registry.startAll();

    const health = ctx.store.getCoverage(CHATGPT_DESKTOP_CONNECTOR_ID);
    expect(health?.state).toBe('degraded');
    expect(health?.observedSessionCount).toBe(0);
    expect(health?.lastError).toMatch(/unrecognised schema/);
  });

  it('reports the recent-list completeness limit instead of implying a full archive', async () => {
    await writeCache(levelDbPath, {
      recent: recent([conversation(SESSION_A, 'One cached chat', NOW - HOUR)], 73),
      pinned: pinned([]),
    });
    registry.register(connector());
    await registry.startAll();

    expect(ctx.store.getCoverage(CHATGPT_DESKTOP_CONNECTOR_ID)?.lastError).toMatch(
      /contains 1 of 73 account conversations/,
    );
  });
});
