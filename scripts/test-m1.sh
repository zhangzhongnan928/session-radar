#!/usr/bin/env bash
#
# M1 acceptance gate.
#
#   * 2 seeded sessions per CLI, discovered by the pollers
#   * each driven into all four states: running, needs_victor, done, stale
#   * hook-driven transitions land within 15s; poll-driven within 60s
#   * revoking ~/.claude/projects makes the connector go DOWN in Coverage Health
#     while its work items REMAIN visible
#
# Runs against throwaway fixture directories, never real sessions or configs.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SESSION_RADAR_TEST_PORT:-4758}"
PASS=0
FAIL=0
DAEMON_PID=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/session-radar-m1-XXXXXX")"
RADAR_HOME="$WORK/home"
CLAUDE_HOME="$WORK/dot-claude"
CODEX_HOME="$WORK/dot-codex"
PROJECTS="$CLAUDE_HOME/projects"
ROLLOUTS="$CODEX_HOME/sessions/2026/07/28"

CC_A="11111111-1111-4111-8111-111111111111"
CC_B="22222222-2222-4222-8222-222222222222"
CX_A="019fa7ae-3778-7671-ba66-aaaaaaaaaaaa"
CX_B="019fa7ae-3778-7671-ba66-bbbbbbbbbbbb"

cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null
    wait "$DAEMON_PID" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

check() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  \033[32mPASS\033[0m  %-56s %s\n' "$label" "$actual"
    PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-56s got %s, want %s\n' "$label" "$actual" "$expected"
    FAIL=$((FAIL + 1))
  fi
}

api() { curl -fsS "http://127.0.0.1:$PORT$1"; }

# Status of the work item whose title contains $1.
status_of() {
  api /api/workitems | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const j=JSON.parse(s);
  const it=j.items.find(i=>i.title.includes(process.argv[1]));
  console.log(it?it.status:'<absent>');
});" "$1"
}

# Poll until status_of matches, or time out. Echoes the elapsed seconds.
await_status() {
  local needle="$1" want="$2" limit="$3" waited=0
  while [[ "$waited" -lt "$limit" ]]; do
    if [[ "$(status_of "$needle")" == "$want" ]]; then echo "$waited"; return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "$limit"
  return 1
}

post_claude_hook() {
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/hooks/claude-code" \
    -H 'Content-Type: application/json' -d "$1" >/dev/null
}
post_codex_hook() {
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/hooks/codex" \
    -H 'Content-Type: application/json' -d "$1" >/dev/null
}

seed() {
  mkdir -p "$PROJECTS/-tmp-repo-alpha" "$PROJECTS/-tmp-repo-beta" "$ROLLOUTS" "$RADAR_HOME"
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

  printf '%s\n' \
    "{\"type\":\"user\",\"timestamp\":\"$now\",\"cwd\":\"/tmp/repo-alpha\",\"sessionId\":\"$CC_A\",\"message\":{\"role\":\"user\",\"content\":\"M1ALPHA refactor the alpha module\"}}" \
    > "$PROJECTS/-tmp-repo-alpha/$CC_A.jsonl"
  printf '%s\n' \
    "{\"type\":\"user\",\"timestamp\":\"$now\",\"cwd\":\"/tmp/repo-beta\",\"sessionId\":\"$CC_B\",\"message\":{\"role\":\"user\",\"content\":\"M1BETA fix the beta tests\"}}" \
    > "$PROJECTS/-tmp-repo-beta/$CC_B.jsonl"

  printf '%s\n%s\n' \
    "{\"timestamp\":\"$now\",\"type\":\"session_meta\",\"payload\":{\"id\":\"$CX_A\",\"cwd\":\"/tmp/repo-gamma\",\"cli_version\":\"0.144.1\"}}" \
    "{\"timestamp\":\"$now\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"M1GAMMA migrate the gamma service\"}}" \
    > "$ROLLOUTS/rollout-2026-07-28T17-44-00-$CX_A.jsonl"
  printf '%s\n%s\n' \
    "{\"timestamp\":\"$now\",\"type\":\"session_meta\",\"payload\":{\"id\":\"$CX_B\",\"cwd\":\"/tmp/repo-delta\",\"cli_version\":\"0.144.1\"}}" \
    "{\"timestamp\":\"$now\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"M1DELTA audit the delta config\"}}" \
    > "$ROLLOUTS/rollout-2026-07-28T17-44-00-$CX_B.jsonl"
}

echo
echo "session-radar — M1 acceptance"
echo "  fixtures: $WORK"
echo "  port:     $PORT"
echo

echo "[1/6] pnpm test"
if (cd "$ROOT" && pnpm test >/tmp/session-radar-m1-tests.log 2>&1); then
  check "unit + integration tests" "green" "green"
  grep -E "Tests +[0-9]+ passed" /tmp/session-radar-m1-tests.log | tail -1 | sed 's/^/        /'
else
  check "unit + integration tests" "red" "green"
  tail -30 /tmp/session-radar-m1-tests.log | sed 's/^/        /'
fi
echo

echo "[2/6] build, seed fixtures, start daemon"
(cd "$ROOT" && pnpm build >/tmp/session-radar-m1-build.log 2>&1) \
  && check "tsc build" "ok" "ok" \
  || { check "tsc build" "failed" "ok"; tail -20 /tmp/session-radar-m1-build.log; exit 1; }

seed
check "2 Claude Code sessions seeded" "$(ls "$PROJECTS"/*/*.jsonl | wc -l | tr -d ' ')" "2"
check "2 Codex sessions seeded" "$(ls "$ROLLOUTS"/*.jsonl | wc -l | tr -d ' ')" "2"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  port $PORT already in use"; exit 1
fi

