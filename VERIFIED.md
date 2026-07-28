# What was verified, and how

Boundary 4 says: never fabricate status, and never let an unverified assumption sit
silently in the code. This file records what was actually checked, so the next person
(or the next model) can tell evidence from guesswork.

Verified July 2026 on Victor's Mac — macOS 26.5.2, arm64.

## Claude Code CLI

| Claim | How it was checked | Result |
| --- | --- | --- |
| Transcripts live at `~/.claude/projects/<slug-cwd>/<session-uuid>.jsonl` | `ls ~/.claude/projects/**` | Confirmed. 26 project directories. |
| The filename is the session id | Compared filename to `sessionId` inside the records | Confirmed, they match. |
| Record shape | Parsed a 1.3 MB live transcript | `type`, `timestamp` (ISO), `sessionId`, `cwd`, `gitBranch`, `version`, `uuid`, `parentUuid` |
| Record types in the wild | Counted across a full session | `queue-operation`, `attachment`, `user`, `assistant`, `system`, `last-prompt`, `custom-title` |
| `custom-title` gives a title with no message content | Read the record | Confirmed: `{"type":"custom-title","customTitle":"…","sessionId":"…"}` |
| Hook events and payload fields | [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) | Confirmed. 30+ events; common fields `session_id`, `transcript_path`, `cwd`, `hook_event_name`. |
| `type: "http"` hook handler exists | Same reference | Confirmed — used instead of a curl subprocess. |
| `Notification` carries a typed `notification_type` | Same reference | Confirmed: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed` |
| `SessionStart` supplies `session_title` | Same reference | Confirmed — a title costing zero message content. |
| Settings hook schema | Read Victor's live `~/.claude/settings.json` | `hooks: { Event: [ { matcher?, hooks: [ {type, command\|url, timeout?} ] } ] }` |
| Victor already has hooks | Same file | `SessionStart` (matcher `startup`), `UserPromptSubmit`, `Notification`, `Stop` — all `afplay` sounds. **Never overwritten.** |

## Codex CLI (0.144.1)

| Claim | How it was checked | Result |
| --- | --- | --- |
| Rollouts live at `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` | `find ~/.codex/sessions` | Confirmed. |
| The trailing UUID is the resumable session id | Compared to `session_meta.payload.id` | Confirmed, they match. |
| `codex resume <SESSION_ID>` is the resume syntax | `codex resume --help` | Confirmed verbatim. |
| Record shape | Parsed live rollouts | `{ timestamp, type, payload }` |
| `session_meta` payload fields | Same | `id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `model_provider`, `git` |
| Record types | Counted across a full session | `session_meta`, `turn_context`, `world_state`, `response_item/*`, `event_msg/*` |
| `event_msg/user_message` is the real user prompt | Compared against the `response_item` user stream | Confirmed. The `response_item` stream leads with `<recommended_plugins>` injected context. |
| notify events | [developers.openai.com/codex/config-reference](https://developers.openai.com/codex/config-reference) | `agent-turn-complete`, `approval-requested` |
| notify takes ONE program, invoked with a JSON argument | Same reference | Confirmed — hence the dispatcher rather than a replacement. |
| Victor already has a notify | Read `~/.codex/config.toml` | Wired to Codex Computer Use. **Wrapped, never replaced.** |

## Chrome extension (M2)

| Claim | How it was checked | Result |
| --- | --- | --- |
| Extension id derives from the manifest `key` | Generated an RSA keypair, computed SHA-256 of the SPKI DER, mapped the first 16 bytes onto a–p | `mdbfiohpejlnjbeebkmplfhiommkaonf`, pinned in the daemon allowlist |
| MV3 service worker owns network access | Design decision, verified by build | Content script bundles to 8.8 kB with no `fetch` |
| Conversation id parsing | Unit tests over real URL shapes | `claude.ai/chat/<id>`, `claude.ai/project/<p>/chat/<id>`, `chatgpt.com/c/<id>`, `chatgpt.com/codex/<id>` |
| Daemon rejects other extension origins | `defaultAllowedOrigins` test | Confirmed |
| Heartbeat timeout flips coverage | `scripts/test-m2.sh` against the live daemon | Flipped to `down` after 41s, inside the 60s budget |
| Cross-surface dedup | Same script: one CLI hook + one web report for one id | One work item, two entry points, both a resume command and a deep link |

## Desktop apps (M3)

| Claim | How it was checked | Result |
| --- | --- | --- |
| ChatGPT conversation files are encrypted | Sampled 3 files' magic bytes + `strings` | No shared magic, no structure, no plaintext — `857a0da4…`, `dd076b0f…`, `243097a8…` |
| Only ids and mtimes are legible | Listed `conversations-v3-<acct>/` | 80 files named by conversation UUID |
| `lastSelectedConversation` exists but is unusable | `defaults read com.openai.chat` | Present, but a *local* uppercase UUID in a different namespace from the server ids — merging on it would create duplicates |
| Claude Desktop holds its LevelDB open | `lsof` on the IndexedDB `LOCK` | Held by the running app (PID confirmed) |
| Claude Desktop logs carry no state | Scanned 3,000 recent lines | Zero conversation ids, zero navigation events, all `[error]` |
| Accessibility API | **Not attempted** | Requires a highly invasive permission; not triggered unilaterally. Reasoning in the feasibility doc |

## Dashboard (M4)

| Claim | How it was checked | Result |
| --- | --- | --- |
| Readable within 2s | `scripts/test-m4.sh` timing shell + JS + CSS + data | 188 ms |
| Scan order | `scripts/lib/scan-check.mjs` over the live API | needs_victor → done+unseen → stale → running → done+seen |
| Every item explains itself | Same | All items carry rule, confidence and a human reason |
| Every actionable item has a route back | Same | 7/7 had a link, command or hint |
| Renders real data correctly | Headless screenshot of `127.0.0.1:4747` against 183 real sessions | No console errors; caught two real bugs (see below) |
| Static serving cannot escape its root | 8 traversal tests incl. encoded, null-byte and prefix-sibling cases | Contained |

## Not verified

- **Hooks firing from a live `claude` process.** The ingest path is proven over real
  HTTP with the documented payload shapes, and the installer is proven to merge
  correctly, but no one has yet watched a running session fire a hook into the daemon.
  To close: `pnpm radar install-hooks --apply`, restart a session, watch `pnpm radar status`.
- **Codex `notify` payload field names.** The docs describe the event types and that a
  JSON argument is passed, but the exact keys (`session-id`, `turn-id`, `cwd`) were not
  observed in a live payload. The schema tolerates their absence and reports a Coverage
  Health warning when a payload cannot be attributed, rather than guessing.
- **The DOM selectors themselves.** They were written from knowledge of these sites, not
  read off live logged-in pages, which is not possible from here. The `selfTest`
  mechanism that surfaces their correctness IS verified, over DOM fixtures. Expect
  `degraded` naming missing anchors on first real load; that is the design working, and
  the fix is one file plus a `SELECTORS_VERSION` bump.
- **The extension running in Chrome.** Built and loadable; never loaded.
- **The dashboard driven by a human in a real browser.** Verified rendering headlessly
  against real data; no one has clicked a Seen toggle or followed a deep link.
- **The literal 30-second scan.** The machine-checkable half is proven (order, evidence,
  routes back in, 188 ms load). A human still has to do the actual scan.

## Sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Codex advanced configuration](https://developers.openai.com/codex/config-advanced)
