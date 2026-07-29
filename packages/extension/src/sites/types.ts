import type {
  SelectorHealth,
  WebBlockReason,
  WebConversationState,
  WebInventoryItem,
  WebSite,
} from '@session-radar/shared';

/**
 * A site adapter.
 *
 * Everything site-specific lives behind this interface, in ONE file per site, so
 * when claude.ai reshuffles its DOM there is exactly one place to fix and one
 * version number to bump.
 */
export interface SiteAdapter {
  readonly site: WebSite;
  /** Bump on every selector change. Reported to the daemon and shown in coverage. */
  readonly selectorsVersion: string;
  /** Does this adapter own the site, including list/new-chat pages? */
  owns(url: string): boolean;
  /** Does this adapter handle the current location? */
  matches(url: string): boolean;
  /** Discover metadata-only conversation links currently rendered in the DOM. */
  discover(doc: Document, url: string): SiteInventoryDiscovery;
  /** Read the current conversation state from the DOM. */
  detect(doc: Document, url: string): SiteObservation;
  /**
   * Check that the anchors this adapter depends on still exist.
   *
   * This is the honest core of the whole web collector. When selectors rot, the
   * naive failure mode is to report "no conversations" or "completed" — a
   * confident lie. The self-test turns that into visible degraded coverage.
   */
  selfTest(doc: Document): SelectorHealth;
}

export interface SiteObservation {
  state: WebConversationState;
  blockReason?: WebBlockReason;
  title?: string;
  /** Why the adapter concluded what it did — surfaced in evidence. */
  basis: string;
}

export interface SiteInventoryDiscovery {
  items: WebInventoryItem[];
  /** Why this inventory is necessarily partial. */
  basis: string;
}

/** An anchor the adapter needs in order to read state at all. */
export interface Anchor {
  name: string;
  /** Any match counts as present. Multiple selectors tolerate minor reshuffles. */
  selectors: string[];
  /**
   * Anchors that only exist in some states (a stop button appears only while
   * generating) cannot prove rot by their absence, so they are excluded from the
   * missing-anchor signal.
   */
  transient?: boolean;
}

export function firstMatch(doc: Document, selectors: string[]): Element | null {
  for (const selector of selectors) {
    try {
      const found = doc.querySelector(selector);
      if (found) return found;
    } catch {
      // An invalid selector is a bug in the adapter, not a page problem.
      continue;
    }
  }
  return null;
}

export function anyMatch(doc: Document, selectors: string[]): boolean {
  return firstMatch(doc, selectors) !== null;
}

/** Runs the anchor list and reports which structural anchors are missing. */
export function runSelfTest(
  doc: Document,
  selectorsVersion: string,
  anchors: Anchor[],
): SelectorHealth {
  const found: string[] = [];
  const missing: string[] = [];
  for (const anchor of anchors) {
    if (anyMatch(doc, anchor.selectors)) found.push(anchor.name);
    else if (!anchor.transient) missing.push(anchor.name);
  }
  return { selectorsVersion, found, missing };
}

/** Text content of the first matching element, trimmed and capped. */
export function textOf(doc: Document, selectors: string[], maxChars = 120): string | undefined {
  const element = firstMatch(doc, selectors);
  const text = element?.textContent?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1);
}

/** List titles only: normalize UI glyphs/whitespace and enforce the wire cap. */
export function cleanInventoryTitle(
  value: string | null | undefined,
  maxChars = 160,
): string | undefined {
  const text = value
    ?.replace(/[\uE000-\uF8FF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/** Strip query/hash tracking while retaining the exact source-native path. */
export function stableInventoryUrl(raw: string, base: string): string | undefined {
  try {
    const parsed = new URL(raw, base);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}
