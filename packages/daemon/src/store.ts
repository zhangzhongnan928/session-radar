import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type {
  Attention,
  CanonicalIdentity,
  CoverageHealth,
  CoverageState,
  Observation,
  PermissionState,
  Provider,
  SignalName,
  Source,
  SourceRef,
  Status,
  StatusDecision,
  StatusEvidence,
  StatusTransition,
  Surface,
  WorkItem,
  WorkItemContext,
} from '@session-radar/shared';
import { sortWorkItems } from '@session-radar/shared';
import type { EventBus } from './bus.js';

// --- row shapes -------------------------------------------------------------

interface WorkItemRow {
  id: string;
  canonical_key: string;
  title: string;
  title_rank: number;
  provider: string;
  status: string;
  status_since: number;
  status_evidence_id: string | null;
  last_activity_at: number;
  attention: string;
  ctx_cwd: string | null;
  ctx_repo: string | null;
  ctx_conversation_id: string | null;
  ctx_url: string | null;
  created_at: number;
  updated_at: number;
}

interface SourceRefRow {
  id: string;
  work_item_id: string;
  source_id: string;
  external_id: string;
  url: string | null;
  resume_command: string | null;
  locate_hint: string | null;
  is_archived: number;
  merge_basis: string;
  first_seen_at: number;
  last_seen_at: number;
  src_provider: string;
  src_surface: string;
  src_device: string;
  src_account: string | null;
  src_version: string | null;
}

interface MergeSourceRefRow {
  source_id: string;
  external_id: string;
  url: string | null;
  resume_command: string | null;
  locate_hint: string | null;
  is_archived: number;
  merge_basis: string;
  first_seen_at: number;
  last_seen_at: number;
}

interface EvidenceRow {
  id: string;
  work_item_id: string;
  at: number;
  signal: string;
  raw: string;
  rule: string;
  confidence: string;
  resulting_status: string;
  connector_id: string | null;
}

interface TransitionRow {
  id: string;
  work_item_id: string;
  from_status: string | null;
  to_status: string;
  at: number;
  evidence_id: string | null;
}

interface ObservationRow {
  id: string;
  canonical_key: string;
  signal: string;
  at: number;
  raw: string | null;
  connector_id: string | null;
  surface: string | null;
}

/** An observation on its way into the log. */
export interface StoredObservation {
  signal: SignalName;
  at: number;
  raw?: unknown;
  connectorId?: string;
  surface?: Surface;
}

interface CoverageRow {
  connector_id: string;
  display_name: string;
  provider: string | null;
  surface: string | null;
  state: string;
  last_successful_scan_at: number | null;
  permission_state: string;
  last_error: string | null;
  observed_session_count: number;
  archived_session_count: number;
  consecutive_failures: number;
  updated_at: number;
}

// --- inputs -----------------------------------------------------------------

export interface SightingInput {
  identity: CanonicalIdentity;
  provider: Provider;
  /**
   * Preferred title. An EMPTY string means "I have nothing better than what is
   * already stored" — a sighting must never downgrade a good title. A hook that
   * carries no session_title would otherwise clobber the title the poller
   * derived from the first user message.
   */
  title: string;
  /** Higher-ranked source-native titles cannot be replaced by weaker guesses. */
  titlePriority?: number;
  /** Used only when creating the item, if `title` is empty. */
  fallbackTitle?: string;
  source: Source;
  externalId: string;
  context?: WorkItemContext;
  url?: string;
  resumeCommand?: string;
  locateHint?: string;
  /** The source vendor explicitly archived this entry point. */
  sourceArchived?: boolean;
  /**
   * Source ids emitted by an older classifier for this same external id.
   * Removed atomically when the corrected source ref is written.
   */
  replacesSourceIds?: string[];
  /** Epoch ms of the sighting itself — bookkeeping (created/updated/seen-at). */
  at: number;
  /**
   * Epoch ms of the last real PROGRESS, which is a different thing from the
   * sighting time: polling at 14:00 and finding a transcript last written at
   * 09:00 is a sighting now, of activity then. Omitted means "this sighting
   * carried no progress"; the stored value is left alone.
   */
  activityAt?: number;
  /**
   * A work item cannot exist without a reason for its status, so the decision is
   * required here rather than applied in a second step.
   */
  decision: StatusDecision;
  connectorId?: string;
  /** Metadata only. Never prompt or reply text. */
  raw?: Record<string, unknown>;
}

export interface SightingResult {
  workItemId: string;
  created: boolean;
  statusChanged: boolean;
  evidenceId: string;
}

