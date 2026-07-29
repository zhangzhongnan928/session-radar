import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebReport, WebSite } from '@session-radar/shared';
import { canonicalKey, extensionOrigin } from '@session-radar/shared';
import { StatusEngine } from '../../engine.js';
import { createNullLogger } from '../../logger.js';
import { ConnectorRegistry } from '../../registry.js';
import type { TempStore } from '../../testing.js';
import { createTempStore } from '../../testing.js';
import { defaultAllowedOrigins } from '../../http/security.js';
import { HEARTBEAT_TIMEOUT_MS, WebSurfaceConnector } from './connector.js';
import { WebIngest } from './ingest.js';

const CONV = 'conv-abc';

function report(overrides: Partial<WebReport> = {}): WebReport {
  return {
    site: 'claude-web',
    at: Date.now(),
    conversations: [
      {
        conversationId: CONV,
        state: 'generating',
        title: 'Review the retry strategy',
        at: Date.now(),
      },
    ],
    selectors: { selectorsVersion: '2026.07.28-1', found: ['composer', 'message'], missing: [] },
    extensionVersion: '0.0.1',
    ...overrides,
  };
}

type NoteReportInput = Parameters<WebSurfaceConnector['noteReport']>[0];

function healthyNote(overrides: Partial<NoteReportInput> = {}): NoteReportInput {
  return {
    at: 1_800_000_000_000,
    observedSessionCount: 0,
    archivedSessionCount: 0,
    selectorsVersion: 'v1',
    missingAnchors: [],
    inventoryCompleteness: 'complete',
    inventoryScopes: ['account-api'],
    inventoryBasis: ['complete empty account inventory'],
    inventoryErrors: [],
    accountInventoryAt: 1_800_000_000_000,
    untimedInventoryCount: 0,
    unknownLifecycleCount: 0,
    rejectedInventoryCount: 0,
    ...overrides,
  };
}

