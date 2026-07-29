import type {
  PermissionState,
  WebInventoryCompleteness,
  WebInventoryScope,
  WebSite,
} from '@session-radar/shared';
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
/** A complete account snapshot must refresh often enough to still be actionable. */
export const ACCOUNT_INVENTORY_WARN_MS = 10 * 60_000;

export interface WebSurfaceState {
  lastReportAt: number | undefined;
  observedSessionCount: number;
  archivedSessionCount: number;
  selectorsVersion: string | undefined;
  missingAnchors: string[];
  extensionVersion: string | undefined;
  inventoryCompleteness: WebInventoryCompleteness | 'none';
  inventoryScopes: WebInventoryScope[];
  inventoryBasis: string[];
  inventoryErrors: string[];
  accountInventoryAt: number | undefined;
  untimedInventoryCount: number;
  unknownLifecycleCount: number;
  rejectedInventoryCount: number;
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
    observedSessionCount: 0,
    archivedSessionCount: 0,
    selectorsVersion: undefined,
    missingAnchors: [],
    extensionVersion: undefined,
    inventoryCompleteness: 'none',
    inventoryScopes: [],
    inventoryBasis: [],
    inventoryErrors: [],
    accountInventoryAt: undefined,
    untimedInventoryCount: 0,
    unknownLifecycleCount: 0,
    rejectedInventoryCount: 0,
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
    observedSessionCount: number;
    archivedSessionCount: number;
    selectorsVersion: string;
    missingAnchors: string[];
    extensionVersion?: string;
    inventoryCompleteness: WebInventoryCompleteness | 'none';
    inventoryScopes: WebInventoryScope[];
    inventoryBasis: string[];
    inventoryErrors: string[];
    accountInventoryAt?: number;
    untimedInventoryCount: number;
    unknownLifecycleCount: number;
    rejectedInventoryCount: number;
  }): void {
    this.state.lastReportAt = input.at;
    this.state.observedSessionCount = input.observedSessionCount;
    this.state.archivedSessionCount = input.archivedSessionCount;
    this.state.selectorsVersion = input.selectorsVersion;
    this.state.missingAnchors = input.missingAnchors;
    this.state.inventoryCompleteness = input.inventoryCompleteness;
    this.state.inventoryScopes = input.inventoryScopes;
    this.state.inventoryBasis = input.inventoryBasis;
    this.state.inventoryErrors = input.inventoryErrors;
    this.state.accountInventoryAt = input.accountInventoryAt;
    this.state.untimedInventoryCount = input.untimedInventoryCount;
    this.state.unknownLifecycleCount = input.unknownLifecycleCount;
    this.state.rejectedInventoryCount = input.rejectedInventoryCount;
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
    if (this.state.inventoryCompleteness === 'none') {
      const reportedVersion = this.state.extensionVersion
        ? `v${this.state.extensionVersion}`
        : 'an unknown version';
      warnings.push(
        `the extension reported ${reportedVersion} with no history inventory — reload the updated unpacked extension, then refresh the open claude.ai/chatgpt.com tabs; only old open-tab reports are currently arriving`,
      );
    } else if (this.state.inventoryCompleteness !== 'complete') {
      warnings.push(
        `web history inventory is ${this.state.inventoryCompleteness}: ${
          this.state.inventoryBasis.join(' | ') || 'no complete account list is available'
        }`,
      );
    }
    if (
      this.state.accountInventoryAt !== undefined &&
      now - this.state.accountInventoryAt > ACCOUNT_INVENTORY_WARN_MS
    ) {
      const site = this.id === 'claude-web' ? 'claude.ai' : 'chatgpt.com';
      warnings.push(
        `the account inventory snapshot is ${Math.round(
          (now - this.state.accountInventoryAt) / 60_000,
        )} minutes old; open ${site} to refresh it`,
      );
    }
    if (this.state.untimedInventoryCount > 0) {
      warnings.push(
        `${this.state.untimedInventoryCount} visible history row(s) expose no timestamp and stay outside the recent view`,
      );
    }
    if (this.state.unknownLifecycleCount > 0) {
      const strongerEvidence =
        this.id === 'chatgpt-web'
          ? 'open tabs and ChatGPT async values 3/4 provide stronger state when available'
          : 'an open Claude conversation tab provides stronger state when available';
      warnings.push(
        `${this.state.unknownLifecycleCount} history row(s) expose no verified lifecycle; ${strongerEvidence}`,
      );
    }
    if (this.state.rejectedInventoryCount > 0) {
      warnings.push(
        `${this.state.rejectedInventoryCount} history row(s) were rejected at the metadata-only boundary`,
      );
    }
    warnings.push(...this.state.inventoryErrors);

    const permissionState: PermissionState = 'granted';
    return {
      observedSessionCount: this.state.observedSessionCount,
      archivedSessionCount: this.state.archivedSessionCount,
      permissionState,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
