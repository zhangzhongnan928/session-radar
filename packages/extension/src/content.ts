import { conversationIdFromUrl } from '@session-radar/shared/pure';
import { chatgptAdapter } from './sites/chatgpt.js';
import { claudeAdapter } from './sites/claude.js';
import type { SiteAdapter } from './sites/types.js';
import type { ContentMessage } from './protocol.js';
import { OBSERVE_INTERVAL_MS } from './protocol.js';

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
let lastSerialized: string | undefined;

function adapterFor(url: string): SiteAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.matches(url));
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
  const parsed = conversationIdFromUrl(url);
  const adapter = parsed ? adapterFor(url) : undefined;

  // Left the conversation: a new chat, the project list, settings.
  if (!parsed || !adapter) {
    if (currentConversationId) {
      send({
        kind: 'session-radar/left',
        site: ADAPTERS[0]!.site,
        conversationId: currentConversationId,
        at: Date.now(),
      });
      currentConversationId = undefined;
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

// Poll rather than MutationObserver: both sites re-render constantly, and a
// 3-second poll costs far less than reacting to every subtree mutation.
const timer = setInterval(observe, OBSERVE_INTERVAL_MS);
observe();

window.addEventListener('pagehide', () => {
  clearInterval(timer);
  if (currentConversationId) {
    const adapter = adapterFor(window.location.href);
    if (adapter) {
      send({
        kind: 'session-radar/left',
        site: adapter.site,
        conversationId: currentConversationId,
        at: Date.now(),
      });
    }
  }
});
