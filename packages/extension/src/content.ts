import { conversationIdFromUrl } from '@session-radar/shared/pure';
import { chatgptAdapter } from './sites/chatgpt.js';
import { claudeAdapter } from './sites/claude.js';
import type { SiteAdapter } from './sites/types.js';
import type { ContentMessage } from './protocol.js';
import {
  ACCOUNT_INVENTORY_INTERVAL_MS,
  ACCOUNT_INVENTORY_REQUEST,
  ACCOUNT_INVENTORY_RESPONSE,
  CLAUDE_AGENT_INVENTORY_INTERVAL_MS,
  CLAUDE_AGENT_INVENTORY_REQUEST,
  CLAUDE_AGENT_INVENTORY_RESPONSE,
  FLUSH_INTERVAL_MS,
  OBSERVE_INTERVAL_MS,
  sanitizeClaudeAgentInventoryValue,
  isWebInventoryValue,
} from './protocol.js';

/**
 * Content script.
 *
 * Reads DOM state and forwards it to the service worker. It never touches the
 * network itself: a content script's fetch is subject to the page's CORS, and
 * more importantly the whole product is read-only — this script observes and
 * reports, and does nothing else to the page.
 */
const ADAPTERS: SiteAdapter[] = [claudeAdapter, chatgptAdapter];

let currentConversationId: string | undefined;
let currentSite: SiteAdapter['site'] | undefined;
let lastSerialized: string | undefined;
let lastInventorySerialized: string | undefined;
let lastInventorySentAt = 0;
let lastAccountRequestAt = 0;
let pendingAccountRequest: string | undefined;
let pendingAccountSite: SiteAdapter['site'] | undefined;
let lastClaudeAgentRequestAt = 0;
let pendingClaudeAgentRequest: string | undefined;

function adapterFor(url: string): SiteAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.matches(url));
}

function siteAdapterFor(url: string): SiteAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.owns(url));
}

function send(message: ContentMessage): void {
  try {
    chrome.runtime.sendMessage(message, () => {
      // Reading lastError suppresses "Unchecked runtime.lastError" noise when the
      // service worker is asleep. The next tick will retry anyway.
      void chrome.runtime.lastError;
    });
  } catch {
    // Extension context invalidated (reload/update). The next tick recovers.
  }
}

function observe(): void {
  const url = window.location.href;
  const siteAdapter = siteAdapterFor(url);
  const parsed = conversationIdFromUrl(url);
  const adapter = parsed ? adapterFor(url) : undefined;

  if (siteAdapter) {
    const inventoryAt = Date.now();
    const discovered = siteAdapter.discover(document, url);
    const inventoryMessage: ContentMessage = {
      kind: 'session-radar/inventory',
      site: siteAdapter.site,
      inventory: {
        scope: 'visible-dom',
        completeness: 'partial',
        at: inventoryAt,
        items: discovered.items.slice(0, 1_000),
        basis: discovered.basis,
        ...(discovered.items.length > 1_000
          ? {
              rejectedItems: discovered.items.length - 1_000,
              error: 'visible DOM inventory exceeded the 1000-item wire cap',
            }
          : {}),
      },
    };
    const inventorySerialized = JSON.stringify({
      ...inventoryMessage,
      inventory: { ...inventoryMessage.inventory, at: 0 },
    });
    if (
      inventorySerialized !== lastInventorySerialized ||
      inventoryAt - lastInventorySentAt >= FLUSH_INTERVAL_MS
    ) {
      lastInventorySerialized = inventorySerialized;
      lastInventorySentAt = inventoryAt;
      send(inventoryMessage);
    }
  }

  // Left the conversation: a new chat, the project list, settings.
  if (!parsed || !adapter) {
    if (currentConversationId && currentSite) {
      send({
        kind: 'session-radar/left',
        site: currentSite,
        conversationId: currentConversationId,
        at: Date.now(),
      });
      currentConversationId = undefined;
      currentSite = undefined;
      lastSerialized = undefined;
    }
    return;
  }

  // SPA navigation between conversations: the old one is no longer on screen.
  if (currentConversationId && currentConversationId !== parsed.id) {
    send({
      kind: 'session-radar/left',
      site: adapter.site,
      conversationId: currentConversationId,
      at: Date.now(),
    });
    lastSerialized = undefined;
  }
  currentConversationId = parsed.id;
  currentSite = adapter.site;

  const observation = adapter.detect(document, url);
  const selectors = adapter.selfTest(document);

  const message: ContentMessage = {
    kind: 'session-radar/observation',
    site: adapter.site,
    conversationId: parsed.id,
    state: observation.state,
    ...(observation.blockReason ? { blockReason: observation.blockReason } : {}),
    ...(observation.title ? { title: observation.title } : {}),
    url,
    basis: observation.basis,
    selectors,
    at: Date.now(),
  };

  // Only send when something actually changed, apart from the timestamp — but
  // always send at least the heartbeat cadence so the worker knows we are alive.
  const serialized = JSON.stringify({ ...message, at: 0 });
  if (serialized === lastSerialized) {
    send(message);
    return;
  }
  lastSerialized = serialized;
  send(message);
}

