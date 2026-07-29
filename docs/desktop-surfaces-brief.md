# Desktop surface observability — findings and open questions

A brief for anyone we ask about this. Written to be self-contained: hand it to an
Anthropic or OpenAI engineer, or post it to a forum, without further context.

Investigated 28–29 July 2026, macOS 26.5.2 arm64.

---

## What we are building

`session-radar` — a **read-only, local-first** dashboard that discovers AI coding/chat
sessions across every tool on one Mac and answers a single question in under 30 seconds:
*what needs me right now?*

Sessions are normalised into four states — `running`, `needs_victor` (blocked on the
human: permission prompt, question, login wall), `done`, `stale` — deduped across
surfaces by conversation/session id, and shown on one local page. Everything stays on
`127.0.0.1`; nothing is written back to any source; only metadata plus a truncated title
is stored.

The product's core promise is **coverage trustworthiness**: a collector that cannot see
must report a visible failure, never an empty list. That is why a surface being
unobservable matters so much — silence is the one thing we refuse to ship.

## Status per surface

| Surface | Status | Mechanism |
| --- | --- | --- |
| Claude Code CLI | **solved** | Hooks (`Notification`/`Stop`/`PostToolUse`/…) + `~/.claude/projects/**/*.jsonl` + `ps` |
| Codex CLI | **solved** | `notify` dispatcher + `~/.codex/sessions/**/rollout-*.jsonl` |
| claude.ai / chatgpt.com (browser) | **solved** | Chrome MV3 extension, per-site self-testing selectors |
| **Claude Code Desktop** | **solved — official API found** | see below |
| **Claude Desktop (chat)** | open | CDP is the only route found |
| **ChatGPT for macOS** | open | CDP looks likely; untested |

---

## Claude Code Desktop — solved, first-party

Claude Code runs *inside* Claude Desktop. This session's process tree:

```
/Applications/Claude.app/Contents/Helpers/disclaimer
  └── ~/Library/Application Support/Claude/claude-code/2.1.219/claude.app/Contents/MacOS/claude
```

Two independent, fully-supported observation paths exist.

### 1. Session files on disk — plain JSON, unencrypted

```
~/Library/Application Support/Claude/claude-code-sessions/
    <accountId>/<workspaceId>/local_<sessionId>.json
```

Relevant fields:

| Field | Example | Use |
| --- | --- | --- |
| `sessionId` | `local_434a87c1-…` | CCD identity |
| **`cliSessionId`** | `944d73d6-…` | **maps to `~/.claude/projects/**/<cliSessionId>.jsonl`** |
| `title` / `titleSource` | `"Doctor command"` / `"auto"` | human title, with provenance — no message content needed |
| `cwd` / `originCwd` | | repo context |
| `lastActivityAt` / `createdAt` / `lastFocusedAt` | epoch ms | recency |
| `model` / `effort` / `permissionMode` | `claude-fable-5` / `max` / `auto` | context |
| `completedTurns` | `7` | progress |
| `isArchived` | | filtering |

`cliSessionId` is the crucial one: it is the join key between the desktop session and the
CLI transcript we already collect.

### 2. An MCP server: `ccd_session_mgmt`

Exposed to sessions running inside CCD:

- `list_sessions` → `{ sessionId, title, cwd, isArchived, isRunning, lastActivityAt }[]`
- `get_session` → adds `createdAt`, `model`, `effort`, `originCwd`, `isRemote`, worktree/branch, scheduled-task linkage
- `list_events`, `search_session_transcripts`, `send_message`, `set_session_title`, `archive_session`

`isRunning` is a genuine live status signal, straight from the vendor.

### The coverage hole this revealed

Measured on this machine: **17 CCD session files, of which 6 (35%) have a `cliSessionId`
with no corresponding transcript** under `~/.claude/projects/`.

So session-radar, which today only reads `~/.claude/projects/`, is **blind to roughly a
third of Claude Code Desktop sessions**. Reading the CCD session files closes that gap,
and `cliSessionId` lets the other 11 merge cleanly into existing work items rather than
appearing twice.

