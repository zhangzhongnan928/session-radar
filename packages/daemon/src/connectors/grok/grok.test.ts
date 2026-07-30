import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusEngine } from '../../engine.js';
import { applyGrokHooks } from '../../install/grok-hooks.js';
import { createNullLogger } from '../../logger.js';
import { ConnectorRegistry } from '../../registry.js';
import type { TempStore } from '../../testing.js';
import { createTempStore } from '../../testing.js';
import { HookIngest, grokSignalFor } from '../ingest.js';
import {
  GROK_CONNECTOR_ID,
  GrokBuildConnector,
  grokResumeCommand,
} from './connector.js';
import {
  listGrokSummaries,
  readGrokActiveSessions,
  readGrokSummary,
} from './summary.js';

const SESSION = '0e298232-54af-455c-81d5-027f18063f6c';
const NOW = Date.now();

describe('Grok Build summary inventory', () => {
  let ctx: TempStore;
  let grokHome: string;
  let summaryPath: string;

  beforeEach(() => {
    ctx = createTempStore();
    grokHome = join(ctx.home, 'dot-grok');
    const sessionDir = join(grokHome, 'sessions', '%2FUsers%2Fvictor%2Fcode%2Fradar', SESSION);
    mkdirSync(sessionDir, { recursive: true });
    summaryPath = join(sessionDir, 'summary.json');
    writeFileSync(
      summaryPath,
      JSON.stringify({
        info: { id: SESSION, cwd: '/Users/victor/code/radar' },
        generated_title: 'Add Grok Build support',
        session_summary: 'A bounded generated summary',
        created_at: new Date(NOW - 60_000).toISOString(),
        updated_at: new Date(NOW - 10_000).toISOString(),
        last_active_at: new Date(NOW - 5_000).toISOString(),
        current_model_id: 'grok-code-fast',
        num_messages: 12,
        num_chat_messages: 4,
      }),
    );
    writeFileSync(
      join(sessionDir, 'updates.jsonl'),
      '{"prompt":"SECRET PROMPT THAT MUST NEVER BE READ"}\n',
    );
  });

  afterEach(() => ctx.close());

  it('walks only summary.json and extracts the first-party metadata contract', () => {
    const files = listGrokSummaries(grokHome);
    expect(files).toHaveLength(1);
    const summary = readGrokSummary(files[0]!);
    expect(summary).toMatchObject({
      sessionId: SESSION,
      cwd: '/Users/victor/code/radar',
      generatedTitle: 'Add Grok Build support',
      modelId: 'grok-code-fast',
      numMessages: 12,
    });
  });

  it('rejects a summary whose id disagrees with its storage directory', () => {
    writeFileSync(
      summaryPath,
      JSON.stringify({ info: { id: 'different-id', cwd: '/tmp' } }),
    );
    expect(() => readGrokSummary(listGrokSummaries(grokHome)[0]!)).toThrow(
      /does not match directory/,
    );
  });

  it('validates the active TUI registry without reading session bodies', () => {
    writeFileSync(
      join(grokHome, 'active_sessions.json'),
      JSON.stringify([
        {
          session_id: SESSION,
          pid: 1234,
          cwd: '/Users/victor/code/radar',
          opened_at: new Date(NOW).toISOString(),
        },
      ]),
    );
    expect(readGrokActiveSessions(grokHome)).toEqual([
      {
        sessionId: SESSION,
        pid: 1234,
        cwd: '/Users/victor/code/radar',
        openedAt: expect.any(Number),
      },
    ]);
  });
});

