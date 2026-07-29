import type {
  ClaudeAgentInventory,
  ClaudeAgentInventoryItem,
  WebInventory,
  WebInventoryItem,
} from '@session-radar/shared';

/** Keep one heartbeat below the daemon's bounded local request size. */
export const MAX_ACCOUNT_INVENTORY_ITEMS = 1_000;
const ACTIVE_PAGE_SIZE = 28;
const ARCHIVED_PAGE_SIZE = 30;
const CLAUDE_PAGE_SIZE = 30;
const CLAUDE_AGENT_PAGE_SIZE = 50;
const CLAUDE_BOOTSTRAP_ENDPOINT =
  '/api/bootstrap?statsig_hashing_algorithm=djb2&growthbook_format=sdk&include_system_prompts=false';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CLAUDE_AGENT_ID_PATTERN = /^(?:cse|session)_[A-Za-z0-9._:-]+$/u;
const CLAUDE_AGENT_HEADERS = {
  Accept: 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'ccr-byoc-2025-07-29',
  'anthropic-client-feature': 'ccr',
} as const;

export type PageFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface PageCollection {
  items: WebInventoryItem[];
  total?: number;
  examinedItems: number;
  rejectedItems: number;
  complete: boolean;
  error?: string;
}

interface ClaudeBootstrap {
  organizationIds: string[];
}

interface ClaudeAgentPageCollection {
  items: ClaudeAgentInventoryItem[];
  examinedItems: number;
  rejectedItems: number;
  unknownEnumValues: number;
  complete: boolean;
  error?: string;
}

export interface ClaudeAgentProjection {
  item?: ClaudeAgentInventoryItem;
  unknownEnumValues: number;
}

/**
 * Fetch ChatGPT's own metadata list endpoints with ambient same-origin
 * credentials and immediately project them onto the narrow radar contract.
 *
 * No token, cookie, raw response, mapping, snippet, message, or prompt leaves
 * this main-world script.
 */
export async function collectChatGptAccountInventory(
  fetchImpl: PageFetch,
  at = Date.now(),
  maxItems = MAX_ACCOUNT_INVENTORY_ITEMS,
): Promise<WebInventory> {
  const safeMax = Math.max(0, Math.min(MAX_ACCOUNT_INVENTORY_ITEMS, maxItems));
  const active = await collectPages(fetchImpl, false, ACTIVE_PAGE_SIZE, safeMax);
  const remaining = Math.max(0, safeMax - active.examinedItems);
  const archived =
    remaining > 0
      ? await collectPages(fetchImpl, true, ARCHIVED_PAGE_SIZE, remaining)
      : {
          items: [],
          examinedItems: 0,
          rejectedItems: 0,
          complete: false,
          error: `inventory cap ${safeMax} reached before archived history`,
        };

  const byId = new Map<string, WebInventoryItem>();
  for (const item of [...active.items, ...archived.items]) {
    const existing = byId.get(item.conversationId);
    byId.set(item.conversationId, preferInventoryItem(existing, item));
  }

  const items = [...byId.values()];
  const rejectedItems = active.rejectedItems + archived.rejectedItems;
  const advertisedTotal =
    active.total !== undefined && archived.total !== undefined
      ? active.total + archived.total
      : undefined;
  const errors = [active.error, archived.error].filter(
    (value): value is string => Boolean(value),
  );
  const countsMatch =
    advertisedTotal === undefined || items.length + rejectedItems === advertisedTotal;
  const complete =
    active.complete &&
    archived.complete &&
    rejectedItems === 0 &&
    countsMatch &&
    errors.length === 0;
  const unavailable =
    items.length === 0 &&
    !active.complete &&
    !archived.complete &&
    Boolean(active.error) &&
    Boolean(archived.error);

  const basis = cap(
    `ChatGPT account metadata API returned ${items.length}${
      advertisedTotal === undefined ? '' : ` of ${advertisedTotal}`
    } conversation rows (active ${describeCollection(active)}, archived ${describeCollection(
      archived,
    )})`,
    500,
  );

  return {
    scope: 'account-api',
    completeness: unavailable ? 'unavailable' : complete ? 'complete' : 'partial',
    at,
    items,
    basis,
    ...(advertisedTotal !== undefined ? { advertisedTotal } : {}),
    ...(rejectedItems > 0 ? { rejectedItems } : {}),
    ...(errors.length > 0 ? { error: cap(errors.join('; '), 500) } : {}),
  };
}

/**
 * Enumerate ordinary Claude chat history for every chat-capable organization
 * in the signed-in account.
 *
 * Claude's bootstrap and list responses contain considerably more data than
 * the radar needs. They are parsed in this main-world function and only stable
 * ids, names, timestamps, URLs, and a fixed archive flag cross the bridge.
 */