describe('WebIngest', () => {
  let ctx: TempStore;
  let connectors: Map<WebSite, WebSurfaceConnector>;
  let ingest: WebIngest;

  beforeEach(() => {
    ctx = createTempStore();
    connectors = new Map([
      ['claude-web', new WebSurfaceConnector('claude-web')],
      ['chatgpt-web', new WebSurfaceConnector('chatgpt-web')],
    ]);
    for (const site of connectors.keys()) {
      ctx.store.registerConnector({ id: site, displayName: site });
    }
    ingest = new WebIngest({
      engine: new StatusEngine(ctx.store),
      connectors,
      device: 'test-mac',
    });
  });
  afterEach(() => ctx.close());

  it('turns a generating conversation into a running work item with a deep link', () => {
    const result = ingest.handle(report(), Date.now());
    expect(result.accepted).toBe(true);
    expect(result.observed).toBe(1);

    const item = ctx.store.listWorkItems()[0];
    expect(item?.status).toBe('running');
    expect(item?.provider).toBe('anthropic');
    expect(item?.title).toBe('Review the retry strategy');
    expect(item?.entryPoints[0]?.url).toBe(`https://claude.ai/chat/${CONV}`);
    expect(item?.context.conversationId).toBe(CONV);
  });

  it('maps a blocked conversation to needs_victor and keeps the reason', () => {
    ingest.handle(
      report({
        conversations: [
          { conversationId: CONV, state: 'blocked', blockReason: 'login_wall', at: Date.now() },
        ],
      }),
      Date.now(),
    );
    const item = ctx.store.listWorkItems()[0];
    expect(item?.status).toBe('needs_victor');
    const observations = ctx.store.listObservations(canonicalKey('anthropic', CONV).key);
    expect(JSON.stringify(observations)).toContain('login_wall');
  });

  it('maps a completed conversation to done', () => {
    ingest.handle(
      report({ conversations: [{ conversationId: CONV, state: 'completed', at: Date.now() }] }),
      Date.now(),
    );
    expect(ctx.store.listWorkItems()[0]?.status).toBe('done');
  });

  it('ignores unknown state rather than recording a meaningless signal', () => {
    ingest.handle(
      report({ conversations: [{ conversationId: CONV, state: 'unknown', at: Date.now() }] }),
      Date.now(),
    );
    expect(ctx.store.countWorkItems()).toBe(0);
  });

  it('a closed tab mid-generation becomes stale, not running', () => {
    const now = Date.now();
    ingest.handle(report({ at: now }), now);
    expect(ctx.store.listWorkItems()[0]?.status).toBe('running');

    ingest.handle(
      report({ at: now + 1_000, conversations: [], closed: [CONV] }),
      now + 1_000,
    );
    const item = ctx.store.listWorkItems()[0];
    expect(item?.status).toBe('stale');
    expect(item?.currentEvidence?.rule).toBe('stale.process-dead-no-completion');
  });

  it('never lets a skewed page clock place an observation in the future', () => {
    const now = Date.now();
    ingest.handle(
      report({
        at: now,
        conversations: [{ conversationId: CONV, state: 'generating', at: now + 600_000 }],
      }),
      now,
    );
    const observations = ctx.store.listObservations(canonicalKey('anthropic', CONV).key);
    for (const observation of observations) {
      expect(observation.at).toBeLessThanOrEqual(now);
    }
  });

  it('rejects a malformed report and says why', () => {
    const result = ingest.handle({ site: 'nope' }, Date.now());
    expect(result.accepted).toBe(false);
    expect(result.warning).toMatch(/unparseable/);
  });

  it('hands a validated Claude agent snapshot to the canonical agent connector path', () => {
    const received: unknown[] = [];
    const withAgentCallback = new WebIngest({
      engine: new StatusEngine(ctx.store),
      connectors,
      device: 'test-mac',
      onClaudeAgentInventory: (inventory, receivedAt) => {
        received.push({ inventory, receivedAt });
      },
    });
    const now = 1_800_000_000_000;
    const result = withAgentCallback.handle(
      report({
        site: 'claude-web',
        conversations: [],
        claudeAgentInventory: {
          completeness: 'complete',
          at: now - 1_000,
          basis: 'complete active/paused and archived cursor pagination',
          items: [
            {
              sessionId: 'session_01AgentWebInventory000000',
              title: 'Cross-device agent',
              url: 'https://claude.ai/cowork/session_01AgentWebInventory000000',
              updatedAt: now - 60_000,
              sessionStatus: 'running',
              workerStatus: 'running',
              connectionStatus: 'connected',
              origin: 'ios',
              archived: false,
            },
          ],
        },
      }),
      now,
    );

    expect(result.accepted).toBe(true);
    expect(received).toEqual([
      {
        inventory: expect.objectContaining({
          completeness: 'complete',
          items: [
            expect.objectContaining({
              sessionId: 'session_01AgentWebInventory000000',
            }),
          ],
        }),
        receivedAt: now,
      },
    ]);
    // WebIngest deliberately does not create a second remote canonical row.
    expect(ctx.store.countWorkItems()).toBe(0);
  });

  it('keeps the heartbeat alive even when the selectors have rotted', () => {
    const result = ingest.handle(
      report({
        conversations: [],
        selectors: { selectorsVersion: '2026.07.28-1', found: [], missing: ['composer', 'message'] },
      }),
      Date.now(),
    );
    expect(result.accepted).toBe(true);
    expect(result.warning).toContain('composer');
    expect(connectors.get('claude-web')?.snapshot().lastReportAt).toBeDefined();
  });

  it('routes chatgpt reports to the openai provider and the right deep link', () => {
    ingest.handle(
      report({
        site: 'chatgpt-web',
        conversations: [{ conversationId: 'gpt-1', state: 'completed', at: Date.now() }],
      }),
      Date.now(),
    );
    const item = ctx.store.listWorkItems()[0];
    expect(item?.provider).toBe('openai');
    expect(item?.entryPoints[0]?.url).toBe('https://chatgpt.com/c/gpt-1');
  });

  it('merges a web sighting with a CLI sighting of the same conversation id', () => {
    // The CLI saw it first...
    const engine = new StatusEngine(ctx.store);
    engine.observe({
      identity: canonicalKey('anthropic', CONV),
      provider: 'anthropic',
      surface: 'cli',
      title: 'From the CLI',
      source: { id: 'claude-code-cli', provider: 'anthropic', surface: 'cli', device: 'test-mac' },
      externalId: CONV,
      resumeCommand: `claude --resume ${CONV}`,
      observations: [{ signal: 'claude_code.post_tool_use', at: Date.now() }],
      connectorId: 'claude-code-cli',
    });
    // ...then the browser did.
    ingest.handle(report(), Date.now());

    expect(ctx.store.countWorkItems()).toBe(1);
    const item = ctx.store.listWorkItems()[0];
    expect(item?.entryPoints).toHaveLength(2);
    expect(item?.entryPoints.map((e) => e.source.surface).sort()).toEqual(['cli', 'extension']);
    // Both ways back in survive the merge.
    expect(item?.entryPoints.some((e) => e.resumeCommand)).toBe(true);
    expect(item?.entryPoints.some((e) => e.url)).toBe(true);
  });

  it('indexes complete active and archived ChatGPT account history with source recency', () => {
    const now = 1_800_000_000_000;
    const result = ingest.handle(
      report({
        site: 'chatgpt-web',
        at: now,
        conversations: [],
        inventories: [
          {
            scope: 'account-api',
            completeness: 'complete',
            at: now,
            basis: 'complete active and archived pagination',
            advertisedTotal: 3,
            items: [
              {
                conversationId: 'recent',
                title: 'Recent account chat',
                url: 'https://chatgpt.com/c/recent',
                updatedAt: now - 60_000,
                archived: false,
              },
              {
                conversationId: 'old',
                title: 'Old account chat',
                url: 'https://chatgpt.com/c/old',
                updatedAt: now - 10 * 24 * 60 * 60_000,
                archived: false,
              },
              {
                conversationId: 'archived',
                title: 'Vendor archived chat',
                url: 'https://chatgpt.com/c/archived',
                updatedAt: now - 60_000,
                archived: true,
              },
            ],
          },
        ],
      }),
      now,
    );

    expect(result.accepted).toBe(true);
    expect(result.observed).toBe(3);
    expect(ctx.store.listWorkItems()).toHaveLength(3);
    expect(ctx.store.listWorkItems(now - 7 * 24 * 60 * 60_000)).toHaveLength(1);
    const archived = ctx.store
      .listWorkItems()
      .find((item) => item.context.conversationId === 'archived');
    expect(archived?.entryPoints[0]?.archived).toBe(true);
    expect(connectors.get('chatgpt-web')?.snapshot()).toMatchObject({
      observedSessionCount: 1,
      archivedSessionCount: 2,
      inventoryCompleteness: 'complete',
    });
  });

  it('does not trust an empty complete account list that contradicts visible history', () => {
    const now = 1_800_000_000_000;
    const result = ingest.handle(
      report({
        site: 'chatgpt-web',
        at: now,
        conversations: [],
        inventories: [
          {
            scope: 'account-api',
            completeness: 'complete',
            at: now,
            basis: 'account endpoint returned 0 of 0',
            advertisedTotal: 0,
            items: [],
          },
          {
            scope: 'visible-dom',
            completeness: 'partial',
            at: now,
            basis: 'visible sidebar only',
            items: [
              {
                conversationId: 'visible-despite-empty-account',
                title: 'Visible conversation',
                url: 'https://chatgpt.com/c/visible-despite-empty-account',
              },
            ],
          },
        ],
      }),
      now,
    );

    expect(result.accepted).toBe(true);
    expect(result.warning).toContain('history inventory partial');
    expect(connectors.get('chatgpt-web')?.snapshot()).toMatchObject({
      inventoryCompleteness: 'partial',
      observedSessionCount: 0,
      archivedSessionCount: 1,
    });
    expect(
      connectors.get('chatgpt-web')?.snapshot().inventoryErrors,
    ).toContain(
      'account metadata inventory claimed complete with zero rows while 1 conversation(s) are visible in the page; treating account coverage as partial',
    );
  });

  it('indexes complete Claude account history while keeping lifecycle explicitly unknown', () => {
    const now = 1_800_000_000_000;
    const recentId = '20000000-0000-4000-8000-000000000001';
    const oldId = '20000000-0000-4000-8000-000000000002';
    const result = ingest.handle(
      report({
        site: 'claude-web',
        at: now,
        conversations: [],
        inventories: [
          {
            scope: 'account-api',
            completeness: 'complete',
            at: now,
            basis: 'complete starred and non-starred pagination',
            items: [
              {
                conversationId: recentId,
                title: 'Recent Claude account chat',
                url: `https://claude.ai/chat/${recentId}`,
                updatedAt: now - 60_000,
                archived: false,
              },
              {
                conversationId: oldId,
                title: 'Old Claude account chat',
                url: `https://claude.ai/chat/${oldId}`,
                updatedAt: now - 10 * 24 * 60 * 60_000,
                archived: false,
              },
            ],
          },
        ],
      }),
      now,
    );

    expect(result.accepted).toBe(true);
    expect(result.observed).toBe(2);
    expect(ctx.store.listWorkItems()).toHaveLength(2);
    expect(ctx.store.listWorkItems(now - 7 * 24 * 60 * 60_000)).toHaveLength(1);
    expect(connectors.get('claude-web')?.snapshot()).toMatchObject({
      observedSessionCount: 1,
      archivedSessionCount: 1,
      inventoryCompleteness: 'complete',
      unknownLifecycleCount: 2,
    });
    expect(ctx.store.listWorkItems()[0]?.provider).toBe('anthropic');
  });

  it('maps only verified ChatGPT async values 3 and 4 to lifecycle', () => {
    const now = 1_800_000_000_000;
    ingest.handle(
      report({
        site: 'chatgpt-web',
        at: now,
        conversations: [],
        inventories: [
          {
            scope: 'account-api',
            completeness: 'complete',
            at: now,
            basis: 'complete account pagination',
            items: [
              {
                conversationId: 'streaming',
                url: 'https://chatgpt.com/c/streaming',
                updatedAt: now,
                archived: false,
                asyncStatus: 3,
              },
              {
                conversationId: 'unread',
                url: 'https://chatgpt.com/c/unread',
                updatedAt: now,
                archived: false,
                asyncStatus: 4,
              },
            ],
          },
        ],
      }),
      now,
    );

    const byId = new Map(
      ctx.store
        .listWorkItems()
        .map((item) => [item.context.conversationId, item.status]),
    );
    expect(byId.get('streaming')).toBe('running');
    expect(byId.get('unread')).toBe('done');
  });

  it('clears a previously known async lifecycle when the account enum changes', () => {
    const now = 1_800_000_000_000;
    const inventoryAt = now - 60_000;
    const withAsync = (asyncStatus: number): WebReport =>
      report({
        site: 'chatgpt-web',
        conversations: [],
        inventories: [
          {
            scope: 'account-api',
            completeness: 'complete',
            at: now,
            basis: 'complete account pagination',
            items: [
              {
                conversationId: 'changing',
                url: 'https://chatgpt.com/c/changing',
                updatedAt: inventoryAt,
                archived: false,
                asyncStatus,
              },
            ],
          },
        ],
      });

    ingest.handle(withAsync(3), now);
    expect(ctx.store.listWorkItems()[0]?.status).toBe('running');

    ingest.handle(withAsync(5), now + 1_000);
    expect(ctx.store.listWorkItems()[0]?.status).toBe('stale');
    expect(ctx.store.listWorkItems()[0]?.currentEvidence?.rule).toBe(
      'stale.inventory-only',
    );
  });

  it('keeps untimed DOM history out of recent triage and labels it inventory-only', () => {
    const now = 1_800_000_000_000;
    ingest.handle(
      report({
        conversations: [],
        inventories: [
          {
            scope: 'visible-dom',
            completeness: 'partial',
            at: now,
            basis: 'visible sidebar only',
            items: [
              {
                conversationId: 'untimed',
                title: 'Visible but untimed',
                url: 'https://claude.ai/chat/untimed',
              },
            ],
          },
        ],
      }),
      now,
    );

    const item = ctx.store.listWorkItems()[0];
    expect(item?.lastActivityAt).toBe(0);
    expect(item?.currentEvidence?.rule).toBe('stale.inventory-only');
    expect(ctx.store.listWorkItems(now - 7 * 24 * 60 * 60_000)).toEqual([]);
    expect(connectors.get('claude-web')?.snapshot().untimedInventoryCount).toBe(1);
  });

  it('does not append unchanged account inventory on every heartbeat', () => {
    const now = 1_800_000_000_000;
    const payload = report({
      site: 'chatgpt-web',
      conversations: [],
      inventories: [
        {
          scope: 'account-api',
          completeness: 'complete',
          at: now,
          basis: 'complete account pagination',
          items: [
            {
              conversationId: 'stable',
              url: 'https://chatgpt.com/c/stable',
              updatedAt: now - 60_000,
              archived: false,
            },
          ],
        },
      ],
    });
    ingest.handle(payload, now);
    ingest.handle(payload, now + 15_000);

    expect(
      ctx.store.listObservations(canonicalKey('openai', 'stable').key),
    ).toHaveLength(1);
  });

  it('rejects a mismatched inventory id and URL instead of creating a row', () => {
    const now = 1_800_000_000_000;
    const result = ingest.handle(
      report({
        site: 'chatgpt-web',
        conversations: [],
        inventories: [
          {
            scope: 'account-api',
            completeness: 'complete',
            at: now,
            basis: 'claimed complete',
            items: [
              {
                conversationId: 'expected',
                url: 'https://chatgpt.com/c/different',
                updatedAt: now,
              },
            ],
          },
        ],
      }),
      now,
    );
    expect(result.warning).toContain('partial');
    expect(ctx.store.countWorkItems()).toBe(0);
    expect(connectors.get('chatgpt-web')?.snapshot().rejectedInventoryCount).toBe(
      1,
    );
  });
});

