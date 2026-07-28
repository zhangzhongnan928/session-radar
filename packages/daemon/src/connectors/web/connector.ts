import type { PermissionState, WebSite } from '@session-radar/shared';
import { WEB_SITE_LABELS, WEB_SITE_PROVIDERS } from '@session-radar/shared';
import type { Connector, ConnectorScanResult } from '../../registry.js';
import { ConnectorDownError } from '../../registry.js';

/**
 * How long the extension may go silent before its coverage is `down`.
 *
 * The extension heartbeats every 15s, so 60s tolerates a couple of misses. The
 * acceptance criterion is that closing Chrome flips coverage within 60s.
 */
export const HEARTBEAT_TIMEOUT_MS = 60_000;
/** Past this we say "degraded" rather than waiting for the full timeout. */
export const HEARTBEAT_WARN_MS = 30_000;

export interface WebSurfaceState {
  lastReportAt: number | undefined;
  observedConversations: number;
  selectorsVersion: string | undefined;
  missingAnchors: string[];
  extensionVersion: string | undefined;
  /** Set once the extension has ever connected, so we can tell "never" from "gone". */
  everConnected: boolean;
}

/**
 * Coverage for one web surface, fed entirely by pushes from the browser
 * extension.
 *
 * There is nothing to poll — the daemon cannot see a browser tab. So `scan()`
 * asks a different question: "am I still hearing from the thing that CAN see?"
 * A silent extension is a coverage hole, and this is what turns that silence
 * into a visible incident instead of an empty list.
 */
export class WebSurfaceConnector implements Connector {
  readonly id: WebSite;
  readonly displayName: string;
  readonly provider: 'anthropic' | 'openai';
  readonly surface = 'extension' as const;
  readonly scanIntervalMs = 10_000;

  private readonly state: WebSurfaceState = {
    lastReportAt: undefined,
    observedConversations: 0,
    selectorsVersion: undefined,
    missingAnchors: [],
    extensionVersion: undefined,
    everConnected: false,
  };

  constructor(
    site: WebSite,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.id = site;
    this.displayName = WEB_SITE_LABELS[site];
    this.provider = WEB_SITE_PROVIDERS[site];
  }

  /** Called by the ingest layer when a report arrives. */
  noteReport(input: {
    at: number;
    observedConversations: number;
    selectorsVersion: string;
    missingAnchors: string[];
    extensionVersion?: string;
  }): void {
    this.state.lastReportAt = input.at;
    this.state.observedConversations = input.observedConversations;
    this.state.selectorsVersion = input.selectorsVersion;
    this.state.missingAnchors = input.missingAnchors;
    this.state.everConnected = true;
    if (input.extensionVersion) this.state.extensionVersion = input.extensionVersion;
  }

  snapshot(): Readonly<WebSurfaceState> {
    return this.state;
  }

  scan(): ConnectorScanResult {
    const now = this.now();
    const last = this.state.lastReportAt;

    if (last === undefined) {
      // Never heard from. That is not "no conversations" — it is no coverage.
      throw new ConnectorDownError(
        'the session-radar Chrome extension has never connected — load it in Chrome and open claude.ai or chatgpt.com',
      );
    }

    const silentFor = now - last;
    if (silentFor > HEARTBEAT_TIMEOUT_MS) {
      throw new ConnectorDownError(
        `no heartbeat from the Chrome extension for ${Math.round(silentFor / 1000)}s — Chrome closed, or the extension is disabled`,
      );
    }

    const warnings: string[] = [];
    if (this.state.missingAnchors.length > 0) {
      // Selector rot. Say exactly which anchors vanished: this is the message
      // that tells whoever reads it what to go and fix.
      warnings.push(
        `selectors v${this.state.selectorsVersion ?? '?'} — missing anchors: ${this.state.missingAnchors.join(', ')}. State detection is unreliable until these are updated.`,
      );
    }
    if (silentFor > HEARTBEAT_WARN_MS) {
      warnings.push(`last heartbeat ${Math.round(silentFor / 1000)}s ago`);
    }

    const permissionState: PermissionState = 'granted';
    return {
      observedSessionCount: this.state.observedConversations,
      permissionState,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
