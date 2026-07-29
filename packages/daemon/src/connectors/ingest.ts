import { hostname } from 'node:os';
import type { HookIngestResponse, SignalName, Source } from '@session-radar/shared';
import {
  canonicalKey,
  claudeHookPayloadSchema,
  codexNotifyPayloadSchema,
  deriveTitle,
  fallbackLabel,
  notificationSignal,
} from '@session-radar/shared';
import type { StatusEngine } from '../engine.js';
import type { Store } from '../store.js';
import type { StoredObservation } from '../store.js';
import { CLAUDE_CODE_CONNECTOR_ID, resumeCommand } from './claude-code/connector.js';
import {
  CODEX_BUZZ_SOURCE_ID,
  CODEX_CHROME_SOURCE_ID,
  CODEX_CONNECTOR_ID,
  CODEX_DESKTOP_SOURCE_ID,
  codexResumeCommand,
} from './codex/connector.js';
import { CLAUDE_CODE_DESKTOP_CONNECTOR_ID } from './desktop/claude-code.js';

export interface IngestDeps {
  engine: StatusEngine;
  store: Store;
  device?: string;
}

/**
 * Turns a hook payload into observations.
 *
 * Hooks are the highest-confidence path we have: the source is telling us
 * directly. Everything here is validated — an unrecognised shape becomes a
 * Coverage Health warning, never a guess and never a silent drop.
 */
export class HookIngest {
  private readonly device: string;

  constructor(private readonly deps: IngestDeps) {
    this.device = deps.device ?? hostname();
  }

  handle(connector: string, payload: unknown, at: number): HookIngestResponse {
    if (connector === CLAUDE_CODE_CONNECTOR_ID) return this.handleClaude(payload, at);
    if (connector === CODEX_CONNECTOR_ID) return this.handleCodex(payload, at);
    return { accepted: false, warning: `unknown connector ${connector}` };
  }

  private handleClaude(payload: unknown, at: number): HookIngestResponse {
    const parsed = claudeHookPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      const warning = `unparseable Claude Code hook payload: ${parsed.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`;
      this.degrade(CLAUDE_CODE_CONNECTOR_ID, warning);
      return { accepted: false, warning };
    }

    const hook = parsed.data;
    const backgroundTaskCount = hook.background_tasks?.length ?? 0;
    const sessionCronCount = hook.session_crons?.length ?? 0;
    const mapped = claudeSignalFor(
      hook.hook_event_name,
      hook.notification_type,
      backgroundTaskCount + sessionCronCount > 0,
    );
    if (!mapped.signal) {
      // Not an event we act on. Accepted, but say so rather than pretending.
      return { accepted: true, warning: `ignored hook event ${hook.hook_event_name}` };
    }

    if (mapped.warning) this.degrade(CLAUDE_CODE_CONNECTOR_ID, mapped.warning);

    const identity = canonicalKey('anthropic', hook.session_id);
    const existing = this.deps.store.getWorkItemByCanonicalKey(identity.key);
    const desktopEntry = existing?.entryPoints.find(
      (entry) => entry.source.id === CLAUDE_CODE_DESKTOP_CONNECTOR_ID,
    );
    const surface = desktopEntry ? ('desktop' as const) : ('cli' as const);
    const attributedConnectorId = desktopEntry
      ? CLAUDE_CODE_DESKTOP_CONNECTOR_ID
      : CLAUDE_CODE_CONNECTOR_ID;
    const source: Source = {
      id: attributedConnectorId,
      provider: 'anthropic',
      surface,
      device: this.device,
    };
    const cwd = hook.cwd;
    const repo = cwd?.split('/').filter(Boolean).at(-1);
    const observations: StoredObservation[] = [
      {
        signal: mapped.signal,
        at,
        raw: {
          hook: hook.hook_event_name,
          ...(hook.notification_type ? { notificationType: hook.notification_type } : {}),
          ...(hook.tool_name ? { tool: hook.tool_name } : {}),
          ...(hook.end_reason ? { endReason: hook.end_reason } : {}),
          ...(hook.source ? { source: hook.source } : {}),
          ...(backgroundTaskCount > 0 ? { backgroundTaskCount } : {}),
          ...(sessionCronCount > 0 ? { sessionCronCount } : {}),
          ...(hook.error ? { error: hook.error } : {}),
        },
        connectorId: attributedConnectorId,
        surface,
      },
    ];

    const result = this.deps.engine.observe({
      identity,
      provider: 'anthropic',
      surface,
      // SessionStart supplies a title with no message content at all — use it.
      // Every other hook sends none, and must not overwrite the poller's title.
      title: hook.session_title ? deriveTitle(hook.session_title, { fallback: '' }) : '',
      titlePriority: hook.session_title ? 30 : 0,
      fallbackTitle: fallbackLabel(repo, hook.session_id),
      source,
      externalId: desktopEntry?.externalId ?? hook.session_id,
      context: {
        ...(cwd ? { cwd } : {}),
        ...(repo ? { repo } : {}),
      },
      ...(desktopEntry
        ? { locateHint: desktopEntry.locateHint ?? 'Claude Desktop → Code' }
        : { resumeCommand: resumeCommand(hook.session_id, cwd) }),
      observations,
      connectorId: attributedConnectorId,
    });

