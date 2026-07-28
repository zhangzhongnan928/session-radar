import type {
  CanonicalIdentity,
  StaleThresholds,
  Observation,
  Provider,
  Source,
  StatusDecision,
  Surface,
  WorkItemContext,
} from '@session-radar/shared';
import { PROGRESS_KINDS, SIGNALS, decideStatus } from '@session-radar/shared';
import type { StoredObservation, Store } from './store.js';

/**
 * How many recent observations feed a decision.
 *
 * Deliberately a count, not a time window: the status engine only ever consults
 * the LATEST observation of each kind, so old signals are harmless — they simply
 * yield `stale`, which is the right answer. An earlier version windowed to 24h
 * and produced `stale.no-evidence` for every session older than a day, which
 * reported "we know nothing" about sessions we knew plenty about.
 */
export const OBSERVATION_LIMIT = 200;
/** How long raw observations are kept before pruning. */
export const OBSERVATION_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface SightingReport {
  identity: CanonicalIdentity;
  provider: Provider;
  surface: Surface;
  /** Preferred title. Empty means "keep whatever is already stored". */
  title: string;
  /** Used only on first sight, when `title` is empty. */
  fallbackTitle?: string;
  source: Source;
  externalId: string;
  context?: WorkItemContext;
  url?: string;
  resumeCommand?: string;
  locateHint?: string;
  /** New signals observed in this sighting. */
  observations: StoredObservation[];
  connectorId: string;
}

export interface EngineResult {
  workItemId: string;
  created: boolean;
  statusChanged: boolean;
  decision: StatusDecision;
}

/**
 * The one place a status gets written.
 *
 * Connectors report sightings; this appends the raw observations, re-derives the
 * status from the *whole* observation history for that session, and persists the
 * decision with its evidence. Nothing else may call `store.applyDecision`, or
 * statuses stop being reproducible from the log.
 */
export class StatusEngine {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = () => Date.now(),
    private readonly thresholds?: Partial<Record<Surface, StaleThresholds>>,
  ) {}

  observe(report: SightingReport): EngineResult {
    const now = this.now();
    this.store.recordObservations(
      report.identity.key,
      report.observations.map((o) => ({ ...o, surface: o.surface ?? report.surface })),
    );

    const decision = this.decide(report.identity.key, report.surface, now);
    const progressAt = latestActivity(report.observations);

    const result = this.store.recordSighting({
      identity: report.identity,
      provider: report.provider,
      title: report.title,
      ...(report.fallbackTitle ? { fallbackTitle: report.fallbackTitle } : {}),
      source: report.source,
      externalId: report.externalId,
      ...(report.context ? { context: report.context } : {}),
      ...(report.url ? { url: report.url } : {}),
      ...(report.resumeCommand ? { resumeCommand: report.resumeCommand } : {}),
      ...(report.locateHint ? { locateHint: report.locateHint } : {}),
      at: now,
      ...(progressAt !== undefined ? { activityAt: progressAt } : {}),
      decision,
      connectorId: report.connectorId,
    });

    return {
      workItemId: result.workItemId,
      created: result.created,
      statusChanged: result.statusChanged,
      decision,
    };
  }

  /** Re-derive without a new sighting. This is what turns `running` into `stale`. */
  reevaluate(canonicalKey: string, surface: Surface, connectorId?: string): StatusDecision | undefined {
    const item = this.store.getWorkItemByCanonicalKey(canonicalKey);
    if (!item) return undefined;
    const decision = this.decide(canonicalKey, surface, this.now());
    if (decision.status === item.status) return decision;
    this.store.applyDecision(item.id, decision, connectorId ? { connectorId } : {});
    return decision;
  }

  private decide(canonicalKey: string, surface: Surface, now: number): StatusDecision {
    const observations: Observation[] = this.store.listObservations(
      canonicalKey,
      undefined,
      OBSERVATION_LIMIT,
    );
    return decideStatus({
      observations,
      surface,
      now,
      ...(this.thresholds ? { thresholds: this.thresholds } : {}),
    });
  }
}

/**
 * When this session last actually did something.
 *
 * Only PROGRESS signals count. Liveness probes (`process_alive`, `web.tab_open`)
 * are stamped with the time we looked, not the time anything happened — letting
 * them set this produced rows reading "1m ago" directly above "no progress for
 * 6388 min", which is the UI contradicting itself in the space of one line.
 */
function latestActivity(observations: readonly StoredObservation[]): number | undefined {
  let max: number | undefined;
  for (const obs of observations) {
    if (!PROGRESS_KINDS.includes(SIGNALS[obs.signal].kind)) continue;
    if (max === undefined || obs.at > max) max = obs.at;
  }
  return max;
}

/**
 * Periodically re-derives every known session so staleness happens on the clock
 * rather than only when a connector happens to report. Without this an abandoned
 * session would sit on `running` forever, which is exactly the failure the
 * product exists to prevent.
 */
export class StaleSweeper {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: Store,
    private readonly engine: StatusEngine,
    private readonly intervalMs = 30_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweepOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Returns how many items changed status. Exposed for tests. */
  sweepOnce(): number {
    let changed = 0;
    for (const item of this.store.listWorkItems()) {
      const surface = item.entryPoints[0]?.source.surface ?? 'cli';
      const before = item.status;
      const decision = this.engine.reevaluate(item.canonicalKey, surface);
      if (decision && decision.status !== before) changed += 1;
    }
    this.store.pruneObservations(Date.now() - OBSERVATION_RETENTION_MS);
    return changed;
  }
}
