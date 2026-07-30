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

## Codex rollouts (Desktop, CLI and integrations; 0.144.1)

| Claim | How it was checked | Result |
| --- | --- | --- |
| Rollouts live at `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` | `find ~/.codex/sessions` | Confirmed. |
| The trailing UUID is the resumable session id | Compared to `session_meta.payload.id` | Confirmed, they match. |
| `codex resume <SESSION_ID>` is the resume syntax | `codex resume --help` | Confirmed verbatim. |
| Record shape | Parsed live rollouts | `{ timestamp, type, payload }` |
| `session_meta` payload fields | Same | `id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `model_provider`, `git` |
| Originator values on this machine | Aggregated every rollout header without reading message content | `Codex Desktop` 380, `codex-chrome-extension-sidepanel` 16, `buzz-acp` 9, `codex_exec` 3 |
| Record types | Counted across a full session | `session_meta`, `turn_context`, `world_state`, `response_item/*`, `event_msg/*` |
| Persisted lifecycle events | Counted across live rollouts and inspected metadata-only shapes | `event_msg/task_started`, `task_complete`, `turn_aborted`, with `turn_id` and source timestamps |
| `event_msg/user_message` is the real user prompt | Compared against the `response_item` user stream | Confirmed. Attachment turns may prepend `# Files mentioned…`; the request after `## My request for Codex:` is extracted before truncation. |
| notify events | [developers.openai.com/codex/config-reference](https://developers.openai.com/codex/config-reference) | `agent-turn-complete`, `approval-requested` |
| notify takes ONE program, invoked with a JSON argument | Same reference | Confirmed — hence the dispatcher rather than a replacement. |
| Victor already has a notify | Read `~/.codex/config.toml` | Wired to Codex Computer Use. **Wrapped, never replaced.** |

## Grok Build (0.2.114)

| Claim | How it was checked | Result |
| --- | --- | --- |
| Grok Build supports interactive TUI, headless, and ACP modes | [xAI Build overview](https://docs.x.ai/build/overview) and [xai-org/grok-build](https://github.com/xai-org/grok-build) | Confirmed; Grok Build is first-party and open source. |
| Session metadata lives at `~/.grok/sessions/<encoded-cwd>/<session-id>/summary.json` | Inspected the installed 0.2.114 store and the open-source persistence implementation | Confirmed. The directory id matches `info.id`; safe fields include cwd, generated title/summary, source times, model, session kind, hidden flag, and message counts. |
| `active_sessions.json` is a TUI liveness registry, not a global lifecycle index | Inspected `active_sessions.rs` and the installed registry | Entries are `{session_id,pid,cwd,opened_at}` and are removed on clean exit. It does not enumerate headless/ACP sessions, so it is used only as a qualifier and never as progress. |
| `grok --resume <SESSION_ID>` is the return path | Checked the installed CLI help and session persistence contract | Confirmed. The connector emits a cwd-aware, shell-quoted command. |
| Global HTTP hooks are supported | Installed guide `~/.grok/docs/user-guide/10-hooks.md` and open-source hook runner | `~/.grok/hooks/*.json` is always trusted; `{type:"http",url,timeout}` POSTs the full camelCase event envelope as JSON. |
| Claude-hook compatibility can replay Grok events | Same guides plus installed `~/.claude/settings.json` | Grok scans Claude hooks by default. The daemon detects Grok's camelCase envelope on the Claude route, attributes it to xAI, and relies on observation idempotency if the dedicated Grok hook also fires. |
| Live lifecycle event names | Same hook guide and `xai-grok-hooks/src/event.rs` | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `SessionEnd`; the wire `hookEventName` value is snake_case. |
| Blocking notification types | Traced the open-source permission, plan-approval, and ask-user call sites | `permission_prompt` and `elicitation_dialog` require the user. `idle_prompt` is genuine completion after the agent is idle. Unknown types are non-blocking but degrade coverage. |
| `Stop` distinguishes pending background work | Hook guide and open-source stop envelope | A genuine completion fires `Stop`; non-empty `backgroundTasks` or `sessionCrons` keeps the work running. `StopFailure` carries a classified error. |
| Content boundary | Narrow zod schemas plus sentinel tests | Prompt, tool input/result, assistant messages, raw error detail, background descriptions/commands, scheduled prompts, logs, chat history, updates, signals analytics, and `auth.json` are never projected or stored. |
| Installed-machine inventory | Metadata-only probe against `~/.grok` | Four stored session summaries were enumerable. Ten live `grok agent ... stdio` processes existed during the investigation, while `active_sessions.json` was empty as expected because that registry is TUI-only. |
| Coverage semantics without hooks | Connector integration tests | Inventory remains visible as `stale.inventory-only`, while connector health is `DEGRADED` until the exact session-radar global hook file is installed. |

## Chrome extension (M2)

| Claim | How it was checked | Result |
| --- | --- | --- |
| Extension id derives from the manifest `key` | Generated an RSA keypair, computed SHA-256 of the SPKI DER, mapped the first 16 bytes onto a–p | `mdbfiohpejlnjbeebkmplfhiommkaonf`, pinned in the daemon allowlist |
| MV3 network boundaries | Design decision, verified by built bundles | The isolated content script does not fetch. The main-world bridge fetches only each site's same-origin bootstrap/list metadata; the service worker alone posts sanitized reports to the loopback daemon |
| Conversation id parsing | Unit tests over real URL shapes | `claude.ai/chat/<id>`, `claude.ai/project/<p>/chat/<id>`, `chatgpt.com/c/<id>`, `chatgpt.com/codex/<id>` |
| Logged-in web history link shapes | Inspected authenticated ChatGPT and Claude pages without reading message bodies | ChatGPT rendered 28 fixed recent links. Claude `/chats` grew from 33 to 65 rendered rows after one scroll; rows exposed exact chat/Cowork links and `time[datetime]`, so DOM completeness is explicitly partial |
| ChatGPT account pagination contract | Traced the current first-party `chatgpt.com` bundles | Active history is `GET /backend-api/conversations?offset=&limit=28&order=updated&is_archived=false`; archived history uses the same route with `limit=30&is_archived=true`; responses expose `items,total,limit,offset` |
| Claude account pagination contract | Traced the current first-party `claude.ai` bundles, then diagnosed the live July 29 bootstrap drift | `GET /api/bootstrap?...&include_system_prompts=false` supplies verified memberships but no longer supplies `resolved_org_uuid`. v0.0.5 safely enumerates every chat-capable membership and paginates `GET /api/organizations/<uuid>/chat_conversations_v2?limit=30&offset=&starred=<bool>&consistency=strong` until `has_more=false` |
| Claude agent account pagination contract | Traced the current first-party `claude.ai` bundle and mirrored it in projection/pagination tests | `GET /v1/code/sessions` uses repeated `statuses`, limit 50 and opaque `cursor`; active+paused and archived buckets run for each chat-capable organization with the exact current version/beta/client-feature/org headers |
| Metadata-only account boundary | Projection/pagination tests plus built `page.js` inspection | Ordinary inventory keeps only id/title/time/archive/URL/ChatGPT async enum. Claude agent inventory keeps controlled lifecycle/origin/environment enums, unread and exact Cowork URL. Task summaries, first messages, session context, source/outcome config, external/client metadata, resume tokens, cursors and raw responses never cross the bridge |
| History completeness and unknown time | Extension/daemon integration tests | Both ChatGPT scopes must reach totals; every Claude chat membership/star bucket must reach `has_more=false`. Auth/schema/reject/cap failures are loud. Untimed DOM rows use activity time 0, stay out of recent triage and render `time unknown` |
| Claude agent completeness | Extension/daemon integration tests | Every organization’s active+paused and archived cursor chain must end cleanly. Cursor cycles, auth/schema failures, rejected rows, unknown enums and the independent 1,000-row cap degrade. A fresh complete snapshot supersedes the stale one-page Desktop cache; partial/stale snapshots retain both warnings |
| Daemon rejects other extension origins | `defaultAllowedOrigins` test | Confirmed |
| Heartbeat timeout flips coverage | `scripts/test-m2.sh` against the live daemon | Flipped to `down` after 41s, inside the 60s budget |
| Cross-surface dedup | Same script: one CLI hook + one web report for one id | One work item, two entry points, both a resume command and a deep link |
| Web/agent inventory implementation suite | Full repository test/build after the v0.0.5 live-drift and contradiction guards | 28 files, 393/393 tests; extension typecheck/build and M2 25/25 passed, and the daemon build passed |
| Installed v0.0.5 Claude inventories | Reloaded the unpacked extension, refreshed authenticated Claude, inspected only sanitized response structure, and audited `/api/coverage` | Ordinary account pagination completed with 801 projected conversation rows; merged DOM/account coverage represents 806 web conversations. Claude cross-device agent pagination contributes 96 sessions and its connector is `ok` |
| Installed v0.0.5 ChatGPT boundary | Compared the sanitized page-bridge result, the page's own first-party request structure, visible DOM, and daemon coverage | The cookie-only bridge received `0 of 0`, while the authenticated app request and sidebar exposed 28 conversations. The daemon rejects this contradiction, preserves all 28 visible rows, and reports account history `partial`; it never reads or replays authorization/account headers |

## Desktop apps (M3)

| Claim | How it was checked | Result |
| --- | --- | --- |
| Claude Code Desktop inventory is readable | Validated `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json` against a narrow zod schema | Confirmed; `cliSessionId` joins Desktop metadata to the CLI transcript without duplicates |
| Claude Code Desktop live hooks are shared with CLI | Installed hooks, restarted sessions, observed live `PostToolUse` against a Desktop-joined canonical id | Confirmed |
| Codex Desktop tasks use the rollout store | Aggregated `session_meta.originator` and joined by rollout/session UUID | Confirmed; Desktop, Chrome side panel, Buzz and CLI are now distinct source refs |
| Codex task completion is persisted | Inspected `task_started`, `task_complete`, `turn_aborted` records while tasks ran and completed | Confirmed; message fields are stripped and never stored |
| Claude Desktop has a persisted recent-chat list | Copied and opened `~/Library/Application Support/Claude/Local Storage/leveldb`, then selected only `react-query-cache-ls` | Confirmed. Four `chat_conversation_list` query variants yielded 30 unique recent ordinary chats |
| Claude chat cache metadata shape | Projected only the conversation-list query records through a narrow zod schema | Stable `uuid`, `name`, create/update times, star/temporary/project metadata and platform are readable; multi-kilobyte `summary` and all unknown fields are stripped before ingestion |
| Claude cache completeness limit | Inspected the persisted infinite-query pages | `has_more=true`; the connector reports partial inventory rather than implying account completeness |
| Claude ordinary-chat return path | Verified the canonical claude.ai route used by the cached server UUID | `https://claude.ai/chat/<conversation-uuid>`; no unproven desktop custom URL is invented |
| Claude live lifecycle is not persisted | Inspected the selected list-cache schema and compared it with the live UI requirement | No generating/blocked/done field; cache-only rows are explicitly `stale.inventory-only` with degraded coverage |
| Claude has no second metadata-only lifecycle query | Enumerated only the first element of every persisted React Query key, without printing arguments or data | Nine query objects across six families; ordinary chat appears only as four `chat_conversation_list` variants. The renderer receives `isStreaming` in memory, but no ordinary-chat lifecycle query is persisted |
| Claude has a separate cross-device agent-session list | Isolated only the `sessions_api_list_sessions` React Query object from the copied Local Storage value | Confirmed. The active/paused list covers Claude Code/Cowork work whose observed origins include CLI, Desktop, claude.ai and iOS |
| Claude agent lifecycle is persisted | Projected the session and worker states plus `post_turn_summary.status_category` through a narrow schema | `running` maps to running; `need_input`/`blocked`/`failed` map to needs Victor; `review_ready` maps to done; unknown values remain unclassified and degrade coverage |
| Claude agent identity joins exactly to local Code sessions | Compared cloud `session_…` ids with `bridgeSessionIds` and `cliSessionId` in `claude-code-sessions/**/local_*.json`, including a synthetic late-bridge transition | Confirmed. Explicit mappings merge into the local CLI UUID; a previously ingested cloud-only row, observations, evidence, transitions and entry points collapse atomically when the bridge arrives; conflicting mappings are discarded instead of guessed |
| Claude agent cache respects the metadata-only boundary | Inspected the source schema, stored raw observations and live connector output | Only controlled enums, booleans and timestamps survive. Content-bearing `needs_action`, `status_detail`, descriptions, session context and unknown fields are stripped before ingestion |
| Claude agent cache freshness and completeness are bounded | Inspected `dataUpdatedAt` and the list page | Coverage degrades after five minutes without a refresh and whenever `has_more=true`; stale cached running state ages out rather than being refreshed by a daemon restart |
| Claude agent return path | Traced the current first-party route table, exercised normalized `cse_…`/`session_…` ids in connector tests, then audited the redeployed live ledger | `https://claude.ai/cowork/<normalized-session-id>` is attached to all 50/50 remote agent source refs, including rows explicitly joined to a local CLI UUID |
| ChatGPT Desktop has a recent-conversation metadata cache | Copied and opened `~/Library/Application Support/Codex/Default/Local Storage/leveldb` with `classic-level` | Confirmed. `codex.chatgpt-conversations` held 20 recent items; `codex.chatgpt-pinned-conversations` held 0 pinned items |
| ChatGPT cache metadata shape | Projected the two cache records through a narrow schema | Stable ids, titles, ISO create/update times, archive flags and nullable integer `async_status` are readable; all 20 live `mapping`, `snippet` and `async_status` fields were `null` |
| ChatGPT persisted async lifecycle | Traced the first-party bundle's async-status enum and cache update path, then exercised synthetic cache records | Value `3` is streaming/running and `4` is result ready/unread/done; other non-null values are not guessed and visibly degrade coverage |
| ChatGPT Desktop deep-link shape | Inspected the bundled desktop JavaScript | `codex://threads/<conversation-id>` |
| ChatGPT local IPC is not an inventory API | Decoded the same-user `~/.codex/ipc/ipc.sock` framing, method router and `thread-stream-state-changed` handlers from the bundled app | Length-prefixed JSON coordination bus for already-known Codex thread streams; no thread-list method. Its state messages contain full conversation snapshots/patches, so subscribing would still miss forgotten ids and would violate the dashboard's metadata-only boundary |
| ChatGPT ordinary lifecycle is renderer-only | Traced the bundled unified `list_threads` implementation and renderer atoms | The first-party UI combines ChatGPT API/cache inventory with in-memory `idle / streaming / error`. Apart from persisted async states 3/4, ordinary lifecycle and blocked-on-user state are not in the cache or local socket |
| Cursor has a metadata-only composer inventory | Opened `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` read-only and projected only allowlisted JSON paths from `composer.composerHeaders` plus `cursorDiskKV` `composerData:*` rows | Confirmed. The live store had 56 current header rows and 1,474 composerData records; 1,407 were valid JSON. After excluding drafts, internal best-of-N candidates and records with no safe session metadata, 426 composer ids were indexed |
| Cursor lifecycle mapping is first-party, not guessed | Traced the installed Cursor workbench bundle and compared it with persisted composer fields | `hasBlockingPendingActions`/pending plan maps to needs-you; `generating`, continuation-in-progress or non-empty generating bubble ids map to running; `completed` and `aborted` are explicit terminal states. Unknown values remain inventory-only |
| Cursor content stays outside the connector | Inspected the exact SQLite SELECT projection and ran a fixture containing sentinel prompt, conversation-state, rich-text and encryption-key values | The connector never selects `conversation`, `conversationState`, `bubbleId:*`, `agentKv:*`, rich text, prompt text, code selections, context blobs or keys into JavaScript; sentinel content did not enter observations or the ledger |
| Cursor return paths are bounded | Traced the installed bundle's background-agent URI, verified `cursor-agent --resume <chatId>` in the installed CLI help, then compared CLI transcript filenames with the desktop composer ids | Background agents get the verified `cursor://anysphere.cursor-deeplink/background-agent?bcId=…` route. Ordinary composers get an Agent-history locate hint. All 9 top-level Cursor Agent CLI transcript ids already matched desktop composer ids and now add a merged CLI source plus copyable resume command; 2 nested subagent transcripts remain part of their parent work rather than separate dashboard rows |
| Windsurf and Antigravity retain enumerable session ids | Enumerated only UUID filenames plus `stat` metadata under `~/.codeium/windsurf/cascade/*.pb` and `~/.gemini/antigravity/conversations/*.pb` | Confirmed: 4 Windsurf Cascade ids and 5 Antigravity ids. Protobuf bodies were not opened; titles and lifecycle remain explicitly unavailable |
| ChatGPT Atlas retains enumerable conversation ids | Enumerated only `conversations-v3-*/*.data` UUID filenames plus `stat` metadata under `~/Library/Application Support/com.openai.atlas` | Confirmed: 118 unique ids in one account directory. `.data` bodies were not opened; Atlas-only rows use a locate hint and remain lifecycle-unknown |
| VS Code retains persisted chat-session ids | Enumerated UUID filenames under `Code/User/workspaceStorage/*/chatSessions/`; read only the separate one-field `workspace.json` folder locator | Confirmed: 1 chat-session id. The chat JSON body was never opened; the item gets a VS Code Chat-history locate hint and remains lifecycle-unknown |
| Cline retains persisted task ids | Enumerated only 13-digit task-directory names plus `stat` metadata for `api_conversation_history.json` and `ui_messages.json` under VS Code global storage | Confirmed: 4 task ids. Neither JSON body was opened; each task gets a VS Code → Cline → History locate hint and remains lifecycle-unknown |
| Augment cannot yet be inventoried safely | Audited the installed extension manifest, local filenames and VS Code state-key names without reading SecretStorage | The extension exposes History/Copy Session ID commands, but the only session-related local reference is the `augment.sessions` SecretStorage key; visible files are cache/user assets. Augment is therefore an explicit `unsupported` coverage row rather than a silent omission or credential-boundary bypass |
| ChatGPT conversation files are encrypted | Sampled 3 files' magic bytes + `strings` | No shared magic, no structure, no plaintext — `857a0da4…`, `dd076b0f…`, `243097a8…` |
| Only ids and mtimes are legible | Listed `conversations-v3-<acct>/` | 80 files named by conversation UUID |
| `lastSelectedConversation` exists but is unusable | `defaults read com.openai.chat` | Present, but a *local* uppercase UUID in a different namespace from the server ids — merging on it would create duplicates |
| Claude Desktop holds its content-bearing IndexedDB open | `lsof` on the IndexedDB `LOCK` | Held by the running app (PID confirmed); the new inventory connector does not open it and instead reads an allowlisted Local Storage key from a private copy |
| Claude Desktop logs carry no state | Scanned 3,000 recent lines | Zero conversation ids, zero navigation events, all `[error]` |
| Accessibility API | **Not attempted** | Requires a highly invasive permission; not triggered unilaterally. Reasoning in the feasibility doc |

