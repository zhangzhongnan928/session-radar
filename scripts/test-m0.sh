#!/usr/bin/env bash
#
# M0 acceptance gate.
#
#   1. `pnpm test` is green
#   2. the built daemon starts and binds 127.0.0.1:4747
#   3. GET /api/coverage answers with an EMPTY connector registry and does not crash
#   4. the database is 0600 and in WAL mode
#   5. the daemon shuts down cleanly on SIGTERM
#
# Runs against a throwaway SESSION_RADAR_HOME so it never disturbs real data.
# Pass --real-home to run against ~/.session-radar instead.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SESSION_RADAR_PORT:-4747}"
PASS=0
FAIL=0
DAEMON_PID=""

if [[ "${1:-}" == "--real-home" ]]; then
  TEST_HOME="${HOME}/.session-radar"
  CLEANUP_HOME=0
else
  TEST_HOME="$(mktemp -d "${TMPDIR:-/tmp}/session-radar-m0-XXXXXX")"
  CLEANUP_HOME=1
fi

cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null
    wait "$DAEMON_PID" 2>/dev/null
  fi
  if [[ "$CLEANUP_HOME" == "1" ]]; then
    rm -rf "$TEST_HOME"
  fi
}
trap cleanup EXIT

check() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  \033[32mPASS\033[0m  %-52s %s\n' "$label" "$actual"
    PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-52s got %s, want %s\n' "$label" "$actual" "$expected"
    FAIL=$((FAIL + 1))
  fi
}

# Reads JSON on stdin and prints the JSON-encoded value at the given path
# expression, e.g. `jqget '.connectors.length'`.
jqget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s)$1;console.log(v===undefined?'<undefined>':JSON.stringify(v));}catch(e){console.log('<parse-error>')}})"; }

echo
echo "session-radar — M0 acceptance"
echo "  home: $TEST_HOME"
echo "  port: $PORT"
echo

# --- 1. unit tests ----------------------------------------------------------
echo "[1/5] pnpm test"
if (cd "$ROOT" && pnpm test >/tmp/session-radar-m0-tests.log 2>&1); then
  check "unit + integration tests" "green" "green"
  tail -4 /tmp/session-radar-m0-tests.log | sed 's/^/        /'
else
  check "unit + integration tests" "red" "green"
  tail -30 /tmp/session-radar-m0-tests.log | sed 's/^/        /'
fi
echo

# --- 2. build + start -------------------------------------------------------
echo "[2/5] build and start the daemon"
if (cd "$ROOT" && pnpm build >/tmp/session-radar-m0-build.log 2>&1); then
  check "tsc build" "ok" "ok"
else
  check "tsc build" "failed" "ok"
  tail -20 /tmp/session-radar-m0-build.log | sed 's/^/        /'
  exit 1
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  port $PORT is already in use — stop the other process or set SESSION_RADAR_PORT"
  exit 1
fi

# M0's gate is specifically the empty-registry case. Real collectors ship by
# default now, so this asks for the zero-connector daemon explicitly — the
# invariant it protects (an empty registry must still answer, and must say so)
# is as important with four connectors available as it was with none.
SESSION_RADAR_HOME="$TEST_HOME" SESSION_RADAR_PORT="$PORT" SESSION_RADAR_NO_CONNECTORS=1 \
  node "$ROOT/packages/daemon/dist/index.js" >/tmp/session-radar-m0-daemon.log 2>&1 &
DAEMON_PID=$!

for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.2
done

if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  check "daemon listening on 127.0.0.1:$PORT" "up" "up"
else
  check "daemon listening on 127.0.0.1:$PORT" "down" "up"
  cat /tmp/session-radar-m0-daemon.log | sed 's/^/        /'
  exit 1
fi
echo

# --- 3. the acceptance endpoint --------------------------------------------
echo "[3/5] GET /api/coverage with zero connectors"
COVERAGE="$(curl -fsS "http://127.0.0.1:$PORT/api/coverage")"
echo "        $COVERAGE"
check "connectors[]"      "$(echo "$COVERAGE" | jqget '.connectors.length')" "0"
check "connectorCount"    "$(echo "$COVERAGE" | jqget '.connectorCount')" "0"
check "overall"           "$(echo "$COVERAGE" | jqget '.overall')" '"no_connectors"'

WORKITEMS="$(curl -fsS "http://127.0.0.1:$PORT/api/workitems")"
check "workitems count"   "$(echo "$WORKITEMS" | jqget '.count')" "0"
check "coverage bundled with the empty list" \
      "$(echo "$WORKITEMS" | jqget '.coverage.overall')" '"no_connectors"'

check "daemon still alive after those calls" \
      "$(kill -0 "$DAEMON_PID" 2>/dev/null && echo alive || echo dead)" "alive"
echo

# --- 4. store on disk -------------------------------------------------------
echo "[4/5] local store"
HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/api/health")"
check "db file mode"      "$(echo "$HEALTH" | jqget '.db.fileMode')" '"0600"'
check "journal mode"      "$(echo "$HEALTH" | jqget '.db.journalMode.toLowerCase()')" '"wal"'
check "actual mode on disk" "$(stat -f '%OLp' "$TEST_HOME/db.sqlite" 2>/dev/null)" "600"
check "home dir mode"     "$(stat -f '%OLp' "$TEST_HOME" 2>/dev/null)" "700"
echo

# --- 5. loopback + shutdown -------------------------------------------------
echo "[5/5] hardening and shutdown"
check "rejects a rebound Host header" \
      "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' "http://127.0.0.1:$PORT/api/coverage")" \
      "403"
check "rejects a foreign Origin" \
      "$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example.com' "http://127.0.0.1:$PORT/api/coverage")" \
      "403"

SHUTDOWN_START=$(date +%s)
kill -TERM "$DAEMON_PID" 2>/dev/null
for _ in $(seq 1 50); do
  kill -0 "$DAEMON_PID" 2>/dev/null || break
  sleep 0.1
done
SHUTDOWN_MS=$(( ($(date +%s) - SHUTDOWN_START) ))
check "exits on SIGTERM" "$(kill -0 "$DAEMON_PID" 2>/dev/null && echo running || echo exited)" "exited"
check "shutdown under 5s" "$([ "$SHUTDOWN_MS" -lt 5 ] && echo yes || echo no)" "yes"
DAEMON_PID=""
echo

echo "─────────────────────────────────────────────"
printf 'M0 acceptance: %d passed, %d failed\n' "$PASS" "$FAIL"
echo "─────────────────────────────────────────────"
[[ "$FAIL" -eq 0 ]]
