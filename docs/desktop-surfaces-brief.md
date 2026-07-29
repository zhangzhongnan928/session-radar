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
| Codex Desktop / CLI / Chrome / Buzz | **solved** | `session_meta.originator` + persisted rollout lifecycle events |
| claude.ai / chatgpt.com (browser) | **inventory complete in code; lifecycle partial** | open-tab lifecycle; ChatGPT active+archived and Claude multi-organization starred+non-starred pagination after the v0.0.4 extension reload; 1,000-row cap and contract drift degrade loudly |
| **Claude Code Desktop** | **solved — official API found** | see below |
| **Claude cross-device agents / Cowork** | **complete in code; reload pending** | cursor-paginated active+paused+archived account inventory, lifecycle, exact Cowork URL and local identity join |
| **Claude Desktop (chat)** | **partial** | recent metadata cache solved; live lifecycle still open |
| **ChatGPT for macOS ordinary chat** | **partial** | recent/pinned metadata plus async streaming/ready lifecycle; ordinary lifecycle still open |
| **Cursor Agent desktop + CLI** | **lifecycle solved for persisted composers** | safe SQLite metadata projection; pending decision, generating, completed and aborted are mapped; matching CLI transcript filenames add verified `cursor-agent --resume` actions without opening JSONL |
| **Windsurf Cascade** | **inventory only** | UUID filenames and mtime/size only; protobuf bodies are not read |
| **Google Antigravity** | **inventory only** | UUID filenames and mtime/size only; protobuf bodies are not read |
| **ChatGPT Atlas** | **inventory only** | `conversations-v3-*/*.data` UUID filenames and mtime/size only; bodies are not read |
| **VS Code chat / Copilot** | **inventory only** | `workspaceStorage/*/chatSessions/*.json` filenames plus separately stored workspace locator; chat bodies are not read |
| **Cline (VS Code)** | **inventory only** | millisecond task-directory ids plus mtime/size for the two known conversation files; bodies are not read |
| **Augment Code (VS Code)** | **explicitly unsupported** | session reference is in VS Code SecretStorage; no metadata-safe local index or documented session deep link |

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

### What shipped

The connector now recursively reads and validates these files, honours the seven-day
triage boundary, incrementally backfills missing older/archived ids, and uses
`cliSessionId` as the canonical join key. On the live store, every current Desktop item
merged into its CLI transcript with zero duplicate work items. Shared hooks are
attributed back to the Desktop entry point.

This was a collector gap, not a platform limitation, and it is closed.

---

## Codex Desktop — solved from the shared rollout store

Codex Desktop, CLI, the Chrome side panel and Buzz all persist the same rollout format:

```
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl
```

`session_meta.originator` distinguishes the client. Values observed here are
`Codex Desktop`, `codex-chrome-extension-sidepanel`, `buzz-acp` and `codex_exec`.
The rollout also carries explicit metadata-only lifecycle records:

- `event_msg/task_started`
- `event_msg/task_complete`
- `event_msg/turn_aborted`

This avoids the private app IPC entirely. One session id is one canonical work item,
with the correct Desktop/browser/Buzz/CLI badge and a surface-appropriate way back.

---

## Claude Desktop (chat) — inventory solved, lifecycle open

Claude persists its recent-list React Query state in:

```
~/Library/Application Support/Claude/Local Storage/leveldb
key: react-query-cache-ls
```

Nine persisted query objects across six query families were observed. The only ordinary
chat family was four `chat_conversation_list` variants. Those list responses yielded 30
unique recent conversations with stable UUIDs, names, create/update times and list
metadata. The infinite list reports `has_more=true`, so it is partial rather than full
account inventory.

The cache also includes a multi-kilobyte `summary` per conversation. The connector
therefore reads the locked store only through a private copy, selects the one allowlisted
key, isolates only conversation-list query objects and narrows each item to metadata.
`summary` and all unrelated cached data are stripped before ingestion and never stored.
Rows use `anthropic:<uuid>`, deduplicate with the browser extension, and route through
`https://claude.ai/chat/<uuid>`.

The cache contains no generating/blocked/done state. Static renderer inspection shows
ordinary chat rendering receives `isStreaming` as an in-memory prop; no corresponding
ordinary lifecycle query is persisted. Cache-only rows are explicitly
`stale.inventory-only`, Coverage Health is `degraded`, and the `has_more=true` warning is
visible. The same UUID seen in Chrome receives stronger lifecycle evidence.

The content-bearing IndexedDB remains locked and out of bounds. There is no AppleScript
dictionary, and MCP is the wrong direction: Claude Desktop is an MCP client. Electron
CDP could expose the live webview, but its security cost is too high to enable without
informed consent. A vendor-supported read-only lifecycle endpoint remains the desired
solution.

## Claude cross-device agents / Cowork — complete account path built

The copied `react-query-cache-ls` value first exposed a separate query:

```
["sessions_api_list_sessions", { orgUuid, statuses: ["active", "paused"] }]
```

