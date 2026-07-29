import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StatusEngine } from '../../engine.js';
import { OpaqueSessionFilesConnector } from './opaque-session-files.js';

export const WINDSURF_CASCADE_CONNECTOR_ID = 'windsurf-cascade';

export interface WindsurfCascadeConnectorOptions {
  engine: StatusEngine;
  appPath?: string;
  sessionDir?: string;
  scanIntervalMs?: number;
  historyWindowMs?: number;
  device?: string;
  now?: () => number;
}

export class WindsurfCascadeConnector extends OpaqueSessionFilesConnector {
  constructor(options: WindsurfCascadeConnectorOptions) {
    super({
      engine: options.engine,
      id: WINDSURF_CASCADE_CONNECTOR_ID,
      displayName: 'Windsurf Cascade sessions',
      provider: 'windsurf',
      appPath: options.appPath ?? '/Applications/Windsurf.app',
      sessionDir:
        options.sessionDir ??
        join(homedir(), '.codeium', 'windsurf', 'cascade'),
      productLabel: 'Windsurf Cascade',
      locatePrefix: 'Windsurf → Cascade history',
      inventorySignal: 'windsurf.cascade_inventory_seen',
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
