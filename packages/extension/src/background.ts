import type { SelectorHealth, WebConversation, WebReport, WebSite } from '@session-radar/shared';
import { WEB_SITES } from '@session-radar/shared/pure';
import type { ContentMessage } from './protocol.js';
import { DAEMON_WEB_ENDPOINT, FLUSH_INTERVAL_MS, isContentMessage } from './protocol.js';

/**
 * Service worker.
 *
 * Owns every network call, so the daemon sees a `chrome-extension://<id>` origin
 * it can allowlist precisely. Reports on a fixed cadence whether or not anything
 * changed — the report IS the heartbeat, and a missing heartbeat is what turns
 * a closed browser into visible degraded coverage rather than silence.
 */
interface TrackedConversation extends WebConversation {
  tabId: number;
}

/** Keyed by `${site}:${conversationId}`. */
const live = new Map<string, TrackedConversation & { site: WebSite }>();
const closedSince = new Map<WebSite, Set<string>>();
const selectorsBySite = new Map<WebSite, SelectorHealth>();

function key(site: WebSite, conversationId: string): string {
  return `${site}:${conversationId}`;
}

function markClosed(site: WebSite, conversationId: string): void {
  live.delete(key(site, conversationId));
  const set = closedSince.get(site) ?? new Set<string>();
  set.add(conversationId);
  closedSince.set(site, set);
}

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isContentMessage(message)) return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  handle(message, tabId);
});

function handle(message: ContentMessage, tabId: number): void {
  if (message.kind === 'session-radar/left') {
    markClosed(message.site, message.conversationId);
    return;
  }

  selectorsBySite.set(message.site, message.selectors);
  const previouslyClosed = closedSince.get(message.site);
  previouslyClosed?.delete(message.conversationId);

  live.set(key(message.site, message.conversationId), {
    site: message.site,
    tabId,
    conversationId: message.conversationId,
    state: message.state,
    ...(message.blockReason ? { blockReason: message.blockReason } : {}),
    ...(message.title ? { title: message.title } : {}),
    url: message.url,
    at: message.at,
  });
}

// A closed tab is a real signal: a conversation abandoned mid-generation is
// stale, not running. Without this the item would sit on `generating` forever.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [entryKey, entry] of live) {
    if (entry.tabId !== tabId) continue;
    live.delete(entryKey);
    const set = closedSince.get(entry.site) ?? new Set<string>();
    set.add(entry.conversationId);
    closedSince.set(entry.site, set);
  }
});

async function flush(): Promise<void> {
  const now = Date.now();

  for (const site of WEB_SITES) {
    const conversations: WebConversation[] = [];
    for (const entry of live.values()) {
      if (entry.site !== site) continue;
      conversations.push({
        conversationId: entry.conversationId,
        state: entry.state,
        ...(entry.blockReason ? { blockReason: entry.blockReason } : {}),
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.url ? { url: entry.url } : {}),
        at: entry.at,
      });
    }

    const closed = [...(closedSince.get(site) ?? [])];
    const selectors = selectorsBySite.get(site) ?? {
      // No content script has reported for this site yet — we have opened no tab
      // there. Report empty rather than inventing a healthy selector set.
      selectorsVersion: 'unknown',
      found: [],
      missing: [],
    };

    const report: WebReport = {
      site,
      at: now,
      conversations,
      ...(closed.length > 0 ? { closed } : {}),
      selectors,
      extensionVersion: chrome.runtime.getManifest().version,
    };

    try {
      const response = await fetch(DAEMON_WEB_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      if (response.ok) closedSince.delete(site);
    } catch {
      // The daemon is not running. Keep the closed set so nothing is lost, and
      // try again next tick. The daemon's own heartbeat timeout is what makes
      // this visible as degraded coverage.
    }
  }
}

// chrome.alarms survives service-worker suspension; setInterval does not.
chrome.alarms.create('session-radar-flush', {
  periodInMinutes: FLUSH_INTERVAL_MS / 60_000,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'session-radar-flush') void flush();
});

chrome.runtime.onStartup.addListener(() => void flush());
chrome.runtime.onInstalled.addListener(() => void flush());
void flush();
