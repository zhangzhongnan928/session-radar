# session-radar

A read-only, local-first dashboard that discovers AI sessions across multiple tools on
this Mac, normalizes them into four states, dedupes cross-surface duplicates, and shows
Victor in under 30 seconds what is **Running**, what **Needs Victor**, what is **Done**,
and what is **Stale**.

**It is not** a notification centre, an orchestrator, a prompt sender, or a project
manager. Its differentiator is *coverage trustworthiness*: it must never silently miss a
session. A broken collector surfaces as a visible Coverage Health error — never as an
empty list.

---

## Hard boundaries

These are not preferences. Code that violates one is wrong.

1. **Read-only against every source.** No sending prompts, approving permissions,
   cancelling runs, logging in, or writing cookies.
2. **All data stays local.** SQLite at `~/.session-radar/db.sqlite`, mode `0600`, in a
   `0700` directory. No outbound network except `127.0.0.1`.
3. **A dead connector is a Coverage Health incident** — never `stale`, never silence.
4. **Never fabricate status.** If a signal source cannot be verified (file path, hook
   name, DOM selector), mark it degraded in Coverage Health and say so in the milestone
   report. Unverifiable assumptions go in *Open risks* below, not into the code.
5. **Metadata only.** The single exception is the first 120 characters of the first user
   message, read locally, to build a display title. Enforced by `deriveTitle`
   ([title.ts](packages/shared/src/title.ts)) — nothing else may read message content.
6. **Never destructively edit Victor's tool configs.** Hooks and `config.toml` entries are
   merged, never overwritten, and backed up first.

---

## Architecture

```
Sources (CLI / Web / Desktop)
  -> per-source Collectors      isolated, versioned, crash-independent
  -> Normalizer + Identity      canonical key, cross-surface dedup
  -> Status Engine              evidence-based, confidence + named rule
  -> Local event store          SQLite, WAL, 0600
  -> Read-only Dashboard        + Coverage Health + deep-link resolver
```

| Package | Contents |
| --- | --- |
| `packages/shared` | Event model (zod), signal registry, status engine, identity/dedup, scan order, API wire types |
| `packages/daemon` | Migrations, store, connector registry, HTTP + SSE API |
| `packages/extension` | Chrome MV3 collector for claude.ai + chatgpt.com |
| `packages/dashboard` | React UI, served by the daemon at `/` |
| `scripts/` | Milestone acceptance scripts, launchd install |

---

## Event model

Every timestamp is **epoch milliseconds** (integer). No ISO strings anywhere in the model.

- **`Source`** — one tool, on one device, for one account.
- **`WorkItem`** — one unit of work Victor cares about. Holds *all* `entryPoints`, so a
  conversation seen in the CLI, the web app and the desktop app is one item with three
  ways back into it.
- **`StatusEvidence`** — why an item has the status it has: `signal`, `rule`,
  `confidence`, `resultingStatus`. Queryable at `/api/workitems/:id/evidence`.
- **`StatusTransition`** — the status history.
- **`CoverageHealth`** — per-connector: `ok | degraded | down | unsupported`.

**Statuses are exactly four**: `running | needs_victor | done | stale`.
`attention` (`seen | unseen`) is a separate dashboard-local property and is **never** a
fifth status.

**Identity**: the canonical key is `(provider, conversationId|sessionId)`. The fingerprint
fallback (`account + normalized title + 5-min bucket`) is only for surfaces with no stable
id, and the `mergeBasis` is always recorded so a bad merge is debuggable.

---

## Status engine

Connectors never decide status. They report **named signals** from the registry in
[signals.ts](packages/shared/src/signals.ts); [status.ts](packages/shared/src/status.ts)
decides. Evidence priority is `explicit source signal > UI/process signal > time heuristic`.

Rules, in the order they fire:

