import { hostname } from 'node:os';
import type {
  ClaudeAgentInventory,
  SignalName,
  Source,
  WebConversation,
  WebInventory,
  WebInventoryCompleteness,
  WebInventoryItem,
  WebInventoryScope,
  WebReport,
  WebReportResponse,
  WebSite,
} from '@session-radar/shared';
import {
  DEFAULT_HISTORY_WINDOW_MS,
  WEB_SITE_PROVIDERS,
  canonicalKey,
  conversationIdFromUrl,
  deriveTitle,
  fallbackLabel,
  webConversationUrl,
  webReportSchema,
} from '@session-radar/shared';
import type { StatusEngine } from '../../engine.js';
import type { StoredObservation } from '../../store.js';
import type { WebSurfaceConnector } from './connector.js';

export interface WebIngestDeps {
  engine: StatusEngine;
  connectors: Map<WebSite, WebSurfaceConnector>;
  onClaudeAgentInventory?: (
    inventory: ClaudeAgentInventory,
    receivedAt: number,
  ) => void;
  device?: string;
}

/**
 * Handles reports from the browser extension.
 *
 * The extension says what it SAW; this maps observations to signals and lets the
 * status engine decide. A conversation seen here merges with any CLI or desktop
 * sighting of the same id, because the canonical key is `(provider, conversationId)`
 * regardless of which surface noticed it.
 */
export class WebIngest {
  private readonly device: string;
  private readonly lastInventory = new Map<
    string,
    {
      stamp: string;
      asyncStatus: number | undefined;
      accountObserved: boolean;
    }
  >();

  constructor(private readonly deps: WebIngestDeps) {
    this.device = deps.device ?? hostname();
  }

