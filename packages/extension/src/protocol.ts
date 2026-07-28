import type { SelectorHealth, WebBlockReason, WebConversationState, WebSite } from '@session-radar/shared';

/** Content script -> service worker. The worker owns all network access. */
export interface ContentObservation {
  kind: 'session-radar/observation';
  site: WebSite;
  conversationId: string;
  state: WebConversationState;
  blockReason?: WebBlockReason;
  title?: string;
  url: string;
  basis: string;
  selectors: SelectorHealth;
  at: number;
}

/** Sent when a content script leaves a conversation (SPA route change or unload). */
export interface ContentLeft {
  kind: 'session-radar/left';
  site: WebSite;
  conversationId: string;
  at: number;
}

export type ContentMessage = ContentObservation | ContentLeft;

export function isContentMessage(value: unknown): value is ContentMessage {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'session-radar/observation' || kind === 'session-radar/left';
}

/** How often the content script re-reads the DOM. */
export const OBSERVE_INTERVAL_MS = 3_000;
/** How often the service worker flushes to the daemon (also the heartbeat). */
export const FLUSH_INTERVAL_MS = 15_000;

export const DAEMON_ORIGIN = 'http://127.0.0.1:4747';
export const DAEMON_WEB_ENDPOINT = `${DAEMON_ORIGIN}/api/hooks/web`;
