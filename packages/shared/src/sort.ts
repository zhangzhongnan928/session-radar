/**
 * The canonical scan order: what Victor must look at first.
 *
 *   needs_victor -> running -> done+unseen -> stale+unseen
 *   -> stale+seen -> done+seen
 *
 * A status-unknown chat whose vendor timestamp advances is made unseen again by
 * the store, so it returns to the review queue without pretending to know
 * whether it is running or done. Acknowledged stale/unknown items stay above
 * acknowledged completions because their lifecycle is still unresolved.
 * `done+seen` sinks to the bottom: it is finished work already acknowledged.
 * `running` stays above historical completions and stale sessions so active work
 * cannot be buried by a large archive.
 * Within a bucket, most recent activity first.
 */
import type { Attention, Status, WorkItem } from './model.js';

export interface SortableWorkItem {
  status: Status;
  attention: Attention;
  lastActivityAt: number;
}

export const SCAN_BUCKETS = [
  'needs_victor',
  'running',
  'done_unseen',
  'stale_unseen',
  'stale_seen',
  'done_seen',
] as const;

export type ScanBucket = (typeof SCAN_BUCKETS)[number];

export function scanBucket(item: SortableWorkItem): ScanBucket {
  switch (item.status) {
    case 'needs_victor':
      return 'needs_victor';
    case 'done':
      return item.attention === 'unseen' ? 'done_unseen' : 'done_seen';
    case 'stale':
      return item.attention === 'unseen' ? 'stale_unseen' : 'stale_seen';
    case 'running':
      return 'running';
  }
}

export function scanBucketRank(item: SortableWorkItem): number {
  return SCAN_BUCKETS.indexOf(scanBucket(item));
}

export function compareWorkItems(a: SortableWorkItem, b: SortableWorkItem): number {
  const rank = scanBucketRank(a) - scanBucketRank(b);
  if (rank !== 0) return rank;
  return b.lastActivityAt - a.lastActivityAt;
}

export function sortWorkItems<T extends WorkItem>(items: readonly T[]): T[] {
  return [...items].sort(compareWorkItems);
}
