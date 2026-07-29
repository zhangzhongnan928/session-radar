import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Source } from '@session-radar/shared';
import { canonicalKey } from '@session-radar/shared';
import type { BusEnvelope } from './bus.js';
import { EventBus } from './bus.js';
import { openDb } from './db/open.js';
import type { SightingInput } from './store.js';
import { Store } from './store.js';
import type { TempStore } from './testing.js';
import { createTempStore, decisionFixture } from './testing.js';

const AT = 1_800_000_000_000;

const cliSource: Source = {
  id: 'claude-code-cli',
  provider: 'anthropic',
  surface: 'cli',
  device: 'victors-mac',
};

const webSource: Source = {
  id: 'claude-web-extension',
  provider: 'anthropic',
  surface: 'extension',
  device: 'victors-mac',
};

function sighting(overrides: Partial<SightingInput> = {}): SightingInput {
  return {
    identity: canonicalKey('anthropic', 'conv-1'),
    provider: 'anthropic',
    title: 'Refactor billing',
    source: cliSource,
    externalId: 'conv-1',
    context: { cwd: '/Users/victor/code/billing', repo: 'billing' },
    resumeCommand: 'claude --resume conv-1',
    at: AT,
    decision: decisionFixture(),
    connectorId: 'claude-code-cli',
    ...overrides,
  };
}