describe('WebSurfaceConnector — heartbeat as coverage', () => {
  let ctx: TempStore;
  let now: number;
  let connector: WebSurfaceConnector;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    ctx = createTempStore();
    now = 1_800_000_000_000;
    connector = new WebSurfaceConnector('claude-web', () => now);
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
      failuresBeforeDown: 1,
    });
  });
  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  it('is DOWN before the extension has ever connected, with instructions', async () => {
    registry.register(connector);
    await registry.startAll();
    const health = ctx.store.getCoverage('claude-web');
    expect(health?.state).toBe('down');
    expect(health?.lastError).toMatch(/never connected/);
    expect(health?.lastError).toMatch(/load it in Chrome/i);
  });

  it('is OK once reports are arriving', async () => {
    connector.noteReport(healthyNote({
      at: now,
      observedSessionCount: 3,
    }));
    registry.register(connector);
    await registry.startAll();
    const health = ctx.store.getCoverage('claude-web');
    expect(health?.state).toBe('ok');
    expect(health?.observedSessionCount).toBe(3);
  });

  it('names the reporting extension build when history inventory is absent', async () => {
    connector.noteReport(
      healthyNote({
        at: now,
        extensionVersion: '0.0.1',
        inventoryCompleteness: 'none',
        accountInventoryAt: undefined,
      }),
    );
    registry.register(connector);
    await registry.startAll();

    const health = ctx.store.getCoverage('claude-web');
    expect(health?.state).toBe('degraded');
    expect(health?.lastError).toContain('extension reported v0.0.1');
    expect(health?.lastError).toContain('reload the updated unpacked extension');
  });

  it('goes DOWN when the extension stops reporting — Chrome closed', async () => {
    connector.noteReport(healthyNote({ at: now, observedSessionCount: 2 }));
    registry.register(connector);
    await registry.startAll();
    expect(ctx.store.getCoverage('claude-web')?.state).toBe('ok');

    now += HEARTBEAT_TIMEOUT_MS + 1_000;
    await registry.scanAllOnce();

    const health = ctx.store.getCoverage('claude-web');
    expect(health?.state).toBe('down');
    expect(health?.lastError).toMatch(/no heartbeat/);
  });

  it('the 60s timeout satisfies the acceptance budget', () => {
    expect(HEARTBEAT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('DEGRADES on selector rot, naming the anchors to fix', async () => {
    connector.noteReport(healthyNote({
      at: now,
      observedSessionCount: 1,
      selectorsVersion: '2026.07.28-1',
      missingAnchors: ['composer', 'message'],
    }));
    registry.register(connector);
    await registry.startAll();

    const health = ctx.store.getCoverage('claude-web');
    expect(health?.state).toBe('degraded');
    expect(health?.lastError).toContain('composer');
    expect(health?.lastError).toContain('2026.07.28-1');
    // Still counted — degraded means unreliable, not blind.
    expect(health?.observedSessionCount).toBe(1);
  });

  it('DEGRADES loudly when only a partial rendered history window is visible', async () => {
    connector.noteReport(
      healthyNote({
        at: now,
        observedSessionCount: 4,
        inventoryCompleteness: 'partial',
        inventoryScopes: ['visible-dom'],
        inventoryBasis: ['visible sidebar only; lazy-loaded account history'],
        accountInventoryAt: undefined,
        unknownLifecycleCount: 4,
      }),
    );
    registry.register(connector);
    await registry.startAll();

    const health = ctx.store.getCoverage('claude-web');
    expect(health?.state).toBe('degraded');
    expect(health?.lastError).toContain('partial');
    expect(health?.lastError).toContain('visible sidebar');
    expect(health?.lastError).toContain('no verified lifecycle');
  });

  it('reports zero open conversations as ok, not as a failure', async () => {
    connector.noteReport(healthyNote({ at: now, observedSessionCount: 0 }));
    registry.register(connector);
    await registry.startAll();
    expect(ctx.store.getCoverage('claude-web')?.state).toBe('ok');
  });
});

describe('extension origin allowlist', () => {
  it('allows exactly the pinned extension id', () => {
    const origins = defaultAllowedOrigins('127.0.0.1', 4747);
    expect(origins).toContain(extensionOrigin());
    expect(extensionOrigin()).toBe('chrome-extension://mdbfiohpejlnjbeebkmplfhiommkaonf');
  });

  it('does not allow some other extension', () => {
    const origins = defaultAllowedOrigins('127.0.0.1', 4747);
    expect(origins).not.toContain('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});
