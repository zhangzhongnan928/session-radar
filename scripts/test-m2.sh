#!/usr/bin/env bash
#
# M2 acceptance gate.
#
#   * 2 conversations per site, driven through all four states
#   * the same conversation seen in web AND CLI shows as ONE work item with two
#     entry points
#   * a silent extension (Chrome closed / extension disabled) flips its connector
#     to `down` within 60s — never to an empty list
#   * rotted selectors flip the connector to `degraded`, naming what to fix
#
# The extension's service worker is simulated by curl against the real endpoint,
# with the real origin. Live DOM verification against logged-in claude.ai and
# chatgpt.com is NOT covered here — see the M2 report.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SESSION_RADAR_TEST_PORT:-4759}"
ORIGIN="chrome-extension://mdbfiohpejlnjbeebkmplfhiommkaonf"
PASS=0
FAIL=0
DAEMON_PID=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/session-radar-m2-XXXXXX")"
RADAR_HOME="$WORK/home"
CLAUDE_HOME="$WORK/dot-claude"
CODEX_HOME="$WORK/dot-codex"

CLAUDE_A="claude-conv-aaaa"
CLAUDE_B="claude-conv-bbbb"
GPT_A="gpt-conv-cccc"
GPT_B="gpt-conv-dddd"
SHARED="shared-conv-eeee"

cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null; wait "$DAEMON_PID" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

check() {
  local label="$1" actual="$2" expected="$3"
  # An empty actual means the query itself failed. Treating that as a match once
  # let a broken check report PASS, so it is now always a failure.
  if [[ -z "$actual" ]]; then
    printf '  \033[31mFAIL\033[0m  %-56s (empty result — query failed)\n' "$label"; FAIL=$((FAIL + 1)); return
  fi
  if [[ "$actual" == "$expected" ]]; then
    printf '  \033[32mPASS\033[0m  %-56s %s\n' "$label" "$actual"; PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-56s got %s, want %s\n' "$label" "$actual" "$expected"; FAIL=$((FAIL + 1))
  fi
}

api() { curl -fsS "http://127.0.0.1:$PORT$1"; }
q() { node "$ROOT/scripts/lib/query.mjs" "http://127.0.0.1:$PORT" "$@"; }

# POST an extension report with the real extension origin.
web_report() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/hooks/web" \
    -H 'Content-Type: application/json' -H "Origin: $ORIGIN" -d "$1"
}

status_of() { q status "$1"; }
coverage_state() { q coverage-state "$1"; }

conv() { printf '{"conversationId":"%s","state":"%s","title":"%s","at":%s}' "$1" "$2" "$3" "$(node -e 'console.log(Date.now())')"; }

send() { # site, conversations-json, extra
  local site="$1" convs="$2" extra="${3:-}"
  local now item_at items; now="$(node -e 'console.log(Date.now())')"
  # The account list's source update precedes the DOM observation in a real
  # report. Keeping that ordering prevents weaker inventory metadata from
  # displacing the current open-tab lifecycle in this synthetic fixture.
  item_at=$((now - 1000))
  if [[ "$site" == "claude-web" ]]; then
    items="{\"conversationId\":\"$CLAUDE_A\",\"title\":\"Retry strategy review\",\"url\":\"https://claude.ai/chat/$CLAUDE_A\",\"updatedAt\":$item_at},{\"conversationId\":\"$CLAUDE_B\",\"title\":\"Second claude conversation\",\"url\":\"https://claude.ai/chat/$CLAUDE_B\",\"updatedAt\":$item_at},{\"conversationId\":\"$SHARED\",\"title\":\"Open in both places\",\"url\":\"https://claude.ai/chat/$SHARED\",\"updatedAt\":$item_at}"
  else
    items="{\"conversationId\":\"$GPT_A\",\"title\":\"Investor update draft\",\"url\":\"https://chatgpt.com/c/$GPT_A\",\"updatedAt\":$item_at},{\"conversationId\":\"$GPT_B\",\"title\":\"Second gpt conversation\",\"url\":\"https://chatgpt.com/c/$GPT_B\",\"updatedAt\":$item_at}"
  fi
  web_report "{\"site\":\"$site\",\"at\":$now,\"conversations\":[$convs],\"inventories\":[{\"scope\":\"account-api\",\"completeness\":\"complete\",\"at\":$now,\"items\":[$items],\"basis\":\"M2 acceptance fixture: complete v0.0.5 account inventory\"}],\"selectors\":{\"selectorsVersion\":\"2026.07.28-1\",\"found\":[\"composer\",\"message\"],\"missing\":[]},\"extensionVersion\":\"0.0.5\"$extra}"
}

