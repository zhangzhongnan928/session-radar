import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StatusDecision } from '@session-radar/shared';
import { EventBus } from './bus.js';
import { openDb } from './db/open.js';
import { Store } from './store.js';

/**
 * Test helpers. Every suite gets its own SESSION_RADAR_HOME so nothing ever
 * touches the real `~/.session-radar`.
 */
export interface TempStore {
  store: Store;
  bus: EventBus;
  dbFile: string;
  journalMode: string;
  schemaVersion: number;
  home: string;
  close(): void;
}

export function createTempHome(): { home: string; restore(): void } {
  const home = mkdtempSync(join(tmpdir(), 'session-radar-test-'));
  const previous = process.env['SESSION_RADAR_HOME'];
  process.env['SESSION_RADAR_HOME'] = home;
  return {
    home,
    restore(): void {
      if (previous === undefined) delete process.env['SESSION_RADAR_HOME'];
      else process.env['SESSION_RADAR_HOME'] = previous;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function createTempStore(): TempStore {
  const { home, restore } = createTempHome();
  const opened = openDb();
  const bus = new EventBus();
  const store = new Store(opened.db, bus);
  return {
    store,
    bus,
    dbFile: opened.path,
    journalMode: opened.journalMode,
    schemaVersion: opened.schemaVersion,
    home,
    close(): void {
      opened.db.close();
      restore();
    },
  };
}

/** A believable decision object without importing the whole status engine. */
export function decisionFixture(overrides: Partial<StatusDecision> = {}): StatusDecision {
  return {
    status: 'running',
    rule: 'running.live-activity',
    confidence: 'high',
    basisSignal: 'claude_code.post_tool_use',
    basisAt: 1_800_000_000_000,
    evaluatedAt: 1_800_000_000_000,
    reason: 'a tool call completed',
    ...overrides,
  };
}
