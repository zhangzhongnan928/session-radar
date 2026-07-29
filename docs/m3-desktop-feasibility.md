# M3 — Desktop app feasibility

**Revised verdict (29 July 2026): coding-agent desktop sessions and Claude's
cross-device agent/Cowork lifecycle are supported; ordinary Claude and ChatGPT chat
inventory is supported with degraded lifecycle coverage.**
Investigated on Victor's Mac (macOS 26.5.2, arm64), with both apps installed and
running.

The initial spike treated each vendor app as one opaque surface. Deeper inspection found
two trustworthy agent-specific stores:

- Claude Code Desktop:
  `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json`, joined to
  CLI transcripts by `cliSessionId`, with shared documented hooks for live state.
- Codex Desktop: `~/.codex/sessions/**/rollout-*.jsonl`, identified by
  `session_meta.originator === "Codex Desktop"` and carrying persisted
  `task_started`, `task_complete` and `turn_aborted` events.

Those are now first-class desktop entry points. A third source,
`sessions_api_list_sessions`, exposes account-level Claude agent work created on CLI,
Desktop, web and mobile. The ordinary Claude and ChatGPT chat connectors remain
`degraded`: recent sessions are discoverable, deduplicated and returnable, but ordinary
chat lifecycle is incomplete and their local lists are bounded.

---

## Ordinary Claude Desktop chat — inventory supported, lifecycle degraded

**Installed:** `/Applications/Claude.app`, running during the investigation.
**Metadata cache:**
`~/Library/Application Support/Claude/Local Storage/leveldb`

### The metadata cache that changes the inventory verdict

Claude persists React Query state under the Local Storage key:

```
react-query-cache-ls
```

The live value contained nine persisted queries, including four
`chat_conversation_list` variants. Their finite and infinite list responses yielded 30
unique ordinary conversations with stable server UUIDs, names, create/update times,
star/temporary/project metadata and `platform: "CLAUDE_AI"`. The infinite list reported
`has_more=true`, so this is explicitly a recent inventory rather than the full account
archive.

The list objects also contain a multi-kilobyte `summary`. That field is outside this
product's metadata boundary. The connector isolates only conversation-list query
objects, immediately projects each record through a narrow schema, and strips
`summary` plus every unknown field before anything can be logged or persisted.

This closes discovery: recent Claude chats now appear beside coding sessions, use
`anthropic:<uuid>` as their canonical identity, deduplicate with the same chat observed
by the Chrome extension, sort by the source update time, and route back through
`https://claude.ai/chat/<uuid>`.

### What shipped, and the privacy boundary

The shared Chromium Local Storage reader never opens Claude's live LevelDB. It copies
the store to a private temporary directory, opens only the copy with `classic-level`,
selects only `react-query-cache-ls`, closes the database, and removes the copy. The
parser then materialises only the `chat_conversation_list` query objects; unrelated
cached account/query data is ignored.

The content-bearing
`IndexedDB/https_claude.ai_0.indexeddb.leveldb/` remains locked by the running app and
out of bounds. No conversation messages, Keychain data, app permissions or remote
debugging flags are read or requested.

### Why live status is still unavailable

The React Query list is an inventory snapshot. It says when a conversation changed but
does not say whether a response is currently generating, a dialog is blocking on
Victor, or the turn is done. Cache-only rows therefore emit a non-progress inventory
signal:

```
status      stale
rule        stale.inventory-only
confidence  low
reason      history is visible, but live running/blocked/done is not exposed
```

Coverage remains `degraded`, with a warning that 30 conversations were locally
enumerated and `has_more=true`. If the same UUID is live in Chrome, the extension's
stronger lifecycle evidence wins.

### What could close the live-status gap

Claude Desktop is Electron (42.7.0 / Chrome 148) and its binary carries
`remote-debugging-port` / `remote-debugging-pipe`. CDP could expose the webview and
reuse the browser extension's lifecycle adapter, but it also grants local processes
powerful access to the app, including cookies and page content. It was not enabled
without informed consent.

A supported read-only local endpoint exposing conversation UUID plus
generating/blocked/idle would be preferable. Until one exists, discovery is solved but
live lifecycle is not.

---

## Claude cross-device agents/Cowork — complete web enumerator built

This is a separate first-party surface from ordinary Claude chat. Claude Desktop
persists an active/paused agent-session query in the same copied Local Storage value:

```
queryKey: ["sessions_api_list_sessions", { orgUuid, statuses: ["active", "paused"] }]
```

The connector locates that exact compact query marker before parsing, so unrelated
React Query objects are not materialised. The narrow projection keeps only:

- stable `session_…`/`cse_…` id and title;
- create/update timestamps;
- controlled session, worker, connection, environment and origin enums;
- `unread`;
- `post_turn_summary.status_category`.

The post-turn object also carries content-bearing fields such as `needs_action`,
`status_detail` and descriptions. Those fields, session context, external metadata and
every unknown field are stripped immediately and never logged or persisted.

The current claude.ai bundle exposes the complete metadata list at
`GET /v1/code/sessions`. Extension v0.0.4 requests active+paused and archived buckets
with the verified first-party headers, follows each opaque `next_cursor`, and repeats
that process across every verified chat-capable organization. The raw rows also contain
task summaries, session context, source/outcome configuration and arbitrary external
metadata; the page bridge constructs a new allowlisted object and never forwards the
raw response.

### Trustworthy lifecycle mapping

Static bundle inspection and live cache values established this conservative mapping:

| Persisted state | Dashboard state |
| --- | --- |
| `session_status: running`, or a running worker when session status is absent | `running` |
| `status_category: need_input`, `blocked` or `failed` | `needs_victor` |
| `status_category: review_ready` | `done` |
| idle/paused with no recognised post-turn category | inventory only / `stale` |
| any unknown enum | not guessed; named Coverage Health warning |

Running evidence is timestamped at the cache refresh, not the daemon scan. If Claude
Desktop stops refreshing for five minutes, coverage degrades; cached running evidence
then ages into stale under the normal surface threshold rather than being made fresh by
a restart.

### Exact cross-device identity

Claude Code Desktop's local metadata contains both:

```
cliSessionId: "<local CLI UUID>"
bridgeSessionIds: ["session_<server id>" | "cse_<server id>", …]
```

That is an explicit server-session → local-session join. When present, the remote
session is ingested under the CLI UUID and adds its true CLI/Desktop/web/mobile entry
point to the existing work item instead of creating a title/time-based duplicate.
If a cloud-only row was ingested before its local bridge existed, the later mapping
atomically moves its observations, evidence, transitions and entry points onto the CLI
UUID and removes the old row. Both remote prefixes normalize to `session_…`; ambiguous
bridge ids are discarded rather than guessed. A joined idle inventory sighting adds its
Cowork return path without adding lifecycle evidence, so it cannot overwrite stronger
local transcript/hook completion.

Across earlier live scans on 29 July, the Desktop cache contained 13 sessions inside
the seven-day window and 37 older sessions. The current page consistently had one needing Victor and
seven review-ready rows. The remaining five were explicit local joins: one was observed
transitioning between running and idle while four stayed idle, proving the live
transition and suppression paths end to end. Origins observed were Desktop, CLI,
claude.ai and iOS. Stored raw evidence contained only the allowlisted enum, timestamp
and boolean fields.

That Desktop list reported `has_more=true`, so it remains a visibly degraded fallback.
A fresh complete web snapshot is authoritative for the account set; stale or partial
web snapshots merge with the cache and retain both warnings. The canonical first-party
route is `https://claude.ai/cowork/<normalized-session-id>`, now attached to every
remote agent entry point. The v0.0.4 installed-runtime inventory is not claimed live
until Chrome reloads the unpacked bundle.

---

## Ordinary ChatGPT for macOS chat — inventory and async lifecycle supported; full lifecycle degraded

**Installed:** `/Applications/ChatGPT.app`, bundle id `com.openai.codex`, running during
the investigation.

### The metadata cache that changes the inventory verdict

The merged ChatGPT/Codex app intentionally persists the list it uses for its own recent
chat UI in Chromium Local Storage:

```
~/Library/Application Support/Codex/Default/Local Storage/leveldb
```

Two keys were decoded from a private copy of that store:

| Key | Observed value |
| --- | --- |
| `codex.chatgpt-conversations` | version 1, one page, 20 recent conversation metadata records |
| `codex.chatgpt-pinned-conversations` | version 1, zero pinned records on this account |

Each recent record includes a stable server conversation id, title, ISO create/update
times, archive/star/project metadata and the app's list-level fields. In the live sample,
all 20 `mapping`, `snippet` and `async_status` values were `null`. Static inspection of
the same first-party bundle found the persisted async-status enum and cache update path:
value `3` is `STREAMING`, and value `4` is `UNREAD` (an asynchronous result ready for
review). The bundled app also contains the exact deep-link form
`codex://threads/<conversation-id>`.

This closes a real part of the gap: recent ordinary ChatGPT conversations can now be
found, deduplicated with the same conversation seen on the web, sorted by their real
update time and opened in the desktop app.

### What shipped, and the privacy boundary