export async function collectClaudeAccountInventory(
  fetchImpl: PageFetch,
  at = Date.now(),
  maxItems = MAX_ACCOUNT_INVENTORY_ITEMS,
): Promise<WebInventory> {
  const safeMax = Math.max(0, Math.min(MAX_ACCOUNT_INVENTORY_ITEMS, maxItems));
  let bootstrap: ClaudeBootstrap;
  try {
    bootstrap = await collectClaudeBootstrap(fetchImpl);
  } catch (error) {
    const message = cap(error instanceof Error ? error.message : String(error), 300);
    return {
      scope: 'account-api',
      completeness: 'unavailable',
      at,
      items: [],
      basis: 'Claude account metadata API inventory is unavailable',
      error: message,
    };
  }

  const expectedCollections = bootstrap.organizationIds.length * 2;
  const collections: PageCollection[] = [];
  let remaining = safeMax;
  let collectionOrdinal = 0;
  let cappedBeforeAllCollections = false;

  for (const organizationId of bootstrap.organizationIds) {
    for (const starred of [false, true]) {
      collectionOrdinal += 1;
      if (remaining <= 0) {
        cappedBeforeAllCollections = true;
        break;
      }
      const collection = await collectClaudePages(
        fetchImpl,
        organizationId,
        collectionOrdinal,
        starred,
        remaining,
      );
      collections.push(collection);
      remaining = Math.max(0, remaining - collection.examinedItems);
    }
    if (remaining <= 0) break;
  }

  const byId = new Map<string, WebInventoryItem>();
  for (const collection of collections) {
    for (const item of collection.items) {
      const existing = byId.get(item.conversationId);
      byId.set(item.conversationId, preferInventoryItem(existing, item));
    }
  }

  const items = [...byId.values()];
  const rejectedItems = collections.reduce(
    (sum, collection) => sum + collection.rejectedItems,
    0,
  );
  const errors = collections
    .map((collection) => collection.error)
    .filter((value): value is string => Boolean(value));
  if (
    cappedBeforeAllCollections ||
    (remaining <= 0 && collections.length < expectedCollections)
  ) {
    errors.push(
      `inventory cap ${safeMax} reached before every Claude history bucket completed`,
    );
  }

  const completedCollections = collections.filter(
    (collection) => collection.complete,
  ).length;
  const complete =
    collections.length === expectedCollections &&
    completedCollections === expectedCollections &&
    rejectedItems === 0 &&
    errors.length === 0;
  const anyCollectionAvailable = collections.some(
    (collection) => collection.complete || collection.examinedItems > 0,
  );
  const unavailable =
    items.length === 0 &&
    !complete &&
    !anyCollectionAvailable &&
    errors.length > 0;

  return {
    scope: 'account-api',
    completeness: unavailable ? 'unavailable' : complete ? 'complete' : 'partial',
    at,
    items,
    basis: cap(
      `Claude account metadata API returned ${items.length} conversation rows across ${
        bootstrap.organizationIds.length
      } chat organization(s) (${completedCollections}/${expectedCollections} non-starred/starred history buckets complete)`,
      500,
    ),
    ...(rejectedItems > 0 ? { rejectedItems } : {}),
    ...(errors.length > 0 ? { error: cap(errors.join('; '), 500) } : {}),
  };
}

/**
 * Enumerate Claude Code/Cowork sessions across every chat-capable organization.
 *
 * `/v1/code/sessions` returns task summaries, source configuration and other
 * content-bearing fields alongside the lifecycle metadata. Each raw row is
 * projected immediately; only this fixed metadata allowlist can cross the page
 * bridge.
 */