This is a bug in our collector, found by this investigation, not a platform limitation.

---

## Claude Desktop (chat) — open

- Bundle `com.anthropic.claudefordesktop` 1.24012.9; Electron 42.7.0 / Chrome 148
- Conversation UI is a claude.ai webview (`IndexedDB/https_claude.ai_0.indexeddb.leveldb`)
- **No AppleScript** — no `.sdef`, `NSAppleScriptEnabled` absent
- IndexedDB is held locked by the running app, is an undocumented Chromium-versioned
  envelope, and holds content rather than UI state
- MCP is the wrong direction: the app is an MCP *client*, so a server cannot ask it
  "which conversations are open"

Only route found: the Electron binary carries `remote-debugging-port` /
`remote-debugging-pipe`, so CDP would expose the webview and let us reuse the browser
extension's site adapter.

## ChatGPT for macOS — open

- The merged ChatGPT + Codex app is **Chromium**: `Codex Framework.framework/Versions/150.0.7871.128`, identifying as `Chrome/150.0.7871.128`
- Carries `remote-debugging-port`, `remote-debugging-pipe`, `remote-allow-origins`
- Ships an AppleScript dictionary, but its `tab`/`window`/`execute` suite drives the
  **in-app browser**, not conversations. Verified: querying tabs returned an unrelated
  web page. `execute` is additionally gated behind *View › Developer › Allow JavaScript
  from Apple Events*
- `conversations-v3/*.data`, `gizmos`, `models` are all **encrypted** — deliberately, as
  the fix for a July 2024 disclosure that these were world-readable plaintext. We treat
  decrypting them as out of bounds
- `app_pairing_extensions/` is plain JSON but is the *Work with Apps* protocol, running
  the wrong way: ChatGPT is the client connecting to an **editor's** `socketPath`, with
  capabilities `{ content, selections, highlight, highlightLines, setContent, replaceSelection, reload, ping }`. No status read
- Codex Micro's Agent Keys prove live thread status *is* exported from this app, over a
  proprietary USB HID/Bluetooth link to first-party hardware. No documented API, SDK or
  extension point

CDP is untested here and is the obvious next experiment.

---

## The questions we actually want answered

**For Anthropic**

1. Is `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json` a stable,
   supported thing to read? Is `cliSessionId` a contract we can rely on for joining to
   `~/.claude/projects/`?
2. Is `ccd_session_mgmt` available to processes *outside* a CCD session, or only to
   sessions hosted inside it? A local endpoint a daemon could poll would be ideal.
3. Is there any supported way to observe **Claude Desktop chat** conversation state
   (id + generating/blocked/idle) without CDP? Would running the app with
   `--remote-debugging-port` be considered acceptable use?
4. `list_sessions` gives `isRunning`. Is there, or could there be, a "blocked on the user"
   signal — the desktop equivalent of the `Notification` hook?

**For OpenAI**

5. Is there any local API, IPC surface or extension point exposing Codex thread status
   (idle/thinking/running/waiting/done) — the same state Codex Micro's Agent Keys display?
6. Is the Codex Micro status protocol documented anywhere for third-party devices, or is
   it first-party only by design?
7. The desktop app is Chromium and carries the remote-debugging switches. Is launching it
   with `--remote-debugging-port` acceptable use, or explicitly discouraged?
8. `app_pairing_extensions` lets an editor expose itself *to* ChatGPT. Is a reverse
   direction planned — an app subscribing to ChatGPT thread state?

**General**

9. Does either vendor consider "let local tools observe agent session state" a use case
   worth a supported API? Codex Micro and Claude Code Agent View both show the plumbing
   exists internally; a read-only local status endpoint would remove every hack in this
   document.

---

## What we would do with an answer

Nothing exotic. Given a stable read path per surface, each becomes a ~1 hour connector in
an architecture that already handles identity, dedup, evidence and coverage health. The
site adapters, status engine and merge logic are built and tested; what is missing is
purely a trustworthy way to *see* the two chat desktop apps.
