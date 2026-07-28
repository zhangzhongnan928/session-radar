import type {
  ConnectorSchedulingConfig,
  PermissionState,
  Provider,
  Surface,
} from '@session-radar/shared';
import { DEFAULT_CONNECTOR_SCHEDULING } from '@session-radar/shared';
import type { EventBus } from './bus.js';
import type { Logger } from './logger.js';
import type { Store } from './store.js';

export interface ConnectorScanResult {
  /** How many sessions this connector can currently see. Zero is meaningful. */
  observedSessionCount: number;
  /**
   * Sessions deliberately outside the history window. Reported so the boundary
   * is visible — "we see 6 of your 412 sessions" is honest, "we see 6" is not.
   */
  archivedSessionCount?: number;
  permissionState?: PermissionState;
  /**
   * Non-fatal problems — a rotted DOM selector, a missing optional path. These
   * put the connector in `degraded`, which is loud, instead of quietly reporting
   * fewer sessions.
   */
  warnings?: string[];
}

export interface ConnectorContext {
  store: Store;
  bus: EventBus;
  logger: Logger;
  /** Aborted when the daemon is shutting down. */
  signal: AbortSignal;
}

export interface Connector {
  readonly id: string;
  readonly displayName: string;
  readonly provider?: Provider;
  readonly surface?: Surface;
  /** Overrides the default poll interval. Push-only connectors may omit `scan`. */
  readonly scanIntervalMs?: number;
  start?(ctx: ConnectorContext): Promise<void> | void;
  stop?(): Promise<void> | void;
  scan?(ctx: ConnectorContext): Promise<ConnectorScanResult> | ConnectorScanResult;
}

interface Entry {
  connector: Connector;
  timer: NodeJS.Timeout | undefined;
  consecutiveFailures: number;
  stopped: boolean;
  /** Set for connectors declared permanently unobservable (see M3). */
  unsupported: boolean;
}

/**
 * Thrown by a connector that is definitively without coverage — not merely
 * having a bad scan.
 *
 * The failure ladder (degraded -> degraded -> down) exists to absorb flakes: a
 * transient read error should not scream on the first blip. But "the extension
 * has never connected" or "the transcript directory does not exist" are not
 * flakes; they are known, stable facts, and making the user wait 45 seconds to
 * be told so would be its own small dishonesty.
 */
export class ConnectorDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorDownError';
  }
}

/**
 * Thrown by a connector for a surface we investigated and cannot observe.
 *
 * Distinct from `down`: nothing is broken and retrying will not help. It is a
 * permanent, explained gap — which is still infinitely better than the surface
 * quietly not existing in the UI.
 */
export class ConnectorUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorUnsupportedError';
  }
}

export class ConnectorTimeoutError extends Error {
  constructor(ms: number) {
    super(`connector call exceeded ${ms}ms`);
    this.name = 'ConnectorTimeoutError';
  }
}

/**
 * Owns connector lifecycle and, more importantly, connector *failure*.
 *
 * Rule 3 of the product: a dead or broken connector is a Coverage Health incident,
 * never silence and never Stale. So every call into connector code is wrapped —
 * a throw, a rejection or a hang degrades that one connector's coverage row and
 * leaves the daemon and every other connector running.
 */