export async function collectClaudeAgentInventory(
  fetchImpl: PageFetch,
  at = Date.now(),
  maxItems = MAX_ACCOUNT_INVENTORY_ITEMS,
): Promise<ClaudeAgentInventory> {
  const safeMax = Math.max(0, Math.min(MAX_ACCOUNT_INVENTORY_ITEMS, maxItems));
  let bootstrap: ClaudeBootstrap;
  try {
    bootstrap = await collectClaudeBootstrap(fetchImpl);
  } catch (error) {
    return {
      completeness: 'unavailable',
      at,
      items: [],
      basis: 'Claude Code/Cowork account metadata inventory is unavailable',
      error: cap(error instanceof Error ? error.message : String(error), 300),
    };
  }

  const expectedCollections = bootstrap.organizationIds.length * 2;
  const collections: ClaudeAgentPageCollection[] = [];
  let remaining = safeMax;
  let collectionOrdinal = 0;

  for (const organizationId of bootstrap.organizationIds) {
    for (const archived of [false, true]) {
      collectionOrdinal += 1;
      if (remaining <= 0) break;
      const collection = await collectClaudeAgentPages(
        fetchImpl,
        organizationId,
        collectionOrdinal,
        archived,
        remaining,
      );
      collections.push(collection);
      remaining = Math.max(0, remaining - collection.examinedItems);
    }
    if (remaining <= 0) break;
  }

  const byId = new Map<string, ClaudeAgentInventoryItem>();
  for (const collection of collections) {
    for (const item of collection.items) {
      const current = byId.get(item.sessionId);
      byId.set(item.sessionId, preferClaudeAgentItem(current, item));
    }
  }

  const items = [...byId.values()];
  const rejectedItems = collections.reduce(
    (sum, collection) => sum + collection.rejectedItems,
    0,
  );
  const unknownEnumValues = collections.reduce(
    (sum, collection) => sum + collection.unknownEnumValues,
    0,
  );
  const errors = collections
    .map((collection) => collection.error)
    .filter((value): value is string => Boolean(value));
  if (collections.length < expectedCollections) {
    errors.push(
      `inventory cap ${safeMax} reached before every Claude Code/Cowork bucket completed`,
    );
  }

  const completedCollections = collections.filter(
    (collection) => collection.complete,
  ).length;
  const complete =
    collections.length === expectedCollections &&
    completedCollections === expectedCollections &&
    rejectedItems === 0 &&
    unknownEnumValues === 0 &&
    errors.length === 0;
  const anyCollectionAvailable = collections.some(
    (collection) => collection.complete || collection.examinedItems > 0,
  );
  const unavailable =
    items.length === 0 &&
    !complete &&
    !anyCollectionAvailable &&
    errors.length > 0;

  return {
    completeness: unavailable ? 'unavailable' : complete ? 'complete' : 'partial',
    at,
    items,
    basis: cap(
      `Claude Code/Cowork account metadata API returned ${items.length} session rows across ${
        bootstrap.organizationIds.length
      } organization(s) (${completedCollections}/${expectedCollections} active-plus-paused/archived buckets complete)`,
      500,
    ),
    ...(rejectedItems > 0 ? { rejectedItems } : {}),
    ...(unknownEnumValues > 0 ? { unknownEnumValues } : {}),
    ...(errors.length > 0 ? { error: cap(errors.join('; '), 500) } : {}),
  };
}

