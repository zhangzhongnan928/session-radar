# session-radar

`session-radar` is a read-only, local-first dashboard for finding AI sessions
that are running, waiting for you, finished, or no longer verifiably active.

It combines metadata from supported CLI, desktop, and browser surfaces into one
triage view while keeping collection on your Mac.

## What the cards mean

- **Waiting for you** — a connector observed an explicit blocking signal, such as an
  approval request, permission prompt, login wall, or a provider-reported
  `needs_input` state. The signal remains active until a strictly newer
  completion, unblock/resume, or process-death signal is observed.
- **Needs attention** — work stopped or disappeared without a confirmed
  completion and should be checked.
- **Running** — recent progress activity is visible and no unresolved blocking
  signal has priority.
- **Done—review needed** — the source emitted a completion signal, but the radar
  does not claim to know or approve the substantive result.
- **Status unknown** — the task was found in inventory, but that source does not
  expose trustworthy lifecycle state.
- **Stale** — the radar saw lifecycle activity but can no longer prove progress.

These are session states. The separate **coverage** panel reports whether each
connector can see its intended surface reliably. A `DEGRADED` connector means
coverage is partial or unverifiable; it does not mean the underlying AI task
failed.

Cards lead with a recommended next step and a human return path. Session ids,
connector identifiers, the deciding rule, and confidence remain available under
**Technical evidence** instead of dominating the home view.

**Analyze this task** is a separate, explicit per-card permission flow. This
version exposes the safe request boundary but has no authorised source-content
adapter, so it returns “not available” without opening or storing conversation
content. See [docs/task-analysis.md](docs/task-analysis.md).

## Privacy and trust boundary

- The daemon listens only on `127.0.0.1`.
- Its SQLite store is local and owner-readable only.
- Connectors collect session metadata and bounded display titles, not prompt or
  response bodies.
- The project does not bypass app encryption, credentials, or macOS security
  boundaries.
- Missing, stale, partial, and unsupported coverage is shown explicitly rather
  than silently treated as complete.

Some applications do not expose a safe, documented session inventory or live
lifecycle. Those rows may remain unknown and their connectors will explain the
coverage limitation in the dashboard.

## Requirements

- macOS
- Node.js 20 or newer
- pnpm 9
- Chrome or another Chromium browser if you want the optional web connector

## Run locally

```sh
pnpm install
pnpm build
pnpm --filter @session-radar/dashboard build
pnpm daemon
```

Open [http://127.0.0.1:4747](http://127.0.0.1:4747).

Useful commands:

```sh
pnpm radar status
pnpm radar scan
pnpm radar coverage
pnpm radar doctor
```

The install commands are dry-runs unless `--apply` is present:

```sh
pnpm radar install-hooks
pnpm radar install-hooks --apply
pnpm radar install-daemon
pnpm radar install-daemon --apply
```

`install-hooks` adds narrowly scoped Claude Code, Codex, and Grok Build
lifecycle notifications after showing the proposed changes and making backups.
For Grok Build, the connector can enumerate `summary.json` metadata without
hooks, but coverage remains `DEGRADED` because inventory alone cannot prove
running, blocked, or done. `install-daemon` installs a macOS LaunchAgent.
Matching uninstall commands remove only session-radar's entries and preserve a
recoverable backup.

## Grok Build

Grok Build sessions are discovered from the first-party
`~/.grok/sessions/<encoded-cwd>/<session-id>/summary.json` inventory. Optional
global HTTP hooks provide the live lifecycle. The connector never opens Grok's
message streams, tool results, logs, or `auth.json`.

See [docs/grok-build.md](docs/grok-build.md) for the exact coverage and privacy
contract.

## Optional browser connector

Build the extension:

```sh
pnpm --filter @session-radar/extension build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked**, and select `packages/extension/dist`. Refresh any open
`claude.ai` or `chatgpt.com` tabs.

The extension sends metadata only to the loopback daemon. Browser and account
inventory coverage remains subject to what each site safely exposes.

## Develop and verify

```sh
pnpm typecheck
pnpm test
pnpm test:m0
pnpm test:m1
pnpm test:m2
pnpm test:m4
```

The workspace contains:

- `packages/shared` — status model and deterministic decision engine
- `packages/daemon` — local collectors, store, API, CLI, and macOS installers
- `packages/dashboard` — React triage interface
- `packages/extension` — optional metadata-only Chromium connector

## Security

See [SECURITY.md](SECURITY.md). Please do not attach real session databases,
transcripts, logs, or credential material to public issues.

## License

Copyright © 2026 session-radar contributors.

Licensed under the [GNU General Public License v3.0 only](LICENSE)
(`GPL-3.0-only`).