    return {
      accepted: true,
      signal: mapped.signal,
      workItemId: result.workItemId,
      status: result.decision.status,
      ...(mapped.warning ? { warning: mapped.warning } : {}),
    };
  }

  private handleCodex(payload: unknown, at: number): HookIngestResponse {
    const parsed = codexNotifyPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      const warning = 'unparseable Codex notify payload';
      this.degrade(CODEX_CONNECTOR_ID, warning);
      return { accepted: false, warning };
    }

    const notify = parsed.data;
    let signal: SignalName;
    if (notify.type === 'approval-requested') signal = 'codex.approval_requested';
    else if (notify.type === 'agent-turn-complete') signal = 'codex.turn_complete';
    else {
      const warning = `unrecognised Codex notify type "${notify.type}" — status may be incomplete`;
      this.degrade(CODEX_CONNECTOR_ID, warning);
      return { accepted: true, warning };
    }

    // Codex does not always include the session id; without it we cannot attach
    // the signal to a session, and guessing would be worse than saying so.
    const sessionId = notify['session-id'];
    if (!sessionId) {
      // Current Codex Desktop builds occasionally omit the session id. The
      // rollout poller independently reads task_started/task_complete, so this
      // one notify packet is redundant rather than a coverage failure.
      const warning =
        `Codex ${notify.type} arrived without a session-id — ignored; ` +
        'the rollout lifecycle collector remains authoritative';
      return { accepted: true, warning };
    }

    const cwd = notify.cwd;
    const repo = cwd?.split('/').filter(Boolean).at(-1);
    const identity = canonicalKey('openai', sessionId);
    const existing = this.deps.store.getWorkItemByCanonicalKey(identity.key);
    const nonCliEntry = existing?.entryPoints.find(
      (entry) =>
        entry.source.id === CODEX_DESKTOP_SOURCE_ID ||
        entry.source.id === CODEX_CHROME_SOURCE_ID ||
        entry.source.id === CODEX_BUZZ_SOURCE_ID ||
        entry.source.id.startsWith('codex-origin-'),
    );
    const surface = nonCliEntry?.source.surface ?? ('cli' as const);
    const sourceId = nonCliEntry?.source.id ?? CODEX_CONNECTOR_ID;
    const result = this.deps.engine.observe({
      identity,
      provider: 'openai',
      surface,
      // Codex notify carries no title at all.
      title: '',
      fallbackTitle: fallbackLabel(repo, sessionId),
      source: {
        id: sourceId,
        provider: 'openai',
        surface,
        device: this.device,
        ...(nonCliEntry?.source.version ? { version: nonCliEntry.source.version } : {}),
      },
      externalId: nonCliEntry?.externalId ?? sessionId,
      context: {
        ...(cwd ? { cwd } : {}),
        ...(repo ? { repo } : {}),
      },
      ...(nonCliEntry
        ? { locateHint: nonCliEntry.locateHint ?? 'Codex client → this task' }
        : { resumeCommand: codexResumeCommand(sessionId, cwd) }),
      observations: [
        { signal, at, raw: { type: notify.type }, connectorId: sourceId, surface },
      ],
      connectorId: sourceId,
    });

    return {
      accepted: true,
      signal,
      workItemId: result.workItemId,
      status: result.decision.status,
    };
  }

  /**
   * Surface a parsing problem as degraded coverage instead of swallowing it.
   *
   * The warning is ALWAYS recorded, even for a connector that is currently down.
   * An earlier version skipped down connectors entirely, which meant every hook
   * warning vanished on a freshly started daemon — connectors register as `down`
   * until their first scan, so that was the common case, not the edge case.
   * Only the state transition is conditional: a hard-down connector stays down
   * rather than being upgraded to merely degraded.
   */
  private degrade(connectorId: string, warning: string): void {
    const current = this.deps.store.getCoverage(connectorId);
    if (!current) return;
    this.deps.store.updateCoverage(connectorId, {
      lastError: warning,
      ...(current.state === 'ok' ? { state: 'degraded' as const } : {}),
    });
  }
}

export interface ClaudeSignalMapping {
  signal: SignalName | undefined;
  warning?: string;
}

/**
 * Maps a Claude Code hook event to a signal.
 *
 * Notification is split by type: an unknown type is treated as informational
 * (NOT blocking) but raises a warning, so a newly added blocking type shows up
 * as degraded coverage rather than either crying wolf or vanishing.
 */
export function claudeSignalFor(
  hookEvent: string,
  notificationType: string | undefined,
  hasBackgroundWork = false,
): ClaudeSignalMapping {
  switch (hookEvent) {
    case 'SessionStart':
      return { signal: 'claude_code.session_start' };
    case 'SessionEnd':
      return { signal: 'claude_code.session_end' };
    case 'UserPromptSubmit':
      return { signal: 'claude_code.user_prompt_submit' };
    case 'PostToolUse':
      return { signal: 'claude_code.post_tool_use' };
    case 'Stop':
      return {
        signal: hasBackgroundWork
          ? 'claude_code.background_work_pending'
          : 'claude_code.stop',
      };
    case 'StopFailure':
      return { signal: 'claude_code.stop_failure' };
    case 'PermissionRequest':
      return { signal: 'claude_code.permission_request' };
    case 'Notification': {
      const mapped = notificationSignal(notificationType);
      if (mapped.known) return { signal: mapped.signal };
      return {
        signal: mapped.signal,
        warning: `unrecognised Claude Code notification_type "${String(
          notificationType,
        )}" — treated as non-blocking; if it should block, session-radar needs updating`,
      };
    }
    default:
      return { signal: undefined };
  }
}