async function collectClaudeBootstrap(fetchImpl: PageFetch): Promise<ClaudeBootstrap> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let payload: unknown;
  try {
    const response = await fetchImpl(CLAUDE_BOOTSTRAP_ENDPOINT, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Claude bootstrap HTTP ${response.status}`);
    payload = await response.json();
  } finally {
    clearTimeout(timeout);
  }

  return parseClaudeBootstrap(payload);
}

function parseClaudeBootstrap(value: unknown): ClaudeBootstrap {
  if (!isRecord(value)) throw new Error('Claude bootstrap response is not an object');
  const rawResolvedOrganizationId = value['resolved_org_uuid'];
  const resolvedOrganizationId =
    rawResolvedOrganizationId === undefined || rawResolvedOrganizationId === null
      ? undefined
      : claudeUuid(rawResolvedOrganizationId);
  if (
    rawResolvedOrganizationId !== undefined &&
    rawResolvedOrganizationId !== null &&
    !resolvedOrganizationId
  ) {
    throw new Error('Claude bootstrap resolved organization is invalid');
  }

  const account = value['account'];
  if (!isRecord(account) || account['is_verified'] !== true) {
    throw new Error('Claude bootstrap account is not verified');
  }
  const memberships = account['memberships'];
  if (!Array.isArray(memberships) || memberships.length > 1_000) {
    throw new Error('Claude bootstrap memberships are invalid');
  }

  const chatOrganizations: string[] = [];
  const allOrganizations = new Set<string>();
  for (const membership of memberships) {
    if (!isRecord(membership) || !isRecord(membership['organization'])) {
      throw new Error('Claude bootstrap membership is invalid');
    }
    const organization = membership['organization'];
    const organizationId = claudeUuid(organization['uuid']);
    if (!organizationId) {
      throw new Error('Claude bootstrap membership organization is invalid');
    }
    const capabilities = organization['capabilities'];
    if (
      capabilities !== undefined &&
      (!Array.isArray(capabilities) ||
        capabilities.length > 1_000 ||
        !capabilities.every((capability) => typeof capability === 'string'))
    ) {
      throw new Error('Claude bootstrap organization capabilities are invalid');
    }
    allOrganizations.add(organizationId);
    if (Array.isArray(capabilities) && capabilities.includes('chat')) {
      chatOrganizations.push(organizationId);
    }
  }

  if (chatOrganizations.length === 0) {
    throw new Error('Claude bootstrap has no chat-capable memberships');
  }
  if (
    resolvedOrganizationId !== undefined &&
    !allOrganizations.has(resolvedOrganizationId)
  ) {
    throw new Error('Claude bootstrap resolved organization is not a membership');
  }
  if (
    resolvedOrganizationId !== undefined &&
    !chatOrganizations.includes(resolvedOrganizationId)
  ) {
    throw new Error('Claude bootstrap resolved organization is not chat-capable');
  }

  return {
    organizationIds: [
      ...(resolvedOrganizationId ? [resolvedOrganizationId] : []),
      ...chatOrganizations.filter(
        (organizationId) => organizationId !== resolvedOrganizationId,
      ),
    ].filter(
      (organizationId, index, all) => all.indexOf(organizationId) === index,
    ),
  };
}

async function collectClaudeAgentPages(
  fetchImpl: PageFetch,
  organizationId: string,
  collectionOrdinal: number,
  archived: boolean,
  maxItems: number,
): Promise<ClaudeAgentPageCollection> {
  const collected: ClaudeAgentInventoryItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let examinedItems = 0;
  let rejectedItems = 0;
  let unknownEnumValues = 0;
  const label = `Claude Code/Cowork organization ${collectionOrdinal} ${
    archived ? 'archived' : 'active-plus-paused'
  } sessions`;

  try {
    while (examinedItems < maxItems) {
      const params = new URLSearchParams();
      if (archived) {
        params.append('statuses', 'archived');
      } else {
        params.append('statuses', 'active');
        params.append('statuses', 'paused');
      }
      params.set('limit', String(CLAUDE_AGENT_PAGE_SIZE));
      if (cursor) params.set('cursor', cursor);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let payload: unknown;
      try {
        const response = await fetchImpl(`/v1/code/sessions?${params.toString()}`, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            ...CLAUDE_AGENT_HEADERS,
            'x-organization-uuid': organizationId,
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
        payload = await response.json();
      } finally {
        clearTimeout(timeout);
      }

      const page = parseClaudeAgentPage(payload);
      const remaining = maxItems - examinedItems;
      const rawSlice = page.items.slice(0, remaining);
      for (const rawItem of rawSlice) {
        const projected = projectClaudeAgentSession(rawItem, archived);
        unknownEnumValues += projected.unknownEnumValues;
        if (projected.item) collected.push(projected.item);
        else rejectedItems += 1;
      }
      examinedItems += rawSlice.length;

      if (rawSlice.length < page.items.length) {
        return {
          items: collected,
          examinedItems,
          rejectedItems,
          unknownEnumValues,
          complete: false,
          error: `inventory cap ${maxItems} reached before ${label} completed`,
        };
      }
      if (!page.nextCursor) {
        return {
          items: collected,
          examinedItems,
          rejectedItems,
          unknownEnumValues,
          complete: rejectedItems === 0 && unknownEnumValues === 0,
        };
      }
      if (page.items.length === 0) {
        throw new Error(`${label} returned a cursor with an empty page`);
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error(`${label} returned a repeated pagination cursor`);
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
      if (examinedItems >= maxItems) {
        return {
          items: collected,
          examinedItems,
          rejectedItems,
          unknownEnumValues,
          complete: false,
          error: `inventory cap ${maxItems} reached before ${label} completed`,
        };
      }
    }

    return {
      items: collected,
      examinedItems,
      rejectedItems,
      unknownEnumValues,
      complete: false,
      error: `inventory cap ${maxItems} reached before ${label} completed`,
    };
  } catch (error) {
    return {
      items: collected,
      examinedItems,
      rejectedItems,
      unknownEnumValues,
      complete: false,
      error: cap(error instanceof Error ? error.message : String(error), 300),
    };
  }
}

function parseClaudeAgentPage(
  value: unknown,
): { items: unknown[]; nextCursor?: string } {
  if (!isRecord(value)) {
    throw new Error('Claude Code/Cowork session response is not an object');
  }
  const items = value['data'];
  if (!Array.isArray(items)) {
    throw new Error('Claude Code/Cowork session response data is not an array');
  }
  if (items.length > CLAUDE_AGENT_PAGE_SIZE) {
    throw new Error(
      'Claude Code/Cowork session response exceeded the requested page size',
    );
  }
  const rawCursor = value['next_cursor'];
  if (
    rawCursor !== undefined &&
    rawCursor !== null &&
    (typeof rawCursor !== 'string' ||
      rawCursor.length === 0 ||
      rawCursor.length > 4_096)
  ) {
    throw new Error('Claude Code/Cowork session response cursor is invalid');
  }
  return {
    items,
    ...(typeof rawCursor === 'string' ? { nextCursor: rawCursor } : {}),
  };
}

/**
 * Mirror Claude's first-party raw -> display-session mapping, but project only
 * controlled metadata. Unknown enums are counted and omitted rather than
 * copied or guessed.
 */
export function projectClaudeAgentSession(
  value: unknown,
  expectedArchived: boolean,
): ClaudeAgentProjection {
  if (!isRecord(value)) return { unknownEnumValues: 0 };

  const rawId = typeof value['id'] === 'string' ? value['id'].trim() : '';
  if (!CLAUDE_AGENT_ID_PATTERN.test(rawId) || rawId.length > 512) {
    return { unknownEnumValues: 0 };
  }
  const sessionId = rawId.replace(/^cse_/u, 'session_');

  const titleResult = optionalTitle(value['title']);
  if (!titleResult.valid) return { unknownEnumValues: 0 };
  const createdResult = optionalTimestamp(value['created_at']);
  if (!createdResult.valid) return { unknownEnumValues: 0 };
  const updatedResult = optionalTimestamp(
    value['last_event_at'] ?? value['updated_at'] ?? value['created_at'],
  );
  if (!updatedResult.valid) return { unknownEnumValues: 0 };
  if (
    value['unread'] !== undefined &&
    value['unread'] !== null &&
    typeof value['unread'] !== 'boolean'
  ) {
    return { unknownEnumValues: 0 };
  }

  const configValue = value['config'];
  if (
    configValue !== undefined &&
    configValue !== null &&
    !isRecord(configValue)
  ) {
    return { unknownEnumValues: 0 };
  }
  const config = isRecord(configValue) ? configValue : {};

  let unknownEnumValues = 0;
  const status = controlledEnum(
    value['status'],
    ['active', 'paused', 'failed', 'archived'],
    [],
  );
  unknownEnumValues += status.unknown;
  const workerStatus = controlledEnum(
    value['worker_status'],
    ['running', 'idle', 'requires_action'],
    ['WORKER_STATUS_UNSPECIFIED'],
  );
  unknownEnumValues += workerStatus.unknown;
  const connectionStatus = controlledEnum(
    value['connection_status'],
    ['connected', 'disconnected'],
    ['CONNECTION_STATUS_UNSPECIFIED'],
  );
  unknownEnumValues += connectionStatus.unknown;
  const environmentKind = controlledEnum(
    value['environment_kind'],
    ['bridge', 'anthropic_cloud'],
    ['ENVIRONMENT_KIND_UNSPECIFIED'],
  );
  unknownEnumValues += environmentKind.unknown;
  const origin = controlledEnum(
    config['origin'],
    ['claude_code_cli', 'desktop_app', 'web_claude_ai', 'ios', 'android'],
    [],
  );
  unknownEnumValues += origin.unknown;

  const summaryResult = claudeAgentStatusCategory(value);
  if (!summaryResult.valid) return { unknownEnumValues };
  unknownEnumValues += summaryResult.unknown;

  if (
    (expectedArchived && status.value !== 'archived') ||
    (!expectedArchived && status.value === 'archived')
  ) {
    return { unknownEnumValues };
  }

  const sessionStatus = claudeAgentSessionStatus(
    status.value,
    workerStatus.value,
    connectionStatus.value,
  );
  return {
    unknownEnumValues,
    item: {
      sessionId,
      ...(titleResult.value ? { title: titleResult.value } : {}),
      url: `https://claude.ai/cowork/${encodeURIComponent(sessionId)}`,
      ...(createdResult.value !== undefined
        ? { createdAt: createdResult.value }
        : {}),
      ...(updatedResult.value !== undefined
        ? { updatedAt: updatedResult.value }
        : {}),
      sessionStatus,
      ...(workerStatus.value ? { workerStatus: workerStatus.value } : {}),
      ...(connectionStatus.value
        ? { connectionStatus: connectionStatus.value }
        : {}),
      ...(environmentKind.value
        ? { environmentKind: environmentKind.value }
        : {}),
      ...(origin.value ? { origin: origin.value } : {}),
      ...(typeof value['unread'] === 'boolean'
        ? { unread: value['unread'] }
        : {}),
      ...(summaryResult.value
        ? { statusCategory: summaryResult.value }
        : {}),
      archived: expectedArchived,
    },
  };
}

