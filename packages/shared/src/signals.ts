/**
 * The signal registry.
 *
 * Connectors do not decide status. They report *named signals*, and the status
 * engine decides. This keeps every status traceable to (signal, rule, confidence)
 * and lets us reason about evidence priority in one place.
 *
 * Evidence priority is expressed by `tier`:
 *   explicit  — the source told us (hook fired, state file changed)
 *   observed  — we watched the UI or the process table
 *   heuristic — we inferred it from the passage of time
 *
 * Every `claude_code.*` and `codex.*` name below was verified in July 2026
 * against the Claude Code hooks reference and Codex CLI 0.144.1 on this machine.
 * See VERIFIED.md for what was checked and how.
 */
import type { Confidence } from './model.js';

export type SignalKind =
  /** Something is waiting on Victor: permission, question, login, plan approval. */
  | 'blocking'
  /** A previously reported block was explicitly resolved. */
  | 'unblocked'
  /** The source confirmed the turn/session finished. */
  | 'completion'
  /** Real forward progress: tool call, transcript write, tokens generated. */
  | 'activity'
  /** Explicit "I am still alive and working" ping. */
  | 'heartbeat'
  /** A session began. Counts as progress, weakly. */
  | 'session_start'
  /**
   * The source can enumerate a session and its metadata, but exposes no live
   * lifecycle. Inventory is useful for discovery and recency, never progress.
   */
  | 'inventory'
  /** The process/tab exists. Liveness only — does NOT count as progress. */
  | 'process_alive'
  /** The process/tab is gone. */
  | 'process_dead';

export type SignalTier = 'explicit' | 'observed' | 'heuristic';

export interface SignalSpec {
  kind: SignalKind;
  tier: SignalTier;
  confidence: Confidence;
  description: string;
}

/**
 * Signal names are `<connector>.<event>`. Adding a signal here is the only
 * supported way for a connector to influence status.
 */