## Dashboard (M4)

| Claim | How it was checked | Result |
| --- | --- | --- |
| Readable within 2s | `scripts/test-m4.sh` timing shell + JS + CSS + data | 135 ms |
| Scan order | Unit tests plus live in-app browser snapshot | needs_victor → running → done+unseen → stale/unknown+unseen → stale/unknown+seen → done+seen |
| Unknown-chat recall | Store tests with repeated same-status sightings | Acknowledging a status-unknown desktop chat quiets its unchanged scans. If the vendor update timestamp later advances, it becomes unseen again even though its honest status remains `stale`; a second completion similarly reopens `done -> done` |
| Recent versus indexed history boundary | HTTP tests with one session just beyond the seven-day cutoff, plus a regression test for long-lived active work | The default route excludes old terminal/inventory rows; `GET /api/workitems?history=all` returns them. Running and needs-you rows are never hidden solely because their last activity crossed seven days. Unknown scope values fail with HTTP 400 |
| Locally enumerable archive backfill | Metadata-only benchmark in a disposable store, connector/store tests, live schema-v5 migration, then a second daemon restart | The first clean pass indexed 50 Claude transcripts in 419 ms, 410 Codex rollouts in 2.9 s, and each desktop cache in under 200 ms. The live ledger grew from 252 to 574 rows; the next restart fell from about 3.3 s to 1.1 s because already indexed archive ids were skipped |
| Every currently enumerable local id is represented | Exact set comparison from live source inventories to SQLite source refs/canonical bridge targets | Existing Claude/Codex/ChatGPT inventories remain represented, plus 426 Cursor composers, 9 merged Cursor Agent CLI resume sources, 4 Windsurf Cascades, 5 Antigravity conversations, 118 ChatGPT Atlas conversations, 1 VS Code chat session and 4 Cline tasks. Source-specific parse/cache limits remain visibly degraded rather than being counted as complete |
| Vendor archive state stays out of triage | Store and desktop-connector tests with recently updated archived rows | Archive state is stored per source ref. Explicitly archived rows remain in all-history but are excluded from the recent query unless another merged source is not archived |
| Historical terminal state survives compaction | Store compaction test plus two consecutive stale sweeps over an old completed session | Repeated old samples are pruned, but the newest occurrence of each signal is retained, so an explicit historical completion cannot decay into `stale.no-evidence` |
| Every item explains itself | Same | All items carry rule, confidence and a human reason |
| Every item has a route back | Final live all-indexed API audit after v0.0.5 activation | 1,955/1,955 indexed items had at least one link, resume command or locate hint; 2,039 source entry points were retained across CLI, desktop, browser, web and mobile surfaces |
| Installed-surface implementation suite | Full repository test/typecheck/build after Cursor CLI, Cline, Augment, Claude v0.0.5 and the ChatGPT contradiction guard | 28 files, 393/393 tests; shared/daemon build, extension typecheck/build and M2 25/25 all passed |
| Live expanded ledger | Redeployed `gui/501/com.session-radar.daemon`, then audited `/api/health`, `/api/coverage` and both work-item history scopes | 15 connectors, 226 recent rows, 1,955 all-indexed rows; provider totals are Anthropic 950, OpenAI 565, Cursor 426, Google 5, GitHub 1, Windsurf 4 and Cline 4. Augment is explicitly unsupported rather than silently omitted |
| Live expanded dashboard | Refreshed the Chrome dashboard against the final daemon, then audited its DOM, dimensions and diagnostics | The live page renders 226 triage rows with 6 needs-you, 2 running, 17 done-unseen and 65 unknown-unseen at the top; all 15 coverage rows and eight provider namespaces render. Document width equals viewport width, and the dashboard itself emitted no warnings or errors |
| Persistent daemon | Installed and inspected `gui/501/com.session-radar.daemon` | `launchd` state `running`; schema 5 is live; plist, SQLite and both logs are owner-only `0600` |
| Static serving cannot escape its root | 8 traversal tests incl. encoded, null-byte and prefix-sibling cases | Contained |