function claudeAgentSessionStatus(
  status: string | undefined,
  workerStatus: string | undefined,
  connectionStatus: string | undefined,
): ClaudeAgentInventoryItem['sessionStatus'] {
  switch (status) {
    case 'archived':
      return 'archived';
    case 'paused':
      return 'paused';
    case 'failed':
      return 'idle';
    case 'active':
    case undefined:
      if (!workerStatus) return 'pending';
      if (workerStatus === 'running') {
        return connectionStatus === 'disconnected' ? 'idle' : 'running';
      }
      return workerStatus === 'requires_action' ? 'requires_action' : 'idle';
    default:
      return 'pending';
  }
}

function claudeAgentStatusCategory(value: Record<string, unknown>): {
  valid: boolean;
  value?: ClaudeAgentInventoryItem['statusCategory'];
  unknown: number;
} {
  const external = value['external_metadata'];
  if (external !== undefined && external !== null && !isRecord(external)) {
    return { valid: false, unknown: 0 };
  }
  const rawSummary =
    value['post_turn_summary'] ??
    (isRecord(external) ? external['post_turn_summary'] : undefined);
  if (
    rawSummary !== undefined &&
    rawSummary !== null &&
    !isRecord(rawSummary)
  ) {
    return { valid: false, unknown: 0 };
  }
  const rawCategory = isRecord(rawSummary)
    ? rawSummary['status_category']
    : undefined;
  const category = controlledEnum(
    rawCategory,
    ['need_input', 'blocked', 'failed', 'review_ready'],
    [],
  );
  return {
    valid: true,
    ...(category.value
      ? {
          value:
            category.value as ClaudeAgentInventoryItem['statusCategory'],
        }
      : {}),
    unknown: category.unknown,
  };
}

