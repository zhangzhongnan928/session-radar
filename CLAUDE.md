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
| `stale.no-progress` | No writes **and** no heartbeat past the surface threshold. |
| `stale.no-evidence` | Defensive: an item exists but nothing was ever observed. |

Behaviours that are deliberate and should not be "fixed":

- **An unanswered block never ages out.** A permission prompt from two hours ago still
  needs Victor; ageing it into `stale` would hide real work.
- **`process_alive` is liveness, not progress.** A CLI process idle for 11 minutes is
  stale even though `ps` still lists it.
- **Staleness requires no writes AND no heartbeat**, so a long silent tool run stays
  `running` as long as hooks keep pinging.
- **There is no global timeout.** Thresholds are per surface: CLI 10 min, web/desktop
  15 min ([config.ts](packages/shared/src/config.ts)).

---

## Collectors (M1)

**Claude Code CLI.** Two independent paths. The poller reads
`~/.claude/projects/<slug-cwd>/<session-uuid>.jsonl` (the filename *is* the session id)
and the process table. Hooks POST directly to the daemon using Claude Code's
`type: "http"` handler — no curl subprocess, no shell quoting to get wrong.

**Codex CLI.** The poller reads `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
Titles come from `event_msg/user_message`, which is what Victor actually typed —
the `response_item` stream also carries user-role messages, but those include
tool-injected context and produced pages of identical titles.

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

## The browser extension (M2)

```bash
cd packages/extension && pnpm build
# chrome://extensions -> Developer mode -> Load unpacked -> packages/extension/dist
```

The manifest embeds a fixed public key, so the extension id is always
`mdbfiohpejlnjbeebkmplfhiommkaonf` and the daemon allowlists exactly that origin —
no other extension can post to it. `SESSION_RADAR_EXTENSION_IDS=<id>,…` allows extra
ids when developing against a differently-keyed build.

**Content script observes, service worker reports.** The content script never touches
the network: a content-script `fetch` inherits the page's CORS, and routing through the
worker is what gives the daemon a `chrome-extension://` origin worth allowlisting. It
also keeps the content script tiny — 8.8 kB, because it imports
`@session-radar/shared/pure` rather than the zod-carrying barrel (130 kB).

**Selectors live in one versioned file per site**
([claude.ts](packages/extension/src/sites/claude.ts),
[chatgpt.ts](packages/extension/src/sites/chatgpt.ts)) with a `selfTest` that checks
structural anchors on every read. Anchors that only exist in some states — a stop
button appears only while streaming — are marked `transient` and cannot raise a false
alarm. When a real anchor goes missing the connector degrades and says exactly which,
so the fix is a one-file change and a version bump.

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

**Desktop surfaces appear here as `unsupported` with their reasons.** That is the M3
verdict made visible rather than a gap you have to notice yourself.

## The CLI

```bash
pnpm radar status      # every work item, with evidence and coverage
pnpm radar scan        # one-shot collection, no daemon needed
pnpm radar doctor      # paths, permissions, daemon reachability
```

`status` prefers a running daemon and falls back to reading the local store directly.

## History window

Only sessions touched in the last **7 days** are triaged. Older ones are counted and
reported as `archivedSessionCount` — "26 in window, +20 archived" — so the boundary is
visible rather than silent. This is also the difference between a 25-second first scan
and a sub-second one on a machine with a long archive.

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

Read-only API:

| Route | Purpose |
| --- | --- |
| `GET /api/health` | version, uptime, db path/mode/journal/schema version |
| `GET /api/coverage` | per-connector health + `overall` rollup |
| `GET /api/workitems` | all items in scan order, **with coverage bundled in** |
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
| **M1** CLI collectors (Claude Code, Codex) | **complete** | `scripts/test-m1.sh` 22/22; running on real sessions |
| **M2** Browser extension collector | **complete** | `scripts/test-m2.sh` 25/25; selectors unverified against live sites — see risk 13 |
| **M3** Desktop app spike | **complete** | Both `unsupported`, with evidence — [docs/m3-desktop-feasibility.md](docs/m3-desktop-feasibility.md) |
| **M4** Minimal dashboard | **complete** | `scripts/test-m4.sh` 17/17; running on real data |

All four gates: **81 acceptance checks, 0 failures.** 277 unit/integration tests.

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
2. **The DOM selectors in the extension have NOT been verified against live,
   logged-in claude.ai and chatgpt.com pages.** They are best-effort. This is why every
   adapter ships a `selfTest`: until the anchors are seen in a real page the connector
   reports `degraded` and names the missing anchors, rather than reporting an
   unreadable page as a finished conversation. See [VERIFIED.md](VERIFIED.md).
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
9. **The install path contains spaces** (`/Users/victorzhang/AI Session Status Dashboard`).
   Tests and scripts handle it, and `index.ts` uses `pathToFileURL` rather than string
   concatenation for its entry-point check. Any launchd plist or hook command written in
   M1 **must** quote paths.
10. **The poller cannot associate a CLI process with a specific session** — neither CLI
    puts its session id in argv, so liveness is matched by cwd via `lsof`. Two sessions
    in one directory are indistinguishable to the process probe. This is why liveness is
    only ever a qualifier that can mark a session dead, never one that marks it as making
    progress.
11. **Hook firing has not been observed end-to-end from a real `claude` process.** The
    ingest path is proven over real HTTP with the documented payload shapes, and the
    installer is proven to merge correctly, but nobody has yet watched a live Claude Code
    session fire a hook into the daemon. Run `pnpm radar install-hooks --apply`, restart a
    session, and watch `pnpm radar status` to close this.
12. **`SESSION_RADAR_STALE_CLI_MS`, `SESSION_RADAR_STALE_WEB_MS`, `SESSION_RADAR_SWEEP_MS`
    and `SESSION_RADAR_PROBE_PROCESSES`** override thresholds and probing. The acceptance
    script uses them to prove a `running -> stale` transition in seconds.
13. **Extension selectors are unverified against the live sites**, and cannot be verified
    from here — it needs a logged-in browser session. The `selfTest` mechanism is proven
    (21 tests over DOM fixtures) and will report the truth once loaded; what is unproven
    is whether the specific selectors match today's markup. Expect `degraded` with named
    anchors on first load, and treat that as the system working.
14. **The extension has never been loaded into Chrome.** The daemon side is proven
    end-to-end over real HTTP with the real extension origin, but no one has watched the
    built extension run in a browser.
15. **Codex web (`chatgpt.com/codex/*`) is parsed as a chatgpt-web conversation.** Whether
    a Codex web task exposes the same generating/blocked/completed affordances as a chat
    is unverified.
16. **On real data the dashboard is dominated by `stale`** — on this machine, 182 of 183.
    That is accurate (most sessions really are abandoned) but it means the filters and
    the scan-order grouping are doing the real work, not the list itself. If the
    `needs_victor` and `done+unseen` groups are empty, the honest reading is "nothing
    needs you", and the 182 below are history.
17. **Nothing has been observed end-to-end through a browser except by screenshot.** The
    dashboard was verified rendering real data headlessly; no one has clicked a Seen
    toggle or a deep link in a real browser session.
