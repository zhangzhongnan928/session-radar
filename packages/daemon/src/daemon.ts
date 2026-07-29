import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { DEFAULT_DAEMON_CONFIG, DEFAULT_STALE_THRESHOLDS, WEB_SITES } from '@session-radar/shared';
import type { StaleThresholds, Surface, WebSite } from '@session-radar/shared';
import { EventBus } from './bus.js';
import { ClaudeCodeConnector } from './connectors/claude-code/connector.js';
import { CodexConnector } from './connectors/codex/connector.js';
import { HookIngest } from './connectors/ingest.js';
import { ClaudeCodeDesktopConnector } from './connectors/desktop/claude-code.js';
import {
  CLAUDE_AGENT_SESSIONS_CONNECTOR_ID,
  ClaudeAgentAccountSnapshotStore,
  ClaudeAgentSessionsConnector,
} from './connectors/desktop/claude-agent-sessions.js';
import { ClaudeDesktopChatConnector } from './connectors/desktop/claude-chat.js';
import { ChatGptDesktopConnector } from './connectors/desktop/chatgpt.js';
import { CursorConnector } from './connectors/desktop/cursor.js';
import { WindsurfCascadeConnector } from './connectors/desktop/windsurf.js';
import { AntigravityConnector } from './connectors/desktop/antigravity.js';
import { ChatGptAtlasConnector } from './connectors/desktop/chatgpt-atlas.js';
import { VsCodeCopilotConnector } from './connectors/desktop/vscode.js';
import { ClineConnector } from './connectors/desktop/cline.js';
import { AugmentConnector } from './connectors/desktop/augment.js';
import { WebSurfaceConnector } from './connectors/web/connector.js';
import { WebIngest } from './connectors/web/ingest.js';
import { openDb } from './db/open.js';
import { StaleSweeper, StatusEngine } from './engine.js';
import type { Logger } from './logger.js';
import { createLogger, resolveLogLevel } from './logger.js';
import { FILE_MODE, dbPath, fileMode, formatMode } from './paths.js';
import { ConnectorRegistry } from './registry.js';
import type { Connector } from './registry.js';
import { ApiServer } from './http/server.js';
import { Store } from './store.js';

export interface DaemonOptions {
  host?: string;
  /** 0 asks the OS for a free port (used by tests). */
  port?: number;
  dbFile?: string;
  logger?: Logger;
  /** Replaces the built-in collectors entirely. Used by tests. */
  connectors?: Connector[];
  /** Skip registering the real CLI collectors (tests, or a metadata-only run). */
  withoutDefaultConnectors?: boolean;
  allowedOrigins?: string[];
  /** Disable the periodic staleness sweep (tests drive it manually). */
  withoutSweeper?: boolean;
  /** Overrides where the built dashboard is found. */
  dashboardDir?: string;
}

/**
 * The dashboard bundle, relative to the built daemon.
 * `dist/` -> `packages/daemon/dist` -> up to `packages` -> `dashboard/dist`.
 */
export function defaultDashboardDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return process.env['SESSION_RADAR_DASHBOARD_DIR'] ?? resolve(here, '..', '..', 'dashboard', 'dist');
}

/**
 * Threshold and probe overrides from the environment.
 *
 * These exist so the acceptance scripts can prove a `running -> stale`
 * transition in seconds instead of waiting out the real 10-minute window. They
 * are ordinary config, not test hooks: a user with different working habits can
 * legitimately want a different threshold.
 */
export function thresholdsFromEnv(): Record<Surface, StaleThresholds> {
  const cli = numberFromEnv('SESSION_RADAR_STALE_CLI_MS');
  const web = numberFromEnv('SESSION_RADAR_STALE_WEB_MS');
  return {
    cli: { noProgressMs: cli ?? DEFAULT_STALE_THRESHOLDS.cli.noProgressMs },
    web: { noProgressMs: web ?? DEFAULT_STALE_THRESHOLDS.web.noProgressMs },
    desktop: { noProgressMs: web ?? DEFAULT_STALE_THRESHOLDS.desktop.noProgressMs },
    mobile: { noProgressMs: web ?? DEFAULT_STALE_THRESHOLDS.mobile.noProgressMs },
    extension: { noProgressMs: web ?? DEFAULT_STALE_THRESHOLDS.extension.noProgressMs },
  };
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? undefined : value;
}

/** `SESSION_RADAR_PROBE_PROCESSES=0` turns off ps/lsof probing. */
function probeProcessesFromEnv(): boolean {
  return process.env['SESSION_RADAR_PROBE_PROCESSES'] !== '0';
}

/**
 * `SESSION_RADAR_NO_CONNECTORS=1` starts the daemon watching nothing.
 *
 * Keeps the M0 invariant testable now that real collectors ship by default:
 * with an empty registry the API must still answer, and must say
 * `no_connectors` rather than implying everything is fine.
 */