function controlledEnum<const Allowed extends readonly string[]>(
  value: unknown,
  allowed: Allowed,
  unspecified: readonly string[],
): { value?: Allowed[number]; unknown: number } {
  if (value === undefined || value === null) return { unknown: 0 };
  if (typeof value !== 'string') return { unknown: 1 };
  if (unspecified.includes(value)) return { unknown: 0 };
  if (allowed.includes(value)) return { value, unknown: 0 };
  return { unknown: 1 };
}

function optionalTitle(value: unknown): {
  valid: boolean;
  value?: string;
} {
  if (value === undefined || value === null) return { valid: true };
  if (typeof value !== 'string') return { valid: false };
  const title = cleanTitle(value);
  return { valid: true, ...(title ? { value: title } : {}) };
}

function optionalTimestamp(value: unknown): {
  valid: boolean;
  value?: number;
} {
  if (value === undefined || value === null || value === '') {
    return { valid: true };
  }
  const parsed = timestamp(value);
  return parsed === undefined
    ? { valid: false }
    : { valid: true, value: parsed };
}

function preferClaudeAgentItem(
  current: ClaudeAgentInventoryItem | undefined,
  incoming: ClaudeAgentInventoryItem,
): ClaudeAgentInventoryItem {
  if (!current) return incoming;
  const incomingNewer =
    (incoming.updatedAt ?? incoming.createdAt ?? -1) >=
    (current.updatedAt ?? current.createdAt ?? -1);
  const primary = incomingNewer ? incoming : current;
  const secondary = incomingNewer ? current : incoming;
  return {
    ...secondary,
    ...primary,
    title: primary.title ?? secondary.title,
    url: primary.url,
    archived: primary.archived,
  };
}

async function collectClaudePages(
  fetchImpl: PageFetch,
  organizationId: string,
  collectionOrdinal: number,
  starred: boolean,
  maxItems: number,
): Promise<PageCollection> {
  const collected: WebInventoryItem[] = [];
  let offset = 0;
  let examinedItems = 0;
  let rejectedItems = 0;
  const label = `Claude organization ${collectionOrdinal} ${
    starred ? 'starred' : 'non-starred'
  } history`;

  try {
    while (examinedItems < maxItems) {
      const endpoint = `/api/organizations/${encodeURIComponent(
        organizationId,
      )}/chat_conversations_v2?limit=${CLAUDE_PAGE_SIZE}&offset=${offset}&starred=${String(
        starred,
      )}&consistency=strong`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let pagePayload: unknown;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
        pagePayload = await response.json();
      } finally {
        clearTimeout(timeout);
      }

      const page = parseClaudePage(pagePayload);
      const remaining = maxItems - examinedItems;
      const rawSlice = page.items.slice(0, remaining);
      for (const rawItem of rawSlice) {
        const item = projectClaudeConversation(rawItem, starred);
        if (item) collected.push(item);
        else rejectedItems += 1;
      }
      examinedItems += rawSlice.length;

      if (rawSlice.length < page.items.length) {
        return {
          items: collected,
          examinedItems,
          rejectedItems,
          complete: false,
          error: `inventory cap ${maxItems} reached before ${label} completed`,
        };
      }
      if (!page.hasMore) {
        return {
          items: collected,
          examinedItems,
          rejectedItems,
          complete: rejectedItems === 0,
        };
      }
      if (page.items.length === 0) {
        throw new Error(`${label} returned has_more=true with an empty page`);
      }
      if (examinedItems >= maxItems) {
        return {
          items: collected,
          examinedItems,
          rejectedItems,
          complete: false,
          error: `inventory cap ${maxItems} reached before ${label} completed`,
        };
      }
      offset += CLAUDE_PAGE_SIZE;
    }

    return {
      items: collected,
      examinedItems,
      rejectedItems,
      complete: false,
      error: `inventory cap ${maxItems} reached before ${label} completed`,
    };
  } catch (error) {
    return {
      items: collected,
      examinedItems,
      rejectedItems,
      complete: false,
      error: cap(error instanceof Error ? error.message : String(error), 300),
    };
  }
}

