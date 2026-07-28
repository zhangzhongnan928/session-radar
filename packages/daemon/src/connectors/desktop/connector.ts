import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '@session-radar/shared';
import type { Connector, ConnectorScanResult } from '../../registry.js';
import { ConnectorUnsupportedError } from '../../registry.js';

/**
 * Desktop app surfaces — M3.
 *
 * The verdict for both apps is `unsupported`, and that is a real finding rather
 * than a shrug. See docs/m3-desktop-feasibility.md for the investigation.
 *
 * Registering them at all is the point: an unsupported surface that appears in
 * Coverage Health with a reason is honest ("we cannot see your Claude Desktop
 * conversations, here is why"). Omitting them entirely would leave Victor to
 * discover the blind spot himself, which is the exact failure this product
 * exists to prevent.
 */
export interface DesktopSurfaceSpec {
  id: string;
  displayName: string;
  provider: Provider;
  /** Where the app is installed, used to tell "absent" from "unreadable". */
  appPath: string;
  /** Where its state lives, if installed. */
  dataDir: string;
  /** Why it cannot be observed, when it IS installed. */
  reason: string;
}

export const CLAUDE_DESKTOP: DesktopSurfaceSpec = {
  id: 'claude-desktop',
  displayName: 'Claude Desktop',
  provider: 'anthropic',
  appPath: '/Applications/Claude.app',
  dataDir: join(homedir(), 'Library', 'Application Support', 'Claude'),
  reason:
    'conversation state lives in a Chromium IndexedDB LevelDB store that the running app holds locked; reading it would mean copying the store and decoding an undocumented, version-specific format, and it still would not expose whether a conversation is blocked or finished',
};

export const CHATGPT_DESKTOP: DesktopSurfaceSpec = {
  id: 'chatgpt-desktop',
  displayName: 'ChatGPT for macOS',
  provider: 'openai',
  appPath: '/Applications/ChatGPT.app',
  dataDir: join(homedir(), 'Library', 'Application Support', 'com.openai.chat'),
  reason:
    'conversation files are encrypted at rest (per-file, no readable structure); only conversation ids and modification times are legible, which cannot distinguish running from done from blocked',
};

/**
 * Reports a desktop surface as `unsupported`, with a reason that changes
 * depending on whether the app is even installed.
 */
export class DesktopSurfaceConnector implements Connector {
  readonly id: string;
  readonly displayName: string;
  readonly provider: Provider;
  readonly surface = 'desktop' as const;
  /** Slow: this only ever re-checks whether the app appeared or vanished. */
  readonly scanIntervalMs = 10 * 60_000;

  constructor(private readonly spec: DesktopSurfaceSpec) {
    this.id = spec.id;
    this.displayName = spec.displayName;
    this.provider = spec.provider;
  }

  scan(): ConnectorScanResult {
    if (!existsSync(this.spec.appPath)) {
      throw new ConnectorUnsupportedError(
        `${this.spec.displayName} is not installed — nothing to watch`,
      );
    }

    const conversations = this.countLocalConversations();
    const seen =
      conversations === undefined
        ? ''
        : ` We can see ${conversations} conversation file(s), but not their contents.`;

    throw new ConnectorUnsupportedError(
      `${this.spec.displayName} is installed but cannot be observed: ${this.spec.reason}.${seen} Open these conversations in Chrome to have them covered by the extension instead.`,
    );
  }

  /** File count only — never contents. Used to make the reason concrete. */
  private countLocalConversations(): number | undefined {
    try {
      if (this.spec.id !== 'chatgpt-desktop') return undefined;
      const entries = readdirSync(this.spec.dataDir, { withFileTypes: true });
      const store = entries.find(
        (entry) => entry.isDirectory() && entry.name.startsWith('conversations-'),
      );
      if (!store) return undefined;
      return readdirSync(join(this.spec.dataDir, store.name)).filter((name) =>
        name.endsWith('.data'),
      ).length;
    } catch {
      return undefined;
    }
  }
}

export const DESKTOP_SURFACES: DesktopSurfaceSpec[] = [CLAUDE_DESKTOP, CHATGPT_DESKTOP];
