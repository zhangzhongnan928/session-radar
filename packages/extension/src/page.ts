import type {
  ClaudeAgentInventory,
  WebInventory,
} from '@session-radar/shared';
import {
  collectChatGptAccountInventory,
  collectClaudeAccountInventory,
  collectClaudeAgentInventory,
} from './page-inventory.js';
import {
  ACCOUNT_INVENTORY_REQUEST,
  ACCOUNT_INVENTORY_RESPONSE,
  CLAUDE_AGENT_INVENTORY_REQUEST,
  CLAUDE_AGENT_INVENTORY_RESPONSE,
} from './protocol.js';

const ACCOUNT_CACHE_MS = 5 * 60_000;
const CLAUDE_AGENT_CACHE_MS = 60_000;
let accountCached:
  | {
      fetchedAt: number;
      inventory: WebInventory;
    }
  | undefined;
let accountInFlight: Promise<WebInventory> | undefined;
let claudeAgentCached:
  | {
      fetchedAt: number;
      inventory: ClaudeAgentInventory;
    }
  | undefined;
let claudeAgentInFlight: Promise<ClaudeAgentInventory> | undefined;

/**
 * Main-world bridge.
 *
 * This runs on the exact first-party ChatGPT and Claude origins because an
 * isolated Chrome content script cannot use the page's ambient authenticated
 * fetch. It never reads cookies/storage or asks either app for a token.
 */
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (isAccountRequest(event.data)) {
    void respondWithAccountInventory(event.data.requestId);
  } else if (
    window.location.hostname === 'claude.ai' &&
    isClaudeAgentRequest(event.data)
  ) {
    void respondWithClaudeAgentInventory(event.data.requestId);
  }
});

async function respondWithAccountInventory(requestId: string): Promise<void> {
  const inventory = await currentAccountInventory();
  window.postMessage(
    {
      type: ACCOUNT_INVENTORY_RESPONSE,
      requestId,
      inventory,
    },
    window.location.origin,
  );
}

async function respondWithClaudeAgentInventory(requestId: string): Promise<void> {
  const inventory = await currentClaudeAgentInventory();
  window.postMessage(
    {
      type: CLAUDE_AGENT_INVENTORY_RESPONSE,
      requestId,
      inventory,
    },
    window.location.origin,
  );
}

async function currentAccountInventory(): Promise<WebInventory> {
  const now = Date.now();
  if (
    accountCached &&
    now - accountCached.fetchedAt < ACCOUNT_CACHE_MS
  ) {
    return accountCached.inventory;
  }
  if (accountInFlight) return accountInFlight;

  accountInFlight =
    window.location.hostname === 'claude.ai'
      ? collectClaudeAccountInventory(window.fetch.bind(window), now)
      : collectChatGptAccountInventory(window.fetch.bind(window), now);
  try {
    const inventory = await accountInFlight;
    accountCached = { fetchedAt: Date.now(), inventory };
    return inventory;
  } finally {
    accountInFlight = undefined;
  }
}

async function currentClaudeAgentInventory(): Promise<ClaudeAgentInventory> {
  const now = Date.now();
  if (
    claudeAgentCached &&
    now - claudeAgentCached.fetchedAt < CLAUDE_AGENT_CACHE_MS
  ) {
    return claudeAgentCached.inventory;
  }
  if (claudeAgentInFlight) return claudeAgentInFlight;

  claudeAgentInFlight = collectClaudeAgentInventory(
    window.fetch.bind(window),
    now,
  );
  try {
    const inventory = await claudeAgentInFlight;
    claudeAgentCached = { fetchedAt: Date.now(), inventory };
    return inventory;
  } finally {
    claudeAgentInFlight = undefined;
  }
}

function isAccountRequest(
  value: unknown,
): value is { type: typeof ACCOUNT_INVENTORY_REQUEST; requestId: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; requestId?: unknown };
  return (
    candidate.type === ACCOUNT_INVENTORY_REQUEST &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0 &&
    candidate.requestId.length <= 128
  );
}

function isClaudeAgentRequest(
  value: unknown,
): value is {
  type: typeof CLAUDE_AGENT_INVENTORY_REQUEST;
  requestId: string;
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; requestId?: unknown };
  return (
    candidate.type === CLAUDE_AGENT_INVENTORY_REQUEST &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0 &&
    candidate.requestId.length <= 128
  );
}
