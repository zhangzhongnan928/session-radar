# M3 — Desktop app feasibility

**Verdict: both apps are `unsupported`.** Investigated July 2026 on Victor's Mac
(macOS 26.5.2, arm64), with both apps installed and running.

This is a real finding, not a shrug. Both surfaces are registered in Coverage Health as
`unsupported` with the reasons below, so the blind spot is visible in the dashboard
rather than left for Victor to discover on his own.

---

## Claude Desktop — `unsupported`

**Installed:** `/Applications/Claude.app`, running during the investigation.
**Data:** `~/Library/Application Support/Claude/`

### What is actually there

The app is Electron and loads claude.ai in a webview. Its storage is Chromium's:

| Path | Contents |
| --- | --- |
| `IndexedDB/https_claude.ai_0.indexeddb.leveldb/` | The conversation store |
| `Local Storage/leveldb/` | 3.6 MB of session state |
| `~/Library/Logs/Claude/claude.ai-web.log` | 1.8 MB, live |

### Why it cannot be observed

1. **The LevelDB is held open by the running app.** `lsof` confirms the app holds
   `LOCK` while running. Reading it live risks corruption; reading it safely means
   copying a multi-megabyte store on every scan.
2. **The format is undocumented and version-specific.** Chromium wraps IndexedDB values
   in an envelope whose encoding changes between Chromium releases. Decoding it needs a
   LevelDB dependency plus reverse-engineering that would break on any Electron bump —
   the opposite of a connector you can trust.
3. **Even if decoded, it would not answer the question.** IndexedDB holds conversation
   *content*, not UI state. Nothing there says "an approval dialog is open" or "a
   response is streaming". We would gain titles and timestamps and still be unable to
   tell `needs_victor` from `done` — which is the entire point of this product.
4. **The log is errors only.** 3,000 recent lines contain zero conversation ids and
   zero navigation events; every line is an `[error]` record.

### The solution: Chrome DevTools Protocol

Claude Desktop is Electron (42.7.0 / Chrome 148) and its binary carries both
`remote-debugging-port` and `remote-debugging-pipe`. Launched with a debug port, the
claude.ai webview is fully inspectable over CDP:

```
/Applications/Claude.app/Contents/MacOS/Claude --remote-debugging-port=9222
```

