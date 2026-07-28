/**
 * Tunables. There is deliberately NO global timeout: staleness is per-surface,
 * because a CLI agent silent for 10 minutes means something very different from a
 * browser tab silent for 10 minutes.
 */
import type { Surface } from './model.js';

export interface StaleThresholds {
  /**
   * How long a surface may go with no progress signal (no transcript write, no
   * heartbeat, no tool call) before we call it stale. Liveness alone (a `ps` hit,
   * an open tab) does NOT refresh this — that is the whole point.
   */
  noProgressMs: number;
}

export const DEFAULT_STALE_THRESHOLDS: Record<Surface, StaleThresholds> = {
  // CLI process alive but no transcript writes for 10 min -> stale candidate.
  cli: { noProgressMs: 10 * 60_000 },
  // Web tab closed mid-generation with no completion -> stale after 15 min.
  web: { noProgressMs: 15 * 60_000 },
  desktop: { noProgressMs: 15 * 60_000 },
  extension: { noProgressMs: 15 * 60_000 },
};

export interface ConnectorSchedulingConfig {
  /** Default poll interval for connectors that do not set their own. */
  defaultScanIntervalMs: number;
  /** A scan that exceeds this is abandoned and the connector marked degraded. */
  scanTimeoutMs: number;
  /** Restart backoff after a crash. */
  backoffStartMs: number;
  backoffMaxMs: number;
  /** Consecutive failures before a connector goes from `degraded` to `down`. */
  failuresBeforeDown: number;
  /**
   * If a connector has not completed a successful scan within
   * `scanInterval * staleScanFactor`, coverage degrades even without an explicit
   * error — a silently wedged connector is still a coverage hole.
   */
  staleScanFactor: number;
}

export const DEFAULT_CONNECTOR_SCHEDULING: ConnectorSchedulingConfig = {
  defaultScanIntervalMs: 15_000,
  scanTimeoutMs: 30_000,
  backoffStartMs: 1_000,
  backoffMaxMs: 60_000,
  failuresBeforeDown: 3,
  staleScanFactor: 3,
};

export interface DaemonConfig {
  host: string;
  port: number;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  // Loopback only. Never 0.0.0.0. There is no auth on this API by design;
  // the security boundary is "this machine only".
  host: '127.0.0.1',
  port: 4747,
};

/**
 * Privacy boundary: the ONLY content we are allowed to read is the first
 * `TITLE_MAX_CHARS` characters of the first user message, locally, to build a
 * display title. Enforced by `deriveTitle`.
 */
export const TITLE_MAX_CHARS = 120;

export interface SessionRadarConfig {
  daemon: DaemonConfig;
  thresholds: Record<Surface, StaleThresholds>;
  connectors: ConnectorSchedulingConfig;
  titleMaxChars: number;
}

export const DEFAULT_CONFIG: SessionRadarConfig = {
  daemon: DEFAULT_DAEMON_CONFIG,
  thresholds: DEFAULT_STALE_THRESHOLDS,
  connectors: DEFAULT_CONNECTOR_SCHEDULING,
  titleMaxChars: TITLE_MAX_CHARS,
};
