import { hostname } from 'node:os';
import type {
  SignalName,
  Source,
  WebConversation,
  WebReport,
  WebReportResponse,
  WebSite,
} from '@session-radar/shared';
import {
  WEB_SITE_PROVIDERS,
  canonicalKey,
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

    // Record the heartbeat FIRST, so even a report we cannot use keeps coverage
    // alive — the extension is demonstrably running.
    connector.noteReport({
      at: receivedAt,
      observedConversations: report.conversations.length,
      selectorsVersion: report.selectors.selectorsVersion,
      missingAnchors: report.selectors.missing,
      ...(report.extensionVersion ? { extensionVersion: report.extensionVersion } : {}),
    });

    for (const conversation of report.conversations) {
      this.ingestConversation(report.site, conversation, receivedAt);
    }

    for (const conversationId of report.closed ?? []) {
      this.ingestClosed(report.site, conversationId, receivedAt);
    }

    const warning =
      report.selectors.missing.length > 0
        ? `missing anchors: ${report.selectors.missing.join(', ')}`
        : undefined;

    return {
      accepted: true,
      observed: report.conversations.length,
      ...(warning ? { warning } : {}),
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