| Rule | Meaning |
| --- | --- |
| `needs_victor.blocking-signal` | **Absolute priority.** Any block flips the item, even if activity continues. |
| `done.source-confirmed` | The source confirmed completion and nothing has happened since. |
| `running.live-activity` | Progress inside the surface's window, no outstanding block. |
| `stale.process-dead-no-completion` | The process or tab went away without confirming completion. |
| `stale.web-abandoned` | A web conversation was left mid-generation. |
| `stale.inventory-only` | The conversation is discoverable, but that source exposes no live lifecycle. |
| `stale.no-progress` | No writes **and** no heartbeat past the surface threshold. |
| `stale.no-evidence` | Defensive: an item exists but nothing was ever observed. |

Behaviours that are deliberate and should not be "fixed":

- **An unanswered block never ages out.** A permission prompt from two hours ago still
  needs Victor; ageing it into `stale` would hide real work.
- **`process_alive` is liveness, not progress.** A CLI process idle for 11 minutes is
  stale even though `ps` still lists it.
- **`inventory` is discovery, not progress.** A recent-list timestamp may sort a
  conversation correctly without implying that it is currently generating.
- **Staleness requires no writes AND no heartbeat**, so a long silent tool run stays
  `running` as long as hooks keep pinging.
- **There is no global timeout.** Thresholds are per surface: CLI 10 min,
  web/desktop/mobile 15 min ([config.ts](packages/shared/src/config.ts)).

---

## Collectors (M1)

**Claude Code CLI.** Two independent paths. The poller reads
`~/.claude/projects/<slug-cwd>/<session-uuid>.jsonl` (the filename *is* the session id)
and the process table. Hooks POST directly to the daemon using Claude Code's
`type: "http"` handler — no curl subprocess, no shell quoting to get wrong.

**Codex sessions.** The poller reads
`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. The same format is used by
Codex Desktop, CLI, the Chrome side panel and Buzz; `session_meta.originator` classifies
the surface, while `event_msg/task_started|task_complete|turn_aborted` provides
source-native lifecycle state.
Titles come from `event_msg/user_message`, which is what Victor actually typed —
the `response_item` stream also carries user-role messages, but those include
tool-injected context and produced pages of identical titles.

**Grok Build.** The poller reads only
`~/.grok/sessions/<encoded-cwd>/<session-id>/summary.json` plus the TUI-only
`active_sessions.json` registry. Inventory is never treated as progress.
Documented global HTTP hooks provide explicit prompt, tool, notification, stop,
failure, subagent, and session lifecycle. Unknown event/notification values
degrade coverage instead of being guessed. Message streams, tool payloads, logs,
analytics, and `auth.json` are never opened.

**Titles never cost more privacy than they must.** Priority: Claude Code's
`custom-title` record or a hook's `session_title` (zero message content) → the first
user message truncated to 120 chars → `repo · <session-id-suffix>`. Injected context
(`<system-reminder>`, `# Files mentioned…`, `[Base] You are…`) is rejected outright.

**Hook installation is opt-in and non-destructive.**

```bash
pnpm radar install-hooks          # dry run: shows exactly what changes
pnpm radar install-hooks --apply  # backs up, then merges
pnpm radar uninstall-hooks --apply
```

Claude Code hooks are *appended* as new matcher groups — existing hooks are never
opened or edited. Codex allows only ONE notify program, so instead of replacing it we
install a dispatcher that runs the original first, with its argv and exit code intact,
and reports to session-radar afterwards in the background. If the notify line is any
shape we cannot rewrite safely, we refuse and say so rather than risk the config.
Grok Build receives a dedicated global `~/.grok/hooks/session-radar.json`; the
installer updates only files it can prove contain session-radar handlers and refuses
foreign content.

## The browser extension (M2)

```bash
cd packages/extension && pnpm build
# chrome://extensions -> Developer mode -> Load unpacked -> packages/extension/dist
```

The manifest embeds a fixed public key, so the extension id is always
`mdbfiohpejlnjbeebkmplfhiommkaonf` and the daemon allowlists exactly that origin —
no other extension can post to it. `SESSION_RADAR_EXTENSION_IDS=<id>,…` allows extra
ids when developing against a differently-keyed build.