This is not ordinary chat history. It is an account-level list of agent/Cowork work
created across Claude Code CLI, Claude Desktop, claude.ai and mobile. Its metadata
includes stable server ids, origin/environment, `session_status`, `worker_status`,
connection state, `unread`, timestamps and `post_turn_summary.status_category`.

The current first-party claude.ai bundle then supplied the missing complete enumerator:

```http
GET /v1/code/sessions?statuses=active&statuses=paused&limit=50&cursor=<opaque>
GET /v1/code/sessions?statuses=archived&limit=50&cursor=<opaque>
```

Requests use ambient same-origin credentials plus Claude's current
`anthropic-version`, `anthropic-beta`, `anthropic-client-feature` and
`x-organization-uuid` headers. The v0.0.4 page bridge runs both buckets for every
verified chat-capable organization. A missing cursor proves the bucket ended; repeated
cursors, auth/schema failures, rejected rows, unknown enums or the 1,000-row cap make
the snapshot partial/unavailable.

The shipped connector uses this conservative mapping:

- running session or worker → `running`;
- `need_input`, `blocked` or `failed` → `needs_victor`;
- `review_ready` → `done`;
- idle/paused without a recognised category → inventory only;
- unknown values → no guess, visible Coverage Health warning.

The post-turn object also contains content-bearing action/detail/description fields.
They are not selected. The parser isolates only the exact session-list query and stores
only allowlisted enums, booleans and timestamps.

Cross-device deduplication is exact. Claude Code Desktop writes cloud
`session_…`/`cse_…` ids into `bridgeSessionIds` alongside the local `cliSessionId`;
both cloud prefixes are normalized before joining, and those rows
merge under the CLI UUID. If the cloud row was seen first, a later bridge atomically
moves its observations, evidence, transitions and entry points onto the local row.
Conflicting mappings are discarded, and a joined idle inventory sighting cannot
overwrite stronger local hook/transcript lifecycle.

The exact first-party return route is
`https://claude.ai/cowork/<normalized-session-id>`. Every remote CLI/Desktop/web/mobile
source ref now carries that URL even when its canonical work item is joined to a local
CLI UUID.

Earlier live Desktop-cache scans on 29 July found 13 sessions inside the seven-day
window and 37 older rows:
one needing Victor, seven review-ready and five explicit local joins. One joined item
was observed transitioning between running and idle while four stayed idle, proving
both the live transition and stronger-local-evidence suppression paths. That cache page
reported `has_more=true`; it remains a fallback. Once a fresh complete v0.0.4 web
snapshot arrives, it becomes authoritative for the account set and suppresses the
cache's pagination/staleness warning. Partial or stale web snapshots merge with the
cache and keep both limitations visible. Live installed-runtime counts remain
unclaimed until Chrome reloads v0.0.4.

## ChatGPT for macOS ordinary chat — inventory and async lifecycle solved; ordinary lifecycle open

The merged app is bundle `com.openai.codex`. It persists its recent-chat UI metadata at:

```
~/Library/Application Support/Codex/Default/Local Storage/leveldb
```

Observed keys:

- `codex.chatgpt-conversations`: version 1, 20 recent items;
- `codex.chatgpt-pinned-conversations`: version 1, zero pinned items here.

These records expose stable server ids, titles, ISO create/update timestamps and archive
metadata. The bundled app uses `codex://threads/<id>` to reopen a conversation. It also
defines a persisted async-status enum: `3` is streaming, and `4` is an unread async
result ready for review. The connector copies the live LevelDB before opening it,
allowlists the two keys, and refuses any record whose `mapping` or `snippet` becomes
non-null. It therefore solves discovery and return paths, plus that narrow background
work lifecycle, without reading encrypted conversation files or requesting Keychain
access.

The remaining limit is now precise:

- ordinary renderer lifecycle is in memory as `idle | streaming | error`, not in the
  cache; persisted async values 3/4 are the verified exception;
- `~/.codex/ipc/ipc.sock` is a same-user stream-coordination bus for already-known
  Codex conversation ids, not a thread-list API; its state method carries full
  conversation snapshots/patches rather than a metadata-only status event;
- the cache is the recent list plus pinned chats, not a complete account archive.

Coverage is therefore `degraded`. Async value 3 maps to `running`, value 4 maps to
unread `done`, and other/null cache rows are `stale.inventory-only` with low confidence
and an explicit “ordinary live status unavailable” reason. An unknown non-null value is
never guessed. Acknowledged unknown rows become unseen again only when their vendor
update timestamp advances; a daemon poll by itself cannot reopen them. The same id
observed through the Chrome extension acquires stronger lifecycle evidence.

The older encrypted `conversations-v3/*.data` store remains out of bounds. AppleScript
still addresses the in-app browser rather than conversations, and CDP/Accessibility were
not enabled without informed user consent.

## Other installed AI interfaces — now visible, with bounded claims