export const SIGNALS = {
  // --- Claude Code CLI -------------------------------------------------------
  // Notification is split by `notification_type` because the types are NOT
  // equivalent: a permission prompt blocks Victor, an auth_success does not.
  // Collapsing them would either cry wolf on every login or hide real prompts.
  'claude_code.notification.permission_prompt': {
    kind: 'blocking',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude Code is asking permission to run a tool',
  },
  'claude_code.notification.idle_prompt': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude Code is done and waiting for the next prompt',
  },
  'claude_code.notification.agent_needs_input': {
    kind: 'blocking',
    tier: 'explicit',
    confidence: 'high',
    description: 'An agent is asking you a question',
  },
  'claude_code.notification.elicitation_dialog': {
    kind: 'blocking',
    tier: 'explicit',
    confidence: 'high',
    description: 'An MCP server is asking you to fill in a form',
  },
  'claude_code.permission_request': {
    kind: 'blocking',
    tier: 'explicit',
    confidence: 'high',
    description: 'A permission dialog is open for a tool call',
  },
  'claude_code.notification.info': {
    kind: 'heartbeat',
    tier: 'explicit',
    confidence: 'low',
    description: 'A non-blocking Claude Code notification',
  },
  'claude_code.stop': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude Code finished responding',
  },
  'claude_code.background_work_pending': {
    kind: 'heartbeat',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude Code paused its response with background work still scheduled',
  },
  'claude_code.stop_failure': {
    kind: 'blocking',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude Code could not complete its response because of an API error',
  },
  'claude_code.session_start': {
    kind: 'session_start',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude Code session started',
  },
  'claude_code.session_end': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude Code session ended',
  },
  'claude_code.user_prompt_submit': {
    kind: 'activity',
    tier: 'explicit',
    confidence: 'high',
    description: 'You sent a new prompt',
  },
  'claude_code.post_tool_use': {
    kind: 'activity',
    tier: 'explicit',
    confidence: 'high',
    description: 'A tool call completed',
  },
  'claude_code.transcript_write': {
    kind: 'activity',
    tier: 'observed',
    confidence: 'med',
    description: 'The session transcript grew',
  },
  'claude_code.desktop_metadata_write': {
    kind: 'activity',
    tier: 'observed',
    confidence: 'med',
    description: 'Claude Code Desktop session metadata changed',
  },
  'claude_code.process_alive': {
    kind: 'process_alive',
    tier: 'observed',
    confidence: 'med',
    description: 'A claude process for this session is running',
  },
  'claude_code.process_dead': {
    kind: 'process_dead',
    tier: 'observed',
    confidence: 'med',
    description: 'The claude process for this session is gone',
  },

  // --- Codex -----------------------------------------------------------------
  // These signals cover the CLI, Codex Desktop and other clients that persist
  // the same rollout format. Notify emits approval-requested and
  // agent-turn-complete; the rollout itself records task lifecycle events.
  'codex.approval_requested': {
    kind: 'blocking',
    tier: 'explicit',
    confidence: 'high',
    description: 'Codex is asking permission to run a tool',
  },
  'codex.turn_complete': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'high',
    description: 'Codex finished its turn and is waiting for you',
  },
  'codex.task_started': {
    kind: 'activity',
    tier: 'explicit',
    confidence: 'high',
    description: 'Codex started working on a turn',
  },
  'codex.task_complete': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'high',
    description: 'Codex finished its turn and is waiting for you',
  },
  'codex.turn_aborted': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'high',
    description: 'The Codex turn was explicitly interrupted',
  },
  'codex.rollout_write': {
    kind: 'activity',
    tier: 'observed',
    confidence: 'med',
    description: 'The Codex rollout file grew',
  },
  'codex.process_alive': {
    kind: 'process_alive',
    tier: 'observed',
    confidence: 'med',
    description: 'A codex process for this session is running',
  },
  'codex.process_dead': {
    kind: 'process_dead',
    tier: 'observed',
    confidence: 'med',
    description: 'The codex process for this session is gone',
  },

  // --- ChatGPT Desktop history ---------------------------------------------
  // The desktop app intentionally persists a recent-conversation list for its
  // own UI. It contains useful inventory metadata, but the renderer's
  // idle/streaming/error state is not persisted alongside it.
  'chatgpt.desktop_history_seen': {
    kind: 'inventory',
    tier: 'observed',
    confidence: 'low',
    description:
      'ChatGPT Desktop history is visible, but the local cache does not expose live running, blocked, or done state',
  },
  'chatgpt.desktop_async_streaming': {
    kind: 'heartbeat',
    tier: 'explicit',
    confidence: 'med',
    description: 'ChatGPT reports that an asynchronous desktop task is still streaming',
  },
  'chatgpt.desktop_async_unread': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'med',
    description: 'ChatGPT reports that an asynchronous result is ready and unread',
  },
  'claude.desktop_history_seen': {
    kind: 'inventory',
    tier: 'observed',
    confidence: 'low',
    description:
      'Claude Desktop history is visible, but the local cache does not expose live running, blocked, or done state',
  },
  'claude.agent_running': {
    kind: 'heartbeat',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude reports that this cross-device agent session is running',
  },
  'claude.agent_resumed': {
    kind: 'unblocked',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude reports that this agent session resumed work',
  },
  'claude.agent_needs_input': {
    kind: 'blocking',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude reports that this agent session needs your input',
  },
  'claude.agent_review_ready': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'high',
    description: 'Claude reports that this agent session is ready for review',
  },
  'claude.agent_inventory_seen': {
    kind: 'inventory',
    tier: 'observed',
    confidence: 'low',
    description:
      'Claude exposes this agent session, but its current lifecycle is not classified',
  },

  // --- Web surfaces via the browser extension (M2) ---------------------------
  'web.generating': {
    kind: 'activity',
    tier: 'observed',
    confidence: 'med',
    description: 'The assistant is streaming a response',
  },
  'web.blocked': {
    kind: 'blocking',
    tier: 'observed',
    confidence: 'med',
    description: 'An approval dialog, tool permission prompt or login wall is showing',
  },
  'web.completed': {
    kind: 'completion',
    tier: 'observed',
    confidence: 'med',
    description: 'The reply finished and the composer is idle',
  },
  'web.tab_open': {
    kind: 'process_alive',
    tier: 'observed',
    confidence: 'med',
    description: 'The conversation tab is open',
  },
  'web.tab_closed': {
    kind: 'process_dead',
    tier: 'observed',
    confidence: 'med',
    description: 'The conversation tab was closed',
  },
  'web.history_seen': {
    kind: 'inventory',
    tier: 'observed',
    confidence: 'low',
    description:
      'The web history lists this conversation, but no current ordinary-chat lifecycle is exposed',
  },
  'chatgpt.web_async_streaming': {
    kind: 'heartbeat',
    tier: 'explicit',
    confidence: 'med',
    description: 'ChatGPT reports that an asynchronous web task is still streaming',
  },
  'chatgpt.web_async_unread': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'med',
    description: 'ChatGPT reports that an asynchronous web result is ready and unread',
  },

  // --- Cursor ---------------------------------------------------------------
  // Verified against the first-party Cursor desktop bundle and the persisted
  // composer header/data fields on this machine. Only allowlisted lifecycle
  // values are mapped; unknown values remain inventory-only.
  'cursor.agent_needs_attention': {
    kind: 'blocking',
    tier: 'explicit',
    confidence: 'high',
    description: 'Cursor has a pending user decision or blocking action',
  },
  'cursor.agent_resumed': {
    kind: 'unblocked',
    tier: 'explicit',
    confidence: 'high',
    description: 'Cursor no longer reports a pending user decision',
  },
  'cursor.agent_running': {
    kind: 'heartbeat',
    tier: 'explicit',
    confidence: 'high',
    description: 'Cursor reports that the agent is generating',
  },
  'cursor.agent_completed': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'high',
    description: 'Cursor reports that the agent completed',
  },
  'cursor.agent_aborted': {
    kind: 'completion',
    tier: 'explicit',
    confidence: 'high',
    description: 'Cursor reports that the agent was stopped',
  },
  'cursor.process_dead': {
    kind: 'process_dead',
    tier: 'observed',
    confidence: 'med',
    description: 'Cursor is not running while a persisted composer says it is generating',
  },
  'cursor.agent_inventory_seen': {
    kind: 'inventory',
    tier: 'observed',
    confidence: 'low',
    description:
      'Cursor exposes this composer, but its current lifecycle is not classified',
  },

  // --- Metadata-only desktop inventories -----------------------------------
  // These products persist protobuf conversation bodies without a separately
  // verified lifecycle index. We enumerate filenames and filesystem metadata
  // only; reading those bodies would violate the dashboard's content boundary.
  'windsurf.cascade_inventory_seen': {
    kind: 'inventory',
    tier: 'observed',
    confidence: 'low',
    description:
      'Windsurf exposes a Cascade session file, but title and lifecycle metadata are unavailable',
  },
  'antigravity.conversation_inventory_seen': {
    kind: 'inventory',
    tier: 'observed',
    confidence: 'low',
    description:
      'Antigravity exposes a conversation file, but title and lifecycle metadata are unavailable',
  },
  'chatgpt.atlas_inventory_seen': {
    kind: 'inventory',
    tier: 'observed',
    confidence: 'low',
    description:
      'ChatGPT Atlas exposes a local conversation file, but title and lifecycle metadata are unavailable',
  },
  'vscode.copilot_inventory_seen': {
    kind: 'inventory',
    tier: 'observed',
    confidence: 'low',
    description:
      'VS Code exposes a persisted chat session, but title and lifecycle metadata are unavailable',
  },
  'cline.task_inventory_seen': {
    kind: 'inventory',
    tier: 'observed',
    confidence: 'low',
    description:
      'Cline exposes a persisted task directory, but title and live lifecycle metadata are unavailable',
  },

  // --- Cross-cutting ---------------------------------------------------------
  'radar.no_progress': {
    kind: 'heartbeat',
    tier: 'heuristic',
    confidence: 'low',
    description: 'The staleness sweeper found no progress in-window',
  },
} as const satisfies Record<string, SignalSpec>;