function parseClaudePage(
  value: unknown,
): { items: unknown[]; hasMore: boolean } {
  if (!isRecord(value)) throw new Error('Claude history response is not an object');
  const items = value['data'];
  const hasMore = value['has_more'];
  if (!Array.isArray(items)) {
    throw new Error('Claude history response data is not an array');
  }
  if (items.length > CLAUDE_PAGE_SIZE) {
    throw new Error('Claude history response exceeded the requested page size');
  }
  if (typeof hasMore !== 'boolean') {
    throw new Error('Claude history response has_more is invalid');
  }
  return { items, hasMore };
}

/**
 * Claude's list response deliberately includes a generated `summary`. The
 * collector validates its primitive shape and drops it. Unexpected
 * message-bearing structures reject the row entirely.
 */
export function projectClaudeConversation(
  value: unknown,
  expectedStarred: boolean,
): WebInventoryItem | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of [
    'mapping',
    'messages',
    'message',
    'matched_snippet',
    'snippet',
    'prompt',
    'response',
    'content',
  ]) {
    if (value[key] !== null && value[key] !== undefined) return undefined;
  }
  if (
    value['summary'] !== undefined &&
    value['summary'] !== null &&
    typeof value['summary'] !== 'string'
  ) {
    return undefined;
  }

  const id = claudeUuid(value['uuid']);
  if (!id) return undefined;

  const starred = value['is_starred'];
  if (typeof starred === 'boolean' && starred !== expectedStarred) return undefined;
  if (starred !== undefined && starred !== null && typeof starred !== 'boolean') {
    return undefined;
  }

  const title =
    typeof value['name'] === 'string'
      ? cleanTitle(value['name'])
      : value['name'] === null || value['name'] === undefined
        ? undefined
        : null;
  if (title === null) return undefined;

  const updatedAt =
    timestamp(value['updated_at']) ?? timestamp(value['created_at']);

  return {
    conversationId: id,
    ...(title ? { title } : {}),
    url: `https://claude.ai/chat/${encodeURIComponent(id)}`,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    archived: false,
  };
}

