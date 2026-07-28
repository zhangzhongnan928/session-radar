/**
 * The canonical scan order: what Victor must look at first.
 *
 *   needs_victor -> done+unseen -> stale -> running -> done+seen
 *
 * `done+seen` sinks to the bottom: it is finished work he already acknowledged.
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
  'done_unseen',
  'stale',
  'running',
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
      return 'stale';
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