**Three deliberately separate layers.** The isolated content script observes
versioned DOM state and metadata-only history links. A main-world bridge uses ambient
same-origin credentials against each site's own metadata list endpoints; it never reads
cookies, storage or access tokens. ChatGPT responses are projected onto
id/title/time/archive/URL/async-status. Claude's bootstrap response is reduced to
verified chat-capable organization UUIDs before the bridge paginates the ordinary-chat
list and projects only id/title/time/archive/URL. Known Claude list summaries are
dropped; any unexpected message-bearing structure rejects the row. The service worker
also fetches Claude's separate agent/Cowork list once a minute, but immediately projects
its content-bearing response onto controlled ids, titles, timestamps, lifecycle enums,
archive state and exact `/cowork/<session-id>` URLs. It paginates active+paused and
archived buckets by opaque cursor for every chat-capable organization. The worker alone
posts the sanitized report to the daemon, which gives that write a pinned
`chrome-extension://` origin. Each site's latest account snapshot uses
`storage.session` only so MV3 worker suspension cannot silently erase coverage.

**Selectors live in one versioned file per site**
([claude.ts](packages/extension/src/sites/claude.ts),
[chatgpt.ts](packages/extension/src/sites/chatgpt.ts)) with a `selfTest` that checks
structural anchors on every read. Anchors that only exist in some states — a stop
button appears only while streaming — are marked `transient` and cannot raise a false
alarm. When a real anchor goes missing the connector degrades and says exactly which,
so the fix is a one-file change and a version bump. Logged-in list links were checked
on 29 July 2026: ChatGPT's rendered sidebar is a fixed recent window; Claude's `/chats`
table exposes exact links and times but lazy-loads as it scrolls. Both DOM inventories
therefore remain explicitly partial.

**History completeness is data, not an implication.** ChatGPT account pagination is
`complete` only when both active and archived endpoints reach their advertised totals
without schema rejects or the 1,000-row safety cap. Claude is `complete` only when its
same-origin bootstrap proves a verified membership, every chat-capable organization
finishes both starred and non-starred pagination at `has_more=false`, and no row is
rejected or capped. Claude history still carries no ordinary-chat lifecycle. Rows with
no source timestamp receive activity time `0`, stay out of seven-day triage, and render
as `time unknown` rather than “just now”.

**The heartbeat IS the coverage.** The worker reports every 15s whether or not
anything changed. No report for 60s means Chrome is closed or the extension is
disabled, and the connector goes `down` — because a browser we cannot see is a
coverage hole, not an empty list.

## The dashboard (M4)

```bash
pnpm --filter @session-radar/dashboard build   # then open http://127.0.0.1:4747
```

One screen. Header counts double as status filters. The Coverage strip sits above the
list and auto-expands whenever anything is not `ok`, because a coverage hole you have
to click to discover is a coverage hole you will miss.

Rows are grouped in scan order and each one carries: the inferred title, the status, the
evidence one-liner *in plain English* plus its rule and confidence in monospace, source
badges for every entry point, the context (repo or conversation), how long ago, and a
way back in — a deep link, a copyable resume command, or a locate hint.

Live via SSE, with a 30s poll as a backstop in case the stream dies quietly. Relative
timestamps re-render on a timer without refetching.

The default view stays focused on active work plus the last seven days. A running or
needs-you item never disappears solely because its last activity is old. The activity
selector can switch to **All indexed history**, which asks the daemon for every work
item retained in its local SQLite ledger. Locally enumerable archive rows are backfilled incrementally:
connectors parse each missing old transcript/cache record once, retain it in SQLite,
and skip it on later scans. Coverage’s “+ older/archived” count is therefore a triage
boundary, while vendor cache limits and parse warnings remain genuine missing-history
boundaries.

Acknowledgement is a recall ledger, not a permanent mute. Done and stale/status-unknown
rows can be acknowledged and are grouped separately. If a vendor-native activity
timestamp advances, a same-status `done -> done` completion or `stale -> stale`
inventory update becomes unseen again. Collector polling alone cannot reopen it. The
“Unknown · unseen” count filters directly to that review queue without adding a fifth
status or pretending the unknown chat is complete.