## Not verified

- **Ordinary Claude Desktop live chat state and complete archive.** Recent metadata
  inventory is now collected, but the cache reports `has_more=true` and does not expose
  generating/blocked/done. Opening the same id in Chrome supplies stronger lifecycle
  evidence through the extension.
- **Complete ChatGPT account and project history without credential access.** The
  authenticated app injects authorization/account headers that the metadata-only bridge
  deliberately does not read or replay. The visible 28-row sidebar is indexed and the
  account contradiction is loudly `partial`; older and project conversations are not
  claimed complete.
- **Ordinary ChatGPT macOS live chat state outside async work.** Recent and pinned
  metadata plus persisted async streaming/ready state are collected, but the cache and
  local IPC do not expose the full renderer lifecycle or blocked-on-user state.
- **Ordinary web lifecycle outside an open tab.** ChatGPT's account list exposes only
  the verified async 3/4 subset, and Claude's history list exposes no lifecycle. Other
  account rows remain explicitly status unknown.
- **Every future web DOM version.** The extension is installed and currently reporting
  healthy live heartbeats, but selectors remain version-sensitive by nature. The
  self-test turns a future mismatch into degraded coverage.
- **Every locate hint/deep link clicked by a human.** The live dashboard and actions were
  rendered in the in-app browser; no source app was mutated during verification.
- **Augment account/session inventory.** The installed extension keeps its session
  reference behind VS Code SecretStorage and exposes no metadata-safe local index or
  documented per-session deep link. The dashboard says `unsupported` and points to
  Visual Studio Code → Augment → History; it does not read credentials to manufacture
  coverage.
- **The literal 30-second scan.** The machine-checkable half is proven (order, evidence,
  routes back in, 135 ms load). A human still has to do the actual scan.

## Sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Codex advanced configuration](https://developers.openai.com/codex/config-advanced)
