import type { CoverageHealth, WorkItem } from '@session-radar/shared';

export type HumanTaskState =
  | 'Running'
  | 'Waiting for you'
  | 'Needs attention'
  | 'Done—review needed'
  | 'Stale'
  | 'Status unknown';

export type ActionGroup =
  | 'attention'
  | 'running'
  | 'done_review'
  | 'stale_unknown'
  | 'acknowledged';

const INTERRUPTED_RULES = new Set([
  'stale.process-dead-no-completion',
  'stale.web-abandoned',
]);

/**
 * The canonical four-state engine remains untouched. This is the user-facing
 * action interpretation: interrupted work is promoted for review, while
 * inventory without lifecycle proof is explicitly unknown.
 */
export function humanTaskState(item: WorkItem): HumanTaskState {
  if (item.status === 'needs_victor') return 'Waiting for you';
  if (item.status === 'running') return 'Running';
  if (item.status === 'done') return 'Done—review needed';
  if (
    item.currentEvidence?.rule === 'stale.inventory-only' ||
    item.currentEvidence?.rule === 'stale.no-evidence'
  ) {
    return 'Status unknown';
  }
  if (INTERRUPTED_RULES.has(item.currentEvidence?.rule ?? '')) {
    return 'Needs attention';
  }
  return 'Stale';
}

export function actionGroup(item: WorkItem): ActionGroup {
  if (
    item.attention === 'seen' &&
    (item.status === 'done' || item.status === 'stale')
  ) {
    return 'acknowledged';
  }
  const state = humanTaskState(item);
  if (state === 'Waiting for you' || state === 'Needs attention') return 'attention';
  if (state === 'Running') return 'running';
  if (state === 'Done—review needed') return 'done_review';
  return 'stale_unknown';
}

export function recommendedNextStep(item: WorkItem): string {
  switch (humanTaskState(item)) {
    case 'Waiting for you':
      return 'Open the original task and answer the request so work can continue.';
    case 'Needs attention':
      return 'Open the original task to review why it stopped, then resume or close it.';
    case 'Running':
      return 'No action needed now; check back when the task finishes or asks for you.';
    case 'Done—review needed':
      return 'Open the original task and review the result before treating it as complete.';
    case 'Status unknown':
      return 'Open the original task to check its real status; this source did not expose lifecycle state.';
    case 'Stale':
      return 'Open the original task to decide whether to resume it or leave it closed.';
  }
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
  return item.currentEvidence
    ? 'The observed evidence supports this state, but no plain-language reason was provided.'
    : 'No lifecycle evidence has been recorded for this task.';
}

/** Project context only. Session/conversation ids stay in technical details. */
export function contextLabel(item: WorkItem): string | undefined {
  if (item.context.repo) return item.context.repo;
  if (item.context.cwd) return item.context.cwd.split('/').filter(Boolean).at(-1);
  return undefined;
}

/** Hide a fallback id suffix from the headline while retaining it in evidence. */
export function displayTitle(item: WorkItem): string {
  const match = /^(.*?) · ([a-z0-9]{8})$/i.exec(item.title.trim());
  if (!match) return item.title;
  const context = contextLabel(item);
  const prefix = match[1]?.trim();
  if (context && prefix === context) return `Untitled task in ${context}`;
  if (prefix === 'session') return 'Untitled task';
  return `${prefix ?? 'Untitled'} task`;
}

/** A deliberately modest project summary: only say what stored metadata proves. */
export function taskSummary(item: WorkItem): string | undefined {
  const context = contextLabel(item);
  if (!context) return undefined;
  return `Project work in ${context}.`;
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
 * Deep links first because they are one click; then copyable open commands;
 * then a human location hint. Raw ids are deliberately excluded from the
 * primary action area and remain available in technical details.
 */
export function entryActions(item: WorkItem): EntryAction[] {
  const actions: EntryAction[] = [];
  for (const entry of item.entryPoints) {
    if (entry.url) {
      actions.push({ kind: 'link', label: 'Open original task', value: entry.url });
    }
  }
  for (const entry of item.entryPoints) {
    if (entry.resumeCommand) {
      actions.push({
        kind: 'copy',
        label: 'Copy command to open',
        value: entry.resumeCommand,
      });
    }
  }
  for (const entry of item.entryPoints) {
    if (!entry.url && !entry.resumeCommand && entry.locateHint) {
      actions.push({ kind: 'locate', label: 'Original task location', value: entry.locateHint });
    }
  }
  if (actions.length === 0) {
    actions.push({
      kind: 'locate',
      label: 'Original task location',
      value: 'No direct opening path was observed. Check technical details for the source reference.',
    });
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