  handle(payload: unknown, receivedAt: number): WebReportResponse {
    const parsed = webReportSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        accepted: false,
        observed: 0,
        warning: `unparseable extension report: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      };
    }

    const report: WebReport = parsed.data;
    const connector = this.deps.connectors.get(report.site);
    if (!connector) {
      return { accepted: false, observed: 0, warning: `unknown site ${report.site}` };
    }

    const inventory = mergeInventories(report.site, report.inventories ?? []);
    const coverage = inventoryCoverage(report, inventory, receivedAt);

    // Record the heartbeat FIRST, so even a report we cannot use keeps coverage
    // alive — the extension is demonstrably running.
    connector.noteReport({
      at: receivedAt,
      observedSessionCount: coverage.observedSessionCount,
      archivedSessionCount: coverage.archivedSessionCount,
      selectorsVersion: report.selectors.selectorsVersion,
      missingAnchors: report.selectors.missing,
      ...(report.extensionVersion ? { extensionVersion: report.extensionVersion } : {}),
      inventoryCompleteness: coverage.completeness,
      inventoryScopes: coverage.scopes,
      inventoryBasis: coverage.basis,
      inventoryErrors: coverage.errors,
      ...(coverage.accountInventoryAt !== undefined
        ? { accountInventoryAt: coverage.accountInventoryAt }
        : {}),
      untimedInventoryCount: coverage.untimedInventoryCount,
      unknownLifecycleCount: coverage.unknownLifecycleCount,
      rejectedInventoryCount: coverage.rejectedInventoryCount,
    });
    if (report.site === 'claude-web' && report.claudeAgentInventory) {
      this.deps.onClaudeAgentInventory?.(
        report.claudeAgentInventory,
        receivedAt,
      );
    }

    // Live/closed state is ingested first. Inventory carries source timestamps,
    // so it cannot override newer lifecycle evidence, while its archive flag is
    // the last (and more authoritative) source-ref update in this report.
    for (const conversation of report.conversations) {
      this.ingestConversation(report.site, conversation, receivedAt);
    }

    for (const conversationId of report.closed ?? []) {
      this.ingestClosed(report.site, conversationId, receivedAt);
    }

    for (const item of inventory.items) {
      this.ingestInventory(report.site, item, receivedAt);
    }

    const warnings: string[] = [];
    if (report.selectors.missing.length > 0) {
      warnings.push(`missing anchors: ${report.selectors.missing.join(', ')}`);
    }
    if (coverage.completeness !== 'complete') {
      warnings.push(`history inventory ${coverage.completeness}`);
    }

    return {
      accepted: true,
      observed: coverage.observedSessionCount + coverage.archivedSessionCount,
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    };
  }

  private ingestConversation(site: WebSite, conversation: WebConversation, at: number): void {
    const signal = signalForState(conversation.state);
    if (!signal) return; // 'unknown' tells us nothing; recording it would be noise.

    const provider = WEB_SITE_PROVIDERS[site];
    const source: Source = {
      id: site,
      provider,
      surface: 'extension',
      device: this.device,
    };

    const observations: StoredObservation[] = [
      {
        signal,
        // Trust the page's timestamp, but never let a skewed clock place an
        // observation in the future.
        at: Math.min(conversation.at, at),
        raw: {
          state: conversation.state,
          ...(conversation.blockReason ? { blockReason: conversation.blockReason } : {}),
        },
        connectorId: site,
        surface: 'extension',
      },
      // The tab being open is liveness, not progress — same rule as the CLI.
      { signal: 'web.tab_open', at, connectorId: site, surface: 'extension' },
    ];

    const url = conversation.url ?? webConversationUrl(site, conversation.conversationId);

    this.deps.engine.observe({
      identity: canonicalKey(provider, conversation.conversationId),
      provider,
      surface: 'extension',
      title: conversation.title ? deriveTitle(conversation.title, { fallback: '' }) : '',
      titlePriority: conversation.title ? 25 : 0,
      fallbackTitle: fallbackLabel(undefined, conversation.conversationId),
      source,
      externalId: conversation.conversationId,
      context: { conversationId: conversation.conversationId, url },
      url,
      observations,
      connectorId: site,
    });
  }

  private ingestClosed(site: WebSite, conversationId: string, at: number): void {
    const provider = WEB_SITE_PROVIDERS[site];
    this.deps.engine.observe({
      identity: canonicalKey(provider, conversationId),
      provider,
      surface: 'extension',
      title: '',
      fallbackTitle: fallbackLabel(undefined, conversationId),
      source: { id: site, provider, surface: 'extension', device: this.device },
      externalId: conversationId,
      context: { conversationId, url: webConversationUrl(site, conversationId) },
      url: webConversationUrl(site, conversationId),
      observations: [
        { signal: 'web.tab_closed', at, connectorId: site, surface: 'extension' },
      ],
      connectorId: site,
    });
  }

  private ingestInventory(
    site: WebSite,
    item: InventoryCandidate,
    receivedAt: number,
  ): void {
    const activityAt =
      item.updatedAt === undefined ? 0 : Math.min(item.updatedAt, receivedAt);
    const accountObserved =
      site === 'chatgpt-web' && item.scope === 'account-api';
    const mapKey = `${site}:${item.conversationId}`;
    const stamp = [
      item.scope,
      item.completeness,
      activityAt,
      item.title ?? '',
      item.url,
      item.archived === true ? 'archived' : 'active',
      item.asyncStatus ?? '',
    ].join(':');
    const previous = this.lastInventory.get(mapKey);
    if (previous?.stamp === stamp) return;

    const lifecycleChanged =
      accountObserved &&
      previous?.accountObserved === true &&
      previous.asyncStatus !== item.asyncStatus;
    const signalAt = lifecycleChanged ? receivedAt : activityAt;
    const signal: SignalName =
      item.asyncStatus === 3 && item.scope === 'account-api'
        ? 'chatgpt.web_async_streaming'
        : item.asyncStatus === 4 && item.scope === 'account-api'
          ? 'chatgpt.web_async_unread'
          : 'web.history_seen';
    const provider = WEB_SITE_PROVIDERS[site];
    const parsedUrl = conversationIdFromUrl(item.url);
    const url =
      parsedUrl?.site === site && parsedUrl.id === item.conversationId
        ? item.url
        : webConversationUrl(site, item.conversationId);
    const title = item.title ? deriveTitle(item.title, { fallback: '' }) : '';

    this.deps.engine.observe({
      identity: canonicalKey(provider, item.conversationId),
      provider,
      surface: 'extension',
      title,
      titlePriority: title ? (item.scope === 'account-api' ? 30 : 20) : 0,
      fallbackTitle: fallbackLabel(undefined, item.conversationId),
      source: {
        id: site,
        provider,
        surface: 'extension',
        device: this.device,
      },
      externalId: item.conversationId,
      context: { conversationId: item.conversationId, url },
      url,
      sourceArchived: item.archived === true,
      observations: [
        {
          signal,
          at: signalAt,
          raw: {
            inventoryScope: item.scope,
            completeness: item.completeness,
            ...(item.asyncStatus !== undefined
              ? { asyncStatus: item.asyncStatus }
              : {}),
          },
          connectorId: site,
          surface: 'extension',
        },
      ],
      sourceActivityAt: activityAt,
      connectorId: site,
    });
    this.lastInventory.set(mapKey, {
      stamp,
      asyncStatus: item.asyncStatus,
      accountObserved,
    });
  }
}

interface InventoryCandidate extends WebInventoryItem {
  scope: WebInventoryScope;
  completeness: WebInventoryCompleteness;
}

interface MergedInventory {
  items: InventoryCandidate[];
  inventories: WebInventory[];
  invalidItems: number;
}

interface InventoryCoverage {
  observedSessionCount: number;
  archivedSessionCount: number;
  completeness: WebInventoryCompleteness | 'none';
  scopes: WebInventoryScope[];
  basis: string[];
  errors: string[];
  accountInventoryAt?: number;
  untimedInventoryCount: number;
  unknownLifecycleCount: number;
  rejectedInventoryCount: number;
}

/**
 * DOM rows from multiple tabs are deduplicated; an account API row wins field
 * authority while retaining a newer source timestamp if a rendered row has one.
 */
function mergeInventories(
  site: WebSite,
  inventories: WebInventory[],
): MergedInventory {
  const ordered = [...inventories].sort((left, right) => {
    const scopeRank =
      Number(left.scope === 'account-api') - Number(right.scope === 'account-api');
    return scopeRank !== 0 ? scopeRank : left.at - right.at;
  });
  const byId = new Map<string, InventoryCandidate>();
  let invalidItems = 0;

  for (const inventory of ordered) {
    for (const item of inventory.items) {
      const parsed = conversationIdFromUrl(item.url);
      if (parsed?.site !== site || parsed.id !== item.conversationId) {
        invalidItems += 1;
        continue;
      }
      const incoming: InventoryCandidate = {
        ...item,
        scope: inventory.scope,
        completeness: inventory.completeness,
      };
      const current = byId.get(item.conversationId);
      byId.set(item.conversationId, mergeInventoryItem(current, incoming));
    }
  }

  return { items: [...byId.values()], inventories, invalidItems };
}

function mergeInventoryItem(
  current: InventoryCandidate | undefined,
  incoming: InventoryCandidate,
): InventoryCandidate {
  if (!current) return incoming;
  const incomingAuthoritative = incoming.scope === 'account-api';
  const updatedAt = Math.max(current.updatedAt ?? -1, incoming.updatedAt ?? -1);
  const merged: InventoryCandidate = {
    conversationId: current.conversationId,
    scope: incomingAuthoritative ? incoming.scope : current.scope,
    completeness: incomingAuthoritative
      ? incoming.completeness
      : current.completeness,
    title: incoming.title ?? current.title,
    url: incomingAuthoritative ? incoming.url : current.url,
    archived: incomingAuthoritative
      ? (incoming.archived ?? current.archived)
      : (current.archived ?? incoming.archived),
  };
  if (updatedAt >= 0) merged.updatedAt = updatedAt;
  const asyncStatus = incomingAuthoritative
    ? incoming.asyncStatus
    : current.asyncStatus;
  if (asyncStatus !== undefined) merged.asyncStatus = asyncStatus;
  return merged;
}

function inventoryCoverage(
  report: WebReport,
  merged: MergedInventory,
  receivedAt: number,
): InventoryCoverage {
  const scopes = [
    ...new Set(merged.inventories.map((inventory) => inventory.scope)),
  ];
  const basis = [
    ...new Set(merged.inventories.map((inventory) => inventory.basis)),
  ];
  const errors = [
    ...new Set(
      merged.inventories
        .filter(
          (inventory): inventory is WebInventory & { error: string } =>
            typeof inventory.error === 'string' && inventory.error.length > 0,
        )
        .map((inventory) => `${inventory.scope}: ${inventory.error}`),
    ),
  ];
  const rejectedInventoryCount =
    merged.invalidItems +
    merged.inventories.reduce(
      (sum, inventory) => sum + (inventory.rejectedItems ?? 0),
      0,
    );

  const latestAccount = merged.inventories
    .filter((inventory) => inventory.scope === 'account-api')
    .sort((left, right) => right.at - left.at)[0];
  const visibleInventoryIds = new Set(
    merged.inventories
      .filter((inventory) => inventory.scope === 'visible-dom')
      .flatMap((inventory) =>
        inventory.items.map((item) => item.conversationId),
      ),
  );
  const emptyAccountContradictsPage =
    latestAccount?.completeness === 'complete' &&
    latestAccount.items.length === 0 &&
    visibleInventoryIds.size > 0;
  if (emptyAccountContradictsPage) {
    errors.push(
      `account metadata inventory claimed complete with zero rows while ${visibleInventoryIds.size} conversation(s) are visible in the page; treating account coverage as partial`,
    );
  }
  let completeness: InventoryCoverage['completeness'];
  if (
    latestAccount?.completeness === 'complete' &&
    rejectedInventoryCount === 0 &&
    !emptyAccountContradictsPage
  ) {
    completeness = 'complete';
  } else if (merged.inventories.length === 0) {
    completeness = 'none';
  } else if (
    merged.inventories.some(
      (inventory) =>
        inventory.completeness === 'partial' || inventory.items.length > 0,
    )
  ) {
    completeness = 'partial';
  } else {
    completeness = 'unavailable';
  }

  const recent = new Set(report.conversations.map((item) => item.conversationId));
  const archived = new Set<string>();
  const cutoff = receivedAt - DEFAULT_HISTORY_WINDOW_MS;
  let untimedInventoryCount = 0;
  let unknownLifecycleCount = 0;
  let futureTimestamps = 0;

  for (const item of merged.items) {
    const live = recent.has(item.conversationId);
    if (item.updatedAt === undefined) {
      if (!live) untimedInventoryCount += 1;
    } else if (item.updatedAt > receivedAt) {
      futureTimestamps += 1;
    }

    if (
      !live &&
      !(
        item.scope === 'account-api' &&
        (item.asyncStatus === 3 || item.asyncStatus === 4)
      )
    ) {
      unknownLifecycleCount += 1;
    }

    const activityAt =
      item.updatedAt === undefined ? 0 : Math.min(item.updatedAt, receivedAt);
    if (!live && (item.archived === true || activityAt < cutoff)) {
      archived.add(item.conversationId);
    } else {
      recent.add(item.conversationId);
      archived.delete(item.conversationId);
    }
  }
  if (futureTimestamps > 0) {
    errors.push(
      `${futureTimestamps} history timestamp(s) were in the future and clamped to receive time`,
    );
  }
  if (merged.invalidItems > 0) {
    errors.push(
      `${merged.invalidItems} history row(s) had a mismatched same-site id/URL and were rejected`,
    );
  }

  return {
    observedSessionCount: recent.size,
    archivedSessionCount: archived.size,
    completeness,
    scopes,
    basis,
    errors,
    ...(latestAccount ? { accountInventoryAt: latestAccount.at } : {}),
    untimedInventoryCount,
    unknownLifecycleCount,
    rejectedInventoryCount,
  };
}

/** Observed UI state -> named signal. The engine, not this, decides status. */
export function signalForState(state: WebConversation['state']): SignalName | undefined {
  switch (state) {
    case 'generating':
      return 'web.generating';
    case 'blocked':
      return 'web.blocked';
    case 'completed':
      return 'web.completed';
    case 'unknown':
      return undefined;
  }
}