function requestAccountInventory(): void {
  const site = siteAdapterFor(window.location.href)?.site;
  if (!site) return;
  if (pendingAccountRequest) return;
  const now = Date.now();
  if (now - lastAccountRequestAt < ACCOUNT_INVENTORY_INTERVAL_MS) return;

  const requestId =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${now}-${Math.random().toString(36).slice(2)}`;
  lastAccountRequestAt = now;
  pendingAccountRequest = requestId;
  pendingAccountSite = site;
  window.postMessage(
    { type: ACCOUNT_INVENTORY_REQUEST, requestId },
    window.location.origin,
  );
  window.setTimeout(() => {
    if (pendingAccountRequest === requestId) {
      pendingAccountRequest = undefined;
      pendingAccountSite = undefined;
    }
  }, 120_000);
}

function requestClaudeAgentInventory(): void {
  if (siteAdapterFor(window.location.href)?.site !== 'claude-web') return;
  if (pendingClaudeAgentRequest) return;
  const now = Date.now();
  if (
    now - lastClaudeAgentRequestAt <
    CLAUDE_AGENT_INVENTORY_INTERVAL_MS
  ) {
    return;
  }

  const requestId =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${now}-${Math.random().toString(36).slice(2)}`;
  lastClaudeAgentRequestAt = now;
  pendingClaudeAgentRequest = requestId;
  window.postMessage(
    { type: CLAUDE_AGENT_INVENTORY_REQUEST, requestId },
    window.location.origin,
  );
  window.setTimeout(() => {
    if (pendingClaudeAgentRequest === requestId) {
      pendingClaudeAgentRequest = undefined;
    }
  }, 120_000);
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (typeof event.data !== 'object' || event.data === null) return;
  const candidate = event.data as {
    type?: unknown;
    requestId?: unknown;
    inventory?: unknown;
  };

  if (candidate.type === ACCOUNT_INVENTORY_RESPONSE) {
    const expectedSite = pendingAccountSite;
    if (
      candidate.requestId !== pendingAccountRequest ||
      expectedSite === undefined ||
      !isWebInventoryValue(candidate.inventory) ||
      candidate.inventory.scope !== 'account-api'
    ) {
      return;
    }
    if (
      candidate.inventory.items.some((item) => {
        const parsed = conversationIdFromUrl(item.url);
        return (
          parsed?.site !== expectedSite ||
          parsed.id !== item.conversationId
        );
      })
    ) {
      return;
    }

    pendingAccountRequest = undefined;
    pendingAccountSite = undefined;
    send({
      kind: 'session-radar/inventory',
      site: expectedSite,
      inventory: candidate.inventory,
    });
    return;
  }

  if (
    candidate.type !== CLAUDE_AGENT_INVENTORY_RESPONSE ||
    candidate.requestId !== pendingClaudeAgentRequest
  ) {
    return;
  }
  const inventory = sanitizeClaudeAgentInventoryValue(candidate.inventory);
  if (
    !inventory ||
    inventory.items.some((item) => {
      const parsed = conversationIdFromUrl(item.url);
      return (
        parsed?.site !== 'claude-web' ||
        parsed.id !== item.sessionId
      );
    })
  ) {
    return;
  }

  pendingClaudeAgentRequest = undefined;
  send({
    kind: 'session-radar/claude-agent-inventory',
    site: 'claude-web',
    inventory,
  });
});

// Poll rather than MutationObserver: both sites re-render constantly, and a
// 3-second poll costs far less than reacting to every subtree mutation.
const timer = setInterval(observe, OBSERVE_INTERVAL_MS);
const accountTimer = setInterval(() => {
  if (document.visibilityState === 'visible') requestAccountInventory();
}, ACCOUNT_INVENTORY_INTERVAL_MS);
const claudeAgentTimer = setInterval(() => {
  if (document.visibilityState === 'visible') requestClaudeAgentInventory();
}, CLAUDE_AGENT_INVENTORY_INTERVAL_MS);
observe();
requestAccountInventory();
requestClaudeAgentInventory();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestAccountInventory();
    requestClaudeAgentInventory();
  }
});

window.addEventListener('pagehide', () => {
  clearInterval(timer);
  clearInterval(accountTimer);
  clearInterval(claudeAgentTimer);
  const siteAdapter = siteAdapterFor(window.location.href);
  if (siteAdapter) {
    send({
      kind: 'session-radar/inventory-left',
      site: siteAdapter.site,
      scope: 'visible-dom',
      at: Date.now(),
    });
  }
  if (currentConversationId) {
    const adapter = adapterFor(window.location.href);
    if (adapter && currentSite) {
      send({
        kind: 'session-radar/left',
        site: currentSite,
        conversationId: currentConversationId,
        at: Date.now(),
      });
    }
  }
});
