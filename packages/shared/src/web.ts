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
 * Metadata-only history inventory discovered by the extension.
 *
 * `account-api` is the site's own authenticated list endpoint, fetched with the
 * page's ambient session. `visible-dom` is deliberately weaker: it contains
 * only links currently rendered in a sidebar/table and can never claim account
 * completeness.
 */
export const webInventoryScopeSchema = z.enum(['visible-dom', 'account-api']);
export type WebInventoryScope = z.infer<typeof webInventoryScopeSchema>;

export const webInventoryCompletenessSchema = z.enum([
  'complete',
  'partial',
  'unavailable',
]);
export type WebInventoryCompleteness = z.infer<
  typeof webInventoryCompletenessSchema
>;

export const webInventoryItemSchema = z.object({
  conversationId: z.string().min(1).max(512),
  /** Source-native list title only; never prompt or response text. */
  title: z.string().max(160).optional(),
  /** Exact, same-site return path observed in the list surface. */
  url: z.string().url().max(2_048),
  /** Source-native create/update time. Omitted when the DOM exposes none. */
  updatedAt: z.number().int().nonnegative().optional(),
  archived: z.boolean().optional(),
  /**
   * ChatGPT's first-party async enum. Only verified values 3 and 4 are mapped
   * to lifecycle signals; every other value remains inventory-only.
   */
  asyncStatus: z.number().int().min(1).max(7).optional(),
});
export type WebInventoryItem = z.infer<typeof webInventoryItemSchema>;

export const webInventorySchema = z.object({
  scope: webInventoryScopeSchema,
  completeness: webInventoryCompletenessSchema,
  /** Epoch ms when this inventory snapshot was read. */
  at: z.number().int().nonnegative(),
  /** Capped so one extension heartbeat remains a small local request. */
  items: z.array(webInventoryItemSchema).max(1_000),
  /** Human-readable explanation of the boundary, shown in Coverage Health. */
  basis: z.string().min(1).max(500),
  advertisedTotal: z.number().int().nonnegative().optional(),
  rejectedItems: z.number().int().nonnegative().optional(),
  error: z.string().max(500).optional(),
});
export type WebInventory = z.infer<typeof webInventorySchema>;

/**
 * Metadata-only Claude Code/Cowork account session.
 *
 * The upstream response also contains prompts, task summaries, files, source
 * configuration, events, and arbitrary external metadata. None of those fields
 * are permitted on this wire contract.
 */
export const claudeAgentInventoryItemSchema = z.object({
  sessionId: z.string().regex(/^session_[A-Za-z0-9._:-]+$/u).max(512),
  title: z.string().max(160).optional(),
  url: z.string().url().max(2_048),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  sessionStatus: z
    .enum(['running', 'idle', 'paused', 'archived', 'pending', 'requires_action'])
    .optional(),
  workerStatus: z.enum(['running', 'idle', 'requires_action']).optional(),
  connectionStatus: z.enum(['connected', 'disconnected']).optional(),
  environmentKind: z.enum(['bridge', 'anthropic_cloud']).optional(),
  origin: z
    .enum(['claude_code_cli', 'desktop_app', 'web_claude_ai', 'ios', 'android'])
    .optional(),
  unread: z.boolean().optional(),
  statusCategory: z
    .enum(['need_input', 'blocked', 'failed', 'review_ready'])
    .optional(),
  archived: z.boolean(),
});
export type ClaudeAgentInventoryItem = z.infer<
  typeof claudeAgentInventoryItemSchema
>;

export const claudeAgentInventorySchema = z.object({
  completeness: webInventoryCompletenessSchema,
  at: z.number().int().nonnegative(),
  items: z.array(claudeAgentInventoryItemSchema).max(1_000),
  basis: z.string().min(1).max(500),
  rejectedItems: z.number().int().nonnegative().optional(),
  unknownEnumValues: z.number().int().nonnegative().optional(),
  error: z.string().max(500).optional(),
});
export type ClaudeAgentInventory = z.infer<typeof claudeAgentInventorySchema>;

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
  /** Account/sidebar history snapshots, independent of currently open chats. */
  inventories: z.array(webInventorySchema).max(16).optional(),
  /** Complete Claude Code/Cowork account inventory when the Claude bridge can fetch it. */
  claudeAgentInventory: claudeAgentInventorySchema.optional(),
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
