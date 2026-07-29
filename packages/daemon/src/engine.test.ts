import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Source } from '@session-radar/shared';
import { canonicalKey } from '@session-radar/shared';
import { HookIngest } from './connectors/ingest.js';
import { CODEX_DESKTOP_SOURCE_ID } from './connectors/codex/connector.js';
import { CLAUDE_CODE_DESKTOP_CONNECTOR_ID } from './connectors/desktop/claude-code.js';
import { StaleSweeper, StatusEngine } from './engine.js';
import type { TempStore } from './testing.js';
import { createTempStore } from './testing.js';

const SESSION = 'sess-1';

const cliSource: Source = {
  id: 'claude-code-cli',
  provider: 'anthropic',
  surface: 'cli',
  device: 'test-mac',
};

describe('StatusEngine', () => {
  let ctx: TempStore;
  let now: number;
  let engine: StatusEngine;

  beforeEach(() => {
    ctx = createTempStore();
    now = 1_800_000_000_000;
    engine = new StatusEngine(ctx.store, () => now);
  });
  afterEach(() => ctx.close());

  function observe(signal: Parameters<StatusEngine['observe']>[0]['observations'][0]['signal'], at: number) {
    return engine.observe({
      identity: canonicalKey('anthropic', SESSION),
      provider: 'anthropic',
      surface: 'cli',
      title: 'Fix the rounding bug',
      source: cliSource,
      externalId: SESSION,
      context: { cwd: '/Users/victor/code/billing', repo: 'billing' },
      observations: [{ signal, at, connectorId: 'claude-code-cli' }],
      connectorId: 'claude-code-cli',
    });
  }

  it('derives status from the observation log rather than being told', () => {
    const result = observe('claude_code.post_tool_use', now - 60_000);
    expect(result.decision.status).toBe('running');
    expect(result.decision.rule).toBe('running.live-activity');
    expect(result.created).toBe(true);
  });

  it('accumulates observations across sightings', () => {
    observe('claude_code.post_tool_use', now - 120_000);
    const blocked = observe('claude_code.notification.permission_prompt', now - 1_000);
    expect(blocked.decision.status).toBe('needs_victor');

    const observations = ctx.store.listObservations(canonicalKey('anthropic', SESSION).key);
    expect(observations).toHaveLength(2);
  });

  it('is idempotent — a replayed hook does not duplicate the log', () => {
    observe('claude_code.stop', now - 1_000);
    observe('claude_code.stop', now - 1_000);
    expect(ctx.store.listObservations(canonicalKey('anthropic', SESSION).key)).toHaveLength(1);
  });

  it('keeps needs_victor even when later activity arrives', () => {
    observe('claude_code.notification.permission_prompt', now - 120_000);
    const later = observe('claude_code.post_tool_use', now - 1_000);
    expect(later.decision.status).toBe('needs_victor');
  });

  it('clears the block once the source confirms completion', () => {
    observe('claude_code.notification.permission_prompt', now - 120_000);
    const done = observe('claude_code.stop', now - 1_000);
    expect(done.decision.status).toBe('done');
  });

  it('reevaluate is a no-op when nothing changed', () => {
    observe('claude_code.post_tool_use', now - 1_000);
    const before = ctx.store.listEvidence(ctx.store.listWorkItems()[0]!.id).length;
    engine.reevaluate(canonicalKey('anthropic', SESSION).key, 'cli');
    expect(ctx.store.listEvidence(ctx.store.listWorkItems()[0]!.id)).toHaveLength(before);
  });

  it('reevaluate turns a running session stale once the clock moves past the threshold', () => {
    observe('claude_code.post_tool_use', now - 60_000);
    expect(ctx.store.listWorkItems()[0]?.status).toBe('running');

    now += 20 * 60_000;
    const decision = engine.reevaluate(canonicalKey('anthropic', SESSION).key, 'cli');
    expect(decision?.status).toBe('stale');
    expect(decision?.rule).toBe('stale.no-progress');
    expect(ctx.store.listWorkItems()[0]?.status).toBe('stale');
  });

  it('records the stale transition so the history explains itself', () => {
    observe('claude_code.post_tool_use', now - 60_000);
    now += 20 * 60_000;
    engine.reevaluate(canonicalKey('anthropic', SESSION).key, 'cli');

    const id = ctx.store.listWorkItems()[0]!.id;
    const transitions = ctx.store.listTransitions(id);
    expect(transitions[0]).toMatchObject({ from: 'running', to: 'stale' });
  });
});