This is a known, community-validated technique rather than a novel hack — see
[jedi.be, Automating Claude Desktop via CDP](https://jedi.be/blog/2026/automating-claude-desktop-via-chrome-devtools-protocol/),
which uses it for MutationObserver-based response capture and dialog automation, and
vercel-labs' `agent-browser` electron skill, which generalises it.

For session-radar it would mean evaluating the **same site adapter already written for
the Chrome extension** against the desktop webview: conversation id from `location.href`,
plus generating/blocked/completed from the same anchors. One selector file would then
serve both surfaces.

**The trade-off, which is real.** An open debug port lets any local process fully control
the app: read cookies, execute JS, extract conversation content. The jedi.be author
flags the same concern. If built, it must be:

- opt-in behind an explicit flag, never on by default;
- declared in the Coverage strip so the exposure is visible while it is active;
- ideally `--remote-debugging-pipe` instead, which uses a file descriptor and opens no
  socket at all — but that requires the daemon to launch Claude as a child process,
  which fights how a GUI app is normally opened.

Until that trade-off is accepted, the verdict stays `unsupported`.

### Mitigation available today

Claude Desktop shows the same claude.ai conversations, under the same conversation ids.
Opening one in Chrome puts it under the M2 extension, and the identity engine merges it
into the same WorkItem. The desktop app is a blind spot, not a hole in coverage of the
underlying conversations.

---

## ChatGPT for macOS — `unsupported`

**Installed:** `/Applications/ChatGPT.app`, running during the investigation.
**Data:** `~/Library/Application Support/com.openai.chat/`

### What is actually there

| Path | Contents |
| --- | --- |
| `conversations-v3-<accountId>/<uuid>.data` | 80 files, one per conversation |
| `defaults read com.openai.chat` | Preferences, including `lastSelectedConversation` |

The filenames are lowercase UUIDs matching the chatgpt.com conversation id format, and
their mtimes are meaningful.

### Why the files are encrypted — this matters

The encryption is not incidental. In July 2024 Pedro José Pereira Vieito disclosed that
ChatGPT for macOS stored every conversation in **plain text** in exactly this directory,
unsandboxed and readable by any local process. He published `ChatGPTStealer` to
demonstrate it. OpenAI shipped 1.2024.171 in response, moving conversations to
`conversations-v2-<uuid>/` encrypted with a key (`com.openai.chat.conversations_v2_cache`)
held in the macOS Keychain.

So the store session-radar would need to read is encrypted **specifically to stop local
processes like session-radar reading it**. Decrypting it would mean extracting a Keychain
item that exists to prevent exactly this, and re-opening a disclosed and patched
vulnerability. That is a firm no, independent of whether it is technically achievable —
"read-only, metadata only" is not a licence to defeat another vendor's security fix.

### Why it cannot be observed

1. **The conversation files are encrypted at rest.** Sampled files begin
   `857a0da4…`, `dd076b0f…`, `243097a8…` — no shared magic number, no plist or protobuf
   structure, and `strings` yields nothing but noise. Per-file encryption, key almost
   certainly in the Keychain. Attempting to extract that key would be both fragile and
   a straightforward violation of "read-only, metadata only".
2. **What IS readable is not enough.** Filenames plus mtimes give "conversation X was
   touched at time T". There is no completion signal, no blocking signal, no liveness.
   Every conversation would land on `stale` forever.

### The partial signal we found and deliberately did NOT use

`defaults read com.openai.chat` exposes `lastSelectedConversation`, containing a
conversation id and a `lastUpdated` timestamp. It is genuinely readable, and it was
tempting.

It was rejected for two reasons:

- **It cannot produce a status.** Knowing which conversation is on screen says nothing
  about whether it is generating, blocked or finished. It would create work items whose
  only possible status is `stale`.
- **The id is in a different namespace.** The value observed was an uppercase *local*
  UUID (`42BE948E-…`), while the conversation files use lowercase server-style UUIDs.
  Merging on it would risk creating duplicate WorkItems for one conversation — worse
  than the gap it would close.

Adding 80 permanently-stale rows to a dashboard whose job is "what needs me in the next
30 seconds" would make the product worse, not more complete. The honest move is to say
we cannot see this surface, and say why.

### Codex Micro proves the state exists and IS exported — just not to us

OpenAI shipped **Codex Micro** on 15 July 2026 (a macropad, with Work Louder). Its six
RGB "Agent Keys" show live Codex thread status straight from this app: white idle, blue
thinking, green complete, amber input-needed, red error. It works *only* while the
ChatGPT desktop app is running — the app is the bridge — and Codex users on CLI, IDE or
browser get no live status at all.

So "the desktop app cannot tell anything its state" is **false**, and this doc previously
implied it. The app has the state and streams it to an external device.

What it does not have is a third-party channel:

1. The [official Codex Micro docs](https://learn.chatgpt.com/docs/features/codex-micro)
   describe the feature purely in user terms. No protocol, no API, no SDK, no extension
   point — nothing on how status reaches the device.
2. It requires the OpenAI-branded device over USB-C or Bluetooth.
3. The one readable local extension point, `app_pairing_extensions/` (plain JSON, unlike
   everything else here), is the **"Work with Apps"** protocol — and it runs the wrong
   way. Its shape is `{ appName, bundleID, socketPath, capabilities: { content,
   selections, highlight, highlightLines, setContent, replaceSelection, reload, ping } }`.
   ChatGPT is the *client*, connecting to an **editor's** socket to read and edit code.
   Every capability is an editor operation. There is no "read thread status".
4. `codex-taskItems-*` and `codex-environments/` exist but are empty here. If Codex
   threads were used in the desktop app they might populate — worth re-checking, though
   `conversations-v3`, `gizmos` and `models` are all encrypted, so expect the same.

**The theoretically-open door, and why it stays shut.** One could emulate a Codex Micro
over virtual USB HID and receive the status frames the app already broadcasts. That means
reverse-engineering a proprietary protocol and impersonating first-party hardware: fragile
across app updates, near-certainly against terms, and a long way past "read-only observer".
Not a road session-radar takes.

**What is worth taking from this.** The Agent Keys state model — idle / thinking /
running / waiting / done — maps almost exactly onto this product's four states. That is
independent validation of the model from the vendor's own hardware. And because the
plumbing demonstrably exists inside the app, a public status API is a reasonable thing to
ask OpenAI for; it is the single change that would flip this verdict.

Practical today: Codex threads opened at chatgpt.com in Chrome (including `/codex/` URLs)
are already covered by the M2 extension.

### What would change the verdict

- A readable local state file, or an app-exposed local API.
- Accessibility API observation (below).
- A documented mapping between local and server conversation ids, which would at least
  let desktop sightings merge as extra entry points.

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
but for a better reason than "we could not find anything": we found the official API,
tested it, and it addresses a different surface.

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

Both are registered and report:

```
unsupported  Claude Desktop        Claude Desktop is installed but cannot be observed: …
unsupported  ChatGPT for macOS     …We can see 80 conversation file(s), but not their contents…
```

`unsupported` is distinct from `down` in the model and in the rollup: it is a permanent,
explained gap rather than an incident, so it does not make overall coverage read as
broken — but it is never hidden. If an app is not installed at all, the reason says so
instead.
