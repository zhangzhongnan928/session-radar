import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StatusEngine } from '../../engine.js';
import { OpaqueSessionFilesConnector } from './opaque-session-files.js';

export const ANTIGRAVITY_CONNECTOR_ID = 'antigravity-desktop';

export interface AntigravityConnectorOptions {
  engine: StatusEngine;
  appPath?: string;
  sessionDir?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  device?: string;
  now?: () => number;
}

export class AntigravityConnector extends OpaqueSessionFilesConnector {
  constructor(options: AntigravityConnectorOptions) {
    super({
      engine: options.engine,
      id: ANTIGRAVITY_CONNECTOR_ID,
      displayName: 'Antigravity conversations',
      provider: 'google',
      appPath: options.appPath ?? '/Applications/Antigravity.app',
      sessionDir:
        options.sessionDir ??
        join(homedir(), '.gemini', 'antigravity', 'conversations'),
      productLabel: 'Antigravity',
      locatePrefix: 'Antigravity → conversation history',
      inventorySignal: 'antigravity.conversation_inventory_seen',
      ...(options.scanIntervalMs !== undefined
        ? { scanIntervalMs: options.scanIntervalMs }
        : {}),
      ...(options.historyWindowMs !== undefined
        ? { historyWindowMs: options.historyWindowMs }
        : {}),
      ...(options.device !== undefined ? { device: options.device } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }
}
