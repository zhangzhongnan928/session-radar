import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalKey } from '@session-radar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusEngine } from '../../engine.js';
import { createNullLogger } from '../../logger.js';
import { ConnectorRegistry } from '../../registry.js';
import type { TempStore } from '../../testing.js';
import { createTempStore } from '../../testing.js';
import { AntigravityConnector } from './antigravity.js';
import { WindsurfCascadeConnector } from './windsurf.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const WINDSURF_SESSION = '39c7fe9d-953a-4aa8-90d5-42f89185b859';
const ANTIGRAVITY_SESSION = 'd3597e3c-c7c9-4c40-b5b2-5a1f0407425b';

describe('opaque desktop session inventories', () => {
  let ctx: TempStore;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    ctx = createTempStore();
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
    });
  });
  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  it('indexes Windsurf protobuf filenames without reading their bodies', async () => {
    const sessionDir = join(ctx.home, 'cascade');
    const appPath = join(ctx.home, 'missing-Windsurf.app');
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, `${WINDSURF_SESSION}.pb`);
    writeFileSync(file, Buffer.from('SECRET CASCADE BODY MUST NEVER ESCAPE'));
    utimesSync(file, new Date(NOW - DAY), new Date(NOW - DAY));

    registry.register(
      new WindsurfCascadeConnector({
        engine: new StatusEngine(ctx.store, () => NOW),
        sessionDir,
        appPath,
        now: () => NOW,
        device: 'test-mac',
      }),
    );
    await registry.startAll();

    const item = ctx.store.getWorkItemByCanonicalKey(
      canonicalKey('windsurf', WINDSURF_SESSION).key,
    );
    expect(item).toMatchObject({
      provider: 'windsurf',
      status: 'stale',
      title: 'Windsurf Cascade · 9185b859',
    });
    expect(item?.entryPoints[0]?.locateHint).toContain('Cascade history');
    expect(
      JSON.stringify(
        ctx.store.listObservations(
          canonicalKey('windsurf', WINDSURF_SESSION).key,
        ),
      ),
    ).not.toContain('SECRET');
    expect(ctx.store.getCoverage('windsurf-cascade')).toMatchObject({
      state: 'degraded',
      observedSessionCount: 1,
    });
  });

  it('indexes Antigravity from only UUID, size and mtime metadata', async () => {
    const sessionDir = join(ctx.home, 'conversations');
    const appPath = join(ctx.home, 'Antigravity.app');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(appPath, { recursive: true });
    const file = join(sessionDir, `${ANTIGRAVITY_SESSION}.pb`);
    writeFileSync(file, Buffer.from([0, 1, 2, 3]));
    utimesSync(file, new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));

    registry.register(
      new AntigravityConnector({
        engine: new StatusEngine(ctx.store, () => NOW),
        sessionDir,
        appPath,
        now: () => NOW,
        device: 'test-mac',
      }),
    );
    await registry.startAll();

    const item = ctx.store.getWorkItemByCanonicalKey(
      canonicalKey('google', ANTIGRAVITY_SESSION).key,
    );
    expect(item).toMatchObject({
      provider: 'google',
      status: 'stale',
      title: 'Antigravity · 0407425b',
    });
    expect(item?.currentEvidence?.rule).toBe('stale.inventory-only');
    expect(item?.entryPoints[0]?.locateHint).toContain(
      'Antigravity → conversation history',
    );
  });
});