describe('Store — work items', () => {
  let ctx: TempStore;
  beforeEach(() => {
    ctx = createTempStore();
  });
  afterEach(() => {
    ctx.close();
  });

  it('creates a work item on first sighting, with traceable evidence', () => {
    const result = ctx.store.recordSighting(sighting());
    expect(result.created).toBe(true);

    const item = ctx.store.getWorkItem(result.workItemId);
    expect(item?.status).toBe('running');
    expect(item?.title).toBe('Refactor billing');
    expect(item?.context.repo).toBe('billing');
    expect(item?.currentEvidence?.id).toBe(result.evidenceId);
    expect(item?.currentEvidence?.rule).toBe('running.live-activity');
    expect(item?.entryPoints).toHaveLength(1);
    expect(item?.entryPoints[0]?.resumeCommand).toBe('claude --resume conv-1');
  });

  it('records a transition from null for the first status', () => {
    const { workItemId } = ctx.store.recordSighting(sighting());
    const transitions = ctx.store.listTransitions(workItemId);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.from).toBeNull();
    expect(transitions[0]?.to).toBe('running');
  });

  it('merges a second surface into ONE work item with two entry points', () => {
    const first = ctx.store.recordSighting(sighting());
    const second = ctx.store.recordSighting(
      sighting({
        source: webSource,
        url: 'https://claude.ai/chat/conv-1',
        resumeCommand: undefined,
        at: AT + 1_000,
      }),
    );

    expect(second.workItemId).toBe(first.workItemId);
    expect(second.created).toBe(false);
    expect(ctx.store.countWorkItems()).toBe(1);

    const item = ctx.store.getWorkItem(first.workItemId);
    expect(item?.entryPoints).toHaveLength(2);
    expect(item?.entryPoints.map((e) => e.source.surface).sort()).toEqual(['cli', 'extension']);
    expect(item?.entryPoints.every((e) => e.mergeBasis === 'canonical-id')).toBe(true);
  });

  it('lists indexed external ids by source and provider for archive backfill', () => {
    ctx.store.recordSighting(sighting());
    ctx.store.recordSighting(
      sighting({
        source: webSource,
        externalId: 'web-conv-1',
        url: 'https://claude.ai/chat/web-conv-1',
      }),
    );

    expect([...ctx.store.externalIdsForSource('claude-code-cli')]).toEqual(['conv-1']);
    expect([...ctx.store.externalIdsForSource('claude-web-extension')]).toEqual([
      'web-conv-1',
    ]);
    expect([...ctx.store.externalIdsForProvider('anthropic')].sort()).toEqual([
      'conv-1',
      'web-conv-1',
    ]);
    expect(ctx.store.externalIdsForProvider('openai').size).toBe(0);
  });

  it('retains vendor-archived rows without putting them in recent triage', () => {
    const { workItemId } = ctx.store.recordSighting(
      sighting({ sourceArchived: true }),
    );

    expect(ctx.store.listWorkItems()).toHaveLength(1);
    expect(ctx.store.listWorkItems(AT - 1)).toHaveLength(0);
    expect(ctx.store.getWorkItem(workItemId)?.entryPoints[0]?.archived).toBe(true);

    ctx.store.recordSighting(
      sighting({ sourceArchived: false, at: AT + 1_000 }),
    );
    expect(ctx.store.listWorkItems(AT - 1)).toHaveLength(1);
    expect(ctx.store.getWorkItem(workItemId)?.entryPoints[0]?.archived).toBe(false);
  });

  it('keeps a merged item in triage when at least one source is not archived', () => {
    ctx.store.recordSighting(sighting({ sourceArchived: true }));
    ctx.store.recordSighting(
      sighting({
        source: webSource,
        sourceArchived: false,
        url: 'https://claude.ai/chat/conv-1',
      }),
    );

    expect(ctx.store.listWorkItems(AT - 1)).toHaveLength(1);
  });

  it('atomically collapses a late explicit identity alias without losing history', () => {
    const remote = canonicalKey('anthropic', 'session_remote');
    const local = canonicalKey('anthropic', 'local-cli-id');
    const remoteItem = ctx.store.recordSighting(
      sighting({
        identity: remote,
        source: webSource,
        externalId: 'session_remote',
        title: 'Remote account title',
        titlePriority: 20,
        context: { conversationId: 'session_remote' },
        url: 'https://claude.ai/',
        at: AT + 2_000,
        decision: decisionFixture({
          status: 'done',
          rule: 'done.source-confirmed',
          evaluatedAt: AT + 2_000,
          basisAt: AT + 2_000,
        }),
      }),
    );
    const localItem = ctx.store.recordSighting(
      sighting({
        identity: local,
        externalId: 'local-cli-id',
        title: 'Local source-native title',
        titlePriority: 30,
        at: AT,
      }),
    );
    ctx.store.setAttention(localItem.workItemId, 'seen');
    ctx.store.recordObservations(remote.key, [
      {
        signal: 'claude.agent_review_ready',
        at: AT + 2_000,
        connectorId: 'claude-agent-sessions',
        surface: 'web',
      },
    ]);
    ctx.store.recordObservations(local.key, [
      {
        signal: 'claude_code.post_tool_use',
        at: AT,
        connectorId: 'claude-code-cli',
        surface: 'cli',
      },
    ]);

    expect(ctx.store.mergeCanonicalKeys(remote.key, local.key)).toBe(true);
    expect(ctx.store.countWorkItems()).toBe(1);
    expect(ctx.store.getWorkItem(remoteItem.workItemId)).toBeUndefined();

    const item = ctx.store.getWorkItem(localItem.workItemId);
    expect(item).toMatchObject({
      canonicalKey: local.key,
      title: 'Local source-native title',
      lastActivityAt: AT + 2_000,
      attention: 'unseen',
      context: {
        repo: 'billing',
        conversationId: 'session_remote',
      },
    });
    expect(item?.entryPoints.map((entry) => entry.source.surface).sort()).toEqual([
      'cli',
      'extension',
    ]);
    expect(ctx.store.listEvidence(localItem.workItemId)).toHaveLength(2);
    expect(ctx.store.listTransitions(localItem.workItemId)).toHaveLength(2);
    expect(ctx.store.listObservations(remote.key)).toHaveLength(0);
    expect(ctx.store.listObservations(local.key)).toHaveLength(2);
  });

  it('does not duplicate an entry point when the same source is seen again', () => {
    const first = ctx.store.recordSighting(sighting());
    ctx.store.recordSighting(sighting({ at: AT + 5_000 }));
    const item = ctx.store.getWorkItem(first.workItemId);
    expect(item?.entryPoints).toHaveLength(1);
    expect(item?.entryPoints[0]?.lastSeenAt).toBe(AT + 5_000);
    expect(item?.entryPoints[0]?.firstSeenAt).toBe(AT);
  });

  it('keeps a deep link discovered later even if a later sighting omits it', () => {
    const first = ctx.store.recordSighting(
      sighting({ source: webSource, url: 'https://claude.ai/chat/conv-1' }),
    );
    ctx.store.recordSighting(sighting({ source: webSource, url: undefined, at: AT + 100 }));
    const item = ctx.store.getWorkItem(first.workItemId);
    expect(item?.entryPoints[0]?.url).toBe('https://claude.ai/chat/conv-1');
  });

  it('does not let a weaker cross-surface title overwrite a source-native title', () => {
    const first = ctx.store.recordSighting(
      sighting({ title: 'Desktop custom title', titlePriority: 30 }),
    );
    ctx.store.recordSighting(
      sighting({
        source: webSource,
        title: 'First prompt approximation',
        titlePriority: 20,
        at: AT + 1_000,
      }),
    );
    expect(ctx.store.getWorkItem(first.workItemId)?.title).toBe('Desktop custom title');

    ctx.store.recordSighting(
      sighting({
        source: webSource,
        title: 'Newer source-native title',
        titlePriority: 30,
        at: AT + 2_000,
      }),
    );
    expect(ctx.store.getWorkItem(first.workItemId)?.title).toBe(
      'Newer source-native title',
    );
  });

  it('atomically replaces an entry point emitted by an older classifier', () => {
    const first = ctx.store.recordSighting(sighting());
    ctx.store.recordSighting(
      sighting({
        source: {
          id: 'claude-code-desktop',
          provider: 'anthropic',
          surface: 'desktop',
          device: 'victors-mac',
        },
        resumeCommand: undefined,
        locateHint: 'Claude Desktop → Code',
        replacesSourceIds: ['claude-code-cli'],
        at: AT + 1_000,
      }),
    );
    const item = ctx.store.getWorkItem(first.workItemId);
    expect(item?.entryPoints).toHaveLength(1);
    expect(item?.entryPoints[0]?.source.id).toBe('claude-code-desktop');
    expect(item?.entryPoints[0]?.resumeCommand).toBeUndefined();
    expect(item?.entryPoints[0]?.locateHint).toBe('Claude Desktop → Code');
  });

  it('writes a transition and moves statusSince when the status changes', () => {
    const { workItemId } = ctx.store.recordSighting(sighting());
    ctx.store.applyDecision(
      workItemId,
      decisionFixture({
        status: 'needs_victor',
        rule: 'needs_victor.blocking-signal',
        basisSignal: 'claude_code.notification.permission_prompt',
        evaluatedAt: AT + 60_000,
      }),
    );

    const item = ctx.store.getWorkItem(workItemId);
    expect(item?.status).toBe('needs_victor');
    expect(item?.statusSince).toBe(AT + 60_000);

    const transitions = ctx.store.listTransitions(workItemId);
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ from: 'running', to: 'needs_victor' });
  });

  it('does not move statusSince when the status is merely reconfirmed', () => {
    const { workItemId } = ctx.store.recordSighting(sighting());
    const write = ctx.store.applyDecision(
      workItemId,
      decisionFixture({ evaluatedAt: AT + 60_000 }),
    );
    expect(write.statusChanged).toBe(false);
    expect(ctx.store.getWorkItem(workItemId)?.statusSince).toBe(AT);
    expect(ctx.store.listTransitions(workItemId)).toHaveLength(1);
  });

  it('never moves lastActivityAt backwards', () => {
    const { workItemId } = ctx.store.recordSighting(sighting({ at: AT + 10_000 }));
    ctx.store.recordSighting(sighting({ at: AT }));
    expect(ctx.store.getWorkItem(workItemId)?.lastActivityAt).toBe(AT + 10_000);
  });

  it('keeps a full evidence trail, newest first', () => {
    const { workItemId } = ctx.store.recordSighting(sighting());
    ctx.store.applyDecision(workItemId, decisionFixture({ evaluatedAt: AT + 1_000 }));
    ctx.store.applyDecision(
      workItemId,
      decisionFixture({ status: 'done', rule: 'done.source-confirmed', evaluatedAt: AT + 2_000 }),
    );

    const evidence = ctx.store.listEvidence(workItemId);
    expect(evidence).toHaveLength(3);
    expect(evidence[0]?.resultingStatus).toBe('done');
    expect(evidence[0]?.at).toBe(AT + 2_000);
    expect(evidence.at(-1)?.at).toBe(AT);
  });

  it('stores the decision reason in evidence so the dashboard can explain itself', () => {
    const { workItemId } = ctx.store.recordSighting(sighting());
    const evidence = ctx.store.listEvidence(workItemId)[0];
    expect(evidence?.raw).toMatchObject({ reason: 'a tool call completed', basisAt: AT });
  });

  it('compacts repeated old observations but retains the last status-bearing signal', () => {
    const key = canonicalKey('openai', 'historical-task').key;
    ctx.store.recordObservations(key, [
      { signal: 'codex.rollout_write', at: AT - 3_000 },
      { signal: 'codex.rollout_write', at: AT - 2_000 },
      { signal: 'codex.task_complete', at: AT - 4_000 },
    ]);

    expect(ctx.store.pruneObservations(AT - 1_000)).toBe(1);
    expect(
      ctx.store.listObservations(key).map((observation) => [
        observation.signal,
        observation.at,
      ]),
    ).toEqual([
      ['codex.rollout_write', AT - 2_000],
      ['codex.task_complete', AT - 4_000],
    ]);
  });

  it('rejects a decision for an unknown work item instead of inventing one', () => {
    expect(() => ctx.store.applyDecision('wi_nope', decisionFixture())).toThrow(/unknown work item/);
  });

  it('sorts the list into scan order', () => {
    ctx.store.recordSighting(
      sighting({ identity: canonicalKey('anthropic', 'a'), externalId: 'a', at: AT + 3 }),
    );
    const blocked = ctx.store.recordSighting(
      sighting({ identity: canonicalKey('anthropic', 'b'), externalId: 'b', at: AT + 2 }),
    );
    ctx.store.applyDecision(
      blocked.workItemId,
      decisionFixture({ status: 'needs_victor', rule: 'needs_victor.blocking-signal' }),
    );

    const items = ctx.store.listWorkItems();
    expect(items[0]?.status).toBe('needs_victor');
  });

  it('can limit the triage view without deleting historical rows', () => {
    ctx.store.recordSighting(
      sighting({
        identity: canonicalKey('anthropic', 'old'),
        externalId: 'old',
        at: AT - 10_000,
        decision: decisionFixture({
          status: 'stale',
          rule: 'stale.no-progress',
          evaluatedAt: AT - 10_000,
          basisAt: AT - 10_000,
        }),
      }),
    );
    ctx.store.recordSighting(
      sighting({
        identity: canonicalKey('anthropic', 'recent'),
        externalId: 'recent',
        at: AT,
      }),
    );

    expect(ctx.store.listWorkItems(AT - 1_000).map((item) => item.canonicalKey)).toEqual([
      canonicalKey('anthropic', 'recent').key,
    ]);
    expect(ctx.store.countWorkItems()).toBe(2);
  });

  it('never hides old running or needs-you work from the triage view', () => {
    ctx.store.recordSighting(
      sighting({
        identity: canonicalKey('anthropic', 'old-running'),
        externalId: 'old-running',
        at: AT - 10_000,
        activityAt: AT - 10_000,
        decision: decisionFixture({
          status: 'running',
          evaluatedAt: AT - 10_000,
          basisAt: AT - 10_000,
        }),
      }),
    );
    ctx.store.recordSighting(
      sighting({
        identity: canonicalKey('anthropic', 'old-blocked'),
        externalId: 'old-blocked',
        at: AT - 10_000,
        activityAt: AT - 10_000,
        decision: decisionFixture({
          status: 'needs_victor',
          rule: 'needs_victor.blocking-signal',
          evaluatedAt: AT - 10_000,
          basisAt: AT - 10_000,
        }),
      }),
    );

    expect(
      ctx.store
        .listWorkItems(AT - 1_000)
        .map((item) => item.canonicalKey)
        .sort(),
    ).toEqual(
      [
        canonicalKey('anthropic', 'old-running').key,
        canonicalKey('anthropic', 'old-blocked').key,
      ].sort(),
    );
  });

  it('toggles attention without touching status', () => {
    const { workItemId } = ctx.store.recordSighting(sighting());
    expect(ctx.store.getWorkItem(workItemId)?.attention).toBe('unseen');
    expect(ctx.store.setAttention(workItemId, 'seen')).toBe(true);
    const item = ctx.store.getWorkItem(workItemId);
    expect(item?.attention).toBe('seen');
    expect(item?.status).toBe('running');
    expect(ctx.store.setAttention('wi_nope', 'seen')).toBe(false);
  });

  it('baselines the imported completion backlog exactly once', () => {
    const oldDone = ctx.store.recordSighting(
      sighting({
        identity: canonicalKey('anthropic', 'old-done'),
        externalId: 'old-done',
        decision: decisionFixture({
          status: 'done',
          rule: 'done.source-confirmed',
        }),
      }),
    );
    expect(ctx.store.getWorkItem(oldDone.workItemId)?.attention).toBe('unseen');
    expect(ctx.store.initializeAttentionBaseline()).toBe(1);
    expect(ctx.store.getWorkItem(oldDone.workItemId)?.attention).toBe('seen');

    const laterDone = ctx.store.recordSighting(
      sighting({
        identity: canonicalKey('anthropic', 'later-done'),
        externalId: 'later-done',
        decision: decisionFixture({
          status: 'done',
          rule: 'done.source-confirmed',
        }),
      }),
    );
    expect(ctx.store.initializeAttentionBaseline()).toBe(0);
    expect(ctx.store.getWorkItem(laterDone.workItemId)?.attention).toBe('unseen');
  });

  it('makes a newly completed turn unseen even if the session was acknowledged before', () => {
    const { workItemId } = ctx.store.recordSighting(sighting());
    ctx.store.setAttention(workItemId, 'seen');
    ctx.store.applyDecision(
      workItemId,
      decisionFixture({
        status: 'done',
        rule: 'done.source-confirmed',
        evaluatedAt: AT + 1_000,
      }),
    );
    expect(ctx.store.getWorkItem(workItemId)?.attention).toBe('unseen');
  });

  it('reopens an acknowledged status-unknown chat when its source timestamp advances', () => {
    const identity = canonicalKey('anthropic', 'ordinary-chat');
    const staleDecision = decisionFixture({
      status: 'stale',
      rule: 'stale.inventory-only',
    });
    const { workItemId } = ctx.store.recordSighting(
      sighting({
        identity,
        externalId: 'ordinary-chat',
        activityAt: AT,
        decision: staleDecision,
      }),
    );
    ctx.store.setAttention(workItemId, 'seen');

    ctx.store.recordSighting(
      sighting({
        identity,
        externalId: 'ordinary-chat',
        at: AT + 60_000,
        activityAt: AT + 30_000,
        decision: decisionFixture({
          status: 'stale',
          rule: 'stale.inventory-only',
          evaluatedAt: AT + 60_000,
        }),
      }),
    );

    expect(ctx.store.getWorkItem(workItemId)).toMatchObject({
      status: 'stale',
      attention: 'unseen',
      lastActivityAt: AT + 30_000,
    });
  });

  it('keeps an acknowledged unknown chat quiet when only the collector scan time advances', () => {
    const identity = canonicalKey('openai', 'unchanged-chat');
    const { workItemId } = ctx.store.recordSighting(
      sighting({
        identity,
        provider: 'openai',
        externalId: 'unchanged-chat',
        activityAt: AT,
        decision: decisionFixture({
          status: 'stale',
          rule: 'stale.inventory-only',
        }),
      }),
    );
    ctx.store.setAttention(workItemId, 'seen');

    ctx.store.recordSighting(
      sighting({
        identity,
        provider: 'openai',
        externalId: 'unchanged-chat',
        at: AT + 60_000,
        activityAt: AT,
        decision: decisionFixture({
          status: 'stale',
          rule: 'stale.inventory-only',
          evaluatedAt: AT + 60_000,
        }),
      }),
    );

    expect(ctx.store.getWorkItem(workItemId)?.attention).toBe('seen');
  });

  it('reopens a done item when another turn completes between polls', () => {
    const identity = canonicalKey('anthropic', 'repeat-completion');
    const { workItemId } = ctx.store.recordSighting(
      sighting({
        identity,
        externalId: 'repeat-completion',
        activityAt: AT,
        decision: decisionFixture({
          status: 'done',
          rule: 'done.source-confirmed',
        }),
      }),
    );
    ctx.store.setAttention(workItemId, 'seen');

    ctx.store.recordSighting(
      sighting({
        identity,
        externalId: 'repeat-completion',
        at: AT + 2_000,
        activityAt: AT + 1_000,
        decision: decisionFixture({
          status: 'done',
          rule: 'done.source-confirmed',
          evaluatedAt: AT + 2_000,
          basisAt: AT + 1_000,
        }),
      }),
    );

    expect(ctx.store.getWorkItem(workItemId)?.attention).toBe('unseen');
  });

  it('generates a stable device id', () => {
    expect(ctx.store.deviceId()).toBe(ctx.store.deviceId());
  });
});

