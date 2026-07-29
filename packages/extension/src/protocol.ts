import type {
  ClaudeAgentInventory,
  SelectorHealth,
  WebBlockReason,
  WebConversationState,
  WebInventory,
  WebSite,
} from '@session-radar/shared';

/** Content script -> service worker. The worker owns all network access. */
export interface ContentObservation {
  kind: 'session-radar/observation';
  site: WebSite;
  conversationId: string;
  state: WebConversationState;
  blockReason?: WebBlockReason;
  title?: string;
  url: string;
  basis: string;
  selectors: SelectorHealth;
  at: number;
}

/** Sent when a content script leaves a conversation (SPA route change or unload). */
export interface ContentLeft {
  kind: 'session-radar/left';
  site: WebSite;
  conversationId: string;
  at: number;
}

/** Metadata-only history currently visible in a page, or fetched by its bridge. */
export interface ContentInventory {
  kind: 'session-radar/inventory';
  site: WebSite;
  inventory: WebInventory;
}

/** A visible-DOM snapshot belongs to a tab and disappears with its document. */
export interface ContentInventoryLeft {
  kind: 'session-radar/inventory-left';
  site: WebSite;
  scope: 'visible-dom';
  at: number;
}

/** Metadata-only Claude Code/Cowork inventory fetched in the Claude page. */
export interface ContentClaudeAgentInventory {
  kind: 'session-radar/claude-agent-inventory';
  site: 'claude-web';
  inventory: ClaudeAgentInventory;
}

export type ContentMessage =
  | ContentObservation
  | ContentLeft
  | ContentInventory
  | ContentInventoryLeft
  | ContentClaudeAgentInventory;

export function isContentMessage(value: unknown): value is ContentMessage {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === 'session-radar/observation' ||
    kind === 'session-radar/left' ||
    kind === 'session-radar/inventory' ||
    kind === 'session-radar/inventory-left' ||
    kind === 'session-radar/claude-agent-inventory'
  );
}

/** Main-world page bridge message names. Kept out of page globals. */
export const ACCOUNT_INVENTORY_REQUEST =
  'session-radar/request-account-inventory-v1';
export const ACCOUNT_INVENTORY_RESPONSE =
  'session-radar/account-inventory-v1';
export const CLAUDE_AGENT_INVENTORY_REQUEST =
  'session-radar/request-claude-agent-inventory-v1';
export const CLAUDE_AGENT_INVENTORY_RESPONSE =
  'session-radar/claude-agent-inventory-v1';

/** Narrow manual guard so the isolated content script never imports zod. */
export function isWebInventoryValue(value: unknown): value is WebInventory {
  if (!record(value)) return false;
  if (value['scope'] !== 'visible-dom' && value['scope'] !== 'account-api') {
    return false;
  }
  if (
    value['completeness'] !== 'complete' &&
    value['completeness'] !== 'partial' &&
    value['completeness'] !== 'unavailable'
  ) {
    return false;
  }
  if (!integer(value['at']) || value['at'] < 0) return false;
  if (
    typeof value['basis'] !== 'string' ||
    value['basis'].length === 0 ||
    value['basis'].length > 500
  ) {
    return false;
  }
  if (!Array.isArray(value['items']) || value['items'].length > 1_000) return false;
  if (!value['items'].every(isInventoryItem)) return false;
  if (
    value['advertisedTotal'] !== undefined &&
    (!integer(value['advertisedTotal']) || value['advertisedTotal'] < 0)
  ) {
    return false;
  }
  if (
    value['rejectedItems'] !== undefined &&
    (!integer(value['rejectedItems']) || value['rejectedItems'] < 0)
  ) {
    return false;
  }
  return (
    value['error'] === undefined ||
    (typeof value['error'] === 'string' && value['error'].length <= 500)
  );
}

/** Narrow manual guard so the isolated content script never imports zod. */
export function isClaudeAgentInventoryValue(
  value: unknown,
): value is ClaudeAgentInventory {
  if (!record(value)) return false;
  if (
    value['completeness'] !== 'complete' &&
    value['completeness'] !== 'partial' &&
    value['completeness'] !== 'unavailable'
  ) {
    return false;
  }
  if (!integer(value['at']) || value['at'] < 0) return false;
  if (
    typeof value['basis'] !== 'string' ||
    value['basis'].length === 0 ||
    value['basis'].length > 500
  ) {
    return false;
  }
  if (!Array.isArray(value['items']) || value['items'].length > 1_000) {
    return false;
  }
  if (!value['items'].every(isClaudeAgentInventoryItem)) return false;
  for (const key of [
    'rejectedItems',
    'unknownEnumValues',
  ] as const) {
    if (
      value[key] !== undefined &&
      (!integer(value[key]) || value[key] < 0)
    ) {
      return false;
    }
  }
  return (
    value['error'] === undefined ||
    (typeof value['error'] === 'string' && value['error'].length <= 500)
  );
}

/**
 * Clone the validated page value onto the exact wire allowlist. This prevents
 * an unrelated page script from smuggling extra raw/content fields through a
 * coincidentally matching window message.
 */
