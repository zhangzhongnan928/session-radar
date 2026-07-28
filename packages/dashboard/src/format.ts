import type { CoverageHealth, Status, WorkItem } from '@session-radar/shared';

export const STATUS_LABELS: Record<Status, string> = {
  needs_victor: 'Needs you',
  done: 'Done',
  stale: 'Stale',
  running: 'Running',
};

/** Relative for scanning; absolute in the tooltip for when it matters. */
export function relativeTime(at: number, now = Date.now()): string {
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
};

export function sourceBadges(item: WorkItem): string[] {
  const seen = new Set<string>();
  for (const entry of item.entryPoints) {
    const provider = entry.source.provider === 'anthropic' ? 'Claude' : 'OpenAI';
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
