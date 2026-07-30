import type { CoverageHealth, Status, WorkItem } from '@session-radar/shared';

export const STATUS_LABELS: Record<Status, string> = {
  needs_victor: 'Needs you',
  done: 'Done',
  stale: 'Stale',
  running: 'Running',
};

export function statusLabel(item: WorkItem): string {
  if (item.status === 'stale' && item.currentEvidence?.rule === 'stale.inventory-only') {
    return 'Stale · status unknown';
  }
  return STATUS_LABELS[item.status];
}

/** Relative for scanning; absolute in the tooltip for when it matters. */
export function relativeTime(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return 'time unknown';
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function absoluteTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return 'Time unknown';
  return new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  });
}

/** The human-readable half of the evidence, written by the status engine. */
export function evidenceReason(item: WorkItem): string {
  const raw = item.currentEvidence?.raw;
  if (raw && typeof raw === 'object' && 'reason' in raw) {
    const reason = (raw as { reason: unknown }).reason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  return item.currentEvidence?.rule ?? 'no evidence recorded';
}

/** repo, or the conversation id, or the cwd — whatever locates this work. */
export function contextLabel(item: WorkItem): string | undefined {
  if (item.context.repo) return item.context.repo;
  if (item.context.cwd) return item.context.cwd.split('/').filter(Boolean).at(-1);
  if (item.context.conversationId) return item.context.conversationId.slice(0, 12);
  return undefined;
}

export const SURFACE_LABELS: Record<string, string> = {
  cli: 'CLI',
  web: 'web',
  extension: 'browser',
  desktop: 'desktop',
  mobile: 'mobile',
};

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  google: 'Google',
  github: 'GitHub',
  cline: 'Cline',
  augment: 'Augment',
};

const SOURCE_LABELS: Record<string, string> = {
  'claude-code-cli': 'Claude Code CLI',
  'claude-code-desktop': 'Claude Code desktop',
  'claude-web': 'Claude web',
  'claude-desktop': 'Claude desktop chat',
  'claude-agent-cli': 'Claude agent · CLI',
  'claude-agent-desktop': 'Claude Cowork · desktop',
  'claude-agent-web': 'Claude Cowork · web',
  'claude-agent-ios': 'Claude Cowork · iOS',
  'claude-agent-android': 'Claude Cowork · Android',
  'claude-agent-unknown': 'Claude agent session',
  'codex-cli': 'Codex CLI',
  'codex-desktop': 'Codex desktop',
  'codex-chrome-sidepanel': 'Codex browser',
  'codex-buzz': 'Codex via Buzz',
  'grok-build-cli': 'Grok Build',
  'chatgpt-web': 'ChatGPT web',
  'chatgpt-desktop': 'ChatGPT desktop',
  'cursor-desktop': 'Cursor agent',
  'cursor-agent-cli': 'Cursor Agent CLI',
  'windsurf-cascade': 'Windsurf Cascade',
  'antigravity-desktop': 'Antigravity',
  'chatgpt-atlas': 'ChatGPT Atlas',
  'vscode-copilot': 'VS Code Copilot',
  'cline-vscode': 'Cline · VS Code',
  'augment-vscode': 'Augment · VS Code',
};

export function sourceBadges(item: WorkItem): string[] {
  const seen = new Set<string>();
  for (const entry of item.entryPoints) {
    const specific = SOURCE_LABELS[entry.source.id];
    if (specific) {
      seen.add(specific);
      continue;
    }
    if (entry.source.id.startsWith('codex-origin-')) {
      seen.add('Codex desktop');
      continue;
    }
    const provider =
      entry.source.provider === 'anthropic'
        ? 'Claude'
        : PROVIDER_LABELS[entry.source.provider] ?? entry.source.provider;
    seen.add(`${provider} ${SURFACE_LABELS[entry.source.surface] ?? entry.source.surface}`);
  }
  return [...seen];
}

export interface EntryAction {
  kind: 'link' | 'copy' | 'locate';
  label: string;
  value: string;
}

/**
 * How to get back into this work.
 *
 * Deep links first because they are one click; then copyable resume commands;
 * then a human "go look here" hint. An item with none of these is a bug worth
 * seeing, so it renders the raw external id rather than nothing.
 */
export function entryActions(item: WorkItem): EntryAction[] {
  const actions: EntryAction[] = [];
  for (const entry of item.entryPoints) {
    if (entry.url) actions.push({ kind: 'link', label: 'Open', value: entry.url });
  }
  for (const entry of item.entryPoints) {
    if (entry.resumeCommand) {
      actions.push({ kind: 'copy', label: 'Copy resume', value: entry.resumeCommand });
    }
  }
  for (const entry of item.entryPoints) {
    if (!entry.url && !entry.resumeCommand && entry.locateHint) {
      actions.push({ kind: 'locate', label: 'Find it', value: entry.locateHint });
    }
  }
  if (actions.length === 0) {
    const first = item.entryPoints[0];
    if (first) actions.push({ kind: 'locate', label: 'id', value: first.externalId });
  }
  return actions;
}

export function coverageIsHealthy(connectors: readonly CoverageHealth[]): boolean {
  // `unsupported` is a known, explained gap rather than an incident, so it does
  // not raise the alarm — but it is always listed.
  return !connectors.some((c) => c.state === 'down' || c.state === 'degraded');
}

export function coverageSummary(connectors: readonly CoverageHealth[]): string {
  if (connectors.length === 0) return 'no collectors registered — nothing is being watched';
  const down = connectors.filter((c) => c.state === 'down').length;
  const degraded = connectors.filter((c) => c.state === 'degraded').length;
  const unsupported = connectors.filter((c) => c.state === 'unsupported').length;
  const ok = connectors.filter((c) => c.state === 'ok').length;

  const parts: string[] = [];
  if (down > 0) parts.push(`${down} down`);
  if (degraded > 0) parts.push(`${degraded} degraded`);
  if (parts.length === 0) {
    return unsupported > 0
      ? `${ok} watching, ${unsupported} unsupported`
      : `${ok} collector${ok === 1 ? '' : 's'} watching`;
  }
  return `${parts.join(', ')} — you may be missing sessions`;
}

const WEB_EXTENSION_CONNECTORS = new Set(['chatgpt-web', 'claude-web']);

/**
 * The old extension can still report open tabs, which makes these connectors
 * look partly alive while account history remains absent. Surface that exact
 * setup state separately from the general coverage list so it cannot be
 * mistaken for an ordinary parse limitation.
 */
export function webExtensionReloadRequired(
  connectors: readonly CoverageHealth[],
): boolean {
  return connectors.some(
    (connector) =>
      WEB_EXTENSION_CONNECTORS.has(connector.connectorId) &&
      connector.state === 'degraded' &&
      connector.lastError?.includes(
        'reload the updated unpacked extension',
      ) === true,
  );
}
