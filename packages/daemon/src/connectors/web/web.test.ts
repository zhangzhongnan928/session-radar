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
    connector.noteReport({
      at: now,
      observedConversations: 3,
      selectorsVersion: 'v1',
      missingAnchors: [],
    });
    registry.register(connector);
    await registry.startAll();
    const health = ctx.store.getCoverage('claude-web');
    expect(health?.state).toBe('ok');
    expect(health?.observedSessionCount).toBe(3);
  });

  it('goes DOWN when the extension stops reporting — Chrome closed', async () => {
    connector.noteReport({ at: now, observedConversations: 2, selectorsVersion: 'v1', missingAnchors: [] });
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
    connector.noteReport({
      at: now,
      observedConversations: 1,
      selectorsVersion: '2026.07.28-1',
      missingAnchors: ['composer', 'message'],
    });
    registry.register(connector);
    await registry.startAll();

    const health = ctx.store.getCoverage('claude-web');
    expect(health?.state).toBe('degraded');
    expect(health?.lastError).toContain('composer');
    expect(health?.lastError).toContain('2026.07.28-1');
    // Still counted — degraded means unreliable, not blind.
    expect(health?.observedSessionCount).toBe(1);
  });

  it('reports zero open conversations as ok, not as a failure', async () => {
    connector.noteReport({ at: now, observedConversations: 0, selectorsVersion: 'v1', missingAnchors: [] });
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