export function sanitizeClaudeAgentInventoryValue(
  value: unknown,
): ClaudeAgentInventory | undefined {
  if (!isClaudeAgentInventoryValue(value)) return undefined;
  return {
    completeness: value.completeness,
    at: value.at,
    items: value.items.map((item) => ({
      sessionId: item.sessionId,
      ...(item.title !== undefined ? { title: item.title } : {}),
      url: item.url,
      ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
      ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
      ...(item.sessionStatus !== undefined
        ? { sessionStatus: item.sessionStatus }
        : {}),
      ...(item.workerStatus !== undefined
        ? { workerStatus: item.workerStatus }
        : {}),
      ...(item.connectionStatus !== undefined
        ? { connectionStatus: item.connectionStatus }
        : {}),
      ...(item.environmentKind !== undefined
        ? { environmentKind: item.environmentKind }
        : {}),
      ...(item.origin !== undefined ? { origin: item.origin } : {}),
      ...(item.unread !== undefined ? { unread: item.unread } : {}),
      ...(item.statusCategory !== undefined
        ? { statusCategory: item.statusCategory }
        : {}),
      archived: item.archived,
    })),
    basis: value.basis,
    ...(value.rejectedItems !== undefined
      ? { rejectedItems: value.rejectedItems }
      : {}),
    ...(value.unknownEnumValues !== undefined
      ? { unknownEnumValues: value.unknownEnumValues }
      : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
  };
}

function isInventoryItem(value: unknown): boolean {
  if (!record(value)) return false;
  if (
    typeof value['conversationId'] !== 'string' ||
    value['conversationId'].length === 0 ||
    value['conversationId'].length > 512
  ) {
    return false;
  }
  if (
    value['title'] !== undefined &&
    (typeof value['title'] !== 'string' || value['title'].length > 160)
  ) {
    return false;
  }
  if (typeof value['url'] !== 'string' || value['url'].length > 2_048) return false;
  try {
    void new URL(value['url']);
  } catch {
    return false;
  }
  if (
    value['updatedAt'] !== undefined &&
    (!integer(value['updatedAt']) || value['updatedAt'] < 0)
  ) {
    return false;
  }
  if (value['archived'] !== undefined && typeof value['archived'] !== 'boolean') {
    return false;
  }
  return (
    value['asyncStatus'] === undefined ||
    (integer(value['asyncStatus']) &&
      value['asyncStatus'] >= 1 &&
      value['asyncStatus'] <= 7)
  );
}

function isClaudeAgentInventoryItem(value: unknown): boolean {
  if (!record(value)) return false;
  if (
    typeof value['sessionId'] !== 'string' ||
    !/^session_[A-Za-z0-9._:-]+$/u.test(value['sessionId']) ||
    value['sessionId'].length > 512
  ) {
    return false;
  }
  if (
    value['title'] !== undefined &&
    (typeof value['title'] !== 'string' || value['title'].length > 160)
  ) {
    return false;
  }
  if (typeof value['url'] !== 'string' || value['url'].length > 2_048) {
    return false;
  }
  try {
    void new URL(value['url']);
  } catch {
    return false;
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (
      value[key] !== undefined &&
      (!integer(value[key]) || value[key] < 0)
    ) {
      return false;
    }
  }
  if (
    value['sessionStatus'] !== undefined &&
    (typeof value['sessionStatus'] !== 'string' ||
      ![
        'running',
        'idle',
        'paused',
        'archived',
        'pending',
        'requires_action',
      ].includes(value['sessionStatus']))
  ) {
    return false;
  }
  if (
    value['workerStatus'] !== undefined &&
    (typeof value['workerStatus'] !== 'string' ||
      !['running', 'idle', 'requires_action'].includes(
        value['workerStatus'],
      ))
  ) {
    return false;
  }
  if (
    value['connectionStatus'] !== undefined &&
    (typeof value['connectionStatus'] !== 'string' ||
      !['connected', 'disconnected'].includes(value['connectionStatus']))
  ) {
    return false;
  }
  if (
    value['environmentKind'] !== undefined &&
    (typeof value['environmentKind'] !== 'string' ||
      !['bridge', 'anthropic_cloud'].includes(value['environmentKind']))
  ) {
    return false;
  }
  if (
    value['origin'] !== undefined &&
    (typeof value['origin'] !== 'string' ||
      ![
        'claude_code_cli',
        'desktop_app',
        'web_claude_ai',
        'ios',
        'android',
      ].includes(value['origin']))
  ) {
    return false;
  }
  if (value['unread'] !== undefined && typeof value['unread'] !== 'boolean') {
    return false;
  }
  if (
    value['statusCategory'] !== undefined &&
    (typeof value['statusCategory'] !== 'string' ||
      !['need_input', 'blocked', 'failed', 'review_ready'].includes(
        value['statusCategory'],
      ))
  ) {
    return false;
  }
  return typeof value['archived'] === 'boolean';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** How often the content script re-reads the DOM. */
export const OBSERVE_INTERVAL_MS = 3_000;
/** How often the service worker flushes to the daemon (also the heartbeat). */
export const FLUSH_INTERVAL_MS = 15_000;
/** Account inventory refresh. The page bridge caches at the same cadence. */
export const ACCOUNT_INVENTORY_INTERVAL_MS = 5 * 60_000;
/** Agent state changes independently and is cheap enough to refresh each minute. */
export const CLAUDE_AGENT_INVENTORY_INTERVAL_MS = 60_000;

export const DAEMON_ORIGIN = 'http://127.0.0.1:4747';
export const DAEMON_WEB_ENDPOINT = `${DAEMON_ORIGIN}/api/hooks/web`;
