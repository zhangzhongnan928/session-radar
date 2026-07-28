import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../../logger.js';
import { ConnectorRegistry } from '../../registry.js';
import type { TempStore } from '../../testing.js';
import { createTempStore } from '../../testing.js';
import type { DesktopSurfaceSpec } from './connector.js';
import { CHATGPT_DESKTOP, CLAUDE_DESKTOP, DesktopSurfaceConnector } from './connector.js';

describe('desktop surfaces — M3 verdict', () => {
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

  function spec(overrides: Partial<DesktopSurfaceSpec> = {}): DesktopSurfaceSpec {
    return { ...CLAUDE_DESKTOP, appPath: join(ctx.home, 'App.app'), ...overrides };
  }

  it('reports UNSUPPORTED, not down, when the app is installed but opaque', async () => {
    mkdirSync(join(ctx.home, 'App.app'), { recursive: true });
    registry.register(new DesktopSurfaceConnector(spec()));
    await registry.startAll();

    const health = ctx.store.getCoverage('claude-desktop');
    expect(health?.state).toBe('unsupported');
    expect(health?.lastError).toMatch(/cannot be observed/);
    // The reason must be specific enough to act on.
    expect(health?.lastError).toMatch(/LevelDB/);
  });

  it('says so plainly when the app is simply not installed', async () => {
    registry.register(new DesktopSurfaceConnector(spec({ appPath: join(ctx.home, 'missing.app') })));
    await registry.startAll();

    const health = ctx.store.getCoverage('claude-desktop');
    expect(health?.state).toBe('unsupported');
    expect(health?.lastError).toMatch(/not installed/);
  });

  it('makes the ChatGPT reason concrete by counting files it cannot read', async () => {
    const appPath = join(ctx.home, 'ChatGPT.app');
    const dataDir = join(ctx.home, 'chatgpt-data');
    const store = join(dataDir, 'conversations-v3-acct');
    mkdirSync(appPath, { recursive: true });
    mkdirSync(store, { recursive: true });
    for (const name of ['a.data', 'b.data', 'c.data']) writeFileSync(join(store, name), 'x');

    registry.register(
      new DesktopSurfaceConnector({ ...CHATGPT_DESKTOP, appPath, dataDir }),
    );
    await registry.startAll();

    const health = ctx.store.getCoverage('chatgpt-desktop');
    expect(health?.state).toBe('unsupported');
    expect(health?.lastError).toMatch(/3 conversation file/);
    expect(health?.lastError).toMatch(/encrypted at rest/);
  });

  it('points at the mitigation that does work', async () => {
    mkdirSync(join(ctx.home, 'App.app'), { recursive: true });
    registry.register(new DesktopSurfaceConnector(spec()));
    await registry.startAll();
    expect(ctx.store.getCoverage('claude-desktop')?.lastError).toMatch(/Open these conversations in Chrome/);
  });

  it('does not accumulate failures or retry — it is a verdict, not an outage', async () => {
    mkdirSync(join(ctx.home, 'App.app'), { recursive: true });
    registry.register(new DesktopSurfaceConnector(spec()));
    await registry.startAll();
    await registry.scanAllOnce();
    await registry.scanAllOnce();

    const health = ctx.store.getCoverage('claude-desktop');
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.state).toBe('unsupported');
  });

  it('unsupported does not make overall coverage read as broken', async () => {
    mkdirSync(join(ctx.home, 'App.app'), { recursive: true });
    registry.register(new DesktopSurfaceConnector(spec()));
    await registry.startAll();

    const { rollupCoverage } = await import('@session-radar/shared');
    expect(rollupCoverage(ctx.store.listCoverage())).toBe('ok');
  });
});
