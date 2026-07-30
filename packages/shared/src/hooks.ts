/**
 * Hook payload contracts.
 *
 * Claude Code shapes verified July 2026 against the hooks reference; Codex shapes
 * verified against codex-cli 0.144.1; Grok Build shapes verified against the
 * first-party hook guide and open-source implementation. All are validated at
 * the daemon boundary — an unrecognised payload becomes a Coverage Health
 * warning, never a guess.
 *
 * NOTE ON PRIVACY: several hook payloads carry message text
 * (`last_assistant_message`, `user_input`, Codex's `last-assistant-message`).
 * These schemas deliberately do NOT include those fields, so they are dropped at
 * the boundary and can never reach the database.
 */
import { z } from 'zod';

/** Fields Claude Code sends on every hook. */
const claudeCommonSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().min(1),
  permission_mode: z.string().optional(),
});

export const claudeHookPayloadSchema = claudeCommonSchema.and(
  z.object({
    /** SessionStart */
    source: z.string().optional(),
    session_title: z.string().optional(),
    model: z.string().optional(),
    /** Notification */
    notification_type: z.string().optional(),
    /** PostToolUse / PermissionRequest */
    tool_name: z.string().optional(),
    /** SessionEnd */
    end_reason: z.string().optional(),
    /** Stop — array contents are deliberately stripped; only counts are used. */
    stop_hook_active: z.boolean().optional(),
    background_tasks: z.array(z.object({})).optional(),
    session_crons: z.array(z.object({})).optional(),
    /** StopFailure — error details and rendered messages are deliberately dropped. */
    error: z.string().optional(),
  }),
);

export type ClaudeHookPayload = z.infer<typeof claudeHookPayloadSchema>;

/** Hook events session-radar installs. Everything else is ignored. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PostToolUse',
  'Notification',
  'PermissionRequest',
  'Stop',
  'StopFailure',
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

/**
 * Codex invokes the notify program with a single JSON argument.
 * Only two event types exist as of 0.144.1.
 */
export const codexNotifyPayloadSchema = z.object({
  type: z.string().min(1),
  'turn-id': z.string().optional(),
  'session-id': z.string().optional(),
  cwd: z.string().optional(),
  'input-messages': z.array(z.string()).optional(),
});

export type CodexNotifyPayload = z.infer<typeof codexNotifyPayloadSchema>;

export const CODEX_NOTIFY_EVENTS = ['agent-turn-complete', 'approval-requested'] as const;

/**
 * Grok Build sends camelCase envelopes to HTTP hooks.
 *
 * Message-bearing fields such as `prompt`, `toolInput`, `toolResult`,
 * `lastAssistantMessage`, `errorDetails`, task descriptions, and scheduled
 * prompts are intentionally absent. Zod strips them before ingest.
 */
export const grokHookPayloadSchema = z.object({
  sessionId: z.string().min(1),
  hookEventName: z.string().min(1),
  cwd: z.string().optional(),
  workspaceRoot: z.string().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  permissionMode: z.string().optional(),
  /** SessionStart */
  source: z.string().optional(),
  modelId: z.string().optional(),
  /** Notification */
  notificationType: z.string().optional(),
  /** Stop / SessionEnd */
  reason: z.string().optional(),
  backgroundTasks: z.array(z.object({})).optional(),
  sessionCrons: z.array(z.object({})).optional(),
  /** StopFailure — the classified error only; raw details are dropped. */
  error: z.string().optional(),
  /** Subagent lifecycle. */
  subagentId: z.string().optional(),
  subagentType: z.string().optional(),
  agentType: z.string().optional(),
});

export type GrokHookPayload = z.infer<typeof grokHookPayloadSchema>;

/** Passive lifecycle events session-radar installs for Grok Build. */
export const GROK_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PostToolUse',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
] as const;

export type GrokHookEvent = (typeof GROK_HOOK_EVENTS)[number];

/** Wire body the hook shim POSTs to the daemon. */
export const hookIngestSchema = z.object({
  connector: z.enum(['claude-code-cli', 'codex-cli', 'grok-build-cli']),
  /** Epoch ms when the hook fired. Defaults to receipt time when absent. */
  at: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});

export type HookIngest = z.infer<typeof hookIngestSchema>;

export const hookIngestResponseSchema = z.object({
  accepted: z.boolean(),
  /** Present when the payload was understood. */
  signal: z.string().optional(),
  workItemId: z.string().optional(),
  status: z.string().optional(),
  /** Present when the payload parsed but we did not recognise part of it. */
  warning: z.string().optional(),
});

export type HookIngestResponse = z.infer<typeof hookIngestResponseSchema>;
