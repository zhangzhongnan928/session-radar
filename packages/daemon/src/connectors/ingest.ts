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
import { CODEX_CONNECTOR_ID, codexResumeCommand } from './codex/connector.js';

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
    const mapped = claudeSignalFor(hook.hook_event_name, hook.notification_type);
    if (!mapped.signal) {
      // Not an event we act on. Accepted, but say so rather than pretending.
      return { accepted: true, warning: `ignored hook event ${hook.hook_event_name}` };
    }

    if (mapped.warning) this.degrade(CLAUDE_CODE_CONNECTOR_ID, mapped.warning);

    const source: Source = {
      id: CLAUDE_CODE_CONNECTOR_ID,
      provider: 'anthropic',
      surface: 'cli',
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
        },
        connectorId: CLAUDE_CODE_CONNECTOR_ID,
      },
    ];

    const result = this.deps.engine.observe({
      identity: canonicalKey('anthropic', hook.session_id),
      provider: 'anthropic',
      surface: 'cli',
      // SessionStart supplies a title with no message content at all — use it.
      // Every other hook sends none, and must not overwrite the poller's title.
      title: hook.session_title ? deriveTitle(hook.session_title, { fallback: '' }) : '',
      fallbackTitle: fallbackLabel(repo, hook.session_id),
      source,
      externalId: hook.session_id,
      context: {
        ...(cwd ? { cwd } : {}),
        ...(repo ? { repo } : {}),
      },
      resumeCommand: resumeCommand(hook.session_id, cwd),
      observations,
      connectorId: CLAUDE_CODE_CONNECTOR_ID,
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
      const warning = `Codex ${notify.type} arrived without a session-id — cannot attribute it`;
      this.degrade(CODEX_CONNECTOR_ID, warning);
      return { accepted: false, warning };
    }

    const cwd = notify.cwd;
    const repo = cwd?.split('/').filter(Boolean).at(-1);
    const result = this.deps.engine.observe({
      identity: canonicalKey('openai', sessionId),
      provider: 'openai',
      surface: 'cli',
      // Codex notify carries no title at all.
      title: '',
      fallbackTitle: fallbackLabel(repo, sessionId),
      source: {
        id: CODEX_CONNECTOR_ID,
        provider: 'openai',
        surface: 'cli',
        device: this.device,
      },
      externalId: sessionId,
      context: {
        ...(cwd ? { cwd } : {}),
        ...(repo ? { repo } : {}),
      },
      resumeCommand: codexResumeCommand(sessionId, cwd),
      observations: [
        { signal, at, raw: { type: notify.type }, connectorId: CODEX_CONNECTOR_ID },
      ],
      connectorId: CODEX_CONNECTOR_ID,
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
      return { signal: 'claude_code.stop' };
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
