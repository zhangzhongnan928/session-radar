import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_MODE, dbPath, fileMode, formatMode, sessionRadarHome } from '../paths.js';
import { createTempHome } from '../testing.js';
import { LATEST_SCHEMA_VERSION, currentSchemaVersion, runMigrations } from './migrations.js';
import { hardenPermissions, openDb } from './open.js';

describe('local store on disk', () => {
  let home: ReturnType<typeof createTempHome>;
  beforeEach(() => {
    home = createTempHome();
  });
  afterEach(() => {
    home.restore();
  });

  it('lives under SESSION_RADAR_HOME so tests never touch the real one', () => {
    expect(sessionRadarHome()).toBe(home.home);
    expect(dbPath().startsWith(home.home)).toBe(true);
  });

  it('creates the database with 0600 permissions', () => {
    const opened = openDb();
    try {
      expect(formatMode(fileMode(opened.path))).toBe('0600');
      expect(fileMode(opened.path)).toBe(FILE_MODE);
    } finally {
      opened.db.close();
    }
  });

  it('locks down the WAL sidecar files too — they hold the same data', () => {
    const opened = openDb();
    try {
      // Force a write so the -wal file materialises.
      opened.db.exec("INSERT INTO meta (key, value) VALUES ('probe', '1')");
      hardenPermissions(opened.path);
      const wal = `${opened.path}-wal`;
      if (existsSync(wal)) {
        expect(formatMode(fileMode(wal))).toBe('0600');
      }
    } finally {
      opened.db.close();
    }
  });

  it('runs in WAL mode', () => {
    const opened = openDb();
    try {
      expect(opened.journalMode.toLowerCase()).toBe('wal');
    } finally {
      opened.db.close();
    }
  });

  it('enforces foreign keys so orphan evidence cannot accumulate', () => {
    const opened = openDb();
    try {
      expect(() =>
        opened.db
          .prepare(
            `INSERT INTO status_evidence (id, work_item_id, at, signal, raw, rule, confidence, resulting_status)
             VALUES ('ev_x', 'wi_missing', 1, 's', '{}', 'r', 'low', 'stale')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      opened.db.close();
    }
  });

  it('migrates to the latest version and is idempotent on reopen', () => {
    const first = openDb();
    expect(first.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    first.db.close();

    const second = openDb();
    try {
      expect(second.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(runMigrations(second.db)).toBe(LATEST_SCHEMA_VERSION);
      expect(currentSchemaVersion(second.db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      second.db.close();
    }
  });

  it('creates every table the event model needs', () => {
    const opened = openDb();
    try {
      const names = (
        opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      for (const table of [
        'meta',
        'sources',
        'work_items',
        'source_refs',
        'status_evidence',
        'status_transitions',
        'connectors',
        'coverage_health',
        'schema_migrations',
      ]) {
        expect(names).toContain(table);
      }
    } finally {
      opened.db.close();
    }
  });
});
