import type {
  ClaudeAgentInventory,
  SelectorHealth,
  WebConversation,
  WebInventory,
  WebReport,
  WebSite,
} from '@session-radar/shared';
import { WEB_SITES } from '@session-radar/shared/pure';
import type { ContentMessage } from './protocol.js';
import {
  DAEMON_WEB_ENDPOINT,
  FLUSH_INTERVAL_MS,
  isContentMessage,
  sanitizeClaudeAgentInventoryValue,
  isWebInventoryValue,
} from './protocol.js';

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
/** Visible DOM inventory belongs to one tab and is removed with that document. */
const visibleInventories = new Map<
  string,
  WebInventory & { site: WebSite; tabId: number }
>();
/** Last account snapshot remains useful after its source tab closes; age is reported. */
const accountInventories = new Map<WebSite, WebInventory>();
let claudeAgentInventory: ClaudeAgentInventory | undefined;
const ACCOUNT_INVENTORY_STORAGE_KEYS: Record<WebSite, string> = {
  'chatgpt-web': 'session-radar.chatgpt-account-inventory-v1',
  'claude-web': 'session-radar.claude-account-inventory-v1',
};
const CLAUDE_AGENT_INVENTORY_STORAGE_KEY =
  'session-radar.claude-agent-account-inventory-v1';
const restoredAccountInventory = Promise.all(
  WEB_SITES.map(async (site) => {
    const storageKey = ACCOUNT_INVENTORY_STORAGE_KEYS[site];
    try {
      const stored = await chrome.storage.session.get(storageKey);
      const candidate = stored[storageKey];
      if (
        isWebInventoryValue(candidate) &&
        candidate.scope === 'account-api'
      ) {
        accountInventories.set(site, candidate);
      }
    } catch {
      // A storage failure degrades naturally to "no inventory" in the report.
    }
  }),
);
const restoredClaudeAgentInventory = (async () => {
  try {
    const stored = await chrome.storage.session.get(
      CLAUDE_AGENT_INVENTORY_STORAGE_KEY,
    );
    claudeAgentInventory = sanitizeClaudeAgentInventoryValue(
      stored[CLAUDE_AGENT_INVENTORY_STORAGE_KEY],
    );
  } catch {
    // A storage failure degrades naturally to "no agent inventory".
  }
})();

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
  if (message.kind === 'session-radar/claude-agent-inventory') {
    if (
      !claudeAgentInventory ||
      message.inventory.at >= claudeAgentInventory.at
    ) {
      claudeAgentInventory = message.inventory;
      void chrome.storage.session
        .set({
          [CLAUDE_AGENT_INVENTORY_STORAGE_KEY]: message.inventory,
        })
        .catch(() => {
          // The in-memory copy still works until this worker is suspended.
        });
    }
    return;
  }

  if (message.kind === 'session-radar/inventory-left') {
    visibleInventories.delete(`${message.site}:${tabId}`);
    return;
  }

  if (message.kind === 'session-radar/inventory') {
    if (message.inventory.scope === 'account-api') {
      const previous = accountInventories.get(message.site);
      if (!previous || message.inventory.at >= previous.at) {
        accountInventories.set(message.site, message.inventory);
        const storageKey = ACCOUNT_INVENTORY_STORAGE_KEYS[message.site];
        void chrome.storage.session
          .set({ [storageKey]: message.inventory })
          .catch(() => {
            // The in-memory copy still works until this worker is suspended.
          });
      }
      return;
    }
    visibleInventories.set(`${message.site}:${tabId}`, {
      ...message.inventory,
      site: message.site,
      tabId,
    });
    return;
  }

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
  for (const [inventoryKey, inventory] of visibleInventories) {
    if (inventory.tabId === tabId) visibleInventories.delete(inventoryKey);
  }
});

async function flush(): Promise<void> {
  await Promise.all([
    restoredAccountInventory,
    restoredClaudeAgentInventory,
  ]);
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
      inventories: inventoriesFor(site),
      ...(site === 'claude-web' && claudeAgentInventory
        ? { claudeAgentInventory }
        : {}),
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

function inventoriesFor(site: WebSite): WebInventory[] {
  const inventories: WebInventory[] = [];
  const account = accountInventories.get(site);
  if (account) inventories.push(account);
  const visible = mergeVisibleInventories(site);
  if (visible) inventories.push(visible);
  return inventories;
}

function mergeVisibleInventories(site: WebSite): WebInventory | undefined {
  const snapshots = [...visibleInventories.values()].filter(
    (inventory) => inventory.site === site,
  );
  if (snapshots.length === 0) return undefined;

  const byId = new Map<string, WebInventory['items'][number]>();
  for (const snapshot of snapshots) {
    for (const item of snapshot.items) {
      const current = byId.get(item.conversationId);
      if (
        !current ||
        (item.updatedAt ?? -1) > (current.updatedAt ?? -1) ||
        (!current.title && item.title)
      ) {
        byId.set(item.conversationId, item);
      }
    }
  }
  const rejectedItems = snapshots.reduce(
    (sum, snapshot) => sum + (snapshot.rejectedItems ?? 0),
    0,
  );
  const errors = [
    ...new Set(
      snapshots
        .map((snapshot) => snapshot.error)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return {
    scope: 'visible-dom',
    completeness: 'partial',
    at: Math.max(...snapshots.map((snapshot) => snapshot.at)),
    items: [...byId.values()].slice(0, 1_000),
    basis: [
      ...new Set(snapshots.map((snapshot) => snapshot.basis)),
    ]
      .join(' | ')
      .slice(0, 500),
    ...(rejectedItems > 0 ? { rejectedItems } : {}),
    ...(errors.length > 0 ? { error: errors.join('; ').slice(0, 500) } : {}),
  };
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
