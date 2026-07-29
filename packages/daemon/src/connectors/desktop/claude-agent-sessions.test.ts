import { mkdirSync, writeFileSync } from 'node:fs';
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
  CLAUDE_AGENT_SESSIONS_CONNECTOR_ID,
  CLAUDE_AGENT_SESSIONS_QUERY,
  ClaudeAgentAccountSnapshotStore,
  ClaudeAgentSessionsConnector,
  readClaudeAgentSessionsCache,
  readClaudeBridgeIdentityMap,
} from './claude-agent-sessions.js';
import { CLAUDE_REACT_QUERY_CACHE_KEY } from './claude-chat.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const LOCAL = 'local_10000000-1111-4222-8333-000000000001';
const CLI = '10000000-1111-4222-8333-000000000002';
const REMOTE_RUNNING = 'session_01Running000000000000000';
const REMOTE_INPUT = 'session_01NeedsInput000000000000';
const REMOTE_DONE = 'session_01ReviewReady00000000000';
const REMOTE_IDLE = 'session_01IdleUnknown00000000000';

function encodeChromiumString(value: string): Buffer {
  return Buffer.concat([Buffer.from([0]), Buffer.from(value, 'utf16le')]);
}

function storageKey(name: string): Buffer {
  return Buffer.concat([
    Buffer.from('_https://claude.ai\0', 'utf8'),
    Buffer.concat([Buffer.from([1]), Buffer.from(name, 'utf8')]),
  ]);
}

function session(
  id: string,
  title: string,
  activityAt: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'session',
    id,
    title,
    session_status: 'idle',
    worker_status: 'idle',
    connection_status: 'disconnected',
    environment_kind: 'anthropic_cloud',
    origin: 'web_claude_ai',
    unread: false,
    created_at: new Date(activityAt - HOUR).toISOString(),
    updated_at: new Date(activityAt).toISOString(),
    session_context: {
      outcomes: ['private session outcome'],
      sources: ['private session source'],
    },
    external_metadata: {
      task_summary: 'private task summary',
    },
    ...overrides,
  };
}

function query(
  sessions: unknown[],
  options: { cacheUpdatedAt?: number; hasMore?: boolean } = {},
): Record<string, unknown> {
  return {
    state: {
      data: {
        pages: [
          {
            data: sessions,
            has_more: options.hasMore ?? false,
            first_id: 'first',
            last_id: 'last',
          },
        ],
        pageParams: [null],
      },
      dataUpdateCount: 1,
      dataUpdatedAt: options.cacheUpdatedAt ?? NOW,
      status: 'success',
      fetchStatus: 'idle',
    },
    queryKey: [
      CLAUDE_AGENT_SESSIONS_QUERY,
      {
        orgUuid: 'org-test',
        statuses: ['active', 'paused'],
      },
    ],
    queryHash: JSON.stringify([CLAUDE_AGENT_SESSIONS_QUERY, 'org-test']),
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
      encodeChromiumString(JSON.stringify(value)),
    );
  } finally {
    await db.close();
  }
}