export class ConnectorRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly abort = new AbortController();
  private readonly config: ConnectorSchedulingConfig;
  private started = false;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    config: Partial<ConnectorSchedulingConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONNECTOR_SCHEDULING, ...config };
  }

  register(connector: Connector): void {
    if (this.entries.has(connector.id)) {
      throw new Error(`connector ${connector.id} is already registered`);
    }
    this.entries.set(connector.id, {
      connector,
      timer: undefined,
      consecutiveFailures: 0,
      stopped: false,
      unsupported: false,
    });
    const registerInput: Parameters<Store['registerConnector']>[0] = {
      id: connector.id,
      displayName: connector.displayName,
    };
    if (connector.provider) registerInput.provider = connector.provider;
    if (connector.surface) registerInput.surface = connector.surface;
    this.store.registerConnector(registerInput);
    this.logger.info('connector registered', { connector: connector.id });
  }

  list(): Connector[] {
    return [...this.entries.values()].map((e) => e.connector);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * An honest terminal verdict for a surface we investigated and cannot observe.
   * Distinct from `down`: nothing is broken, the coverage simply does not exist.
   */
  markUnsupported(connectorId: string, reason: string): void {
    const entry = this.entries.get(connectorId);
    if (entry) {
      entry.unsupported = true;
      this.clearTimer(entry);
    }
    this.store.updateCoverage(connectorId, {
      state: 'unsupported',
      lastError: reason,
      consecutiveFailures: 0,
    });
  }

  async startAll(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await Promise.all([...this.entries.values()].map((entry) => this.startEntry(entry)));
  }

  async stopAll(): Promise<void> {
    this.abort.abort();
    for (const entry of this.entries.values()) {
      entry.stopped = true;
      this.clearTimer(entry);
      if (entry.connector.stop) {
        // Shutdown must not be blockable by a misbehaving connector.
        await this.isolate(entry, 'stop', () => entry.connector.stop?.());
      }
    }
    this.started = false;
  }

  /** Run one scan cycle for every connector. Exposed for tests and the CLI. */
  async scanAllOnce(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.runScan(entry)));
  }

  private async startEntry(entry: Entry): Promise<void> {
    if (entry.unsupported) return;

    if (entry.connector.start) {
      const ok = await this.isolate(entry, 'start', () => entry.connector.start?.(this.context()));
      if (!ok) {
        this.scheduleRetry(entry);
        return;
      }
    }

    if (entry.connector.scan) {
      await this.runScan(entry);
    } else {
      // Push-only connector (hooks/extension POSTs): starting cleanly is the only
      // health signal we get, so treat it as coverage established.
      this.store.updateCoverage(entry.connector.id, {
        state: 'ok',
        lastError: null,
        consecutiveFailures: 0,
        lastSuccessfulScanAt: Date.now(),
      });
    }
  }

  private async runScan(entry: Entry): Promise<void> {
    if (entry.stopped || entry.unsupported || !entry.connector.scan) return;

    let result: ConnectorScanResult | undefined;
    const ok = await this.isolate(entry, 'scan', async () => {
      result = await entry.connector.scan?.(this.context());
    });

    if (ok && result) {
      entry.consecutiveFailures = 0;
      const warnings = result.warnings ?? [];
      const patch: Parameters<Store['updateCoverage']>[1] = {
        state: warnings.length > 0 ? 'degraded' : 'ok',
        lastSuccessfulScanAt: Date.now(),
        lastError: warnings.length > 0 ? warnings.join('; ') : null,
        observedSessionCount: result.observedSessionCount,
        archivedSessionCount: result.archivedSessionCount ?? 0,
        consecutiveFailures: 0,
      };
      if (result.permissionState) patch.permissionState = result.permissionState;
      this.store.updateCoverage(entry.connector.id, patch);
    }

    this.scheduleNext(entry, ok);
  }

  /**
   * The isolation boundary. Nothing a connector does — throwing, rejecting,
   * hanging — escapes this method.
   *
   * Note: a timeout stops us *waiting*, it cannot cancel work already running
   * inside the connector. Connectors must honour `ctx.signal` for real cancellation.
   */
  private async isolate(entry: Entry, phase: string, fn: () => unknown): Promise<boolean> {
    try {
      await withTimeout(async () => fn(), this.config.scanTimeoutMs);
      return true;
    } catch (error) {
      const message = describeError(error);
      const unsupported = error instanceof ConnectorUnsupportedError;
      if (unsupported) {
        // Not a failure — a verdict. It must not accumulate failure counts or
        // back off, because there is nothing to retry into.
        entry.unsupported = true;
        this.clearTimer(entry);
        this.logger.info('connector unsupported', { connector: entry.connector.id, reason: message });
        this.store.updateCoverage(entry.connector.id, {
          state: 'unsupported',
          lastError: message,
          consecutiveFailures: 0,
        });
        return false;
      }

      entry.consecutiveFailures += 1;
      const definitivelyDown = error instanceof ConnectorDownError;
      const state =
        definitivelyDown || entry.consecutiveFailures >= this.config.failuresBeforeDown
          ? 'down'
          : 'degraded';

      this.logger.error('connector failure', {
        connector: entry.connector.id,
        phase,
        failures: entry.consecutiveFailures,
        error: message,
      });

      // Coverage is the user-visible consequence. It must never be silence.
      // A ConnectorDownError message is written FOR the user and already says
      // what to do, so it is not prefixed with the internal phase name.
      this.store.updateCoverage(entry.connector.id, {
        state,
        lastError: definitivelyDown ? message : `${phase}: ${message}`,
        consecutiveFailures: entry.consecutiveFailures,
      });
      return false;
    }
  }

  private scheduleNext(entry: Entry, lastScanSucceeded: boolean): void {
    if (lastScanSucceeded) {
      const interval = entry.connector.scanIntervalMs ?? this.config.defaultScanIntervalMs;
      this.arm(entry, interval);
    } else {
      this.scheduleRetry(entry);
    }
  }

  private scheduleRetry(entry: Entry): void {
    const exponent = Math.max(0, entry.consecutiveFailures - 1);
    const delay = Math.min(
      this.config.backoffMaxMs,
      this.config.backoffStartMs * 2 ** Math.min(exponent, 16),
    );
    this.arm(entry, delay);
  }

  private arm(entry: Entry, delayMs: number): void {
    this.clearTimer(entry);
    if (entry.stopped || entry.unsupported || !this.started) return;
    entry.timer = setTimeout(() => {
      void this.runScan(entry);
    }, delayMs);
    // Never let a poll timer be the reason the process refuses to exit.
    entry.timer.unref?.();
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private context(): ConnectorContext {
    return {
      store: this.store,
      bus: this.bus,
      logger: this.logger,
      signal: this.abort.signal,
    };
  }
}

export async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ConnectorTimeoutError(ms)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function describeError(error: unknown): string {
  // These carry their own user-facing explanation; the class name would only get
  // in the way of the message that is actually read.
  if (error instanceof ConnectorDownError) return error.message;
  if (error instanceof ConnectorUnsupportedError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    // JSON.stringify returns undefined for undefined/functions/symbols, so the
    // String() fallback is not just for the throwing case.
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
