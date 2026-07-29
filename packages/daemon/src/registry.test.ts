import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from './logger.js';
import type { Connector, ConnectorScanResult } from './registry.js';
import { ConnectorRegistry, describeError, withTimeout } from './registry.js';
import type { TempStore } from './testing.js';
import { createTempStore } from './testing.js';

function connector(overrides: Partial<Connector> & { id: string }): Connector {
  return {
    displayName: overrides.id,
    ...overrides,
  };
}

describe('ConnectorRegistry — crash isolation', () => {
  let ctx: TempStore;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    ctx = createTempStore();
    registry = new ConnectorRegistry(ctx.store, ctx.bus, createNullLogger(), {
      // Keep the poll loop out of the way; tests drive scans explicitly.
      defaultScanIntervalMs: 3_600_000,
      backoffStartMs: 3_600_000,
      scanTimeoutMs: 200,
    });
  });

  afterEach(async () => {
    await registry.stopAll();
    ctx.close();
  });

  it('registers a connector as down with a reason before any scan', () => {
    registry.register(connector({ id: 'c1' }));
    const health = ctx.store.getCoverage('c1');
    expect(health?.state).toBe('down');
    expect(health?.lastError).toMatch(/has not completed a scan/);
  });

  it('refuses to register the same id twice', () => {
    registry.register(connector({ id: 'c1' }));
    expect(() => registry.register(connector({ id: 'c1' }))).toThrow(/already registered/);
  });

  it('marks a connector ok after a successful scan', async () => {
    registry.register(
      connector({ id: 'good', scan: (): ConnectorScanResult => ({ observedSessionCount: 3 }) }),
    );
    await registry.startAll();

    const health = ctx.store.getCoverage('good');
    expect(health?.state).toBe('ok');
    expect(health?.observedSessionCount).toBe(3);
    expect(health?.lastError).toBeNull();
    expect(health?.lastSuccessfulScanAt).not.toBeNull();
  });

  it('can refresh one named connector immediately after a push cache update', async () => {
    let visible = 1;
    registry.register(
      connector({
        id: 'push-backed-scan',
        scan: (): ConnectorScanResult => ({
          observedSessionCount: visible,
        }),
      }),
    );
    await registry.startAll();
    expect(ctx.store.getCoverage('push-backed-scan')?.observedSessionCount).toBe(
      1,
    );

    visible = 4;
    await expect(registry.scanOne('push-backed-scan')).resolves.toBe(true);
    expect(ctx.store.getCoverage('push-backed-scan')?.observedSessionCount).toBe(
      4,
    );
    await expect(registry.scanOne('missing')).resolves.toBe(false);
  });

  it('a throwing connector degrades its own coverage and nothing else', async () => {
    registry.register(
      connector({
        id: 'bad',
        scan: () => {
          throw new Error('~/.claude/projects is gone');
        },
      }),
    );
    registry.register(
      connector({ id: 'good', scan: (): ConnectorScanResult => ({ observedSessionCount: 2 }) }),
    );

    await expect(registry.startAll()).resolves.toBeUndefined();

    expect(ctx.store.getCoverage('bad')?.state).toBe('degraded');
    expect(ctx.store.getCoverage('bad')?.lastError).toMatch(/projects is gone/);
    expect(ctx.store.getCoverage('good')?.state).toBe('ok');
  });

  it('a rejecting async connector is caught the same way', async () => {
    registry.register(
      connector({ id: 'bad', scan: async () => Promise.reject(new Error('permission denied')) }),
    );
    await registry.startAll();
    expect(ctx.store.getCoverage('bad')?.lastError).toMatch(/permission denied/);
  });

  it('escalates to down after repeated failures', async () => {
    let calls = 0;
    registry.register(
      connector({
        id: 'flaky',
        scan: () => {
          calls += 1;
          throw new Error('boom');
        },
      }),
    );
    await registry.startAll();
    expect(ctx.store.getCoverage('flaky')?.state).toBe('degraded');

    await registry.scanAllOnce();
    expect(ctx.store.getCoverage('flaky')?.state).toBe('degraded');

    await registry.scanAllOnce();
    expect(ctx.store.getCoverage('flaky')?.state).toBe('down');
    expect(ctx.store.getCoverage('flaky')?.consecutiveFailures).toBe(3);
    expect(calls).toBe(3);
  });

  it('recovers to ok and resets the failure count after a good scan', async () => {
    let fail = true;
    registry.register(
      connector({
        id: 'recovering',
        scan: (): ConnectorScanResult => {
          if (fail) throw new Error('temporary');
          return { observedSessionCount: 1 };
        },
      }),
    );
    await registry.startAll();
    expect(ctx.store.getCoverage('recovering')?.state).toBe('degraded');

    fail = false;
    await registry.scanAllOnce();
    const health = ctx.store.getCoverage('recovering');
    expect(health?.state).toBe('ok');
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.lastError).toBeNull();
  });

  it('does not let a hanging connector block startup forever', async () => {
    registry.register(
      connector({
        id: 'hanging',
        scan: () => new Promise<ConnectorScanResult>(() => {
          /* never resolves */
        }),
      }),
    );
    const started = Date.now();
    await registry.startAll();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ctx.store.getCoverage('hanging')?.lastError).toMatch(/exceeded 200ms/);
  });

  it('a failing start() does not stop other connectors from starting', async () => {
    let goodStarted = false;
    registry.register(
      connector({
        id: 'bad-start',
        start: () => {
          throw new Error('no accessibility permission');
        },
      }),
    );
    registry.register(
      connector({
        id: 'good-start',
        start: () => {
          goodStarted = true;
        },
        scan: (): ConnectorScanResult => ({ observedSessionCount: 0 }),
      }),
    );

    await registry.startAll();
    expect(goodStarted).toBe(true);
    expect(ctx.store.getCoverage('bad-start')?.state).toBe('degraded');
    expect(ctx.store.getCoverage('good-start')?.state).toBe('ok');
  });

  it('reports zero observed sessions as ok, not as a failure', async () => {
    registry.register(
      connector({ id: 'empty', scan: (): ConnectorScanResult => ({ observedSessionCount: 0 }) }),
    );
    await registry.startAll();
    const health = ctx.store.getCoverage('empty');
    expect(health?.state).toBe('ok');
    expect(health?.observedSessionCount).toBe(0);
  });

  it('treats scan warnings as degraded rather than swallowing them', async () => {
    registry.register(
      connector({
        id: 'rotting',
        scan: (): ConnectorScanResult => ({
          observedSessionCount: 4,
          warnings: ['stop-button selector not found'],
        }),
      }),
    );
    await registry.startAll();
    const health = ctx.store.getCoverage('rotting');
    expect(health?.state).toBe('degraded');
    expect(health?.lastError).toBe('stop-button selector not found');
    expect(health?.observedSessionCount).toBe(4);
  });

  it('marks a push-only connector ok once it starts cleanly', async () => {
    registry.register(connector({ id: 'push-only', start: () => undefined }));
    await registry.startAll();
    expect(ctx.store.getCoverage('push-only')?.state).toBe('ok');
  });

  it('records a permission state reported by a scan', async () => {
    registry.register(
      connector({
        id: 'ax',
        scan: (): ConnectorScanResult => ({
          observedSessionCount: 0,
          permissionState: 'denied',
        }),
      }),
    );
    await registry.startAll();
    expect(ctx.store.getCoverage('ax')?.permissionState).toBe('denied');
  });

  it('marks a surface unsupported with a visible reason and stops polling it', async () => {
    registry.register(
      connector({ id: 'chatgpt-desktop', scan: (): ConnectorScanResult => ({ observedSessionCount: 0 }) }),
    );
    registry.markUnsupported('chatgpt-desktop', 'no observable state without Accessibility API');
    await registry.startAll();

    const health = ctx.store.getCoverage('chatgpt-desktop');
    expect(health?.state).toBe('unsupported');
    expect(health?.lastError).toMatch(/Accessibility/);
  });

  it('survives a connector that throws during stop', async () => {
    registry.register(
      connector({
        id: 'bad-stop',
        scan: (): ConnectorScanResult => ({ observedSessionCount: 1 }),
        stop: () => {
          throw new Error('cannot stop');
        },
      }),
    );
    await registry.startAll();
    await expect(registry.stopAll()).resolves.toBeUndefined();
  });
});

describe('withTimeout', () => {
  it('resolves fast work untouched', async () => {
    await expect(withTimeout(async () => 42, 1_000)).resolves.toBe(42);
  });

  it('rejects slow work with a named error', async () => {
    await expect(
      withTimeout(() => new Promise<number>(() => undefined), 20),
    ).rejects.toThrow(/exceeded 20ms/);
  });
});

describe('describeError', () => {
  it('keeps the name and message of a real error', () => {
    expect(describeError(new TypeError('nope'))).toBe('TypeError: nope');
  });

  it('handles the non-Error things connectors actually throw', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError({ code: 'EACCES' })).toBe('{"code":"EACCES"}');
    expect(describeError(undefined)).toBe('undefined');
  });
});