The installed-surface audit found additional work that was previously absent from the
dashboard. Cursor supplies the strongest contract: its current composer-header cache and
historical composer metadata can be projected through explicit SQLite JSON paths without
materialising conversation bodies. The installed first-party bundle uses
`hasBlockingPendingActions`/pending plan for needs-attention, `generating` (plus
continuation/generating-bubble state) for in-progress, and `completed`/`aborted` for
terminal state. The live deployment indexed 426 safe composer ids. Sixty-seven records
with an unrecognised encoding and 972 records without safe session metadata are reported
as a visible coverage limit, not silently counted as sessions.

Cursor Agent CLI 2025.09.12 exposes `--resume <chatId>` and retains top-level transcripts
under `.cursor/projects/(project)/agent-transcripts/<chatId>/`. Filename comparison
showed that all 9 top-level CLI ids already exist in the desktop composer index, so they
merge as CLI entry points instead of creating duplicates. Each gets a copyable
`cursor-agent --resume <chatId>` command. Two nested subagent transcripts remain part of
their parent work. No transcript body is opened.

Windsurf, Antigravity, ChatGPT Atlas, VS Code persisted chat and Cline currently expose
stable local session/task identifiers but no separately verified metadata-only lifecycle
index. Their connectors therefore open none of the protobuf, `.data`, chat JSON or Cline
conversation JSON bodies. They retain only ids, file size and modification time; VS Code
additionally permits the separate `workspace.json` folder locator. The live machine
contributed 4 Windsurf Cascades, 5 Antigravity conversations, 118 Atlas conversations,
1 VS Code chat session and 4 Cline tasks. Every row has a human locate hint, stays
`stale.inventory-only`, and keeps Coverage visibly degraded until a supported
title/lifecycle contract exists.

Augment Code is installed and advertises History and Copy Session ID commands, but the
only session-related local state key is `augment.sessions` in VS Code SecretStorage.
Visible local files are cache, index and user-asset files rather than a safe session
inventory. The dashboard therefore registers an explicit `unsupported` Augment row and
points to Visual Studio Code → Augment → History instead of crossing the credential
boundary.

The same audit found no additional session ledger to collect from Ollama (models/logs
only), the empty OpenCode installation footprint (config only; no CLI or share
directory), or Gemini CLI (no installed command; `.gemini` outside Antigravity contains
only settings/instructions). Those are documented exclusions, not invented zero-session
connectors.

---

## The questions we actually want answered

**For Anthropic**

1. Is `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json` a stable,
   supported thing to read? Is `cliSessionId` a contract we can rely on for joining to
   `~/.claude/projects/`?
2. Is `ccd_session_mgmt` available to processes *outside* a CCD session, or only to
   sessions hosted inside it? A local endpoint a daemon could poll would be ideal.
3. Is `react-query-cache-ls` and its `chat_conversation_list` query intended as a stable
   local metadata contract? Is there a supported way to observe generating/blocked/idle
   for those UUIDs without CDP?
4. `list_sessions` gives `isRunning`. Is there, or could there be, a "blocked on the user"
   signal — the desktop equivalent of the `Notification` hook?
5. Are `sessions_api_list_sessions` and `/v1/code/sessions` supported read-only
   contracts? Can the cursor/list/lifecycle/locate contract be documented for
   same-user local tools instead of inferred from current app code?
6. Are `bridgeSessionIds` and `post_turn_summary.status_category` stable contracts for
   joining and classifying Code/Cowork sessions across CLI, desktop, web and mobile?

**For OpenAI**

7. Are `codex.chatgpt-conversations` and
   `codex.chatgpt-pinned-conversations` intended as a stable local metadata contract, or
   only an internal cache that may change without notice?
8. Is there a supported local API or IPC list method exposing ordinary ChatGPT thread ids
   plus `idle | streaming | error` (and ideally blocked-on-user) state?
9. Can an external same-user client subscribe to the renderer lifecycle that the bundled
   first-party thread list already displays, without CDP or Accessibility?
10. Are the persisted async values `3` (`STREAMING`) and `4` (`UNREAD`) intended as a
   stable local contract, and what are the supported meanings of the other enum values?
11. Is the Codex Micro status protocol documented for third-party devices, or is there a
   software equivalent planned for read-only local observers?

**General**

12. Does either vendor consider "let local tools observe agent session state" a use case
   worth a supported API? Codex Micro and Claude Code Agent View both show the plumbing
   exists internally; a read-only local status endpoint would remove every hack in this
   document.

---

## What we would do with an answer

Nothing exotic. The ordinary-chat inventories and Claude agent lifecycle page are
already wired into an architecture that handles identity, dedup, evidence and coverage
health. What remains is a trustworthy live-state path for ordinary Claude and
non-async ChatGPT chats, plus a supported complete Claude enumerator. The browser
extension now has strict ChatGPT active+archived and Claude multi-organization
starred+non-starred account enumerators plus Claude agent cursor pagination in v0.0.4,
but those are current internal
first-party contracts rather than supported public APIs. Their live installed-runtime
counts are intentionally left unclaimed until Chrome reloads that unpacked bundle and
refreshes the existing site tabs.
