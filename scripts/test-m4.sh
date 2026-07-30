#!/usr/bin/env bash
#
# M4 acceptance gate — the 30-second scan test.
#
# With >=8 seeded items across sources and all four states, every item that
# needs attention must be identifiable from the dashboard alone, without opening
# any source app. Automated as:
#
#   * the page is readable within 2s of open
#   * scan order puts needs_victor first, then running, done+unseen,
#     stale+unseen, acknowledged stale and acknowledged done
#   * every attention-worthy item carries a status, an evidence one-liner, and a
#     way back in (deep link or resume command)
#   * revoking a source mid-session shows a coverage failure, NOT a clean empty state
#
# A human still has to do the actual 30-second scan; this proves the information
# is all there to do it with.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SESSION_RADAR_TEST_PORT:-4761}"
BASE="http://127.0.0.1:$PORT"
ORIGIN="chrome-extension://mdbfiohpejlnjbeebkmplfhiommkaonf"
PASS=0
FAIL=0
DAEMON_PID=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/session-radar-m4-XXXXXX")"
RADAR_HOME="$WORK/home"
CLAUDE_HOME="$WORK/dot-claude"
CODEX_HOME="$WORK/dot-codex"
GROK_HOME="$WORK/dot-grok"
PROJECTS="$CLAUDE_HOME/projects"
ROLLOUTS="$CODEX_HOME/sessions/2026/07/28"

cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null; wait "$DAEMON_PID" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

check() {
  local label="$1" actual="$2" expected="$3"
  if [[ -z "$actual" ]]; then
    printf '  \033[31mFAIL\033[0m  %-56s (empty result)\n' "$label"; FAIL=$((FAIL + 1)); return
  fi
  if [[ "$actual" == "$expected" ]]; then
    printf '  \033[32mPASS\033[0m  %-56s %s\n' "$label" "$actual"; PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-56s got %s, want %s\n' "$label" "$actual" "$expected"; FAIL=$((FAIL + 1))
  fi
}

q() { node "$ROOT/scripts/lib/query.mjs" "$BASE" "$@"; }
api() { curl -fsS "$BASE$1"; }
now_ms() { node -p 'Date.now()'; }

seed_cli() {
  mkdir -p "$PROJECTS/-tmp-alpha" "$PROJECTS/-tmp-beta" "$PROJECTS/-tmp-gamma" "$ROLLOUTS" "$RADAR_HOME"
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  local i=1
  for name in alpha beta gamma; do
    printf '{"type":"user","timestamp":"%s","cwd":"/tmp/%s","sessionId":"cc-%s","message":{"role":"user","content":"M4 work on the %s module"}}\n' \
      "$ts" "$name" "$name" "$name" > "$PROJECTS/-tmp-$name/1111111$i-1111-4111-8111-11111111111$i.jsonl"
    i=$((i + 1))
  done
  # The trailing group must be exactly 12 hex chars or the rollout is not
  # recognised as a session at all.
  local tail=1
  for name in delta epsilon; do
    printf '{"timestamp":"%s","type":"session_meta","payload":{"cwd":"/tmp/%s","cli_version":"0.144.1"}}\n{"timestamp":"%s","type":"event_msg","payload":{"type":"user_message","message":"M4 audit the %s service"}}\n' \
      "$ts" "$name" "$ts" "$name" > "$ROLLOUTS/rollout-2026-07-28T17-44-00-019fa7ae-3778-7671-ba66-cccccccccc0$tail.jsonl"
    tail=$((tail + 1))
  done
}

send_web() {
  local site="$1" id="$2" state="$3" title="$4"
  curl -s -o /dev/null -X POST "$BASE/api/hooks/web" -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
    -d "{\"site\":\"$site\",\"at\":$(now_ms),\"conversations\":[{\"conversationId\":\"$id\",\"state\":\"$state\",\"title\":\"$title\",\"at\":$(now_ms)}],\"selectors\":{\"selectorsVersion\":\"2026.07.28-1\",\"found\":[\"composer\",\"message\"],\"missing\":[]}}"
}

hook_claude() {
  curl -s -o /dev/null -X POST "$BASE/api/hooks/claude-code" -H 'Content-Type: application/json' -d "$1"
}

echo
echo "session-radar — M4 acceptance (the 30-second scan test)"
echo "  port: $PORT"
echo

echo "[1/6] build everything"
(cd "$ROOT" && pnpm test >/tmp/session-radar-m4-tests.log 2>&1) \
  && { check "unit tests" "green" "green"; grep -E "Tests +[0-9]+ passed" /tmp/session-radar-m4-tests.log | tail -1 | sed 's/^/        /'; } \
  || { check "unit tests" "red" "green"; tail -25 /tmp/session-radar-m4-tests.log | sed 's/^/        /'; }
(cd "$ROOT" && pnpm build >/tmp/session-radar-m4-build.log 2>&1) \
  && check "daemon build" "ok" "ok" || { check "daemon build" "failed" "ok"; exit 1; }
(cd "$ROOT/packages/dashboard" && pnpm build >/tmp/session-radar-m4-dash.log 2>&1) \
  && check "dashboard build" "ok" "ok" || { check "dashboard build" "failed" "ok"; tail -20 /tmp/session-radar-m4-dash.log; exit 1; }