**Ordinary Claude and ChatGPT Desktop history is visible but lifecycle-degraded.**
Their recent-list caches supply stable ids, titles and timestamps. Claude rows route to
`https://claude.ai/chat/<id>`; ChatGPT rows use `codex://threads/<id>`. Claude ordinary
chat remains inventory-only. ChatGPT additionally persists a narrow asynchronous-task
state: verified value 3 means streaming and 4 means a result is ready/unread; other
values are never guessed. Both bounded caches disclose their inventory limits in
Coverage Health rather than implying complete account history.

**Claude cross-device agent sessions are a separate, stronger surface.** The
v0.0.5 page bridge paginates Claude's own `/v1/code/sessions` metadata endpoint across
active+paused and archived buckets. It reports running/idle plus post-turn
`need_input`/`review_ready`; `bridgeSessionIds` in local Code metadata explicitly joins
normalized cloud `session_…` ids to CLI UUIDs. Content-bearing task, source, outcome and
post-turn detail is stripped before the page response crosses the bridge. A fresh
complete web snapshot supersedes the stale one-page Desktop cache; partial/unavailable
web state retains the cache and both gaps remain visible. Every remote source gets the
proven `https://claude.ai/cowork/<session-id>` return path.

**Other installed desktop interfaces are explicit collectors, not silent gaps.**
Cursor is read from `state.vscdb` in read-only/query-only mode through a fixed allowlist
of composer id, source title, timestamps, workspace and lifecycle fields. Its
conversation/bubble/agent-KV data is never selected. Current pending decisions,
generating work and terminal completed/aborted states map to named Cursor signals. The
9 top-level Cursor Agent CLI transcript ids are an exact subset of those composer ids;
their filename presence adds a `cursor-agent --resume <chatId>` CLI entry point without
opening JSONL or duplicating work items. Windsurf Cascade, Antigravity, ChatGPT Atlas,
VS Code chat and Cline currently expose only stable content-bearing files/task
directories without a separately verified lifecycle index. Those connectors therefore
read filenames and filesystem metadata only (plus VS Code's separate workspace
locator), attach a locate hint, and remain visibly `stale.inventory-only`/degraded
instead of guessing. Augment is registered as explicit `unsupported`: its only
session-related local reference is the `augment.sessions` VS Code SecretStorage key,
not a metadata-safe inventory.

## The CLI

```bash
pnpm radar status      # every work item, with evidence and coverage
pnpm radar scan        # one-shot collection, no daemon needed
pnpm radar doctor      # paths, permissions, daemon reachability
```

`status` prefers a running daemon and falls back to reading the local store directly.

## History window

Sessions touched in the last **7 days**, plus every older item still classified as
`running` or `needs_victor`, are triaged by default. The dashboard’s **All indexed
history** scope can retrieve every other older row already retained in the local ledger
without changing that fast default. Connectors count source rows outside the source
window as `archivedSessionCount` — "26 recent, +20 older/archived" — and backfill
locally enumerable missing ids once. Explicit vendor archive state is stored per source,
so a recently updated archived chat stays in all-history without leaking back into
triage; a merged item remains triage-visible if any other source is active.
Vendor caches that advertise incomplete pagination still prevent a complete remote
account archive.

## Running it

```bash
pnpm install
pnpm build
pnpm test
```

Start the daemon (listens on `http://127.0.0.1:4747`):

```bash
pnpm dev
```

Install the built daemon as a persistent, owner-only macOS LaunchAgent:

```bash
pnpm radar install-daemon          # dry run
pnpm radar install-daemon --apply  # load now and restart automatically
```

Read-only API:

| Route | Purpose |
| --- | --- |
| `GET /api/health` | version, uptime, db path/mode/journal/schema version |
| `GET /api/coverage` | per-connector health + `overall` rollup |
| `GET /api/workitems` | active plus seven-day triage items in scan order, **with coverage bundled in** |
| `GET /api/workitems?history=all` | every item retained in the local ledger, in the same scan order |
| `GET /api/workitems/:id` | one item |
| `GET /api/workitems/:id/evidence` | full evidence + transition history |
| `GET /api/events` | SSE: `hello` snapshot, then live changes |

`/api/workitems` always carries the coverage verdict so no client can render a
confident-looking empty list while the radar is blind.

