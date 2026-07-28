/**
 * Contract between the Chrome extension and the daemon.
 *
 * The extension reports *observed UI state*, never a status. The daemon maps
 * state -> signal and the status engine decides, exactly as with the CLIs.
 */
import { z } from 'zod';

export const webSiteSchema = z.enum(['claude-web', 'chatgpt-web']);

export * from './web-url.js';

/**
 * What the content script saw. Deliberately descriptive rather than evaluative:
 * `generating` is an observation, `running` would be a judgement.
 */
export const webConversationStateSchema = z.enum([
  /** A response is streaming (stop button present). */
  'generating',
  /** Something is waiting on the user: approval dialog, tool prompt, login wall. */
  'blocked',
  /** Reply finished, composer idle, nothing pending. */
  'completed',
  /** The tab is open but we cannot tell which of the above applies. */
  'unknown',
]);
export type WebConversationState = z.infer<typeof webConversationStateSchema>;

/** Why the content script thinks it is blocked. Shown verbatim in evidence. */
export const webBlockReasonSchema = z.enum([
  'approval_dialog',
  'tool_permission',
  'login_wall',
  'rate_limit',
  'other',
]);
export type WebBlockReason = z.infer<typeof webBlockReasonSchema>;

export const webConversationSchema = z.object({
  /** Conversation id parsed from the URL. */
  conversationId: z.string().min(1),
  state: webConversationStateSchema,
  blockReason: webBlockReasonSchema.optional(),
  /** DOM title, truncated by the content script. */
  title: z.string().optional(),
  url: z.string().optional(),
  /** Epoch ms the observation was made in the page. */
  at: z.number().int().nonnegative(),
});
export type WebConversation = z.infer<typeof webConversationSchema>;

/**
 * Result of the selector self-test.
 *
 * This is the honest core of the web collector: selectors WILL rot, and when
 * they do the extension must say "I can no longer see" rather than reporting an
 * empty page as a finished conversation.
 */
export const selectorHealthSchema = z.object({
  /** Bumped whenever the selector set for a site changes. */
  selectorsVersion: z.string().min(1),
  /** Anchors that were expected and found. */
  found: z.array(z.string()),
  /** Anchors that were expected and are missing — the rot signal. */
  missing: z.array(z.string()),
});
export type SelectorHealth = z.infer<typeof selectorHealthSchema>;

/** One POST from the extension's service worker. */
export const webReportSchema = z.object({
  site: webSiteSchema,
  /** Epoch ms the service worker sent this. Doubles as the heartbeat. */
  at: z.number().int().nonnegative(),
  /** Every conversation tab currently open for this site. May be empty. */
  conversations: z.array(webConversationSchema),
  /** Conversation ids whose tabs closed since the last report. */
  closed: z.array(z.string()).optional(),
  selectors: selectorHealthSchema,
  /** Extension version, for the coverage strip. */
  extensionVersion: z.string().optional(),
});
export type WebReport = z.infer<typeof webReportSchema>;

export const webReportResponseSchema = z.object({
  accepted: z.boolean(),
  observed: z.number().int().nonnegative(),
  warning: z.string().optional(),
});
export type WebReportResponse = z.infer<typeof webReportResponseSchema>;