describe('StaleSweeper', () => {
  let ctx: TempStore;
  let now: number;

  beforeEach(() => {
    ctx = createTempStore();
    now = 1_800_000_000_000;
  });
  afterEach(() => ctx.close());

  it('ages sessions out without any connector reporting again', () => {
    const engine = new StatusEngine(ctx.store, () => now);
    engine.observe({
      identity: canonicalKey('anthropic', SESSION),
      provider: 'anthropic',
      surface: 'cli',
      title: 'Long silent run',
      source: cliSource,
      externalId: SESSION,
      observations: [{ signal: 'claude_code.post_tool_use', at: now - 60_000 }],
      connectorId: 'claude-code-cli',
    });
    expect(ctx.store.listWorkItems()[0]?.status).toBe('running');

    now += 30 * 60_000;
    const sweeper = new StaleSweeper(ctx.store, engine, 1_000_000);
    expect(sweeper.sweepOnce()).toBe(1);
    expect(ctx.store.listWorkItems()[0]?.status).toBe('stale');
  });

  it('leaves a completed session alone — done does not age out', () => {
    const engine = new StatusEngine(ctx.store, () => now);
    engine.observe({
      identity: canonicalKey('anthropic', 'finished'),
      provider: 'anthropic',
      surface: 'cli',
      title: 'Finished work',
      source: cliSource,
      externalId: 'finished',
      observations: [{ signal: 'claude_code.stop', at: now - 60_000 }],
      connectorId: 'claude-code-cli',
    });

    now += 10 * 24 * 60 * 60_000;
    const sweeper = new StaleSweeper(ctx.store, engine, 1_000_000);
    sweeper.sweepOnce();
    expect(ctx.store.listWorkItems()[0]?.status).toBe('done');
    expect(
      ctx.store.listObservations(canonicalKey('anthropic', 'finished').key),
    ).toHaveLength(1);

    // The first sweep also runs retention compaction. A second sweep proves
    // the sole terminal signal survived and historical completion stays true.
    now += 24 * 60 * 60_000;
    sweeper.sweepOnce();
    expect(ctx.store.listWorkItems()[0]?.status).toBe('done');
  });
});