async function collectPages(
  fetchImpl: PageFetch,
  archived: boolean,
  pageSize: number,
  maxItems: number,
): Promise<PageCollection> {
  const collected: WebInventoryItem[] = [];
  let offset = 0;
  let advertisedTotal: number | undefined;
  let examinedItems = 0;
  let rejectedItems = 0;

  try {
    while (examinedItems < maxItems) {
      const endpoint = `/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated&is_archived=${String(
        archived,
      )}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let pagePayload: unknown;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            `${archived ? 'archived' : 'active'} history HTTP ${response.status}`,
          );
        }
        pagePayload = await response.json();
      } finally {
        clearTimeout(timeout);
      }

      const page = parsePage(pagePayload, offset);
      if (advertisedTotal === undefined) {
        advertisedTotal = page.total;
      } else if (advertisedTotal !== page.total) {
        throw new Error(
          `${archived ? 'archived' : 'active'} history total changed during pagination`,
        );
      }

      const remaining = maxItems - examinedItems;
      const rawSlice = page.items.slice(0, remaining);
      for (const rawItem of rawSlice) {
        const item = projectConversation(rawItem, archived);
        if (item) collected.push(item);
        else rejectedItems += 1;
      }
      examinedItems += rawSlice.length;

      const nextOffset = offset + page.items.length;
      if (nextOffset >= page.total) {
        return {
          items: collected,
          total: page.total,
          examinedItems,
          rejectedItems,
          complete: rejectedItems === 0,
        };
      }
      if (page.items.length === 0 || nextOffset <= offset) {
        throw new Error(
          `${archived ? 'archived' : 'active'} history pagination stopped before total`,
        );
      }
      if (rawSlice.length < page.items.length || examinedItems >= maxItems) {
        return {
          items: collected,
          total: page.total,
          examinedItems,
          rejectedItems,
          complete: false,
          error: `inventory cap ${maxItems} reached before ${
            archived ? 'archived' : 'active'
          } history completed`,
        };
      }
      offset = nextOffset;
    }

    return {
      items: collected,
      ...(advertisedTotal !== undefined ? { total: advertisedTotal } : {}),
      examinedItems,
      rejectedItems,
      complete: advertisedTotal !== undefined && offset >= advertisedTotal,
      error: `inventory cap ${maxItems} reached`,
    };
  } catch (error) {
    return {
      items: collected,
      ...(advertisedTotal !== undefined ? { total: advertisedTotal } : {}),
      examinedItems,
      rejectedItems,
      complete: false,
      error: cap(error instanceof Error ? error.message : String(error), 300),
    };
  }
}

function parsePage(
  value: unknown,
  expectedOffset: number,
): { items: unknown[]; total: number } {
  if (!isRecord(value)) throw new Error('history response is not an object');
  const items = value['items'];
  const total = value['total'];
  const offset = value['offset'];
  const limit = value['limit'];
  if (!Array.isArray(items)) throw new Error('history response items is not an array');
  if (!isNonnegativeInteger(total)) throw new Error('history response total is invalid');
  if (!isNonnegativeInteger(offset) || offset !== expectedOffset) {
    throw new Error('history response offset is invalid');
  }
  if (!isNonnegativeInteger(limit) || limit === 0) {
    throw new Error('history response limit is invalid');
  }
  return { items, total };
}

/**
 * Strict field projection. Presence of a non-null content-bearing field rejects
 * the whole row instead of accidentally broadening the product boundary.
 */
export function projectConversation(
  value: unknown,
  expectedArchived: boolean,
): WebInventoryItem | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of [
    'mapping',
    'messages',
    'message',
    'snippet',
    'prompt',
    'response',
    'content',
  ]) {
    if (value[key] !== null && value[key] !== undefined) return undefined;
  }

  const id = typeof value['id'] === 'string' ? value['id'].trim() : '';
  if (!id || id.length > 512) return undefined;

  const archived = value['is_archived'];
  if (typeof archived === 'boolean' && archived !== expectedArchived) return undefined;
  if (archived !== undefined && archived !== null && typeof archived !== 'boolean') {
    return undefined;
  }

  const title =
    typeof value['title'] === 'string'
      ? cleanTitle(value['title'])
      : value['title'] === null || value['title'] === undefined
        ? undefined
        : null;
  if (title === null) return undefined;

  const updatedAt =
    timestamp(value['update_time']) ?? timestamp(value['create_time']);
  const asyncStatus = value['async_status'];
  const verifiedAsyncStatus =
    isNonnegativeInteger(asyncStatus) && asyncStatus >= 1 && asyncStatus <= 7
      ? asyncStatus
      : undefined;
  if (
    asyncStatus !== undefined &&
    asyncStatus !== null &&
    verifiedAsyncStatus === undefined
  ) {
    return undefined;
  }

  return {
    conversationId: id,
    ...(title ? { title } : {}),
    url: `https://chatgpt.com/c/${encodeURIComponent(id)}`,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    archived: expectedArchived,
    ...(verifiedAsyncStatus !== undefined
      ? { asyncStatus: verifiedAsyncStatus }
      : {}),
  };
}

function preferInventoryItem(
  current: WebInventoryItem | undefined,
  incoming: WebInventoryItem,
): WebInventoryItem {
  if (!current) return incoming;
  const incomingNewer = (incoming.updatedAt ?? -1) >= (current.updatedAt ?? -1);
  return {
    conversationId: current.conversationId,
    title: incoming.title ?? current.title,
    url: incoming.url || current.url,
    ...(Math.max(incoming.updatedAt ?? -1, current.updatedAt ?? -1) >= 0
      ? {
          updatedAt: Math.max(incoming.updatedAt ?? -1, current.updatedAt ?? -1),
        }
      : {}),
    archived: incomingNewer
      ? (incoming.archived ?? current.archived)
      : (current.archived ?? incoming.archived),
    ...(incoming.asyncStatus !== undefined
      ? { asyncStatus: incoming.asyncStatus }
      : current.asyncStatus !== undefined
        ? { asyncStatus: current.asyncStatus }
        : {}),
  };
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return Math.round(milliseconds);
  }
  if (typeof value === 'string' && value.length <= 100) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
  }
  return undefined;
}

function claudeUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return UUID_PATTERN.test(id) ? id.toLowerCase() : undefined;
}

function cleanTitle(value: string): string | undefined {
  const title = value
    .replace(/[\uE000-\uF8FF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return undefined;
  return cap(title, 160);
}

function describeCollection(collection: PageCollection): string {
  if (collection.total !== undefined) {
    return `${collection.items.length}/${collection.total}${
      collection.complete ? ' complete' : ' partial'
    }`;
  }
  return collection.complete ? `${collection.items.length} complete` : 'unavailable';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
