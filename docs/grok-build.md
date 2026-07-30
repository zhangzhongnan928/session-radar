# Grok Build connector

Issue [#1](https://github.com/zhangzhongnan928/session-radar/issues/1) adds
first-party Grok Build support without crossing session-radar's metadata-only
boundary.

## Coverage model

The connector has two independent inputs:

1. **Inventory** — reads
   `~/.grok/sessions/<encoded-cwd>/<session-id>/summary.json`. This discovers
   stable session ids, cwd, source timestamps, bounded generated title/summary,
   model id, session kind, hidden flag, and counts.
2. **Lifecycle** — Grok's documented global HTTP hooks POST to
   `http://127.0.0.1:4747/api/hooks/grok-build`.

Inventory alone creates a discoverable `Unknown / stale` row. It never means
running. Until the lifecycle hooks are installed, the connector reports
`DEGRADED` coverage with the exact setup command.

`~/.grok/active_sessions.json` is also read, but it tracks open TUI sessions
only. PID liveness can qualify a session as present or gone; it never refreshes
progress time and cannot make a session running.

## Lifecycle mapping

| Grok event | session-radar signal |
| --- | --- |
| `SessionStart` | session started |
| `UserPromptSubmit`, `PostToolUse` | running progress |
| `Notification/permission_prompt` | needs you |
| `Notification/elicitation_dialog` | needs you |
| `Notification/idle_prompt` | done |
| `Stop` with no pending background work | done |
| `Stop` with `backgroundTasks` or `sessionCrons` | running |
| `StopFailure`, `Notification/agent_error` | needs you |
| `SessionEnd` | done |
| unknown event or notification | ignored/informational plus degraded coverage |

Subagent lifecycle uses the explicit `subagentId` as a separate identity so a
subagent completion cannot accidentally mark the parent session done.

## Privacy boundary

The connector does not open:

- `updates.jsonl`, `chat_history.jsonl`, `events.jsonl`, prompt context, or
  system prompts;
- logs or analytics `signals.json`;
- `auth.json` or any credential store;
- hook prompt, tool input/result, assistant-message, raw error-detail,
  background-task description/command, or scheduled-prompt fields.

Hook payloads pass through a narrow schema first. Unknown keys, including nested
content fields, are stripped before the status engine or SQLite store sees them.

Grok loads compatible `~/.claude` hooks by default. If that compatibility layer
delivers Grok's distinctive camelCase envelope to the Claude endpoint,
session-radar recognizes and routes it as Grok rather than degrading Claude
coverage. Replayed delivery through the dedicated Grok endpoint is idempotent on
session, signal, and source timestamp.

## Installation

Preview:

```sh
pnpm radar install-hooks
```

Apply with a recoverable backup:

```sh
pnpm radar install-hooks --apply
```

This writes only `~/.grok/hooks/session-radar.json`. If that path contains
foreign or malformed configuration, the installer refuses to overwrite it.
Restart or reload existing Grok Build sessions after installation.

## First-party references

- [xAI Build overview](https://docs.x.ai/build/overview)
- [xAI Grok Build source](https://github.com/xai-org/grok-build)
- Hook guide in the installed/open-source distribution:
  `docs/user-guide/10-hooks.md`
- Persistence and active-session implementations:
  `crates/codegen/xai-grok-shell/src/session/persistence.rs` and
  `crates/codegen/xai-grok-shell/src/active_sessions.rs`