describe('HookIngest', () => {
  let ctx: TempStore;
  let ingest: HookIngest;

  beforeEach(() => {
    ctx = createTempStore();
    ctx.store.registerConnector({ id: 'claude-code-cli', displayName: 'Claude Code CLI' });
    ctx.store.registerConnector({
      id: CLAUDE_CODE_DESKTOP_CONNECTOR_ID,
      displayName: 'Claude Code Desktop',
    });
    ctx.store.registerConnector({ id: 'codex-cli', displayName: 'Codex CLI' });
    // Both connectors have completed a scan: registration leaves them `down`,
    // and we want to prove a hook warning DEGRADES a healthy connector.
    ctx.store.updateCoverage('claude-code-cli', { state: 'ok', lastError: null });
    ctx.store.updateCoverage(CLAUDE_CODE_DESKTOP_CONNECTOR_ID, {
      state: 'ok',
      lastError: null,
    });
    ctx.store.updateCoverage('codex-cli', { state: 'ok', lastError: null });
    ingest = new HookIngest({
      engine: new StatusEngine(ctx.store),
      store: ctx.store,
      device: 'test-mac',
    });
  });
  afterEach(() => ctx.close());

  it('turns a permission prompt into needs_victor', () => {
    const result = ingest.handle(
      'claude-code-cli',
      {
        session_id: SESSION,
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        cwd: '/Users/victor/code/billing',
      },
      Date.now(),
    );
    expect(result.accepted).toBe(true);
    expect(result.status).toBe('needs_victor');
    expect(ctx.store.listWorkItems()[0]?.context.repo).toBe('billing');
  });

  it('uses SessionStart session_title, which costs no message content', () => {
    ingest.handle(
      'claude-code-cli',
      {
        session_id: SESSION,
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_title: 'Refactor the billing module',
        cwd: '/Users/victor/code/billing',
      },
      Date.now(),
    );
    expect(ctx.store.listWorkItems()[0]?.title).toBe('Refactor the billing module');
  });

  it('degrades coverage on an unrecognised notification type instead of guessing', () => {
    const result = ingest.handle(
      'claude-code-cli',
      { session_id: SESSION, hook_event_name: 'Notification', notification_type: 'brand_new' },
      Date.now(),
    );
    expect(result.status).not.toBe('needs_victor');
    expect(ctx.store.getCoverage('claude-code-cli')?.state).toBe('degraded');
    expect(ctx.store.getCoverage('claude-code-cli')?.lastError).toMatch(/unrecognised/);
  });

  it('rejects a malformed payload and says so in coverage', () => {
    const result = ingest.handle('claude-code-cli', { nope: true }, Date.now());
    expect(result.accepted).toBe(false);
    expect(ctx.store.getCoverage('claude-code-cli')?.state).toBe('degraded');
  });

  it('never stores message content from the Stop hook', () => {
    ingest.handle(
      'claude-code-cli',
      {
        session_id: SESSION,
        hook_event_name: 'Stop',
        last_assistant_message: 'SECRET CONTENT THAT MUST NOT BE STORED',
      },
      Date.now(),
    );
    const dump = JSON.stringify(ctx.store.listEvidence(ctx.store.listWorkItems()[0]!.id));
    expect(dump).not.toContain('SECRET CONTENT');
    const observations = JSON.stringify(ctx.store.listObservations(canonicalKey('anthropic', SESSION).key));
    expect(observations).not.toContain('SECRET CONTENT');
  });

  it('does not mark Stop as done while background work or crons remain', () => {
    const result = ingest.handle(
      'claude-code-cli',
      {
        session_id: SESSION,
        hook_event_name: 'Stop',
        background_tasks: [
          {
            id: 'task-1',
            status: 'running',
            description: 'SECRET BACKGROUND DESCRIPTION',
            command: 'SECRET COMMAND',
          },
        ],
        session_crons: [{ id: 'cron-1', prompt: 'SECRET CRON PROMPT' }],
      },
      Date.now(),
    );

    expect(result.status).toBe('running');
    expect(result.signal).toBe('claude_code.background_work_pending');
    const observations = JSON.stringify(
      ctx.store.listObservations(canonicalKey('anthropic', SESSION).key),
    );
    expect(observations).toContain('"backgroundTaskCount":1');
    expect(observations).toContain('"sessionCronCount":1');
    expect(observations).not.toContain('SECRET');
  });

  it('turns StopFailure into needs_victor without storing rendered error text', () => {
    const result = ingest.handle(
      'claude-code-cli',
      {
        session_id: SESSION,
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        error_details: 'SECRET 429 BODY',
        last_assistant_message: 'SECRET RENDERED ERROR',
      },
      Date.now(),
    );
    expect(result.status).toBe('needs_victor');
    expect(result.signal).toBe('claude_code.stop_failure');
    const observations = JSON.stringify(
      ctx.store.listObservations(canonicalKey('anthropic', SESSION).key),
    );
    expect(observations).toContain('rate_limit');
    expect(observations).not.toContain('SECRET');
  });

  it('attributes shared hooks to Desktop when its metadata entry point is known', () => {
    const engine = new StatusEngine(ctx.store);
    engine.observe({
      identity: canonicalKey('anthropic', SESSION),
      provider: 'anthropic',
      surface: 'desktop',
      title: 'Desktop task',
      source: {
        id: CLAUDE_CODE_DESKTOP_CONNECTOR_ID,
        provider: 'anthropic',
        surface: 'desktop',
        device: 'test-mac',
      },
      externalId: 'local-desktop-session',
      locateHint: 'Claude Desktop → Code → Desktop task',
      observations: [
        {
          signal: 'claude_code.desktop_metadata_write',
          at: Date.now() - 1_000,
          connectorId: CLAUDE_CODE_DESKTOP_CONNECTOR_ID,
          surface: 'desktop',
        },
      ],
      connectorId: CLAUDE_CODE_DESKTOP_CONNECTOR_ID,
    });

    const result = ingest.handle(
      'claude-code-cli',
      { session_id: SESSION, hook_event_name: 'Stop' },
      Date.now(),
    );
    expect(result.status).toBe('done');
    const item = ctx.store.listWorkItems()[0];
    expect(item?.entryPoints).toHaveLength(1);
    expect(item?.entryPoints[0]?.source.id).toBe(CLAUDE_CODE_DESKTOP_CONNECTOR_ID);
    expect(item?.entryPoints[0]?.externalId).toBe('local-desktop-session');
  });

  it('maps Codex approval-requested to needs_victor', () => {
    const result = ingest.handle(
      'codex-cli',
      { type: 'approval-requested', 'session-id': 'codex-1', cwd: '/Users/victor/code/auth' },
      Date.now(),
    );
    expect(result.status).toBe('needs_victor');
    expect(result.signal).toBe('codex.approval_requested');
  });

  it('maps Codex agent-turn-complete to done', () => {
    const result = ingest.handle(
      'codex-cli',
      { type: 'agent-turn-complete', 'session-id': 'codex-2' },
      Date.now(),
    );
    expect(result.status).toBe('done');
  });

  it('attributes Codex notify events to Desktop after the rollout identified it', () => {
    const engine = new StatusEngine(ctx.store);
    engine.observe({
      identity: canonicalKey('openai', 'codex-desktop-1'),
      provider: 'openai',
      surface: 'desktop',
      title: 'Desktop task',
      source: {
        id: CODEX_DESKTOP_SOURCE_ID,
        provider: 'openai',
        surface: 'desktop',
        device: 'test-mac',
      },
      externalId: 'codex-desktop-1',
      locateHint: 'Codex Desktop → Tasks → Desktop task',
      observations: [
        {
          signal: 'codex.task_started',
          at: Date.now() - 1_000,
          connectorId: 'codex-cli',
          surface: 'desktop',
        },
      ],
      connectorId: 'codex-cli',
    });

    const result = ingest.handle(
      'codex-cli',
      { type: 'agent-turn-complete', 'session-id': 'codex-desktop-1' },
      Date.now(),
    );
    expect(result.status).toBe('done');
    const item = ctx.store.getWorkItemByCanonicalKey(
      canonicalKey('openai', 'codex-desktop-1').key,
    );
    expect(item?.entryPoints).toHaveLength(1);
    expect(item?.entryPoints[0]?.source.id).toBe(CODEX_DESKTOP_SOURCE_ID);
    expect(item?.entryPoints[0]?.source.surface).toBe('desktop');
  });

  it('ignores a redundant Codex notify with no session id without degrading coverage', () => {
    const result = ingest.handle('codex-cli', { type: 'agent-turn-complete' }, Date.now());
    expect(result.accepted).toBe(true);
    expect(result.warning).toMatch(/session-id/);
    expect(ctx.store.getCoverage('codex-cli')?.state).toBe('ok');
  });

  it('never stores Codex message content', () => {
    ingest.handle(
      'codex-cli',
      {
        type: 'agent-turn-complete',
        'session-id': 'codex-3',
        'last-assistant-message': 'SECRET REPLY',
      },
      Date.now(),
    );
    expect(JSON.stringify(ctx.store.listObservations(canonicalKey('openai', 'codex-3').key))).not.toContain('SECRET');
  });

  it('records a hook warning even before the connector has ever scanned', () => {
    // Registration leaves a connector `down`; the warning must still land.
    ctx.store.updateCoverage('codex-cli', { state: 'down', lastError: null });
    ingest.handle(
      'codex-cli',
      { type: 'future-notify-event', 'session-id': 'codex-future' },
      Date.now(),
    );
    const health = ctx.store.getCoverage('codex-cli');
    expect(health?.state).toBe('down');
    expect(health?.lastError).toMatch(/future-notify-event/);
  });

  it('rejects an unknown connector', () => {
    expect(ingest.handle('mystery', {}, Date.now()).accepted).toBe(false);
  });
});
