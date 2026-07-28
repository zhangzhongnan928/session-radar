/**
 * Hook payload contracts.
 *
 * Claude Code shapes verified July 2026 against the hooks reference; Codex shapes
 * verified against codex-cli 0.144.1. Both are validated at the daemon boundary —
 * an unrecognised payload becomes a Coverage Health warning, never a guess.
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

/** Wire body the hook shim POSTs to the daemon. */
export const hookIngestSchema = z.object({
  connector: z.enum(['claude-code-cli', 'codex-cli']),
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