describe('Store — bus events', () => {
  let ctx: TempStore;
  let events: BusEnvelope[];

  beforeEach(() => {
    ctx = createTempStore();
    events = [];
    ctx.bus.subscribe((envelope) => events.push(envelope));
  });
  afterEach(() => {
    ctx.close();
  });

  it('publishes an upsert and a status change on creation', () => {
    ctx.store.recordSighting(sighting());
    expect(events.map((e) => e.event)).toEqual(['workitem.upserted', 'workitem.status_changed']);
  });

  it('reports the true previous status on a change', () => {
    const { workItemId } = ctx.store.recordSighting(sighting());
    events.length = 0;
    ctx.store.applyDecision(
      workItemId,
      decisionFixture({ status: 'done', rule: 'done.source-confirmed' }),
    );
    const changed = events.find((e) => e.event === 'workitem.status_changed');
    expect(changed?.data).toMatchObject({ from: 'running', to: 'done' });
  });

  it('does not publish a status change when nothing changed', () => {
    const { workItemId } = ctx.store.recordSighting(sighting());
    events.length = 0;
    ctx.store.applyDecision(workItemId, decisionFixture({ evaluatedAt: AT + 1 }));
    expect(events.map((e) => e.event)).toEqual(['workitem.upserted']);
  });
});

