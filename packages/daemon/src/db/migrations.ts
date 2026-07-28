import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only. Never edit a shipped migration — add a new one.
 *
 * Timestamps are INTEGER epoch milliseconds throughout. `raw` payloads are TEXT
 * holding JSON; they are metadata only and must never contain prompt or reply text.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE sources (
        id         TEXT PRIMARY KEY,
        provider   TEXT NOT NULL,
        surface    TEXT NOT NULL,
        device     TEXT NOT NULL,
        account    TEXT,
        version    TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE work_items (
        id                  TEXT PRIMARY KEY,
        canonical_key       TEXT NOT NULL UNIQUE,
        title               TEXT NOT NULL,
        provider            TEXT NOT NULL,
        status              TEXT NOT NULL,
        status_since        INTEGER NOT NULL,
        status_evidence_id  TEXT,
        last_activity_at    INTEGER NOT NULL,
        attention           TEXT NOT NULL DEFAULT 'unseen',
        ctx_cwd             TEXT,
        ctx_repo            TEXT,
        ctx_conversation_id TEXT,
        ctx_url             TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE INDEX idx_work_items_status ON work_items(status, last_activity_at DESC);
      CREATE INDEX idx_work_items_activity ON work_items(last_activity_at DESC);

      CREATE TABLE source_refs (
        id             TEXT PRIMARY KEY,
        work_item_id   TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        source_id      TEXT NOT NULL REFERENCES sources(id),
        external_id    TEXT NOT NULL,
        url            TEXT,
        resume_command TEXT,
        locate_hint    TEXT,
        merge_basis    TEXT NOT NULL,
        first_seen_at  INTEGER NOT NULL,
        last_seen_at   INTEGER NOT NULL,
        UNIQUE (work_item_id, source_id, external_id)
      );
      CREATE INDEX idx_source_refs_item ON source_refs(work_item_id);
      CREATE INDEX idx_source_refs_external ON source_refs(external_id);

      CREATE TABLE status_evidence (
        id               TEXT PRIMARY KEY,
        work_item_id     TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        at               INTEGER NOT NULL,
        signal           TEXT NOT NULL,
        raw              TEXT NOT NULL,
        rule             TEXT NOT NULL,
        confidence       TEXT NOT NULL,
        resulting_status TEXT NOT NULL,
        connector_id     TEXT
      );
      CREATE INDEX idx_evidence_item_at ON status_evidence(work_item_id, at DESC);

      CREATE TABLE status_transitions (
        id           TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        from_status  TEXT,
        to_status    TEXT NOT NULL,
        at           INTEGER NOT NULL,
        evidence_id  TEXT REFERENCES status_evidence(id)
      );
      CREATE INDEX idx_transitions_item_at ON status_transitions(work_item_id, at DESC);

      CREATE TABLE connectors (
        id            TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL,
        provider      TEXT,
        surface       TEXT,
        registered_at INTEGER NOT NULL
      );

      CREATE TABLE coverage_health (
        connector_id            TEXT PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
        state                   TEXT NOT NULL,
        last_successful_scan_at INTEGER,
        permission_state        TEXT NOT NULL,
        last_error              TEXT,
        observed_session_count  INTEGER NOT NULL DEFAULT 0,
        consecutive_failures    INTEGER NOT NULL DEFAULT 0,
        updated_at              INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'observation-log',
    sql: `
      -- Raw signals as reported by connectors, BEFORE the status engine has an
      -- opinion. The engine re-derives status from this log, so a status can
      -- always be recomputed and explained rather than only remembered.
      --
      -- Keyed by canonical_key rather than work_item_id on purpose: observations
      -- can arrive before the work item exists, and they must survive a merge of
      -- two surfaces into one item.
      CREATE TABLE observations (
        id            TEXT PRIMARY KEY,
        canonical_key TEXT NOT NULL,
        signal        TEXT NOT NULL,
        at            INTEGER NOT NULL,
        raw           TEXT,
        connector_id  TEXT,
        surface       TEXT,
        UNIQUE (canonical_key, signal, at)
      );
      CREATE INDEX idx_observations_key_at ON observations(canonical_key, at DESC);
      CREATE INDEX idx_observations_at ON observations(at);
    `,
  },
  {
    version: 3,
    name: 'coverage-archived-count',
    sql: `
      -- Sessions deliberately outside the history window. Kept separate from
      -- observed_session_count so the UI can say "6 active, 412 archived"
      -- instead of implying we only ever saw 6.
      ALTER TABLE coverage_health ADD COLUMN archived_session_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export function currentSchemaVersion(db: Database): number {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

/**
 * Applies every migration newer than the recorded version, each inside its own
 * transaction so a failure leaves the database at a known version rather than
 * half-migrated.
 */
export function runMigrations(db: Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = currentSchemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > applied).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
    });
    apply();
  }

  return currentSchemaVersion(db);
}