echo
echo "session-radar — M2 acceptance"
echo "  port:   $PORT"
echo "  origin: $ORIGIN"
echo

echo "[1/6] tests + build"
(cd "$ROOT" && pnpm test >/tmp/session-radar-m2-tests.log 2>&1) \
  && { check "unit tests" "green" "green"; grep -E "Tests +[0-9]+ passed" /tmp/session-radar-m2-tests.log | tail -1 | sed 's/^/        /'; } \
  || { check "unit tests" "red" "green"; tail -25 /tmp/session-radar-m2-tests.log | sed 's/^/        /'; }

(cd "$ROOT" && pnpm build >/tmp/session-radar-m2-build.log 2>&1) \
  && check "daemon build" "ok" "ok" || { check "daemon build" "failed" "ok"; exit 1; }
(cd "$ROOT/packages/extension" && pnpm build >/tmp/session-radar-m2-ext.log 2>&1) \
  && check "extension build" "ok" "ok" || { check "extension build" "failed" "ok"; exit 1; }
check "manifest is MV3" \
  "$(node -p "require('$ROOT/packages/extension/manifest.json').manifest_version")" "3"
check "extension id is pinned by manifest key" \
  "$(node -p "require('$ROOT/packages/extension/manifest.json').key ? 'yes' : 'no'")" "yes"
echo

echo "[2/6] start daemon"
mkdir -p "$RADAR_HOME" "$CLAUDE_HOME/projects" "$CODEX_HOME/sessions"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "  port $PORT busy"; exit 1; fi

SESSION_RADAR_HOME="$RADAR_HOME" SESSION_RADAR_CLAUDE_HOME="$CLAUDE_HOME" \
SESSION_RADAR_CODEX_HOME="$CODEX_HOME" SESSION_RADAR_PORT="$PORT" \
SESSION_RADAR_PROBE_PROCESSES=0 SESSION_RADAR_SWEEP_MS=2000 \
  node "$ROOT/packages/daemon/dist/index.js" >/tmp/session-radar-m2-daemon.log 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 60); do api /api/health >/dev/null 2>&1 && break; sleep 0.25; done
api /api/health >/dev/null 2>&1 && check "daemon up" "up" "up" || { check "daemon up" "down" "up"; exit 1; }

check "both web connectors registered" "$(q connector-count-by-surface extension)" "2"
check "claude-web is DOWN before the extension connects" "$(coverage_state claude-web)" "down"
echo

echo "[3/6] four states per site"
check "generating -> running (claude.ai)" \
  "$(send claude-web "$(conv $CLAUDE_A generating 'Retry strategy review')" >/dev/null; sleep 1; status_of "$CLAUDE_A")" "running"
check "blocked -> needs_victor (claude.ai)" \
  "$(send claude-web "$(conv $CLAUDE_A blocked 'Retry strategy review')" >/dev/null; sleep 1; status_of "$CLAUDE_A")" "needs_victor"
check "completed -> done (claude.ai)" \
  "$(send claude-web "$(conv $CLAUDE_A completed 'Retry strategy review')" >/dev/null; sleep 1; status_of "$CLAUDE_A")" "done"