describe('Grok Build connector', () => {
  let ctx: TempStore;
  let grokHome: string;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    ctx = createTempStore();
    grokHome = join(ctx.home, 'dot-grok');
    const sessionDir = join(grokHome, 'sessions', '%2Frepo', SESSION);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'summary.json'),
      JSON.stringify({
        info: { id: SESSION, cwd: '/Users/victor/AI Session Status Dashboard' },
        generated_title: 'Implement Grok support',
        created_at: new Date(NOW - 120_000).toISOString(),
        updated_at: new Date(NOW - 30_000).toISOString(),
        last_active_at: new Date(NOW - 20_000).toISOString(),
        current_model_id: 'grok-code-fast',
      }),
    );
    writeFileSync(join(grokHome, 'version.json'), JSON.stringify({ version: '0.2.114' }));
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
    });
  });

  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  function connector(isPidAlive: (pid: number) => boolean = () => true): GrokBuildConnector {
    return new GrokBuildConnector({
      engine: new StatusEngine(ctx.store),
      home: grokHome,
      binaryPath: '/opt/grok',
      hookPort: 4747,
      device: 'test-mac',
      isPidAlive,
    });
  }

  it('creates an xAI inventory item without claiming inventory means running', async () => {
    applyGrokHooks(4747, undefined, grokHome);
    registry.register(connector());
    await registry.startAll();

    const item = ctx.store.listWorkItems()[0];
    expect(item).toMatchObject({
      provider: 'xai',
      title: 'Implement Grok support',
      status: 'stale',
      context: { repo: 'AI Session Status Dashboard' },
    });
    expect(item?.currentEvidence?.signal).toBe('grok.inventory_seen');
    expect(item?.entryPoints[0]?.source.version).toBe('0.2.114');
    expect(item?.entryPoints[0]?.resumeCommand).toContain(`--resume '${SESSION}'`);
    expect(ctx.store.getCoverage(GROK_CONNECTOR_ID)?.state).toBe('ok');
    expect(JSON.stringify(ctx.store.listEvidence(item!.id))).not.toContain('SECRET');
  });

  it('reports degraded coverage until the lifecycle hooks are installed', async () => {
    registry.register(connector());
    await registry.startAll();
    expect(ctx.store.getCoverage(GROK_CONNECTOR_ID)).toMatchObject({
      state: 'degraded',
      observedSessionCount: 1,
    });
    expect(ctx.store.getCoverage(GROK_CONNECTOR_ID)?.lastError).toMatch(
      /lifecycle hooks are missing/,
    );
  });

  it('uses the active registry only as liveness, never as progress', async () => {
    applyGrokHooks(4747, undefined, grokHome);
    writeFileSync(
      join(grokHome, 'active_sessions.json'),
      JSON.stringify([{ session_id: SESSION, pid: 1234 }]),
    );
    registry.register(connector(() => true));
    await registry.startAll();

    const item = ctx.store.listWorkItems()[0]!;
    expect(item.status).toBe('stale');
    expect(
      ctx.store
        .listObservations(`xai:id:${SESSION}`)
        .map((row) => row.signal),
    ).toContain(
      'grok.process_alive',
    );
  });

  it('degrades instead of silently dropping a malformed summary', async () => {
    applyGrokHooks(4747, undefined, grokHome);
    const file = listGrokSummaries(grokHome)[0]!;
    writeFileSync(file.path, '{"info":42}');
    registry.register(connector());
    await registry.startAll();

    expect(ctx.store.getCoverage(GROK_CONNECTOR_ID)).toMatchObject({
      state: 'degraded',
      observedSessionCount: 0,
    });
    expect(ctx.store.getCoverage(GROK_CONNECTOR_ID)?.lastError).toMatch(
      /could not read Grok Build session/,
    );
  });
});