export type SignalName = keyof typeof SIGNALS;

export function isKnownSignal(name: string): name is SignalName {
  return Object.prototype.hasOwnProperty.call(SIGNALS, name);
}

export function signalSpec(name: SignalName): SignalSpec {
  return SIGNALS[name];
}

/**
 * Claude Code `notification_type` values that genuinely block Victor.
 *
 * This is an allowlist on purpose. An unknown type is NOT treated as blocking —
 * crying wolf on every `auth_success` would train Victor to ignore the one that
 * matters. Instead the ingest layer raises a Coverage Health warning for
 * unrecognised types, so a new blocking type shows up as `degraded` rather than
 * being silently swallowed.
 */
export const BLOCKING_NOTIFICATION_TYPES = [
  'permission_prompt',
  'agent_needs_input',
  'elicitation_dialog',
] as const;

/** Notification types we know about and know are NOT blocking. */
export const INFO_NOTIFICATION_TYPES = [
  'auth_success',
  'agent_completed',
  'elicitation_complete',
  'elicitation_response',
] as const;

export function notificationSignal(
  notificationType: string | undefined,
): { signal: SignalName; known: boolean } {
  if (notificationType === 'permission_prompt')
    return { signal: 'claude_code.notification.permission_prompt', known: true };
  if (notificationType === 'idle_prompt')
    return { signal: 'claude_code.notification.idle_prompt', known: true };
  if (notificationType === 'agent_needs_input')
    return { signal: 'claude_code.notification.agent_needs_input', known: true };
  if (notificationType === 'elicitation_dialog')
    return { signal: 'claude_code.notification.elicitation_dialog', known: true };
  const known = INFO_NOTIFICATION_TYPES.includes(
    notificationType as (typeof INFO_NOTIFICATION_TYPES)[number],
  );
  return { signal: 'claude_code.notification.info', known };
}

/** Signals that count as forward progress (used for the staleness window). */
export const PROGRESS_KINDS: readonly SignalKind[] = ['activity', 'heartbeat', 'session_start'];

/** Signals that clear an outstanding block. */
export const UNBLOCKING_KINDS: readonly SignalKind[] = [
  'unblocked',
  'completion',
  'process_dead',
];

export const TIER_RANK: Record<SignalTier, number> = {
  explicit: 3,
  observed: 2,
  heuristic: 1,
};