The connector never opens Chromium's live LevelDB. It copies the directory into a
private temporary directory, opens only that copy with `classic-level`, projects the two
allowlisted keys through a narrow schema, closes it, and deletes the copy.

Only id, title, create/update time, archive state and nullable integer `async_status`
leave the parser. A record is refused if `mapping` or `snippet` becomes non-null, so a
future app change cannot silently turn this metadata connector into a message-content
reader. The seven-day history window controls the default triage count; locally cached
older or explicitly archived rows are incrementally backfilled into all-history and
then skipped on later scans.

The old `~/Library/Application Support/com.openai.chat/conversations-v3-*/*.data` files
remain encrypted and out of bounds. They are no longer needed for inventory, and no
Keychain material is requested or read.

### Which lifecycle is available, and what remains unavailable

The cache now gives one narrow, trustworthy lifecycle path:

```
async_status 3  → running
async_status 4  → done + unread
other/null      → status unknown
```

A transition observed while the daemon is alive is current evidence. On first sight,
the source update time is retained, so an old cached `STREAMING` value cannot become
fresh merely because session-radar restarted. Unknown non-null values are counted in
Coverage Health without exposing or guessing their meaning.

That does not make the cache a general lifecycle log. Outside asynchronous work, its
update time proves that a conversation changed but does not say whether an ordinary
turn is currently streaming, waiting on the user, idle or done.

The bundled first-party `list_threads` path makes the boundary precise:

- it combines ChatGPT API/cache inventory with Codex `thread/list`;
- ordinary ChatGPT renderer state is held in memory as `idle | streaming | error`;
- that renderer atom and blocked-on-user state are not persisted into either Local
  Storage key; the async enum above is the verified exception.

The app also owns `~/.codex/ipc/ipc.sock`. Reverse-inspection showed a same-user,
length-prefixed JSON coordination bus for following already-known thread streams. It
broadcasts stream/follower/client changes, but has no thread-list method. The concrete
`thread-stream-state-changed` payload is a full Codex conversation snapshot followed by
state patches. A caller must already know the conversation id, so it cannot discover
forgotten chats; accepting those payloads would also cross session-radar's metadata-only
boundary. The connector deliberately does not subscribe.

Accordingly, rows without async state 3/4 emit a non-progress inventory signal:

```
status      stale
rule        stale.inventory-only
confidence  low
reason      history is visible, but live running/blocked/done is not exposed
```

The dashboard labels this group status unknown, and Coverage Health stays `degraded`.
Acknowledged rows stay quiet while the cached vendor timestamp is unchanged. If that
timestamp advances later, the row becomes unseen again without being relabelled as
running or done. If the same conversation is open in Chrome, stronger extension
lifecycle evidence wins on the canonical id.

### Remaining limitation

The cache is an undocumented implementation detail and currently contains only the
desktop's recent list plus pinned items, not the full account archive. The connector
compares the locally enumerated count with the cache's advertised total and reports the
shortfall in Coverage Health rather than implying completeness.

What would close the remaining lifecycle gap:

- a documented read-only thread-list/status endpoint;
- a supported subscription to the renderer's `idle | streaming | error` state;
- a local IPC list method that returns ids plus lifecycle, rather than requiring ids up
  front.

---

## What the official AppleScript API actually gives (tested)

`ChatGPT.app` **does** ship a scripting dictionary (`Contents/Resources/scripting.sdef`,
`NSAppleScriptEnabled: true`) exposing a Chromium-style suite: `tab` with `id`/`title`/
`URL`/`loading`, `window` with `active tab`/`mode`, and an `execute` command.

Tested on this machine:

```
$ osascript -e 'tell application "ChatGPT" to get {name, URL, loading} of tabs of windows'
Tax registrations, https://onlineservices.ato.gov.au/Individual/TaxRoles#/, false
```

Those tabs are the app's **in-app browser**, not its conversations. `execute` is
additionally gated behind View › Developer › Allow JavaScript from Apple Events.

So the official API tells us the app is running, whether it is frontmost, and what web
page its browser is showing. It does not expose conversation state. Verdict unchanged —
for live lifecycle, and for a better reason than "we could not find anything": we found
the official API, tested it, and it addresses a different surface.

## On the Accessibility API

The M3 brief suggested AX observation for ChatGPT macOS. It was **not** attempted, for
one deliberate reason: it requires granting session-radar Accessibility permission,
which is among the most powerful permissions on macOS — it allows reading and
synthesising input across every application. Requesting it needs Victor's informed
consent, and it was not something to trigger unilaterally during a timeboxed spike.

If Victor wants it explored, the realistic ceiling is worth knowing in advance:

