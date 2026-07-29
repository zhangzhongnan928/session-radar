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
 * claude.ai adapter.
 *
 * Lifecycle selectors remain versioned and self-testing. Conversation links
 * and `time[datetime]` list metadata were verified against a logged-in
 * `/chats` page on 2026-07-29. Claude lazy-loads that table, so DOM discovery
 * must always report partial coverage.
 */
export const SELECTORS_VERSION = '2026.07.29-2';

const COMPOSER = ['div[contenteditable="true"]', 'textarea[data-testid]', 'fieldset textarea'];
const SEND_BUTTON = ['button[aria-label*="Send" i]', 'button[data-testid="send-button"]'];
const STOP_BUTTON = [
  'button[aria-label*="Stop" i]',
  'button[data-testid="stop-button"]',
  'button[aria-label*="stop response" i]',
];
const MESSAGE = ['[data-testid*="message"]', 'div[data-test-render-count]'];
const APPROVAL_DIALOG = [
  '[role="dialog"] button[aria-label*="Allow" i]',
  '[role="dialog"] button:not([aria-label])',
];
const TOOL_PERMISSION = ['[data-testid*="permission"]', '[data-testid*="tool-approval"]'];
const LOGIN_WALL = ['input[type="password"]', 'button[data-testid="login-button"]', 'a[href*="/login"]'];
const TITLE = ['button[data-testid="chat-menu-trigger"]', 'header h1', '[data-testid="conversation-title"]'];

/**
 * Anchors that should exist on ANY loaded conversation page. Their absence means
 * we are no longer reading the page correctly.
 */
const ANCHORS: Anchor[] = [
  { name: 'composer', selectors: COMPOSER },
  { name: 'message', selectors: MESSAGE },
  { name: 'stop-button', selectors: STOP_BUTTON, transient: true },
  { name: 'send-button', selectors: SEND_BUTTON, transient: true },
];

export const claudeAdapter: SiteAdapter = {
  site: 'claude-web',
  selectorsVersion: SELECTORS_VERSION,

  owns(rawUrl) {
    try {
      const host = new URL(rawUrl).hostname;
      return host === 'claude.ai' || host.endsWith('.claude.ai');
    } catch {
      return false;
    }
  },

  matches(url) {
    return conversationIdFromUrl(url)?.site === 'claude-web';
  },

  discover(doc, pageUrl) {
    const byId = new Map<
      string,
      {
        conversationId: string;
        url: string;
        title?: string;
        updatedAt?: number;
      }
    >();

    for (const anchor of Array.from(
      doc.querySelectorAll<HTMLAnchorElement>('a[href]'),
    )) {
      const stableUrl = stableInventoryUrl(anchor.getAttribute('href') ?? '', pageUrl);
      if (!stableUrl) continue;
      const parsed = conversationIdFromUrl(stableUrl);
      if (parsed?.site !== 'claude-web') continue;

      const title = cleanInventoryTitle(
        anchor.getAttribute('aria-label') ?? anchor.textContent,
      );
      const updatedAt = timestampNear(anchor);
      const item = {
        conversationId: parsed.id,
        url: stableUrl,
        ...(title ? { title } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      };
      const existing = byId.get(parsed.id);
      if (
        !existing ||
        (updatedAt ?? -1) > (existing.updatedAt ?? -1) ||
        (!existing.title && title)
      ) {
        byId.set(parsed.id, item);
      }
    }

    return {
      items: [...byId.values()],
      basis:
        'visible claude.ai conversation/Cowork links only; the /chats table is lazy-loaded and not a proven complete account archive',
    };
  },

  detect(doc, _url): SiteObservation {
    const title = textOf(doc, TITLE);

    // A login wall outranks everything: nothing else on the page is meaningful.
    if (anyMatch(doc, LOGIN_WALL)) {
      return { state: 'blocked', blockReason: 'login_wall', basis: 'login form present', ...(title ? { title } : {}) };
    }
    if (anyMatch(doc, TOOL_PERMISSION)) {
      return { state: 'blocked', blockReason: 'tool_permission', basis: 'tool permission prompt', ...(title ? { title } : {}) };
    }
    if (anyMatch(doc, APPROVAL_DIALOG)) {
      return { state: 'blocked', blockReason: 'approval_dialog', basis: 'approval dialog open', ...(title ? { title } : {}) };
    }
    // A stop button only exists while a response is streaming.
    if (anyMatch(doc, STOP_BUTTON)) {
      return { state: 'generating', basis: 'stop button present', ...(title ? { title } : {}) };
    }
    if (anyMatch(doc, MESSAGE)) {
      return { state: 'completed', basis: 'messages rendered, no stop button', ...(title ? { title } : {}) };
    }
    // We can see the page but recognise nothing on it. Saying "unknown" keeps a
    // rotted selector set from being reported as a finished conversation.
    return { state: 'unknown', basis: 'no recognised anchors', ...(title ? { title } : {}) };
  },

  selfTest(doc) {
    return runSelfTest(doc, SELECTORS_VERSION, ANCHORS);
  },
};

function timestampNear(anchor: HTMLAnchorElement): number | undefined {
  const row = anchor.closest('tr, [role="row"], li, article');
  const direct = row?.querySelector<HTMLTimeElement>('time[datetime]');
  const candidates = direct ? [direct] : nearbyTimes(anchor);
  for (const time of candidates) {
    const raw = time.getAttribute('datetime');
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function nearbyTimes(anchor: HTMLAnchorElement): HTMLTimeElement[] {
  let parent = anchor.parentElement;
  for (let depth = 0; parent && depth < 4; depth += 1) {
    const links = parent.querySelectorAll('a[href]');
    const times = Array.from(
      parent.querySelectorAll<HTMLTimeElement>('time[datetime]'),
    );
    if (links.length === 1 && times.length > 0) return times;
    parent = parent.parentElement;
  }
  return [];
}
