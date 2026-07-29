import { conversationIdFromUrl } from '@session-radar/shared/pure';
import type { Anchor, SiteAdapter, SiteObservation } from './types.js';
import {
  anyMatch,
  cleanInventoryTitle,
  runSelfTest,
  stableInventoryUrl,
  textOf,
} from './types.js';

/**
 * chatgpt.com adapter, including Codex web pages under /codex/.
 *
 * Lifecycle selectors remain versioned and self-testing. The sidebar link shape
 * was verified against a logged-in session on 2026-07-29; it is still only the
 * rendered recent window, never the complete account inventory.
 */
export const SELECTORS_VERSION = '2026.07.29-2';

const COMPOSER = ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea[data-id]'];
const STOP_BUTTON = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="Stop streaming" i]',
  'button[aria-label*="Stop generating" i]',
];
const SEND_BUTTON = ['button[data-testid="send-button"]', 'button[aria-label*="Send prompt" i]'];
const MESSAGE = ['[data-message-author-role]', 'article[data-testid^="conversation-turn"]'];
const APPROVAL_DIALOG = ['[role="dialog"] button[data-testid*="allow" i]', '[role="dialog"] [data-testid*="approve" i]'];
const TOOL_PERMISSION = ['[data-testid*="tool-approval"]', '[data-testid*="permission-request"]'];
const LOGIN_WALL = ['input[type="password"]', 'button[data-testid="login-button"]', '[data-testid="welcome-screen"]'];
const RATE_LIMIT = ['[data-testid*="rate-limit"]', '[data-testid*="usage-limit"]'];
const TITLE = ['h1', '[data-testid="conversation-title"]', 'title'];

const ANCHORS: Anchor[] = [
  { name: 'composer', selectors: COMPOSER },
  { name: 'message', selectors: MESSAGE },
  { name: 'stop-button', selectors: STOP_BUTTON, transient: true },
  { name: 'send-button', selectors: SEND_BUTTON, transient: true },
];

export const chatgptAdapter: SiteAdapter = {
  site: 'chatgpt-web',
  selectorsVersion: SELECTORS_VERSION,

  owns(rawUrl) {
    try {
      const host = new URL(rawUrl).hostname;
      return host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
    } catch {
      return false;
    }
  },

  matches(url) {
    return conversationIdFromUrl(url)?.site === 'chatgpt-web';
  },

  discover(doc, pageUrl) {
    const byId = new Map<string, ReturnType<typeof makeItem>>();
    for (const anchor of Array.from(
      doc.querySelectorAll<HTMLAnchorElement>('a[href]'),
    )) {
      const stableUrl = stableInventoryUrl(anchor.getAttribute('href') ?? '', pageUrl);
      if (!stableUrl) continue;
      const parsed = conversationIdFromUrl(stableUrl);
      if (parsed?.site !== 'chatgpt-web') continue;
      const item = makeItem(
        parsed.id,
        stableUrl,
        cleanInventoryTitle(anchor.getAttribute('aria-label') ?? anchor.textContent),
      );
      const existing = byId.get(parsed.id);
      if (!existing || (!existing.title && item.title)) byId.set(parsed.id, item);
    }
    return {
      items: [...byId.values()],
      basis:
        'visible chatgpt.com conversation links only; the rendered sidebar is a fixed recent window',
    };
  },

  detect(doc, _url): SiteObservation {
    const title = textOf(doc, TITLE);

    if (anyMatch(doc, LOGIN_WALL)) {
      return { state: 'blocked', blockReason: 'login_wall', basis: 'login form present', ...(title ? { title } : {}) };
    }
    if (anyMatch(doc, RATE_LIMIT)) {
      return { state: 'blocked', blockReason: 'rate_limit', basis: 'usage limit notice', ...(title ? { title } : {}) };
    }
    if (anyMatch(doc, TOOL_PERMISSION)) {
      return { state: 'blocked', blockReason: 'tool_permission', basis: 'tool permission prompt', ...(title ? { title } : {}) };
    }
    if (anyMatch(doc, APPROVAL_DIALOG)) {
      return { state: 'blocked', blockReason: 'approval_dialog', basis: 'approval dialog open', ...(title ? { title } : {}) };
    }
    if (anyMatch(doc, STOP_BUTTON)) {
      return { state: 'generating', basis: 'stop button present', ...(title ? { title } : {}) };
    }
    if (anyMatch(doc, MESSAGE)) {
      return { state: 'completed', basis: 'messages rendered, no stop button', ...(title ? { title } : {}) };
    }
    return { state: 'unknown', basis: 'no recognised anchors', ...(title ? { title } : {}) };
  },

  selfTest(doc) {
    return runSelfTest(doc, SELECTORS_VERSION, ANCHORS);
  },
};

function makeItem(
  conversationId: string,
  url: string,
  title: string | undefined,
): {
  conversationId: string;
  url: string;
  title?: string;
} {
  return {
    conversationId,
    url,
    ...(title ? { title } : {}),
  };
}
