#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { startDaemon } from './daemon.js';
import { createLogger, resolveLogLevel } from './logger.js';

export * from './daemon.js';
export * from './store.js';
export * from './registry.js';
export * from './bus.js';
export * from './logger.js';
export * from './paths.js';
export * from './db/open.js';
export * from './db/migrations.js';
export * from './engine.js';
export * from './connectors/ingest.js';
export * from './connectors/claude-code/connector.js';
export * from './connectors/claude-code/transcript.js';
export * from './connectors/codex/connector.js';
export * from './connectors/codex/rollout.js';
export * from './analysis/service.js';
export * from './analysis/project.js';
export * from './analysis/apple-model.js';
export * from './connectors/grok/connector.js';
export * from './connectors/grok/summary.js';
export * from './connectors/process.js';
export * from './install/grok-hooks.js';
export * from './connectors/desktop/chromium-local-storage.js';
export * from './connectors/desktop/claude-code.js';
export * from './connectors/desktop/claude-agent-sessions.js';
export * from './connectors/desktop/claude-chat.js';
export * from './connectors/desktop/chatgpt.js';
export * from './connectors/web/connector.js';
export * from './connectors/web/ingest.js';
export * from './http/server.js';
export * from './http/static.js';

/**
 * M0 registers zero connectors on purpose: the acceptance gate is that
 * /api/coverage answers honestly with an empty registry instead of crashing.
 * M1 onwards adds real connectors here.
 */
async function main(): Promise<void> {
  const logger = createLogger(resolveLogLevel());
  const portEnv = process.env['SESSION_RADAR_PORT'];
  const port = portEnv ? Number.parseInt(portEnv, 10) : undefined;

  if (portEnv !== undefined && (port === undefined || Number.isNaN(port))) {
    logger.error('SESSION_RADAR_PORT is not a number', { value: portEnv });
    process.exitCode = 1;
    return;
  }

  const daemon = await startDaemon(port !== undefined ? { port } : {});

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    void daemon.stop().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crash in one collector must never take the whole radar down — that would
  // turn a partial-coverage problem into a total blackout with no warning.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection (daemon kept alive)', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception (daemon kept alive)', { error: error.message });
  });
}

// Only run when executed directly, not when imported by the CLI or tests.
// `pathToFileURL` rather than string concatenation: the install path may contain
// spaces, which import.meta.url percent-encodes and a raw `file://${path}` does not.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        msg: 'daemon failed to start',
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exit(1);
  });
}