function noConnectorsFromEnv(): boolean {
  return process.env['SESSION_RADAR_NO_CONNECTORS'] === '1';
}

export interface Daemon {
  store: Store;
  bus: EventBus;
  registry: ConnectorRegistry;
  engine: StatusEngine;
  sweeper: StaleSweeper;
  server: ApiServer;
  db: Database;
  logger: Logger;
  port: number;
  baseUrl: string;
  stop(): Promise<void>;
}

/**
 * Wires the daemon together and starts it. Split from `index.ts` so tests can
 * spin up a full instance on an ephemeral port against a temp database.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const logger = options.logger ?? createLogger(resolveLogLevel());
  const host = options.host ?? DEFAULT_DAEMON_CONFIG.host;
  const requestedPort = options.port ?? DEFAULT_DAEMON_CONFIG.port;

  const opened = openDb(options.dbFile ? { path: options.dbFile } : {});
  const bus = new EventBus();
  const store = new Store(opened.db, bus);
  store.deviceId();

  const thresholds = thresholdsFromEnv();
  const engine = new StatusEngine(store, () => Date.now(), thresholds);
  const registry = new ConnectorRegistry(store, bus, logger);

  const withoutDefaults = options.withoutDefaultConnectors || noConnectorsFromEnv();

  const webConnectors = new Map<WebSite, WebSurfaceConnector>();
  const claudeAgentSnapshots = new ClaudeAgentAccountSnapshotStore();
  if (!withoutDefaults && !options.connectors) {
    for (const site of WEB_SITES) webConnectors.set(site, new WebSurfaceConnector(site));
  }

  const connectors =
    options.connectors ??
    (withoutDefaults
      ? []
      : [
          new ClaudeCodeConnector({ engine, probeProcesses: probeProcessesFromEnv() }),
          new CodexConnector({ engine, probeProcesses: probeProcessesFromEnv() }),
          new ClaudeCodeDesktopConnector({ engine }),
          new ClaudeAgentSessionsConnector({
            engine,
            accountSnapshots: claudeAgentSnapshots,
          }),
          new ClaudeDesktopChatConnector({ engine }),
          new ChatGptDesktopConnector({ engine }),
          new CursorConnector({
            engine,
            probeProcesses: probeProcessesFromEnv(),
          }),
          new WindsurfCascadeConnector({ engine }),
          new AntigravityConnector({ engine }),
          new ChatGptAtlasConnector({ engine }),
          new VsCodeCopilotConnector({ engine }),
          new ClineConnector({ engine }),
          new AugmentConnector(),
          ...webConnectors.values(),
        ]);

  for (const connector of connectors) {
    registry.register(connector);
  }

  const ingest = new HookIngest({ engine, store });
  const webIngest = new WebIngest({
    engine,
    connectors: webConnectors,
    onClaudeAgentInventory: (inventory) => {
      if (!claudeAgentSnapshots.update(inventory)) return;
      void registry
        .scanOne(CLAUDE_AGENT_SESSIONS_CONNECTOR_ID)
        .catch((error: unknown) => {
          logger.error('immediate Claude agent inventory scan failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  });

  const server = new ApiServer({
    store,
    bus,
    registry,
    logger,
    host,
    port: requestedPort,
    ingest,
    webIngest,
    dashboardDir: options.dashboardDir ?? defaultDashboardDir(),
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    db: {
      path: opened.path,
      journalMode: opened.journalMode,
      fileMode: formatMode(fileMode(opened.path)),
      schemaVersion: opened.schemaVersion,
    },
  });

  const port = await server.listen();
  await registry.startAll();
  const baselinedCompletions =
    registry.size > 0 ? store.initializeAttentionBaseline() : 0;
  if (baselinedCompletions > 0) {
    logger.info('initial completion backlog acknowledged', {
      count: baselinedCompletions,
    });
  }

  const sweeper = new StaleSweeper(
    store,
    engine,
    numberFromEnv('SESSION_RADAR_SWEEP_MS') ?? 30_000,
  );
  if (!options.withoutSweeper) sweeper.start();

  logger.info('daemon listening', {
    url: `http://${host}:${port}`,
    db: opened.path,
    dbMode: formatMode(fileMode(opened.path)),
    connectors: registry.size,
  });

  if (fileMode(opened.path) !== FILE_MODE) {
    logger.warn('database permissions are not 0600', {
      path: opened.path,
      mode: formatMode(fileMode(opened.path)),
    });
  }

  let stopped = false;
  return {
    store,
    bus,
    registry,
    engine,
    sweeper,
    server,
    db: opened.db,
    logger,
    port,
    baseUrl: `http://${host === '::1' ? '[::1]' : host}:${port}`,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      sweeper.stop();
      await registry.stopAll();
      await server.close();
      opened.db.close();
    },
  };
}

export { dbPath };