**Environment**: `SESSION_RADAR_HOME` (default `~/.session-radar`),
`SESSION_RADAR_PORT` (default `4747`), `SESSION_RADAR_LOG_LEVEL`.

---

## Milestone status

| Milestone | State | Notes |
| --- | --- | --- |
| **M0** Scaffold + event model + store | **complete** | `scripts/test-m0.sh` 17/17 |
| **M1** CLI collectors (Claude Code, Codex, Grok Build) | **complete** | Grok inventory and first-party hook lifecycle are covered by connector, installer, ingest, and privacy tests |
| **M2** Browser extension collector | **complete and live** | v0.0.5 is loaded in the authenticated Chrome profile; Claude ordinary and agent account pagination is live, while ChatGPT's credential-bound account-list contradiction is explicitly partial rather than falsely complete |
| **M3** Desktop app spike | **complete** | Coding-agent desktop sessions plus Cursor lifecycle solved; Claude cross-device agent lifecycle added; remaining desktop inventories are explicit and bounded/degraded |
| **M4** Minimal dashboard | **complete** | `scripts/test-m4.sh` 17/17; running on real data |

All four original gates remain in place. Current suite: **412 unit/integration tests**.

```bash
pnpm test:m0 && pnpm test:m1 && pnpm test:m2 && pnpm test:m4
```

Gate: after each milestone, run its acceptance script, report, then wait for `GO M<n+1>`.

---

## Open risks

Named honestly rather than assumed away.

1. **"Encrypted at rest" is FileVault + `0600`, not SQLCipher.** The architecture calls the
   store "encrypted at rest"; v0 ships filesystem permissions and whole-disk encryption
   only. Anyone with the logged-in user's session can read the database. Revisit if the
   data ever grows beyond metadata.
2. **Claude web account pagination is an internal first-party contract, not a supported
   public API.** v0.0.5 uses verified, chat-capable memberships from `/api/bootstrap`
   and no longer requires the removed `resolved_org_uuid` field; it paginates
   `chat_conversations_v2` through starred/non-starred history. The live authenticated
   collector returned 801 complete account rows. The bridge uses ambient credentials
   without reading cookies, tokens or storage, but future drift must still degrade
   loudly rather than be assumed compatible.
3. **The scan timeout stops us waiting; it cannot cancel work already running inside a
   connector.** Connectors must honour `ctx.signal` for real cancellation, or a wedged
   connector leaks a pending promise per scan.
4. **`uncaughtException` does not exit the daemon.** Deliberate — a collector crash must not
   black out the whole radar — but it can leave the process in an inconsistent state. If
   this ever masks a real bug, move to a supervised restart instead.
5. **SSE has no replay buffer.** A client that disconnects misses events until it
   reconnects; it recovers via the `hello` snapshot rather than by replaying. Acceptable
   for a single local dashboard, not for anything more.
6. **The fingerprint hash is 32-bit FNV-1a.** Collisions are possible in principle. It is
   only ever a fallback for surfaces with no stable id, and the basis is recorded.
7. **Merge basis is stored on `source_refs`, not yet as a `StatusEvidence` row.** The spec
   asks for the merge basis to be recorded as evidence; M1/M2 should emit an evidence row
   when two sightings merge.
8. **Node 23.3.0 is in use** (assumption said Node 20+). `better-sqlite3` installed from a
   prebuild, no compile needed. The launchd agent in M1 should pin an explicit Node path.
9. **The install path may contain spaces** (for example, `/Users/tester/AI Session Status Dashboard`).
   Tests and scripts handle it, and `index.ts` uses `pathToFileURL` rather than string
   concatenation for its entry-point check. Any launchd plist or hook command written in
   M1 **must** quote paths.
10. **The poller cannot associate a CLI process with a specific session** — neither CLI
    puts its session id in argv, so liveness is matched by cwd via `lsof`. Two sessions
    in one directory are indistinguishable to the process probe. This is why liveness is
    only ever a qualifier that can mark a session dead, never one that marks it as making
    progress.
11. **Codex notify is supplementary, not authoritative.** Hooks were installed on
    29 July 2026 and live Claude `PostToolUse` events were observed end-to-end. Current
    Codex Desktop builds sometimes omit `session-id` from notify payloads; those packets
    are harmlessly ignored because persisted rollout lifecycle events carry the status.
