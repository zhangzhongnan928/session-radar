import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Source } from '@session-radar/shared';
import { canonicalKey } from '@session-radar/shared';
import { StatusEngine } from './engine.js';
import type { TempStore } from './testing.js';
import { createTempStore } from './testing.js';

/**
 * `lastActivityAt` is what the dashboard prints next to every row. It must mean
 * "when this session last did something", not "when we last looked at it" —
 * otherwise a row reads "1m ago" directly above "no progress for 6388 min".
 */
describe('lastActivityAt reflects progress, not polling', () => {
  let ctx: TempStore;
  let now: number;
  let engine: StatusEngine;

  const source: Source = {
    id: 'codex-cli',
    provider: 'openai',
    surface: 'cli',
    device: 'test-mac',
  };

  beforeEach(() => {
    ctx = createTempStore();
    now = 1_800_000_000_000;
    engine = new StatusEngine(ctx.store, () => now);
  });
  afterEach(() => ctx.close());

  function observe(observations: { signal: Parameters<StatusEngine['observe']>[0]['observations'][0]['signal']; at: number }[]) {
    return engine.observe({
      identity: canonicalKey('openai', 'sess-1'),
      provider: 'openai',
      surface: 'cli',
      title: 'Old work',
      source,
      externalId: 'sess-1',
      observations: observations.map((o) => ({ ...o, connectorId: 'codex-cli' })),
      connectorId: 'codex-cli',
    });
  }

  const HOURS_AGO = 1_800_000_000_000 - 6 * 60 * 60_000;

  it('uses the transcript write time, not the time we polled', () => {
    observe([{ signal: 'codex.rollout_write', at: HOURS_AGO }]);
    expect(ctx.store.listWorkItems()[0]?.lastActivityAt).toBe(HOURS_AGO);
  });

  it('a liveness probe alongside old progress does NOT bump it forward', () => {
    observe([
      { signal: 'codex.rollout_write', at: HOURS_AGO },
      { signal: 'codex.process_alive', at: now },
    ]);
    expect(ctx.store.listWorkItems()[0]?.lastActivityAt).toBe(HOURS_AGO);
  });

  it('a sighting carrying ONLY liveness leaves it untouched', () => {
    observe([{ signal: 'codex.rollout_write', at: HOURS_AGO }]);
    now += 10 * 60_000;
    observe([{ signal: 'codex.process_alive', at: now }]);
    expect(ctx.store.listWorkItems()[0]?.lastActivityAt).toBe(HOURS_AGO);
  });

  it('real new progress does move it', () => {
    observe([{ signal: 'codex.rollout_write', at: HOURS_AGO }]);
    now += 10 * 60_000;
    observe([{ signal: 'codex.rollout_write', at: now }]);
    expect(ctx.store.listWorkItems()[0]?.lastActivityAt).toBe(now);
  });

  it('the displayed age agrees with the staleness verdict', () => {
    observe([
      { signal: 'codex.rollout_write', at: HOURS_AGO },
      { signal: 'codex.process_alive', at: now },
    ]);
    const item = ctx.store.listWorkItems()[0];
    expect(item?.status).toBe('stale');
    // Both the badge and the reason must describe the same six hours.
    const ageMinutes = Math.round((now - (item?.lastActivityAt ?? 0)) / 60_000);
    expect(ageMinutes).toBe(360);
    expect(item?.currentEvidence?.raw).toMatchObject({
      reason: expect.stringContaining('360 min'),
    });
  });

  it('a brand-new item with no progress signal still gets a sane timestamp', () => {
    observe([{ signal: 'codex.process_alive', at: now }]);
    const item = ctx.store.listWorkItems()[0];
    expect(item?.lastActivityAt).toBe(now);
    expect(item?.createdAt).toBe(now);
  });
});
