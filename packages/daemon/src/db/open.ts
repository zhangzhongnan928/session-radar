import { chmodSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { DIR_MODE, FILE_MODE, dbPath, ensureHome } from '../paths.js';
import { runMigrations } from './migrations.js';

export interface OpenDbResult {
  db: Db;
  path: string;
  journalMode: string;
  schemaVersion: number;
}

export interface OpenDbOptions {
  /** Defaults to `~/.session-radar/db.sqlite` (or SESSION_RADAR_HOME). */
  path?: string;
}

/**
 * Opens the local store with WAL and owner-only permissions.
 *
 * "Encrypted at rest" for v0 means macOS FileVault plus 0600 — we do NOT ship
 * SQLCipher. That is a deliberate, documented gap (see CLAUDE.md, Open risks).
 */
export function openDb(options: OpenDbOptions = {}): OpenDbResult {
  ensureHome();
  const path = options.path ?? dbPath();

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const schemaVersion = runMigrations(db);
  hardenPermissions(path);

  const journalMode = String(
    (db.pragma('journal_mode', { simple: true }) as string | number | undefined) ?? 'unknown',
  );

  return { db, path, journalMode, schemaVersion };
}

/**
 * SQLite creates `-wal` and `-shm` siblings with default umask perms; they hold
 * the same data, so they get locked down too.
 */
export function hardenPermissions(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) {
      chmodSync(candidate, FILE_MODE);
    }
  }
}

export { DIR_MODE, FILE_MODE };