# Fast thresholds so a real running->stale transition is observable in seconds.
# Process probing off: fixture cwds host no real CLI process, and a spurious
# process_dead would mask the time-based staleness path we want to prove.
SESSION_RADAR_HOME="$RADAR_HOME" \
SESSION_RADAR_CLAUDE_HOME="$CLAUDE_HOME" \
SESSION_RADAR_CODEX_HOME="$CODEX_HOME" \
SESSION_RADAR_PORT="$PORT" \
SESSION_RADAR_PROBE_PROCESSES=0 \
SESSION_RADAR_STALE_CLI_MS=8000 \
SESSION_RADAR_SWEEP_MS=2000 \
  node "$ROOT/packages/daemon/dist/index.js" >/tmp/session-radar-m1-daemon.log 2>&1 &
DAEMON_PID=$!

for _ in $(seq 1 60); do
  api /api/health >/dev/null 2>&1 && break
  sleep 0.25
done
api /api/health >/dev/null 2>&1 \
  && check "daemon up" "up" "up" \
  || { check "daemon up" "down" "up"; cat /tmp/session-radar-m1-daemon.log; exit 1; }
echo

echo "[3/6] discovery + RUNNING (poll-driven, 60s budget)"
t=$(await_status M1ALPHA running 60); check "claude-code session A -> running (${t}s)" "$(status_of M1ALPHA)" "running"
t=$(await_status M1BETA running 60);  check "claude-code session B -> running (${t}s)" "$(status_of M1BETA)" "running"
t=$(await_status M1GAMMA running 60); check "codex session A -> running (${t}s)" "$(status_of M1GAMMA)" "running"
t=$(await_status M1DELTA running 60); check "codex session B -> running (${t}s)" "$(status_of M1DELTA)" "running"
echo

echo "[4/6] NEEDS_VICTOR and DONE (hook-driven, 15s budget)"
post_claude_hook "{\"session_id\":\"$CC_A\",\"hook_event_name\":\"Notification\",\"notification_type\":\"permission_prompt\",\"cwd\":\"/tmp/repo-alpha\"}"
t=$(await_status M1ALPHA needs_victor 15); check "permission prompt -> needs_victor (${t}s)" "$(status_of M1ALPHA)" "needs_victor"

post_codex_hook "{\"type\":\"approval-requested\",\"session-id\":\"$CX_A\",\"cwd\":\"/tmp/repo-gamma\"}"
t=$(await_status M1GAMMA needs_victor 15); check "codex approval-requested -> needs_victor (${t}s)" "$(status_of M1GAMMA)" "needs_victor"

post_claude_hook "{\"session_id\":\"$CC_A\",\"hook_event_name\":\"Stop\",\"cwd\":\"/tmp/repo-alpha\"}"
t=$(await_status M1ALPHA done 15); check "Stop hook clears the block -> done (${t}s)" "$(status_of M1ALPHA)" "done"

post_codex_hook "{\"type\":\"agent-turn-complete\",\"session-id\":\"$CX_A\",\"cwd\":\"/tmp/repo-gamma\"}"
t=$(await_status M1GAMMA done 15); check "codex agent-turn-complete -> done (${t}s)" "$(status_of M1GAMMA)" "done"
echo

echo "[5/6] STALE (time-driven, threshold 8s)"
t=$(await_status M1BETA stale 60);  check "claude-code session B -> stale (${t}s)" "$(status_of M1BETA)" "stale"
t=$(await_status M1DELTA stale 60); check "codex session B -> stale (${t}s)" "$(status_of M1DELTA)" "stale"
check "a completed session does NOT go stale" "$(status_of M1ALPHA)" "done"

RULE="$(api /api/workitems | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const j=JSON.parse(s);
  const it=j.items.find(i=>i.title.includes('M1BETA'));
  console.log(it&&it.currentEvidence?it.currentEvidence.rule:'<none>');
});")"
check "stale names its rule" "$RULE" "stale.no-progress"
echo

echo "[6/6] revoke ~/.claude/projects — coverage must scream, items must stay"
BEFORE="$(api /api/workitems | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).count))")"
mv "$PROJECTS" "$WORK/projects-revoked"

STATE=""
for _ in $(seq 1 60); do
  STATE="$(api /api/coverage | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const c=JSON.parse(s).connectors.find(c=>c.connectorId==='claude-code-cli');
  console.log(c?c.state:'<absent>');
});")"
  [[ "$STATE" == "down" ]] && break
  sleep 1
done

check "claude-code-cli connector -> down" "$STATE" "down"
check "coverage explains why" \
  "$(api /api/coverage | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const c=JSON.parse(s).connectors.find(c=>c.connectorId==='claude-code-cli');
  console.log(c&&/not found/i.test(c.lastError||'')?'yes':'no:'+(c?c.lastError:'?'));
});")" "yes"
check "work items did NOT vanish" \
  "$(api /api/workitems | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).count))")" \
  "$BEFORE"
check "overall coverage is loud" \
  "$(api /api/workitems | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).coverage.overall))")" \
  "down"

mv "$WORK/projects-revoked" "$PROJECTS"
for _ in $(seq 1 60); do
  [[ "$(api /api/coverage | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const c=JSON.parse(s).connectors.find(c=>c.connectorId==='claude-code-cli');
  console.log(c?c.state:'?');
});")" == "ok" ]] && break
  sleep 1
done
check "connector recovers once the directory returns" \
  "$(api /api/coverage | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const c=JSON.parse(s).connectors.find(c=>c.connectorId==='claude-code-cli');
  console.log(c?c.state:'?');
});")" "ok"
echo

echo "─────────────────────────────────────────────"
printf 'M1 acceptance: %d passed, %d failed\n' "$PASS" "$FAIL"
echo "─────────────────────────────────────────────"
[[ "$FAIL" -eq 0 ]]