describe('Store — coverage health', () => {
  let ctx: TempStore;
  beforeEach(() => {
    ctx = createTempStore();
  });
  afterEach(() => {
    ctx.close();
  });

  it('registers a connector as down until it proves itself', () => {
    const health = ctx.store.registerConnector({
      id: 'claude-code-cli',
      displayName: 'Claude Code CLI',
      provider: 'anthropic',
      surface: 'cli',
    });
    expect(health.state).toBe('down');
    expect(health.lastSuccessfulScanAt).toBeNull();
    expect(health.lastError).toMatch(/has not completed a scan/);
    expect(health.permissionState).toBe('unknown');
  });

  it('re-registration resets health to down but keeps historical counters', () => {
    ctx.store.registerConnector({ id: 'c1', displayName: 'C1' });
    ctx.store.updateCoverage('c1', {
      state: 'ok',
      lastSuccessfulScanAt: AT,
      observedSessionCount: 7,
    });

    const reregistered = ctx.store.registerConnector({ id: 'c1', displayName: 'C1' });
    expect(reregistered.state).toBe('down');
    expect(reregistered.observedSessionCount).toBe(7);
    expect(reregistered.lastSuccessfulScanAt).toBe(AT);
  });

  it('persists coverage across a reopen of the database', () => {
    ctx.store.registerConnector({ id: 'c1', displayName: 'C1' });
    ctx.store.updateCoverage('c1', { state: 'degraded', lastError: 'selector missing' });
    // Same file, new Store instance.
    const reopened = createTempStoreAt(ctx.dbFile);
    try {
      const health = reopened.store.getCoverage('c1');
      expect(health?.state).toBe('degraded');
      expect(health?.lastError).toBe('selector missing');
    } finally {
      reopened.close();
    }
  });

  it('returns an empty list rather than throwing when nothing is registered', () => {
    expect(ctx.store.listCoverage()).toEqual([]);
  });

  it('ignores updates for unknown connectors', () => {
    expect(ctx.store.updateCoverage('nope', { state: 'ok' })).toBeUndefined();
  });
});

// Reopens an existing database file with a fresh Store, to prove persistence.
function createTempStoreAt(file: string): TempStore {
  const opened = openDb({ path: file });
  const bus = new EventBus();
  return {
    store: new Store(opened.db, bus),
    bus,
    dbFile: opened.path,
    journalMode: opened.journalMode,
    schemaVersion: opened.schemaVersion,
    home: '',
    close(): void {
      opened.db.close();
    },
  };
}