- **Likely obtainable:** window title (often the conversation title), whether the app is
  frontmost, and the presence of a modal sheet.
- **Likely NOT obtainable:** a conversation id, so sightings could not be deduped
  against web or CLI items — the merge key simply is not on screen.
- **Fragile:** AX trees are unstable across app releases, in the same way DOM selectors
  are, but without a `selfTest` equivalent that can prove they still work.

The honest cost/benefit: a very invasive permission for a low-confidence, un-mergeable
signal. Recommend against it unless the desktop apps become a primary surface.

---

## Coverage Health treatment

### Additional installed interfaces

The wider local audit now covers Cursor desktop/CLI, Windsurf, Antigravity, ChatGPT
Atlas, VS Code persisted chat, Cline and Augment instead of treating the original two
desktop-chat apps as the whole desktop universe.

- **Cursor** is the one additional surface with a verified persisted lifecycle. The
  connector reads `composer.composerHeaders` and allowlisted fields from
  `cursorDiskKV` `composerData:*` rows in read-only/query-only SQLite mode. It never
  selects the content-bearing document fields or bubble/agent KV stores. Pending actions
  map to needs-you, current generating state maps to running (qualified by Cursor process
  liveness), and completed/aborted map to terminal done.
- **Cursor Agent CLI** keeps UUID transcript filenames that are accepted by its verified
  `--resume <chatId>` flag. All 9 top-level ids on this machine match the desktop
  composer index, so the connector adds a CLI source and resume command to the existing
  work item rather than creating duplicates. Two nested subagent files are not treated
  as separate user work. JSONL bodies remain unopened.
- **Windsurf and Antigravity** expose UUID-named protobuf session files. The connector
  reads filenames and `stat` metadata only.
- **ChatGPT Atlas** exposes UUID-named `.data` files under account-scoped
  `conversations-v3-*` directories. The connector reads filenames and `stat` metadata
  only.
- **VS Code chat/Copilot** exposes UUID-named chat JSON files per workspace. The body is
  never opened; only the separate `workspace.json` folder locator is allowlisted.
- **Cline** exposes 13-digit millisecond task directories containing
  `api_conversation_history.json` and `ui_messages.json`. The connector stats those two
  known files without opening them and retains 4 task ids with History locate hints.
- **Augment Code** exposes its session reference as the `augment.sessions` VS Code
  SecretStorage key, while visible local files are cache/user assets. No credential
  access, safe metadata index or documented session deep link was found, so its
  installed surface is an explicit `unsupported` row pointing to Augment History.

The filename-only connectors are intentionally `degraded`, not `ok`: they solve recall
and return-path coverage while making the missing title/live-state contract explicit.
On the deployed machine they represent 426 Cursor work items (including 9 merged CLI
resume sources), 4 Windsurf, 5 Antigravity, 118 Atlas, 1 VS Code and 4 Cline source ids.
Ollama had models/logs but no session ledger; OpenCode had config only and no installed
CLI/share directory; Gemini CLI was absent and its non-Antigravity footprint contained
settings/instructions only. Those are audit exclusions rather than zero-session claims.

The desktop cache surfaces are registered and report:

```
degraded  Claude Desktop chat history       30 recent sessions, has_more=true; live lifecycle is not exposed…
degraded  Claude cross-device agent sessions 13 in window, +36 older/archived; has_more=true…
degraded  ChatGPT Desktop history           20 of 21 account sessions; ordinary lifecycle is unavailable…
degraded  Cursor Agent desktop + CLI         426 older; 9 merged CLI resume paths; 67 encoded rows and 972 non-session-safe rows excluded…
degraded  Windsurf Cascade sessions         4 older; protobuf bodies deliberately unopened…
degraded  Antigravity conversations         5 older; protobuf bodies deliberately unopened…
degraded  ChatGPT Atlas conversations       118 older; .data bodies deliberately unopened…
degraded  VS Code persisted chat sessions   1 older; chat JSON body deliberately unopened…
degraded  Cline tasks (VS Code)              4 older; conversation JSON bodies deliberately unopened…
unsupported Augment Code sessions (VS Code) session reference is in SecretStorage; use Augment History…
```

The observable cache/file inventories are `degraded` because they are bounded or lack
lifecycle. Ordinary Claude chat lacks lifecycle; ChatGPT has only the async 3/4 subset;
Claude's agent page has strong lifecycle but is paginated and
cache-freshness-dependent. Augment is `unsupported` for the distinct reason above.
Coverage auto-expands in the dashboard, so neither partial nor unsupported results can
look complete. If another app is not installed at all, its connector reports
`unsupported` with the reason.
