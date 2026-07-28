import { conversationIdFromUrl } from '@session-radar/shared/pure';
import type { Anchor, SiteAdapter, SiteObservation } from './types.js';
import { anyMatch, runSelfTest, textOf } from './types.js';

/**
 * claude.ai adapter.
 *
 * IMPORTANT: these selectors are best-effort and were NOT verified against a
 * logged-in claude.ai session. That is exactly why `selfTest` exists — until the
 * anchors below are seen in a real page, this connector will report `degraded`
 * with the missing anchor names, rather than silently reporting conversations as
 * completed. Fix the selectors, bump SELECTORS_VERSION, and the warning clears.
 */
export const SELECTORS_VERSION = '2026.07.28-1';

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

  matches(url) {
    return conversationIdFromUrl(url)?.site === 'claude-web';
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
