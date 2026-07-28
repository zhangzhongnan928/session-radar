import { EventEmitter } from 'node:events';
import type { CoverageHealth, Status, WorkItem } from '@session-radar/shared';
import type { SseEventName } from '@session-radar/shared';

export interface BusEventMap {
  'workitem.upserted': { workItem: WorkItem };
  'workitem.status_changed': {
    workItem: WorkItem;
    from: Status | null;
    to: Status;
    evidenceId: string | null;
  };
  'coverage.changed': { connector: CoverageHealth };
}

export interface BusEnvelope<K extends SseEventName = SseEventName> {
  event: K;
  at: number;
  data: unknown;
}

/**
 * In-process fan-out to SSE subscribers. Deliberately fire-and-forget: a slow or
 * broken dashboard client must never be able to stall a collector.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A dashboard reload can transiently leave many listeners attached.
    this.emitter.setMaxListeners(100);
  }

  emit<K extends keyof BusEventMap>(event: K, data: BusEventMap[K]): void {
    const envelope: BusEnvelope = { event: event as SseEventName, at: Date.now(), data };
    this.emitter.emit('*', envelope);
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  subscribe(listener: (envelope: BusEnvelope) => void): () => void {
    this.emitter.on('*', listener);
    return () => {
      this.emitter.off('*', listener);
    };
  }

  get subscriberCount(): number {
    return this.emitter.listenerCount('*');
  }
}