function writeLocalJoin(
  root: string,
  bridgeSessionIds: string[],
  cliSessionId = CLI,
): void {
  const directory = join(root, 'account', 'workspace');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${LOCAL}.json`),
    JSON.stringify({
      sessionId: LOCAL,
      cliSessionId,
      bridgeSessionIds,
      title: 'Local joined task',
      createdAt: NOW - DAY,
      lastActivityAt: NOW - HOUR,
      isArchived: false,
    }),
  );
}

describe('Claude cross-device agent sessions', () => {
  let ctx: TempStore;
  let registry: ConnectorRegistry;
  let appPath: string;
  let levelDbPath: string;
  let sessionsDir: string;
  let engine: StatusEngine;
  let accountSnapshots: ClaudeAgentAccountSnapshotStore;

  beforeEach(() => {
    ctx = createTempStore();
    appPath = join(ctx.home, 'Claude.app');
    levelDbPath = join(ctx.home, 'leveldb');
    sessionsDir = join(ctx.home, 'claude-code-sessions');
    mkdirSync(appPath, { recursive: true });
    engine = new StatusEngine(ctx.store, () => NOW);
    accountSnapshots = new ClaudeAgentAccountSnapshotStore();
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
    });
  });

  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  function connector(): ClaudeAgentSessionsConnector {
    return new ClaudeAgentSessionsConnector({
      engine,
      accountSnapshots,
      appPath,
      levelDbPath,
      sessionsDir,
      now: () => NOW,
      device: 'test-mac',
    });
  }

  it('projects only lifecycle metadata and strips content-bearing session fields', async () => {
    const privateNeed = 'private question that must not leave the cache parser';
    const privateDetail = 'private status detail';
    await writeCache(
      levelDbPath,
      persistedCache([
        {
          state: { data: { privateAccountField: 'private account value' } },
          queryKey: ['account_profile'],
          queryHash: 'account_profile',
        },
        query([
          session(REMOTE_INPUT, 'Safe title', NOW - HOUR, {
            post_turn_summary: {
              status_category: 'need_input',
              needs_action: privateNeed,
              status_detail: privateDetail,
              description: 'private description',
            },
          }),
        ]),
      ]),
    );

    const cache = await readClaudeAgentSessionsCache(levelDbPath);
    expect(cache.foundCacheKey).toBe(true);
    expect(cache.foundSessionsQuery).toBe(true);
    expect(cache.sessions).toHaveLength(1);
    expect(cache.sessions[0]).toMatchObject({
      id: REMOTE_INPUT,
      title: 'Safe title',
      post_turn_summary: { status_category: 'need_input' },
    });
    const serialised = JSON.stringify(cache);
    expect(serialised).not.toContain(privateNeed);
    expect(serialised).not.toContain(privateDetail);
    expect(serialised).not.toContain('private task summary');
    expect(serialised).not.toContain('private session outcome');
    expect(serialised).not.toContain('privateAccountField');
  });

  it('uses the explicit bridgeSessionIds join and discards ambiguous joins', () => {
    writeLocalJoin(sessionsDir, [REMOTE_RUNNING]);
    const secondDir = join(sessionsDir, 'other', 'workspace');
    mkdirSync(secondDir, { recursive: true });
    writeFileSync(
      join(secondDir, 'local_conflict.json'),
      JSON.stringify({
        sessionId: 'local_conflict',
        cliSessionId: '20000000-1111-4222-8333-000000000002',
        bridgeSessionIds: [REMOTE_IDLE],
      }),
    );
    const thirdDir = join(sessionsDir, 'third', 'workspace');
    mkdirSync(thirdDir, { recursive: true });
    writeFileSync(
      join(thirdDir, 'local_other.json'),
      JSON.stringify({
        sessionId: 'local_other',
        cliSessionId: '30000000-1111-4222-8333-000000000002',
        bridgeSessionIds: [REMOTE_IDLE],
      }),
    );

    const joins = readClaudeBridgeIdentityMap(sessionsDir);
    expect(joins.canonicalByBridgeId.get(REMOTE_RUNNING)).toBe(CLI);
    expect(joins.canonicalByBridgeId.has(REMOTE_IDLE)).toBe(false);
    expect(joins.warnings).toEqual([
      expect.stringMatching(/mapped to multiple local sessions/),
    ]);
  });

  it('classifies running, need-input, review-ready, and unknown lifecycle across surfaces', async () => {
    writeLocalJoin(sessionsDir, [REMOTE_RUNNING]);
    const privateNeed = 'do not persist this question';
    await writeCache(
      levelDbPath,
      persistedCache([
        query(
          [
            session(REMOTE_RUNNING, 'Local bridge running', NOW - 2 * HOUR, {
              session_status: 'running',
              worker_status: 'running',
              connection_status: 'connected',
              environment_kind: 'bridge',
              origin: 'claude_code_cli',
              unread: true,
            }),
            session(REMOTE_INPUT, 'Mobile task needs input', NOW - HOUR, {
              origin: 'ios',
              post_turn_summary: {
                status_category: 'need_input',
                needs_action: privateNeed,
                status_detail: 'private detail',
              },
            }),
            session(REMOTE_DONE, 'Web task ready', NOW - 2 * HOUR, {
              origin: 'web_claude_ai',
              post_turn_summary: {
                status_category: 'review_ready',
                description: 'private completion description',
              },
            }),
            session(REMOTE_IDLE, 'Desktop task unknown', NOW - 3 * HOUR, {
              origin: 'desktop_app',
            }),
          ],
          { hasMore: true },
        ),
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    const byKey = new Map(
      ctx.store.listWorkItems().map((item) => [item.canonicalKey, item]),
    );
    expect(byKey.size).toBe(4);
    expect(byKey.get(canonicalKey('anthropic', CLI).key)).toMatchObject({
      status: 'running',
      currentEvidence: {
        rule: 'running.live-activity',
        signal: 'claude.agent_running',
        confidence: 'high',
      },
      entryPoints: [
        {
          externalId: REMOTE_RUNNING,
          source: {
            id: 'claude-agent-cli',
            surface: 'cli',
          },
        },
      ],
    });
    expect(byKey.get(canonicalKey('anthropic', REMOTE_INPUT).key)).toMatchObject({
      status: 'needs_victor',
      currentEvidence: {
        rule: 'needs_victor.blocking-signal',
        signal: 'claude.agent_needs_input',
      },
      entryPoints: [
        {
          source: {
            id: 'claude-agent-ios',
            surface: 'mobile',
          },
        },
      ],
    });
    expect(byKey.get(canonicalKey('anthropic', REMOTE_DONE).key)).toMatchObject({
      status: 'done',
      currentEvidence: {
        rule: 'done.source-confirmed',
        signal: 'claude.agent_review_ready',
      },
    });
    expect(byKey.get(canonicalKey('anthropic', REMOTE_IDLE).key)).toMatchObject({
      status: 'stale',
      currentEvidence: {
        rule: 'stale.inventory-only',
        signal: 'claude.agent_inventory_seen',
      },
    });

    const health = ctx.store.getCoverage(CLAUDE_AGENT_SESSIONS_CONNECTOR_ID);
    expect(health).toMatchObject({
      state: 'degraded',
      observedSessionCount: 4,
      archivedSessionCount: 0,
      permissionState: 'granted',
    });
    expect(health?.lastError).toMatch(/has_more=true/);

    const stored = JSON.stringify({
      items: ctx.store.listWorkItems(),
      observations: [
        ...ctx.store.listObservations(canonicalKey('anthropic', CLI).key),
        ...ctx.store.listObservations(
          canonicalKey('anthropic', REMOTE_INPUT).key,
        ),
        ...ctx.store.listObservations(
          canonicalKey('anthropic', REMOTE_DONE).key,
        ),
      ],
    });
    expect(stored).not.toContain(privateNeed);
    expect(stored).not.toContain('private detail');
    expect(stored).not.toContain('private completion description');
  });

  it('ages a stale cached running assertion instead of refreshing it at scan time', async () => {
    mkdirSync(sessionsDir, { recursive: true });
    await writeCache(
      levelDbPath,
      persistedCache([
        query(
          [
            session(REMOTE_RUNNING, 'Stale running cache', NOW - HOUR, {
              session_status: 'running',
              worker_status: 'running',
              origin: 'web_claude_ai',
            }),
          ],
          { cacheUpdatedAt: NOW - HOUR },
        ),
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    expect(ctx.store.listWorkItems()[0]).toMatchObject({
      status: 'stale',
      currentEvidence: {
        rule: 'stale.no-progress',
        signal: 'claude.agent_running',
      },
    });
    expect(ctx.store.getCoverage(CLAUDE_AGENT_SESSIONS_CONNECTOR_ID)?.lastError).toMatch(
      /has not refreshed for 60 minutes/,
    );
  });

  it('uses a fresh complete web inventory as the authoritative set and keeps Cowork return paths', async () => {
    writeLocalJoin(sessionsDir, [
      REMOTE_RUNNING.replace(/^session_/u, 'cse_'),
    ]);
    await writeCache(
      levelDbPath,
      persistedCache([
        query(
          [
            session(REMOTE_IDLE, 'Stale cache-only row', NOW - 2 * HOUR),
          ],
          { cacheUpdatedAt: NOW - HOUR, hasMore: true },
        ),
      ]),
    );
    accountSnapshots.update({
      completeness: 'complete',
      at: NOW,
      basis: 'complete active/paused and archived cursor pagination',
      items: [
        {
          sessionId: REMOTE_RUNNING,
          title: 'Fresh account running task',
          url: `https://claude.ai/cowork/${REMOTE_RUNNING}`,
          createdAt: NOW - 2 * HOUR,
          updatedAt: NOW - HOUR,
          sessionStatus: 'running',
          workerStatus: 'running',
          connectionStatus: 'connected',
          environmentKind: 'bridge',
          origin: 'claude_code_cli',
          unread: false,
          archived: false,
        },
        {
          sessionId: REMOTE_DONE,
          title: 'Fresh archived task',
          url: `https://claude.ai/cowork/${REMOTE_DONE}`,
          createdAt: NOW - 2 * HOUR,
          updatedAt: NOW - HOUR,
          sessionStatus: 'archived',
          workerStatus: 'running',
          connectionStatus: 'disconnected',
          environmentKind: 'anthropic_cloud',
          origin: 'web_claude_ai',
          unread: false,
          archived: true,
        },
      ],
    });

    registry.register(connector());
    await registry.startAll();

    expect(ctx.store.countWorkItems()).toBe(2);
    expect(
      ctx.store.getWorkItemByCanonicalKey(
        canonicalKey('anthropic', REMOTE_IDLE).key,
      ),
    ).toBeUndefined();
    const joined = ctx.store.getWorkItemByCanonicalKey(
      canonicalKey('anthropic', CLI).key,
    );
    expect(joined).toMatchObject({
      status: 'running',
      title: 'Fresh account running task',
    });
    expect(
      joined?.entryPoints.find(
        (entry) => entry.externalId === REMOTE_RUNNING,
      )?.url,
    ).toBe(`https://claude.ai/cowork/${REMOTE_RUNNING}`);
    const archived = ctx.store.getWorkItemByCanonicalKey(
      canonicalKey('anthropic', REMOTE_DONE).key,
    );
    expect(archived?.entryPoints[0]?.archived).toBe(true);
    expect(archived?.status).toBe('stale');
    expect(archived?.entryPoints[0]?.url).toBe(
      `https://claude.ai/cowork/${REMOTE_DONE}`,
    );
    expect(ctx.store.getCoverage(CLAUDE_AGENT_SESSIONS_CONNECTOR_ID)).toMatchObject(
      {
        state: 'ok',
        observedSessionCount: 1,
        archivedSessionCount: 1,
        lastError: null,
      },
    );
  });

  it('does not let joined idle inventory overwrite stronger local completion', async () => {
    writeLocalJoin(sessionsDir, [REMOTE_IDLE]);
    engine.observe({
      identity: canonicalKey('anthropic', CLI),
      provider: 'anthropic',
      surface: 'cli',
      title: 'Local completed task',
      source: {
        id: 'claude-code-cli',
        provider: 'anthropic',
        surface: 'cli',
        device: 'test-mac',
      },
      externalId: CLI,
      observations: [
        {
          signal: 'claude_code.stop',
          at: NOW - 2 * HOUR,
          connectorId: 'claude-code-cli',
          surface: 'cli',
        },
      ],
      connectorId: 'claude-code-cli',
    });
    await writeCache(
      levelDbPath,
      persistedCache([
        query([
          session(REMOTE_IDLE, 'Joined idle cache row', NOW - HOUR, {
            environment_kind: 'bridge',
            origin: 'claude_code_cli',
          }),
        ]),
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    const item = ctx.store.getWorkItemByCanonicalKey(
      canonicalKey('anthropic', CLI).key,
    );
    expect(item).toMatchObject({
      status: 'done',
      currentEvidence: {
        signal: 'claude_code.stop',
      },
    });
    expect(item?.entryPoints).toHaveLength(2);
    expect(
      item?.entryPoints.find((entry) => entry.source.id === 'claude-agent-cli')
        ?.url,
    ).toBe(`https://claude.ai/cowork/${REMOTE_IDLE}`);
  });

  it('collapses a cloud-only row when its explicit local bridge arrives later', async () => {
    mkdirSync(sessionsDir, { recursive: true });
    await writeCache(
      levelDbPath,
      persistedCache([
        query([
          session(REMOTE_DONE, 'Remote task', NOW - HOUR, {
            origin: 'web_claude_ai',
            post_turn_summary: { status_category: 'review_ready' },
          }),
        ]),
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    expect(
      ctx.store.getWorkItemByCanonicalKey(
        canonicalKey('anthropic', REMOTE_DONE).key,
      ),
    ).toBeDefined();

    engine.observe({
      identity: canonicalKey('anthropic', CLI),
      provider: 'anthropic',
      surface: 'cli',
      title: 'Local task',
      titlePriority: 30,
      source: {
        id: 'claude-code-cli',
        provider: 'anthropic',
        surface: 'cli',
        device: 'test-mac',
      },
      externalId: CLI,
      resumeCommand: `claude --resume ${CLI}`,
      observations: [
        {
          signal: 'claude_code.stop',
          at: NOW - 2 * HOUR,
          connectorId: 'claude-code-cli',
          surface: 'cli',
        },
      ],
      connectorId: 'claude-code-cli',
    });
    writeLocalJoin(sessionsDir, [REMOTE_DONE]);
    expect(ctx.store.countWorkItems()).toBe(2);

    await registry.scanAllOnce();

    expect(ctx.store.countWorkItems()).toBe(1);
    expect(
      ctx.store.getWorkItemByCanonicalKey(
        canonicalKey('anthropic', REMOTE_DONE).key,
      ),
    ).toBeUndefined();
    const joined = ctx.store.getWorkItemByCanonicalKey(
      canonicalKey('anthropic', CLI).key,
    );
    expect(joined).toMatchObject({
      status: 'done',
      title: 'Remote task',
    });
    expect(
      joined?.entryPoints.map((entry) => entry.source.id).sort(),
    ).toEqual(['claude-agent-web', 'claude-code-cli']);
  });

  it('keeps unknown source enums as inventory and degrades without echoing their values', async () => {
    mkdirSync(sessionsDir, { recursive: true });
    const privateEnumLikeValue = 'private-user-controlled-looking-value';
    await writeCache(
      levelDbPath,
      persistedCache([
        query([
          session(REMOTE_IDLE, 'Unknown state', NOW - HOUR, {
            session_status: privateEnumLikeValue,
            worker_status: privateEnumLikeValue,
            origin: privateEnumLikeValue,
            post_turn_summary: {
              status_category: privateEnumLikeValue,
              needs_action: 'private question',
            },
          }),
        ]),
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    expect(ctx.store.listWorkItems()[0]).toMatchObject({
      status: 'stale',
      currentEvidence: {
        rule: 'stale.inventory-only',
      },
    });
    const health = ctx.store.getCoverage(CLAUDE_AGENT_SESSIONS_CONNECTOR_ID);
    expect(health?.state).toBe('degraded');
    expect(health?.lastError).toMatch(/were unrecognised and not guessed/);
    expect(health?.lastError).not.toContain(privateEnumLikeValue);
    expect(
      JSON.stringify(
        ctx.store.listObservations(
          canonicalKey('anthropic', REMOTE_IDLE).key,
        ),
      ),
    ).not.toContain(privateEnumLikeValue);
  });

  it('backfills cached sessions outside the triage window as archived', async () => {
    mkdirSync(sessionsDir, { recursive: true });
    await writeCache(
      levelDbPath,
      persistedCache([
        query([
          session(REMOTE_IDLE, 'Recent', NOW - HOUR),
          session(REMOTE_DONE, 'Old', NOW - 8 * DAY),
        ]),
      ]),
    );
    registry.register(connector());
    await registry.startAll();

    expect(ctx.store.listWorkItems()).toHaveLength(2);
    expect(ctx.store.listWorkItems(NOW - 7 * DAY).map((item) => item.title)).toEqual([
      'Recent',
    ]);
    expect(ctx.store.getCoverage(CLAUDE_AGENT_SESSIONS_CONNECTOR_ID)).toMatchObject({
      observedSessionCount: 1,
      archivedSessionCount: 1,
    });
  });
});
