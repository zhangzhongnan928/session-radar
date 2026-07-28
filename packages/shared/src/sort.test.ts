import { describe, expect, it } from 'vitest';
import type { SortableWorkItem } from './sort.js';
import { compareWorkItems, scanBucket } from './sort.js';

function item(
  status: SortableWorkItem['status'],
  attention: SortableWorkItem['attention'],
  lastActivityAt: number,
): SortableWorkItem {
  return { status, attention, lastActivityAt };
}

describe('scan order', () => {
  it('puts needs_victor first, then done+unseen, then stale, then running', () => {
    const items = [
      item('running', 'seen', 500),
      item('stale', 'seen', 400),
      item('done', 'unseen', 300),
      item('needs_victor', 'seen', 200),
    ];
    const sorted = [...items].sort(compareWorkItems).map((i) => scanBucket(i));
    expect(sorted).toEqual(['needs_victor', 'done_unseen', 'stale', 'running']);
  });

  it('sinks acknowledged done items to the bottom', () => {
    const sorted = [item('done', 'seen', 999), item('running', 'seen', 1)].sort(compareWorkItems);
    expect(scanBucket(sorted[0]!)).toBe('running');
    expect(scanBucket(sorted[1]!)).toBe('done_seen');
  });

  it('orders within a bucket by most recent activity', () => {
    const older = item('needs_victor', 'unseen', 100);
    const newer = item('needs_victor', 'unseen', 900);
    expect([older, newer].sort(compareWorkItems)[0]).toBe(newer);
  });

  it('keeps attention out of the status enum', () => {
    expect(scanBucket(item('done', 'unseen', 1))).toBe('done_unseen');
    expect(scanBucket(item('done', 'seen', 1))).toBe('done_seen');
    expect(scanBucket(item('running', 'unseen', 1))).toBe('running');
  });
});