describe('Grok Build hook lifecycle', () => {
  let ctx: TempStore;
  let ingest: HookIngest;

  beforeEach(() => {
    ctx = createTempStore();
    ctx.store.registerConnector({
      id: GROK_CONNECTOR_ID,
      displayName: 'Grok Build',
      provider: 'xai',
      surface: 'cli',
    });
    ctx.store.updateCoverage(GROK_CONNECTOR_ID, {
      state: 'ok',
      lastError: null,
    });
    ingest = new HookIngest({
      store: ctx.store,
      engine: new StatusEngine(ctx.store),
      device: 'test-mac',
    });
  });

  afterEach(() => ctx.close());

  function send(
    hookEventName: string,
    at: number,
    extra: Record<string, unknown> = {},
  ): ReturnType<HookIngest['handle']> {
    return ingest.handle(
      GROK_CONNECTOR_ID,
      {
        sessionId: SESSION,
        hookEventName,
        cwd: '/Users/victor/code/radar',
        timestamp: new Date(at).toISOString(),
        ...extra,
      },
      at,
    );
  }

  it('maps prompt, permission, and genuine stop into running, needs-you, and done', () => {
    expect(send('user_prompt_submit', NOW).status).toBe('running');
    expect(
      send('notification', NOW + 1_000, {
        notificationType: 'permission_prompt',
        message: 'SECRET APPROVAL MESSAGE',
      }).status,
    ).toBe('needs_victor');
    expect(send('stop', NOW + 2_000, { reason: 'end_turn' }).status).toBe('done');

    const item = ctx.store.listWorkItems()[0]!;
    expect(JSON.stringify(ctx.store.listEvidence(item.id))).not.toContain(
      'SECRET APPROVAL MESSAGE',
    );
  });

  it('keeps a stopped turn running when Grok reports background work', () => {
    send('user_prompt_submit', NOW);
    const result = send('stop', NOW + 1_000, {
      reason: 'end_turn',
      backgroundTasks: [
        {
          id: 'task-1',
          description: 'SECRET BACKGROUND TASK',
          command: 'SECRET COMMAND',
        },
      ],
    });
    expect(result.signal).toBe('grok.background_work_pending');
    expect(result.status).toBe('running');
    expect(JSON.stringify(ctx.store.listEvidence(result.workItemId!))).not.toContain(
      'SECRET BACKGROUND TASK',
    );
  });

  it('treats an unknown notification as informational and degrades coverage', () => {
    const result = send('notification', NOW, { notificationType: 'future_event' });
    expect(result.signal).toBe('grok.notification_info');
    expect(result.warning).toMatch(/unrecognised/);
    expect(ctx.store.getCoverage(GROK_CONNECTOR_ID)?.state).toBe('degraded');
  });

  it('never lets a subagent completion mark the parent session done', () => {
    send('user_prompt_submit', NOW);
    const subagent = send('subagent_stop', NOW + 1_000, {
      subagentId: 'subagent-123',
      subagentType: 'explore',
    });
    expect(subagent.status).toBe('done');

    const parent = ctx.store.getWorkItemByCanonicalKey(`xai:id:${SESSION}`);
    expect(parent?.status).toBe('running');
    expect(ctx.store.listWorkItems()).toHaveLength(2);
  });

  it('normalises documented snake_case and PascalCase event names', () => {
    expect(grokSignalFor('SessionStart', undefined).signal).toBe('grok.session_start');
    expect(grokSignalFor('stop_failure', undefined).signal).toBe('grok.stop_failure');
    expect(grokSignalFor('Stop', undefined, true).signal).toBe(
      'grok.background_work_pending',
    );
  });

  it('routes Grok envelopes delivered through Grok’s Claude-hook compatibility', () => {
    const result = ingest.handle(
      'claude-code-cli',
      {
        sessionId: SESSION,
        hookEventName: 'user_prompt_submit',
        cwd: '/Users/victor/code/radar',
        timestamp: new Date(NOW).toISOString(),
      },
      NOW,
    );
    expect(result.signal).toBe('grok.user_prompt_submit');
    expect(ctx.store.listWorkItems()[0]?.provider).toBe('xai');
    expect(ctx.store.getCoverage('claude-code-cli')).toBeUndefined();
  });
});

describe('Grok Build resume command', () => {
  it('quotes both cwd and binary path', () => {
    expect(
      grokResumeCommand(
        SESSION,
        "/Users/victor/AI Session Status Dashboard/it's",
        '/Applications/Grok Build/bin/grok',
      ),
    ).toBe(
      `cd '/Users/victor/AI Session Status Dashboard/it'\\''s' && ` +
        `'/Applications/Grok Build/bin/grok' --resume '${SESSION}'`,
    );
  });
});