echo

echo "[2/6] seed >=8 items across sources, start daemon"
seed_cli
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "  port $PORT busy"; exit 1; fi
SESSION_RADAR_HOME="$RADAR_HOME" SESSION_RADAR_CLAUDE_HOME="$CLAUDE_HOME" \
SESSION_RADAR_CODEX_HOME="$CODEX_HOME" SESSION_RADAR_PORT="$PORT" \
SESSION_RADAR_GROK_HOME="$GROK_HOME" SESSION_RADAR_GROK_BINARY="$GROK_HOME/bin/grok" \
SESSION_RADAR_PROBE_PROCESSES=0 SESSION_RADAR_SWEEP_MS=2000 SESSION_RADAR_STALE_CLI_MS=6000 \
  node "$ROOT/packages/daemon/dist/index.js" >/tmp/session-radar-m4-daemon.log 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 60); do api /api/health >/dev/null 2>&1 && break; sleep 0.25; done
api /api/health >/dev/null 2>&1 && check "daemon up" "up" "up" || { check "daemon up" "down" "up"; exit 1; }

# Drive a spread of states across every source.
send_web claude-web m4-web-blocked blocked "M4 review the retry strategy"
send_web chatgpt-web m4-gpt-generating generating "M4 draft the investor update"
send_web chatgpt-web m4-gpt-done completed "M4 summarise the postmortem"
hook_claude '{"session_id":"11111111-1111-4111-8111-111111111111","hook_event_name":"Notification","notification_type":"permission_prompt","cwd":"/tmp/alpha"}'
hook_claude '{"session_id":"11111112-1111-4111-8111-111111111112","hook_event_name":"Stop","cwd":"/tmp/beta"}'
sleep 8

TOTAL="$(q count)"
check "at least 8 work items" "$([ "$TOTAL" -ge 8 ] && echo yes || echo "no($TOTAL)")" "yes"
echo

echo "[3/6] the dashboard is readable within 2s"
START="$(now_ms)"
HTML="$(curl -fsS "$BASE/")"
ASSET="$(printf '%s' "$HTML" | grep -o 'assets/[^"]*\.js' | head -1)"
curl -fsS -o /dev/null "$BASE/$ASSET"
CSS="$(printf '%s' "$HTML" | grep -o 'assets/[^"]*\.css' | head -1)"
curl -fsS -o /dev/null "$BASE/$CSS"
curl -fsS -o /dev/null "$BASE/api/workitems"
ELAPSED=$(( $(now_ms) - START ))
echo "        shell + js + css + data fetched in ${ELAPSED}ms"
check "under 2000ms" "$([ "$ELAPSED" -lt 2000 ] && echo yes || echo "no(${ELAPSED}ms)")" "yes"
check "serves the SPA shell" "$(printf '%s' "$HTML" | grep -c 'id="root"')" "1"
check "serves hashed assets" "$([ -n "$ASSET" ] && echo yes || echo no)" "yes"
echo

echo "[4/6] all four states present, in scan order"
node "$ROOT/scripts/lib/scan-check.mjs" "$BASE" > "$WORK/scan.txt" 2>&1
cat "$WORK/scan.txt" | sed 's/^/        /'
check "all four states present" "$(grep -c '^STATES_OK' "$WORK/scan.txt")" "1"
check "scan order correct" "$(grep -c '^ORDER_OK' "$WORK/scan.txt")" "1"
check "every item explains itself" "$(grep -c '^EVIDENCE_OK' "$WORK/scan.txt")" "1"
check "every actionable item has a way back in" "$(grep -c '^ENTRY_OK' "$WORK/scan.txt")" "1"
echo

echo "[5/6] Seen toggle is dashboard-local and does not touch status"
FIRST_DONE="$(api /api/workitems | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const it=JSON.parse(s).items.find(i=>i.status==='done');
  console.log(it?it.id:'');
});")"
if [[ -n "$FIRST_DONE" ]]; then
  curl -s -o /dev/null -X POST "$BASE/api/workitems/$FIRST_DONE/seen" -H 'Content-Type: application/json' -d '{"attention":"seen"}'
  AFTER="$(api "/api/workitems/$FIRST_DONE" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.attention+'|'+j.status)})")"
  check "attention flips, status untouched" "$AFTER" "seen|done"
else
  check "a done item exists to acknowledge" "none" "one"
fi
echo

echo "[6/6] revoke a source mid-session — coverage failure, not a clean empty state"
BEFORE="$(q count)"
mv "$PROJECTS" "$WORK/revoked"
for _ in $(seq 1 60); do
  [[ "$(q coverage-state claude-code-cli)" == "down" ]] && break
  sleep 1
done
check "collector reports down" "$(q coverage-state claude-code-cli)" "down"
check "coverage overall is loud" "$(q coverage-overall)" "down"
check "items did NOT vanish" "$(q count)" "$BEFORE"
check "the dashboard still serves" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" "200"
mv "$WORK/revoked" "$PROJECTS"
echo

echo "─────────────────────────────────────────────"
printf 'M4 acceptance: %d passed, %d failed\n' "$PASS" "$FAIL"
echo "─────────────────────────────────────────────"
[[ "$FAIL" -eq 0 ]]
