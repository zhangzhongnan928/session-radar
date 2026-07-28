import { conversationIdFromUrl } from '@session-radar/shared/pure';
import type { Anchor, SiteAdapter, SiteObservation } from './types.js';
import { anyMatch, runSelfTest, textOf } from './types.js';

/**
 * chatgpt.com adapter, including Codex web pages under /codex/.
 *
 * Same caveat as the claude.ai adapter: these selectors are best-effort and were
 * NOT verified against a logged-in session. `selfTest` is what makes that
 * honest — missing anchors surface as degraded coverage naming exactly what to
 * fix, instead of an empty list that looks like "nothing is running".
 */
export const SELECTORS_VERSION = '2026.07.28-1';

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

  matches(url) {
    return conversationIdFromUrl(url)?.site === 'chatgpt-web';
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
