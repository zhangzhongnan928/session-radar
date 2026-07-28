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

### What would change the verdict

- A local IPC/HTTP surface in the app, or a documented state file.
- Accessibility API observation of window state (see the shared note below).
- Content that only matters if the CLI/web paths stop covering the same conversations.

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

### What would change the verdict

- A readable local state file, or an app-exposed local API.
- Accessibility API observation (below).
- A documented mapping between local and server conversation ids, which would at least
  let desktop sightings merge as extra entry points.

---

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