11a. **Grok Build inventory is supplementary, not lifecycle.** `summary.json` and
    `active_sessions.json` solve recall and TUI liveness, but do not prove progress.
    Coverage remains degraded until the exact global HTTP hooks are installed.
12. **`SESSION_RADAR_STALE_CLI_MS`, `SESSION_RADAR_STALE_WEB_MS`, `SESSION_RADAR_SWEEP_MS`
    and `SESSION_RADAR_PROBE_PROCESSES`** override thresholds and probing. The acceptance
    script uses them to prove a `running -> stale` transition in seconds.
13. **Extension selectors remain version-sensitive.** Logged-in history link shapes
    were checked on 29 July 2026 and lifecycle anchors remain self-testing. Future DOM
    changes intentionally become named degraded-coverage incidents.
14. **Unpacked extension updates still require a manual Chrome Reload.** v0.0.5 is
    currently loaded and live-verified. A future bundle change will not affect already
    open pages until the extension is reloaded and those pages are refreshed; the
    daemon names the reporting version and treats missing inventory as degraded.
15. **Codex web (`chatgpt.com/codex/*`) is parsed as a chatgpt-web conversation.** Whether
    a Codex web task exposes the same generating/blocked/completed affordances as a chat
    is unverified.
16. **Historical sessions still outnumber active ones**, but the main API defaults to
    the seven-day window and offers an explicit `history=all` local-ledger view.
    `running` is above stale history, and the first completion inventory is baselined
    as acknowledged. Future completions and newly updated status-unknown chats return
    to unseen; unchanged collector scans do not.
17. **Dashboard filters are verified, source actions are not.** The local page was
    exercised in the in-app browser against real data, including Web and Mobile
    filtering. No one has clicked a Seen toggle or a source deep link in that live
    browser session.
18. **Claude cross-device agent account pagination is an internal first-party contract.**
    The live v0.0.5 collector completed cursor pagination on `/v1/code/sessions` with
    the required headers and active/paused/archived filters. It currently contributes
    96 account sessions and the connector is `ok`; auth, cursor, schema, cap,
    rejected-row and unknown-enum failures still degrade rather than silently falling
    back to a clean empty list.
19. **ChatGPT ordinary-chat inventory and lifecycle remain partial.** In the current
    account, a cookie-only page fetch reports a contradictory complete `0 of 0`, while
    ChatGPT's own authorization/account-header request and rendered sidebar expose 28
    conversations. The daemon now rejects that false completeness and says exactly why.
    Reading or replaying ChatGPT's in-memory authorization headers is outside the
    metadata-only credential boundary, so older/project history remains partial.
    Persisted async values 3 and 4 still cover background streaming and ready/unread;
    ordinary renderer `idle | streaming | error` and blocked-on-user state are
    available only while a tab is open.
20. **Each ordinary-chat and Claude-agent account inventory has a 1,000-row safety cap.**
    Hitting either makes completeness `partial` and raises Coverage Health. Neither
    truncates silently nor permits an unbounded authenticated crawl.
21. **Cursor's composer schema is an internal first-party contract.** The current
    installed bundle and database agree on the lifecycle fields, but Cursor could change
    those keys or encodings without notice. Unknown values, 67 currently non-JSON
    records and rows without safe session metadata remain visible Coverage degradation;
    the connector never falls back to reading conversation bodies.
22. **Filename-only desktop inventories prove existence, not lifecycle.** Windsurf,
    Antigravity, ChatGPT Atlas, VS Code and Cline expose stable-looking ids/files, but
    their bodies are deliberately unopened. These connectors solve recall and
    return-path coverage only; they cannot truthfully supply source titles, running,
    needs-you or done until a separately verified metadata contract exists.
23. **Augment is installed but its session list is not safely observable.** The local
    state names `augment.sessions` only through VS Code SecretStorage; visible files are
    cache/user assets, and no documented per-session deep link was found. The connector
    must remain `unsupported` and must not read credentials to make the gap disappear.