/** Outcome of persisting one status decision. */
export interface DecisionWrite {
  evidenceId: string;
  statusChanged: boolean;
  /** null when this is the item's first ever decision. */
  previousStatus: Status | null;
}

export interface RegisterConnectorInput {
  id: string;
  displayName: string;
  provider?: Provider;
  surface?: Surface;
}

export interface CoveragePatch {
  state?: CoverageState;
  lastSuccessfulScanAt?: number | null;
  permissionState?: PermissionState;
  lastError?: string | null;
  observedSessionCount?: number;
  archivedSessionCount?: number;
  consecutiveFailures?: number;
}

const NOT_SCANNED_YET = 'connector registered but has not completed a scan yet';
const ATTENTION_BASELINE_KEY = 'attention_baseline_v1';

/**
 * All reads and writes to the local store.
 *
 * Invariants enforced here:
 *  - a work item always points at the evidence row that produced its status;
 *  - every status change writes a transition, so the history is queryable;
 *  - `last_activity_at` never moves backwards.
 */
export class Store {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
  ) {}

  // --- work items -----------------------------------------------------------

  /**
   * Lists work items, optionally limited to sessions active or status-changing
   * since `activeSince`. Rows remain in SQLite for evidence/history; the cutoff
   * controls today's triage view rather than deleting anything.
   */
  listWorkItems(activeSince?: number): WorkItem[] {
    const rows = (
      activeSince === undefined
        ? this.db.prepare('SELECT * FROM work_items').all()
        : this.db
            .prepare(
              `SELECT w.* FROM work_items w
               WHERE (w.status IN ('running', 'needs_victor') OR w.last_activity_at >= ?)
                 AND EXISTS (
                   SELECT 1 FROM source_refs r
                   WHERE r.work_item_id = w.id AND r.is_archived = 0
                 )`,
            )
            .all(activeSince)
    ) as WorkItemRow[];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const refs = this.entryPointsFor(ids);
    const evidence = this.currentEvidenceFor(rows);
    const items = rows.map((row) => this.toWorkItem(row, refs.get(row.id) ?? [], evidence));
    return sortWorkItems(items);
  }

  getWorkItem(id: string): WorkItem | undefined {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as
      | WorkItemRow
      | undefined;
    if (!row) return undefined;
    const refs = this.entryPointsFor([row.id]);
    const evidence = this.currentEvidenceFor([row]);
    return this.toWorkItem(row, refs.get(row.id) ?? [], evidence);
  }

  getWorkItemByCanonicalKey(key: string): WorkItem | undefined {
    const row = this.db.prepare('SELECT id FROM work_items WHERE canonical_key = ?').get(key) as
      | { id: string }
      | undefined;
    return row ? this.getWorkItem(row.id) : undefined;
  }

  countWorkItems(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM work_items').get() as { n: number };
    return row.n;
  }

  /**
   * Source-native ids already represented in the ledger.
   *
   * Connectors use this to backfill only archive rows that are genuinely
   * missing. Listing old transcript filenames/cache rows is cheap; repeatedly
   * parsing their metadata is not.
   */
  externalIdsForSource(sourceId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT external_id FROM source_refs WHERE source_id = ?')
      .all(sourceId) as { external_id: string }[];
    return new Set(rows.map((row) => row.external_id));
  }

  /**
   * Provider-wide form for sources whose exact client id is stored inside the
   * source file (Codex rollouts are CLI/Desktop/Chrome/Buzz after parsing).
   */
  externalIdsForProvider(provider: Provider): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT r.external_id
         FROM source_refs r JOIN sources s ON s.id = r.source_id
         WHERE s.provider = ?`,
      )
      .all(provider) as { external_id: string }[];
    return new Set(rows.map((row) => row.external_id));
  }

  /**
   * Apply an explicit source-provided identity alias.
   *
   * Some cross-device sources reveal their server id before a local bridge id
   * exists. When that bridge arrives later, move the earlier observations and
   * work-item history onto the stronger local canonical key atomically. This is
   * never used for title/time guesses.
   */
  mergeCanonicalKeys(fromKey: string, intoKey: string): boolean {
    if (fromKey === intoKey) return false;

    const run = this.db.transaction((): {
      changed: boolean;
      workItemId?: string;
    } => {
      let changed = false;

      // Keep every non-duplicate observation under the resolved identity. A
      // collision means the target already has the same signal at the same
      // source timestamp, so dropping the duplicate is lossless.
      changed =
        this.db
          .prepare(
            'UPDATE OR IGNORE observations SET canonical_key = ? WHERE canonical_key = ?',
          )
          .run(intoKey, fromKey).changes > 0 || changed;
      changed =
        this.db
          .prepare('DELETE FROM observations WHERE canonical_key = ?')
          .run(fromKey).changes > 0 || changed;

      const source = this.db
        .prepare('SELECT * FROM work_items WHERE canonical_key = ?')
        .get(fromKey) as WorkItemRow | undefined;
      const target = this.db
        .prepare('SELECT * FROM work_items WHERE canonical_key = ?')
        .get(intoKey) as WorkItemRow | undefined;

      if (!source) {
        return target
          ? { changed, workItemId: target.id }
          : { changed };
      }

      if (!target) {
        this.db
          .prepare('UPDATE work_items SET canonical_key = ? WHERE id = ?')
          .run(intoKey, source.id);
        return { changed: true, workItemId: source.id };
      }

      if (source.provider !== target.provider) {
        throw new Error(
          `cannot merge canonical keys across providers: ${source.provider} -> ${target.provider}`,
        );
      }

      const sourceWinsTitle = source.title_rank > target.title_rank;
      const attention =
        source.attention === 'unseen' || target.attention === 'unseen'
          ? 'unseen'
          : 'seen';
      this.db
        .prepare(
          `UPDATE work_items SET
             title = ?,
             title_rank = ?,
             last_activity_at = MAX(last_activity_at, ?),
             attention = ?,
             ctx_cwd = COALESCE(ctx_cwd, ?),
             ctx_repo = COALESCE(ctx_repo, ?),
             ctx_conversation_id = COALESCE(ctx_conversation_id, ?),
             ctx_url = COALESCE(ctx_url, ?),
             created_at = MIN(created_at, ?),
             updated_at = MAX(updated_at, ?)
           WHERE id = ?`,
        )
        .run(
          sourceWinsTitle ? source.title : target.title,
          sourceWinsTitle ? source.title_rank : target.title_rank,
          source.last_activity_at,
          attention,
          source.ctx_cwd,
          source.ctx_repo,
          source.ctx_conversation_id,
          source.ctx_url,
          source.created_at,
          source.updated_at,
          target.id,
        );

      const refs = this.db
        .prepare(
          `SELECT source_id, external_id, url, resume_command, locate_hint,
                  is_archived, merge_basis, first_seen_at, last_seen_at
           FROM source_refs WHERE work_item_id = ?`,
        )
        .all(source.id) as MergeSourceRefRow[];
      const upsertRef = this.db.prepare(
        `INSERT INTO source_refs (
           id, work_item_id, source_id, external_id, url, resume_command,
           locate_hint, is_archived, merge_basis, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_item_id, source_id, external_id) DO UPDATE SET
           url = COALESCE(source_refs.url, excluded.url),
           resume_command = COALESCE(source_refs.resume_command, excluded.resume_command),
           locate_hint = COALESCE(source_refs.locate_hint, excluded.locate_hint),
           is_archived = CASE
             WHEN excluded.last_seen_at >= source_refs.last_seen_at THEN excluded.is_archived
             ELSE source_refs.is_archived
           END,
           merge_basis = CASE
             WHEN excluded.merge_basis = 'canonical-id' THEN excluded.merge_basis
             ELSE source_refs.merge_basis
           END,
           first_seen_at = MIN(source_refs.first_seen_at, excluded.first_seen_at),
           last_seen_at = MAX(source_refs.last_seen_at, excluded.last_seen_at)`,
      );
      for (const ref of refs) {
        upsertRef.run(
          `sr_${randomUUID()}`,
          target.id,
          ref.source_id,
          ref.external_id,
          ref.url,
          ref.resume_command,
          ref.locate_hint,
          ref.is_archived,
          ref.merge_basis,
          ref.first_seen_at,
          ref.last_seen_at,
        );
      }
      this.db
        .prepare('DELETE FROM source_refs WHERE work_item_id = ?')
        .run(source.id);
      this.db
        .prepare('UPDATE status_evidence SET work_item_id = ? WHERE work_item_id = ?')
        .run(target.id, source.id);
      this.db
        .prepare('UPDATE status_transitions SET work_item_id = ? WHERE work_item_id = ?')
        .run(target.id, source.id);
      this.db.prepare('DELETE FROM work_items WHERE id = ?').run(source.id);

      return { changed: true, workItemId: target.id };
    });

    const result = run();
    if (result.workItemId) {
      const workItem = this.getWorkItem(result.workItemId);
      if (workItem) this.bus.emit('workitem.upserted', { workItem });
    }
    return result.changed;
  }

  /**
   * Record that a connector saw this session, and what it concluded. Creates the
   * work item on first sight, merges into the existing one otherwise.
   */
  recordSighting(input: SightingInput): SightingResult {
    const run = this.db.transaction((): { workItemId: string; created: boolean; write: DecisionWrite } => {
      this.upsertSource(input.source, input.at);

      const existing = this.db
        .prepare('SELECT * FROM work_items WHERE canonical_key = ?')
        .get(input.identity.key) as WorkItemRow | undefined;

      const workItemId = existing?.id ?? `wi_${randomUUID()}`;
      const created = existing === undefined;
      const incomingTitle = input.title.trim();
      const incomingTitleRank =
        incomingTitle.length > 0 ? (input.titlePriority ?? 10) : 0;

      if (created) {
        this.db
          .prepare(
            `INSERT INTO work_items (
               id, canonical_key, title, title_rank, provider, status, status_since,
               status_evidence_id, last_activity_at, attention,
               ctx_cwd, ctx_repo, ctx_conversation_id, ctx_url, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'unseen', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workItemId,
            input.identity.key,
            incomingTitle.length > 0
              ? incomingTitle
              : (input.fallbackTitle ?? 'Untitled session'),
            incomingTitleRank,
            input.provider,
            input.decision.status,
            input.decision.evaluatedAt,
            input.activityAt ?? input.at,
            input.context?.cwd ?? null,
            input.context?.repo ?? null,
            input.context?.conversationId ?? null,
            input.context?.url ?? null,
            input.at,
            input.at,
          );
      } else {
        const shouldReplaceTitle =
          incomingTitle.length > 0 && incomingTitleRank >= existing.title_rank;
        this.db
          .prepare(
            `UPDATE work_items SET
               title = ?,
               title_rank = ?,
               ctx_cwd = COALESCE(?, ctx_cwd),
               ctx_repo = COALESCE(?, ctx_repo),
               ctx_conversation_id = COALESCE(?, ctx_conversation_id),
               ctx_url = COALESCE(?, ctx_url),
               updated_at = ?
             WHERE id = ?`,
          )
          .run(
            shouldReplaceTitle ? incomingTitle : existing.title,
            shouldReplaceTitle ? incomingTitleRank : existing.title_rank,
            input.context?.cwd ?? null,
            input.context?.repo ?? null,
            input.context?.conversationId ?? null,
            input.context?.url ?? null,
            input.at,
            workItemId,
          );
      }

      if (input.replacesSourceIds && input.replacesSourceIds.length > 0) {
        const remove = this.db.prepare(
          'DELETE FROM source_refs WHERE work_item_id = ? AND external_id = ? AND source_id = ?',
        );
        for (const sourceId of input.replacesSourceIds) {
          if (sourceId !== input.source.id) {
            remove.run(workItemId, input.externalId, sourceId);
          }
        }
      }
      this.upsertSourceRef(workItemId, input);

      const write = this.writeDecision(workItemId, input.decision, {
        connectorId: input.connectorId,
        raw: input.raw,
        ...(input.activityAt !== undefined ? { activityAt: input.activityAt } : {}),
      });

      return { workItemId, created, write };
    });

    const { workItemId, created, write } = run();
    this.publish(workItemId, write, input.decision);
    return {
      workItemId,
      created,
      statusChanged: write.statusChanged,
      evidenceId: write.evidenceId,
    };
  }

  /** Re-evaluate an existing item without a new sighting (e.g. the stale sweeper). */
  applyDecision(
    workItemId: string,
    decision: StatusDecision,
    options: { connectorId?: string; raw?: Record<string, unknown> } = {},
  ): DecisionWrite {
    const run = this.db.transaction(() =>
      this.writeDecision(workItemId, decision, {
        connectorId: options.connectorId,
        raw: options.raw,
      }),
    );
    const write = run();
    this.publish(workItemId, write, decision);
    return write;
  }

  setAttention(workItemId: string, attention: Attention): boolean {
    const info = this.db
      .prepare('UPDATE work_items SET attention = ?, updated_at = ? WHERE id = ?')
      .run(attention, Date.now(), workItemId);
    if (info.changes === 0) return false;
    const workItem = this.getWorkItem(workItemId);
    if (workItem) this.bus.emit('workitem.upserted', { workItem });
    return true;
  }

  /**
   * Treat the first inventory scan as a baseline, not 142 new notifications.
   *
   * This runs once per database, after every connector's initial scan. Later
   * transitions into `done` are reset to unseen by `writeDecision`, including
   * completions discovered after a daemon restart.
   */
  initializeAttentionBaseline(): number {
    if (this.getMeta(ATTENTION_BASELINE_KEY)) return 0;
    const run = this.db.transaction(() => {
      const changed = this.db
        .prepare("UPDATE work_items SET attention = 'seen' WHERE status = 'done'")
        .run().changes;
      this.setMeta(ATTENTION_BASELINE_KEY, String(Date.now()));
      return changed;
    });
    return run();
  }

  // --- observations ---------------------------------------------------------

  /**
   * Append raw signals. Idempotent on `(canonicalKey, signal, at)` so a replayed
   * hook or a re-read transcript line cannot inflate the history.
   *
   * Returns how many were genuinely new.
   */
  recordObservations(
    canonicalKey: string,
    observations: readonly StoredObservation[],
  ): number {
    if (observations.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO observations (id, canonical_key, signal, at, raw, connector_id, surface)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      let inserted = 0;
      for (const obs of observations) {
        const info = insert.run(
          `ob_${randomUUID()}`,
          canonicalKey,
          obs.signal,
          obs.at,
          obs.raw === undefined ? null : JSON.stringify(obs.raw),
          obs.connectorId ?? null,
          obs.surface ?? null,
        );
        inserted += info.changes;
      }
      return inserted;
    });
    return run();
  }

  /** Observations for one session, newest first, optionally windowed. */
  listObservations(canonicalKey: string, sinceMs?: number, limit = 500): Observation[] {
    const rows = (
      sinceMs === undefined
        ? this.db
            .prepare(
              'SELECT * FROM observations WHERE canonical_key = ? ORDER BY at DESC LIMIT ?',
            )
            .all(canonicalKey, limit)
        : this.db
            .prepare(
              'SELECT * FROM observations WHERE canonical_key = ? AND at >= ? ORDER BY at DESC LIMIT ?',
            )
            .all(canonicalKey, sinceMs, limit)
    ) as ObservationRow[];

    return rows.map((row) => {
      const obs: Observation = { signal: row.signal as Observation['signal'], at: row.at };
      if (row.raw !== null) obs.raw = safeParseJson(row.raw);
      if (row.connector_id !== null) obs.connectorId = row.connector_id;
      return obs;
    });
  }

  /** Every canonical key with at least one observation. Used by the sweeper. */
  listObservedKeys(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT canonical_key FROM observations')
      .all() as { canonical_key: string }[];
    return rows.map((r) => r.canonical_key);
  }

  /**
   * Compact observations older than the retention window while retaining the
   * newest occurrence of every signal for every session.
   *
   * Status is re-derived from observations. Deleting the sole old
   * `task_complete`/`needs_input` signal would rewrite truthful historical
   * state to `stale.no-evidence` on the next sweep. Repeated activity samples
   * are disposable; the last state-bearing sample is not.
   */
  pruneObservations(olderThan: number): number {
    return this.db
      .prepare(
        `DELETE FROM observations
         WHERE at < ?
           AND EXISTS (
             SELECT 1 FROM observations newer
             WHERE newer.canonical_key = observations.canonical_key
               AND newer.signal = observations.signal
               AND newer.at > observations.at
           )`,
      )
      .run(olderThan).changes;
  }

  // --- evidence -------------------------------------------------------------

  listEvidence(workItemId: string, limit = 200): StatusEvidence[] {
    const rows = this.db
      .prepare('SELECT * FROM status_evidence WHERE work_item_id = ? ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(workItemId, limit) as EvidenceRow[];
    return rows.map(toEvidence);
  }

  listTransitions(workItemId: string, limit = 200): StatusTransition[] {
    const rows = this.db
      .prepare('SELECT * FROM status_transitions WHERE work_item_id = ? ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(workItemId, limit) as TransitionRow[];
    return rows.map((row) => ({
      id: row.id,
      workItemId: row.work_item_id,
      from: row.from_status as Status | null,
      to: row.to_status as Status,
      at: row.at,
      evidenceId: row.evidence_id,
    }));
  }

  // --- coverage -------------------------------------------------------------

  /**
   * Registration always resets live health to `down`. After a daemon restart no
   * connector has proven anything yet, and inheriting last run's `ok` would be a
   * lie. Historical counters are preserved so the UI can still say "last good
   * scan 3 min ago".
   */
  registerConnector(input: RegisterConnectorInput): CoverageHealth {
    const now = Date.now();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO connectors (id, display_name, provider, surface, registered_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
                                         provider = excluded.provider,
                                         surface = excluded.surface`,
        )
        .run(input.id, input.displayName, input.provider ?? null, input.surface ?? null, now);

      this.db
        .prepare(
          `INSERT INTO coverage_health (
             connector_id, state, last_successful_scan_at, permission_state,
             last_error, observed_session_count, consecutive_failures, updated_at
           ) VALUES (?, 'down', NULL, 'unknown', ?, 0, 0, ?)
           ON CONFLICT(connector_id) DO UPDATE SET state = 'down',
                                                   last_error = excluded.last_error,
                                                   consecutive_failures = 0,
                                                   updated_at = excluded.updated_at`,
        )
        .run(input.id, NOT_SCANNED_YET, now);
    });
    run();

    const health = this.getCoverage(input.id);
    if (!health) throw new Error(`failed to register connector ${input.id}`);
    this.bus.emit('coverage.changed', { connector: health });
    return health;
  }

  updateCoverage(connectorId: string, patch: CoveragePatch): CoverageHealth | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.state !== undefined) {
      sets.push('state = ?');
      values.push(patch.state);
    }
    if (patch.lastSuccessfulScanAt !== undefined) {
      sets.push('last_successful_scan_at = ?');
      values.push(patch.lastSuccessfulScanAt);
    }
    if (patch.permissionState !== undefined) {
      sets.push('permission_state = ?');
      values.push(patch.permissionState);
    }
    if (patch.lastError !== undefined) {
      sets.push('last_error = ?');
      values.push(patch.lastError);
    }
    if (patch.observedSessionCount !== undefined) {
      sets.push('observed_session_count = ?');
      values.push(patch.observedSessionCount);
    }
    if (patch.archivedSessionCount !== undefined) {
      sets.push('archived_session_count = ?');
      values.push(patch.archivedSessionCount);
    }
    if (patch.consecutiveFailures !== undefined) {
      sets.push('consecutive_failures = ?');
      values.push(patch.consecutiveFailures);
    }

    const before = this.getCoverage(connectorId);
    if (!before) return undefined;

    sets.push('updated_at = ?');
    values.push(Date.now(), connectorId);

    this.db
      .prepare(`UPDATE coverage_health SET ${sets.join(', ')} WHERE connector_id = ?`)
      .run(...values);

    const after = this.getCoverage(connectorId);
    if (after && !sameHealth(before, after)) {
      this.bus.emit('coverage.changed', { connector: after });
    }
    return after;
  }

  getCoverage(connectorId: string): CoverageHealth | undefined {
    const row = this.db
      .prepare(
        `SELECT c.id AS connector_id, c.display_name, c.provider, c.surface,
                h.state, h.last_successful_scan_at, h.permission_state, h.last_error,
                h.observed_session_count, h.archived_session_count,
                h.consecutive_failures, h.updated_at
         FROM connectors c JOIN coverage_health h ON h.connector_id = c.id
         WHERE c.id = ?`,
      )
      .get(connectorId) as CoverageRow | undefined;
    return row ? toCoverage(row) : undefined;
  }

  listCoverage(): CoverageHealth[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS connector_id, c.display_name, c.provider, c.surface,
                h.state, h.last_successful_scan_at, h.permission_state, h.last_error,
                h.observed_session_count, h.archived_session_count,
                h.consecutive_failures, h.updated_at
         FROM connectors c JOIN coverage_health h ON h.connector_id = c.id
         ORDER BY c.id`,
      )
      .all() as CoverageRow[];
    return rows.map(toCoverage);
  }

  // --- meta -----------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** Stable per-install device id, generated once. */
  deviceId(): string {
    const existing = this.getMeta('device_id');
    if (existing) return existing;
    const id = randomUUID();
    this.setMeta('device_id', id);
    return id;
  }

  // --- internals ------------------------------------------------------------

  private writeDecision(
    workItemId: string,
    decision: StatusDecision,
    options: { connectorId?: string; raw?: Record<string, unknown>; activityAt?: number },
  ): DecisionWrite {
    const current = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(workItemId) as
      | WorkItemRow
      | undefined;
    if (!current) throw new Error(`unknown work item ${workItemId}`);

    const evidenceId = `ev_${randomUUID()}`;
    const raw = JSON.stringify({
      reason: decision.reason,
      basisAt: decision.basisAt,
      evaluatedAt: decision.evaluatedAt,
      ...(options.raw ?? {}),
    });

    this.db
      .prepare(
        `INSERT INTO status_evidence (
           id, work_item_id, at, signal, raw, rule, confidence, resulting_status, connector_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidenceId,
        workItemId,
        decision.evaluatedAt,
        decision.basisSignal,
        raw,
        decision.rule,
        decision.confidence,
        decision.status,
        options.connectorId ?? null,
      );

    // A brand-new item has no evidence pointer yet, so its first decision is a
    // transition from null rather than a no-op.
    const isFirstDecision = current.status_evidence_id === null;
    const previousStatus = isFirstDecision ? null : (current.status as Status);
    const statusChanged = isFirstDecision || current.status !== decision.status;

    if (statusChanged) {
      this.db
        .prepare(
          `INSERT INTO status_transitions (id, work_item_id, from_status, to_status, at, evidence_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `tr_${randomUUID()}`,
          workItemId,
          previousStatus,
          decision.status,
          decision.evaluatedAt,
          evidenceId,
        );
    }

    const reportedActivityAt = options.activityAt ?? 0;
    const activityAdvanced = reportedActivityAt > current.last_activity_at;
    const activityAt = Math.max(current.last_activity_at, reportedActivityAt);
    /*
     * `attention` is an acknowledgement of the last reviewable state, not a
     * permanent mute.
     *
     * A source can advance while its four-state classification stays the same:
     * a second turn may finish between polls (`done -> done`), and an
     * inventory-only desktop chat may receive a new response while remaining
     * honestly `stale`/status-unknown. Re-open both for review when their
     * source-native activity timestamp advances. Status transitions into those
     * reviewable buckets do the same.
     */
    const shouldReopenForReview =
      (statusChanged || activityAdvanced) &&
      (decision.status === 'done' || decision.status === 'stale');
    const attention = shouldReopenForReview ? 'unseen' : current.attention;

    this.db
      .prepare(
        `UPDATE work_items SET
           status = ?,
           status_since = ?,
           status_evidence_id = ?,
           last_activity_at = ?,
           attention = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        decision.status,
        statusChanged ? decision.evaluatedAt : current.status_since,
        evidenceId,
        activityAt,
        attention,
        decision.evaluatedAt,
        workItemId,
      );

    return { evidenceId, statusChanged, previousStatus };
  }

  private publish(workItemId: string, write: DecisionWrite, decision: StatusDecision): void {
    const workItem = this.getWorkItem(workItemId);
    if (!workItem) return;
    this.bus.emit('workitem.upserted', { workItem });
    if (write.statusChanged) {
      this.bus.emit('workitem.status_changed', {
        workItem,
        from: write.previousStatus,
        to: decision.status,
        evidenceId: write.evidenceId,
      });
    }
  }

  private upsertSource(source: Source, at: number): void {
    this.db
      .prepare(
        `INSERT INTO sources (id, provider, surface, device, account, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider = excluded.provider,
                                       surface = excluded.surface,
                                       device = excluded.device,
                                       account = excluded.account,
                                       version = excluded.version,
                                       updated_at = excluded.updated_at`,
      )
      .run(
        source.id,
        source.provider,
        source.surface,
        source.device,
        source.account ?? null,
        source.version ?? null,
        at,
        at,
      );
  }

  private upsertSourceRef(workItemId: string, input: SightingInput): void {
    this.db
      .prepare(
        `INSERT INTO source_refs (
           id, work_item_id, source_id, external_id, url, resume_command,
           locate_hint, is_archived, merge_basis, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_item_id, source_id, external_id) DO UPDATE SET
           url = COALESCE(excluded.url, url),
           resume_command = COALESCE(excluded.resume_command, resume_command),
           locate_hint = COALESCE(excluded.locate_hint, locate_hint),
           is_archived = excluded.is_archived,
           last_seen_at = MAX(excluded.last_seen_at, last_seen_at)`,
      )
      .run(
        `sr_${randomUUID()}`,
        workItemId,
        input.source.id,
        input.externalId,
        input.url ?? null,
        input.resumeCommand ?? null,
        input.locateHint ?? null,
        input.sourceArchived === true ? 1 : 0,
        input.identity.basis,
        input.at,
        input.at,
      );
  }

  private entryPointsFor(workItemIds: string[]): Map<string, SourceRef[]> {
    const map = new Map<string, SourceRef[]>();
    if (workItemIds.length === 0) return map;
    const placeholders = workItemIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT r.*, s.provider AS src_provider, s.surface AS src_surface, s.device AS src_device,
                s.account AS src_account, s.version AS src_version
         FROM source_refs r JOIN sources s ON s.id = r.source_id
         WHERE r.work_item_id IN (${placeholders})
         ORDER BY r.first_seen_at ASC`,
      )
      .all(...workItemIds) as SourceRefRow[];

    for (const row of rows) {
      const list = map.get(row.work_item_id) ?? [];
      list.push(toSourceRef(row));
      map.set(row.work_item_id, list);
    }
    return map;
  }

  private currentEvidenceFor(rows: WorkItemRow[]): Map<string, StatusEvidence> {
    const ids = rows.map((r) => r.status_evidence_id).filter((id): id is string => id !== null);
    const map = new Map<string, StatusEvidence>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => '?').join(', ');
    const evidenceRows = this.db
      .prepare(`SELECT * FROM status_evidence WHERE id IN (${placeholders})`)
      .all(...ids) as EvidenceRow[];
    for (const row of evidenceRows) {
      map.set(row.id, toEvidence(row));
    }
    return map;
  }

  private toWorkItem(
    row: WorkItemRow,
    entryPoints: SourceRef[],
    evidence: Map<string, StatusEvidence>,
  ): WorkItem {
    const context: WorkItemContext = {};
    if (row.ctx_cwd !== null) context.cwd = row.ctx_cwd;
    if (row.ctx_repo !== null) context.repo = row.ctx_repo;
    if (row.ctx_conversation_id !== null) context.conversationId = row.ctx_conversation_id;
    if (row.ctx_url !== null) context.url = row.ctx_url;

    const current = row.status_evidence_id ? evidence.get(row.status_evidence_id) : undefined;

    const item: WorkItem = {
      id: row.id,
      canonicalKey: row.canonical_key,
      title: row.title,
      provider: row.provider as Provider,
      entryPoints,
      context,
      status: row.status as Status,
      statusSince: row.status_since,
      lastActivityAt: row.last_activity_at,
      attention: row.attention as Attention,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (current) item.currentEvidence = current;
    return item;
  }
}

// --- mappers ----------------------------------------------------------------

function toSourceRef(row: SourceRefRow): SourceRef {
  const source: Source = {
    id: row.source_id,
    provider: row.src_provider as Provider,
    surface: row.src_surface as Surface,
    device: row.src_device,
  };
  if (row.src_account !== null) source.account = row.src_account;
  if (row.src_version !== null) source.version = row.src_version;

  const ref: SourceRef = {
    id: row.id,
    workItemId: row.work_item_id,
    source,
    externalId: row.external_id,
    archived: row.is_archived === 1,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    mergeBasis: row.merge_basis as SourceRef['mergeBasis'],
  };
  if (row.url !== null) ref.url = row.url;
  if (row.resume_command !== null) ref.resumeCommand = row.resume_command;
  if (row.locate_hint !== null) ref.locateHint = row.locate_hint;
  return ref;
}

function toEvidence(row: EvidenceRow): StatusEvidence {
  const evidence: StatusEvidence = {
    id: row.id,
    workItemId: row.work_item_id,
    at: row.at,
    signal: row.signal,
    raw: safeParseJson(row.raw),
    rule: row.rule,
    confidence: row.confidence as StatusEvidence['confidence'],
    resultingStatus: row.resulting_status as Status,
  };
  if (row.connector_id !== null) evidence.connectorId = row.connector_id;
  return evidence;
}

function toCoverage(row: CoverageRow): CoverageHealth {
  const health: CoverageHealth = {
    connectorId: row.connector_id,
    displayName: row.display_name,
    state: row.state as CoverageState,
    lastSuccessfulScanAt: row.last_successful_scan_at,
    permissionState: row.permission_state as PermissionState,
    lastError: row.last_error,
    observedSessionCount: row.observed_session_count,
    archivedSessionCount: row.archived_session_count,
    consecutiveFailures: row.consecutive_failures,
    updatedAt: row.updated_at,
  };
  if (row.provider !== null) health.provider = row.provider as Provider;
  if (row.surface !== null) health.surface = row.surface as Surface;
  return health;
}

function sameHealth(a: CoverageHealth, b: CoverageHealth): boolean {
  return (
    a.state === b.state &&
    a.lastError === b.lastError &&
    a.permissionState === b.permissionState &&
    a.observedSessionCount === b.observedSessionCount &&
    a.lastSuccessfulScanAt === b.lastSuccessfulScanAt
  );
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { unparsed: value };
  }
}
