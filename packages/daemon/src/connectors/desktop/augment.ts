import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  Connector,
  ConnectorScanResult,
} from '../../registry.js';
import { ConnectorUnsupportedError } from '../../registry.js';

export const AUGMENT_CONNECTOR_ID = 'augment-vscode';

const AUGMENT_EXTENSION_PREFIX = 'augment.vscode-augment-';

export interface AugmentConnectorOptions {
  extensionRoot?: string;
  retainedStorageDir?: string;
}

function installed(extensionRoot: string): boolean {
  if (!existsSync(extensionRoot)) return false;
  try {
    return readdirSync(extensionRoot, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(AUGMENT_EXTENSION_PREFIX),
    );
  } catch {
    return false;
  }
}

/**
 * Augment is deliberately a visible unsupported row.
 *
 * The installed extension advertises History and Copy Session ID commands, but
 * its local VS Code state exposes only views, cache/user assets and the
 * `augment.sessions` SecretStorage key. Reading SecretStorage would cross the
 * credentials boundary and the extension exposes no metadata-only local
 * inventory or documented per-session deep link.
 */
export class AugmentConnector implements Connector {
  readonly id = AUGMENT_CONNECTOR_ID;
  readonly displayName = 'Augment Code sessions (VS Code)';
  readonly provider = 'augment' as const;
  readonly surface = 'desktop' as const;
  readonly scanIntervalMs = 30_000;

  private readonly extensionRoot: string;
  private readonly retainedStorageDir: string;

  constructor(options: AugmentConnectorOptions = {}) {
    this.extensionRoot =
      options.extensionRoot ?? join(homedir(), '.vscode', 'extensions');
    this.retainedStorageDir =
      options.retainedStorageDir ??
      join(
        homedir(),
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'augment.vscode-augment',
      );
  }

  scan(): ConnectorScanResult {
    const isInstalled = installed(this.extensionRoot);
    const retained = existsSync(this.retainedStorageDir);
    if (!isInstalled && !retained) {
      throw new ConnectorUnsupportedError(
        'Augment Code is not installed and no retained Augment state is present',
      );
    }
    throw new ConnectorUnsupportedError(
      'Augment Code is installed, but its session list is referenced through VS Code SecretStorage (augment.sessions); the visible local files are cache/user assets rather than a metadata-safe session index. Use Visual Studio Code → Augment → History until Augment exposes a safe inventory API or documented session deep link.',
    );
  }
}