send claude-web "$(conv $CLAUDE_B generating 'Second claude conversation')" >/dev/null
sleep 1
NOW="$(node -e 'console.log(Date.now())')"
web_report "{\"site\":\"claude-web\",\"at\":$NOW,\"conversations\":[],\"closed\":[\"$CLAUDE_B\"],\"selectors\":{\"selectorsVersion\":\"2026.07.28-1\",\"found\":[\"composer\"],\"missing\":[]}}" >/dev/null
sleep 1
check "tab closed mid-generation -> stale (claude.ai)" "$(status_of "$CLAUDE_B")" "stale"

check "generating -> running (chatgpt.com)" \
  "$(send chatgpt-web "$(conv $GPT_A generating 'Investor update draft')" >/dev/null; sleep 1; status_of "$GPT_A")" "running"
check "blocked -> needs_victor (chatgpt.com)" \
  "$(send chatgpt-web "$(conv $GPT_A blocked 'Investor update draft')" >/dev/null; sleep 1; status_of "$GPT_A")" "needs_victor"
check "completed -> done (chatgpt.com)" \
  "$(send chatgpt-web "$(conv $GPT_B completed 'Second gpt conversation')" >/dev/null; sleep 1; status_of "$GPT_B")" "done"
echo

echo "[4/6] cross-surface dedup"
# The CLI sees the same conversation id the browser is showing.
curl -fsS -X POST "http://127.0.0.1:$PORT/api/hooks/claude-code" -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SHARED\",\"hook_event_name\":\"PostToolUse\",\"cwd\":\"/tmp/shared-repo\"}" >/dev/null
send claude-web "$(conv $SHARED generating 'Open in both places')" >/dev/null
sleep 1

check "one work item, not two" "$(q item-count-matching "$SHARED")" "1"
check "two entry points on it" "$(q entry-surfaces "$SHARED")" "cli+extension"
check "both ways back in survive" "$(q has-both-entry-kinds "$SHARED")" "yes"
echo

echo "[5/6] selector rot -> degraded, naming the anchors"
NOW="$(node -e 'console.log(Date.now())')"
web_report "{\"site\":\"chatgpt-web\",\"at\":$NOW,\"conversations\":[],\"selectors\":{\"selectorsVersion\":\"2026.07.28-1\",\"found\":[],\"missing\":[\"composer\",\"message\"]}}" >/dev/null
sleep 11
check "chatgpt-web -> degraded" "$(coverage_state chatgpt-web)" "degraded"
check "it names the anchors to fix" "$(q coverage-error-matches chatgpt-web composer)" "yes"
check "degraded still reports what it can see" \
  "$([ "$(q count)" -gt 0 ] && echo yes || echo no)" "yes"
echo

echo "[6/6] extension goes silent (Chrome closed) — down within 60s, items stay"
BEFORE="$(q count)"
echo "        waiting out the 60s heartbeat timeout..."
STATE=""
for i in $(seq 1 75); do
  STATE="$(coverage_state claude-web)"
  [[ "$STATE" == "down" ]] && { echo "        flipped after ${i}s"; break; }
  sleep 1
done
check "claude-web -> down when the extension stops reporting" "$STATE" "down"
check "it says why" "$(q coverage-error-matches claude-web heartbeat)" "yes"
check "work items did NOT vanish" "$(q count)" "$BEFORE"

# It leaves DOWN the moment the extension speaks again. Complete account
# inventory still has an honest lifecycle limitation for rows outside open tabs,
# so the recovered state is DEGRADED rather than falsely OK.
send claude-web "$(conv $CLAUDE_A completed 'Retry strategy review')" >/dev/null
sleep 11
check "reconnects; known history lifecycle gap remains" "$(coverage_state claude-web)" "degraded"
echo

echo "─────────────────────────────────────────────"
printf 'M2 acceptance: %d passed, %d failed\n' "$PASS" "$FAIL"
echo "─────────────────────────────────────────────"
[[ "$FAIL" -eq 0 ]]
