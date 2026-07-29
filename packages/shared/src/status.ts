/**
 * The status engine.
 *
 * Pure, deterministic, and the ONLY place a status is decided. Connectors report
 * named signals; this decides. Every decision names the rule that fired and the
 * observation it was anchored to, so `/api/workitems/:id/evidence` can always
 * explain the badge on screen.
 *
 * Priority: explicit source signal > UI/process signal > time heuristic.
 */
import type { StaleThresholds } from './config.js';
import { DEFAULT_STALE_THRESHOLDS } from './config.js';
import type { Confidence, Status, Surface } from './model.js';
import type { SignalKind, SignalName } from './signals.js';
import { PROGRESS_KINDS, SIGNALS, TIER_RANK, UNBLOCKING_KINDS } from './signals.js';

/** One reported sighting, before it becomes stored evidence. */
export interface Observation {
  signal: SignalName;
  /** Epoch ms when the signal happened (not when it was received). */
  at: number;
  raw?: unknown;
  connectorId?: string;
}

export const STATUS_RULES = [
  /** A block is outstanding. Absolute priority — beats live activity. */
  'needs_victor.blocking-signal',
  /** The source told us it finished, and nothing has happened since. */
  'done.source-confirmed',
  /** Progress inside the surface's window, no outstanding block. */
  'running.live-activity',
  /** The process/tab went away without ever confirming completion. */
  'stale.process-dead-no-completion',
  /** A web conversation was left mid-generation. */
  'stale.web-abandoned',
  /** The source exposes inventory metadata, but no live lifecycle. */
  'stale.inventory-only',
  /** No writes AND no heartbeat for longer than the surface threshold. */
  'stale.no-progress',
  /** Defensive: an item exists but nothing was ever observed for it. */
  'stale.no-evidence',
] as const;

export type StatusRule = (typeof STATUS_RULES)[number];

export interface StatusDecision {
  status: Status;
  rule: StatusRule;
  confidence: Confidence;
  /** The signal the decision hangs on, or 'none' when nothing was observed. */
  basisSignal: SignalName | 'none';
  /** When that signal happened. */
  basisAt: number | null;
  /** When the decision was made. */
  evaluatedAt: number;
  /** One-liner for the dashboard, e.g. "no progress for 23 min (threshold 10 min)". */
  reason: string;
}

export interface StatusDecisionInput {
  observations: readonly Observation[];
  surface: Surface;
  /** Epoch ms. Injected so the engine stays pure and testable. */
  now: number;
  /** Per-surface overrides; unspecified surfaces fall back to defaults. */
  thresholds?: Partial<Record<Surface, StaleThresholds>>;
}

function kindOf(signal: SignalName): SignalKind {
  return SIGNALS[signal].kind;
}

/**
 * Newest observation whose kind is in `kinds`. Ties on timestamp are broken by
 * evidence tier, so an explicit hook beats a poller that happened to land on the
 * same millisecond.
 */
function latestOfKinds(
  observations: readonly Observation[],
  kinds: readonly SignalKind[],
): Observation | undefined {
  let best: Observation | undefined;
  for (const obs of observations) {
    if (!kinds.includes(kindOf(obs.signal))) continue;
    if (best === undefined) {
      best = obs;
      continue;
    }
    if (obs.at > best.at) {
      best = obs;
    } else if (obs.at === best.at) {
      const a = TIER_RANK[SIGNALS[obs.signal].tier];
      const b = TIER_RANK[SIGNALS[best.signal].tier];
      if (a > b) best = obs;
    }
  }
  return best;
}

function minutes(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000));
}

export function thresholdFor(
  surface: Surface,
  overrides?: Partial<Record<Surface, StaleThresholds>>,
): StaleThresholds {
  return overrides?.[surface] ?? DEFAULT_STALE_THRESHOLDS[surface];
}

/**
 * Decide the status of one work item from everything observed about it.
 *
 * Deliberate behaviours worth knowing:
 *  - An unanswered block stays `needs_victor` forever. A permission prompt from two
 *    hours ago still needs Victor; ageing it into `stale` would hide real work.
 *  - `process_alive` is liveness, not progress. A CLI process sitting idle for
 *    11 minutes is stale even though `ps` still lists it.
 *  - Staleness needs no writes AND no heartbeat, so a long silent tool run stays
 *    `running` as long as the hooks keep pinging.
 */
