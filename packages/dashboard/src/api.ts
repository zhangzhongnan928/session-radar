import type { CoverageResponse, WorkItem, WorkItemsResponse } from '@session-radar/shared';

/**
 * Talks to the daemon on the same origin it was served from.
 *
 * The dashboard never invents state: everything it draws comes from
 * `/api/workitems`, which always carries the coverage verdict with it, so the UI
 * cannot render a confident empty list while a collector is blind.
 */
export interface FetchWorkItemsOptions {
  history?: 'recent' | 'all';
  signal?: AbortSignal;
}

export async function fetchWorkItems(
  options: FetchWorkItemsOptions = {},
): Promise<WorkItemsResponse> {
  const path = options.history === 'all' ? '/api/workitems?history=all' : '/api/workitems';
  const response = await fetch(path, options.signal ? { signal: options.signal } : {});
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return (await response.json()) as WorkItemsResponse;
}

export async function setSeen(workItemId: string, seen: boolean): Promise<void> {
  await fetch(`/api/workitems/${encodeURIComponent(workItemId)}/seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attention: seen ? 'seen' : 'unseen' }),
  });
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

export interface StreamHandlers {
  onChange(): void;
  onState(state: ConnectionState): void;
}

/**
 * Subscribes to `/api/events`.
 *
 * Every event is treated as "something changed, refetch" rather than trying to
 * patch local state from the payload. The list is small and the daemon is
 * loopback; a refetch is cheaper than a divergence bug.
 */
export function openEventStream(handlers: StreamHandlers): () => void {
  let source: EventSource | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = (): void => {
    if (closed) return;
    source = new EventSource('/api/events');

    source.addEventListener('open', () => handlers.onState('live'));
    for (const event of ['workitem.upserted', 'workitem.status_changed', 'coverage.changed']) {
      source.addEventListener(event, () => handlers.onChange());
    }
    source.addEventListener('error', () => {
      handlers.onState('reconnecting');
      source?.close();
      // EventSource retries on its own, but only for transport errors. A daemon
      // restart closes the stream cleanly, which needs an explicit reconnect.
      if (!closed) {
        retry = setTimeout(connect, 2_000);
      }
    });
  };

  handlers.onState('connecting');
  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    source?.close();
  };
}

export type { WorkItem, WorkItemsResponse, CoverageResponse };