export function decideStatus(input: StatusDecisionInput): StatusDecision {
  const { observations, surface, now } = input;
  const threshold = thresholdFor(surface, input.thresholds);

  if (observations.length === 0) {
    return {
      status: 'stale',
      rule: 'stale.no-evidence',
      confidence: 'low',
      basisSignal: 'none',
      basisAt: null,
      evaluatedAt: now,
      reason: 'no evidence recorded for this item yet',
    };
  }

  const block = latestOfKinds(observations, ['blocking']);
  const clear = latestOfKinds(observations, UNBLOCKING_KINDS);
  const completion = latestOfKinds(observations, ['completion']);
  const progress = latestOfKinds(observations, PROGRESS_KINDS);
  const dead = latestOfKinds(observations, ['process_dead']);
  const inventory = latestOfKinds(observations, ['inventory']);

  // 1. needs_victor — absolute priority. A block only clears on a strictly newer
  //    completion / explicit unblock / process death. Equal timestamps keep the block.
  if (block && (!clear || clear.at <= block.at)) {
    return {
      status: 'needs_victor',
      rule: 'needs_victor.blocking-signal',
      confidence: SIGNALS[block.signal].confidence,
      basisSignal: block.signal,
      basisAt: block.at,
      evaluatedAt: now,
      reason: `${SIGNALS[block.signal].description} (${minutes(now - block.at)} min ago)`,
    };
  }

  // 2. done — source-confirmed completion with nothing newer.
  if (
    completion &&
    (!progress || progress.at <= completion.at) &&
    (!inventory || inventory.at <= completion.at)
  ) {
    return {
      status: 'done',
      rule: 'done.source-confirmed',
      confidence: SIGNALS[completion.signal].confidence,
      basisSignal: completion.signal,
      basisAt: completion.at,
      evaluatedAt: now,
      reason: SIGNALS[completion.signal].description,
    };
  }

  // 3. running — progress inside the window, and the process has not since died.
  if (
    progress &&
    now - progress.at <= threshold.noProgressMs &&
    (!dead || dead.at <= progress.at) &&
    (!inventory || inventory.at <= progress.at)
  ) {
    return {
      status: 'running',
      rule: 'running.live-activity',
      confidence: SIGNALS[progress.signal].confidence,
      basisSignal: progress.signal,
      basisAt: progress.at,
      evaluatedAt: now,
      reason: `${SIGNALS[progress.signal].description} (${minutes(now - progress.at)} min ago)`,
    };
  }

  // 4. stale — everything else, with a specific reason.
  if (
    dead &&
    (!completion || dead.at > completion.at) &&
    (!inventory || inventory.at <= dead.at)
  ) {
    return {
      status: 'stale',
      rule: 'stale.process-dead-no-completion',
      confidence: SIGNALS[dead.signal].confidence,
      basisSignal: dead.signal,
      basisAt: dead.at,
      evaluatedAt: now,
      reason: 'process or tab went away without confirming completion',
    };
  }

  if (
    progress &&
    (surface === 'web' || surface === 'extension') &&
    progress.signal === 'web.generating' &&
    (!inventory || inventory.at <= progress.at)
  ) {
    return {
      status: 'stale',
      rule: 'stale.web-abandoned',
      confidence: 'low',
      basisSignal: progress.signal,
      basisAt: progress.at,
      evaluatedAt: now,
      reason: `left mid-generation ${minutes(now - progress.at)} min ago with no completion`,
    };
  }

  const lifecycleAt = Math.max(progress?.at ?? -1, completion?.at ?? -1, dead?.at ?? -1);
  if (inventory && inventory.at > lifecycleAt) {
    return {
      status: 'stale',
      rule: 'stale.inventory-only',
      confidence: SIGNALS[inventory.signal].confidence,
      basisSignal: inventory.signal,
      basisAt: inventory.at,
      evaluatedAt: now,
      reason: SIGNALS[inventory.signal].description,
    };
  }

  const anchor = progress ?? completion ?? block ?? newest(observations);
  return {
    status: 'stale',
    rule: 'stale.no-progress',
    confidence: 'low',
    basisSignal: anchor.signal,
    basisAt: anchor.at,
    evaluatedAt: now,
    reason: `no progress for ${minutes(now - anchor.at)} min (threshold ${minutes(threshold.noProgressMs)} min)`,
  };
}

function newest(observations: readonly Observation[]): Observation {
  // Safe: callers only reach this after the empty-list guard above.
  let best = observations[0] as Observation;
  for (const obs of observations) {
    if (obs.at > best.at) best = obs;
  }
  return best;
}
