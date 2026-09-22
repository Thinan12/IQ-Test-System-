#!/bin/bash
# Shared harness for the LALCO verification suites.
#
# Every suite runs against a THROWAWAY database in its own temp directory and
# its own port, so nothing here can touch data/lalco.db.
#
# Override the interpreter if `node` on PATH is not the version better-sqlite3
# was built for:  NODE=/path/to/node ./test/run_all.sh

NODE="${NODE:-node}"
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS_COUNT=0
FAIL_COUNT=0
FAILURES=()
SERVER_PID=""
TEST_DIR=""
BASE=""

c_green() { printf '\033[32m%s\033[0m\n' "$1"; }
c_red()   { printf '\033[31m%s\033[0m\n' "$1"; }
c_head()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

pass() { PASS_COUNT=$((PASS_COUNT + 1)); c_green "  PASS  $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); FAILURES+=("$1"); c_red   "  FAIL  $1"; }

check() { # check <description> <condition-result:0|1> [detail]
  if [ "$2" = "0" ]; then pass "$1"; else fail "$1${3:+ — $3}"; fi
}

expect_eq() { # expect_eq <description> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 — expected '$2', got '$3'"; fi
}

expect_contains() { # expect_contains <description> <needle> <haystack>
  case "$3" in
    *"$2"*) pass "$1" ;;
    *) fail "$1 — '$2' not found in: $(printf '%s' "$3" | head -c 200)" ;;
  esac
}

expect_not_contains() {
  case "$3" in
    *"$2"*) fail "$1 — '$2' WAS present in: $(printf '%s' "$3" | head -c 200)" ;;
    *) pass "$1" ;;
  esac
}

# HTTP helpers -------------------------------------------------------------
http_code() { # http_code <method> <url> [auth-token] [json-body]
  local method="$1" url="$2" token="$3" body="$4"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}"
}

http_body() { # http_body <method> <url> [auth-token] [json-body]
  local method="$1" url="$2" token="$3" body="$4"
  local args=(-s -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}"
}

jsonval() { # jsonval <json> <js expression using `d`>
  "$NODE" -e "
    let d; try { d = JSON.parse(process.argv[1]); } catch (e) { console.log(''); process.exit(0); }
    const v = (() => { try { return ($2); } catch (e) { return ''; } })();
    console.log(v === undefined || v === null ? '' : v);
  " "$1"
}

login() { # login <email> <password>
  http_body POST "$BASE/api/admin/auth/login" '' "{\"email\":\"$1\",\"password\":\"$2\"}"
}

login_token() { jsonval "$(login "$1" "$2")" 'd.token'; }

# Query the throwaway database directly (there is no sqlite3 CLI on Windows).
# `node -e` resolves modules from the current directory, and every suite cds to
# the backend directory first, so a bare require works on both platforms.
dbq() { # dbq <sql returning one row with one column>
  ( cd "$BACKEND_DIR" && "$NODE" -e "
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DATABASE_PATH, { readonly: true });
    const row = db.prepare(process.argv[1]).get();
    console.log(row ? String(Object.values(row)[0]) : '');
  " "$1" )
}

# Assessment helpers -------------------------------------------------------
# The correct answer key for the six seeded calculation questions, in order.
CORRECT_ANSWERS=(
  '{"monthlyInterest":3000,"totalInterest":18000}'
  '{"monthlyPrincipal":2000,"outstandingPrincipal":14000}'
  '{"ltv":250,"decision":"Reject"}'
  '{"monthlyPrincipal":138.89,"month1Interest":125,"month1Total":263.89}'
  '{"monthlyInterest":210,"month6Total":7210}'
  '{"monthlyInterest":250,"totalInterest":9000,"brokerFee":315}'
)
WRONG_ANSWERS=(
  '{"monthlyInterest":1,"totalInterest":1}'
  '{"monthlyPrincipal":1,"outstandingPrincipal":1}'
  '{"ltv":1,"decision":"Accept"}'
  '{"monthlyPrincipal":1,"month1Interest":1,"month1Total":1}'
  '{"monthlyInterest":1,"month6Total":1}'
  '{"monthlyInterest":1,"totalInterest":1,"brokerFee":1}'
)

# take_assessment <exam-token> <candidate-code> <correct|wrong|partial> [essay text]
# Starts, answers every question and submits. Echoes the submit response.
take_assessment() {
  local token="$1" code="$2" mode="${3:-correct}" essay="${4:-Demo essay answer for verification.}"
  http_body POST "$BASE/api/exam/$token/start" '' "{\"candidateCode\":\"$code\"}" > /dev/null
  local qlist; qlist=$(http_body GET "$BASE/api/exam/$token/questions")
  local qids; qids=$(jsonval "$qlist" "d.questions.filter(q=>q.type==='CALC').map(q=>q.id).join(',')")
  local essay_qid; essay_qid=$(jsonval "$qlist" "d.questions.filter(q=>q.type==='ESSAY').map(q=>q.id)[0]")
  local i=0
  local IFS=','
  for qid in $qids; do
    local answer
    case "$mode" in
      correct) answer="${CORRECT_ANSWERS[$i]}" ;;
      wrong)   answer="${WRONG_ANSWERS[$i]}" ;;
      partial) if [ $((i % 2)) -eq 0 ]; then answer="${CORRECT_ANSWERS[$i]}"; else answer="${WRONG_ANSWERS[$i]}"; fi ;;
    esac
    http_body POST "$BASE/api/exam/$token/answer" ''       "{\"questionId\":\"$qid\",\"answer\":$answer,\"timeSpentDeltaSeconds\":30}" > /dev/null
    i=$((i + 1))
  done
  unset IFS
  [ -n "$essay_qid" ] && http_body POST "$BASE/api/exam/$token/answer" ''     "{\"questionId\":\"$essay_qid\",\"answer\":{\"text\":\"$essay\"},\"timeSpentDeltaSeconds\":120}" > /dev/null
  http_body POST "$BASE/api/exam/$token/submit"
}

# new_candidate <admin-token> <name> -> echoes "<id> <code>"
new_candidate() {
  local body; body=$(http_body POST "$BASE/api/admin/candidates" "$1"     "{\"fullName\":\"$2\",\"applicationType\":\"NORMAL\",\"iq\":110,\"education\":\"Bachelor Degree\"}")
  printf '%s %s' "$(jsonval "$body" 'd.id')" "$(jsonval "$body" 'd.code')"
}

# new_link <admin-token> <candidate-id> -> echoes the exam token
new_link() {
  jsonval "$(http_body POST "$BASE/api/admin/candidates/$2/links" "$1")" 'd.token'
}

# Lifecycle ----------------------------------------------------------------
# Node is a native Windows binary in this environment, so it is handed a native
# path and run with the temp directory as its working directory. That also means
# it never picks up the project's own .env — every setting below is explicit.
native_path() {
  if command -v cygpath > /dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

require_free_port() {
  if curl -s -o /dev/null -m 1 "http://localhost:$1/" 2>/dev/null; then
    c_red "port $1 is already in use — stop the other server first"
    exit 1
  fi
}

start_server() { # start_server [port]
  local port="${1:-4111}"
  require_free_port "$port"
  TEST_DIR="$(mktemp -d)"
  NATIVE_BACKEND="$(native_path "$BACKEND_DIR")"
  export DATABASE_PATH="$(native_path "$TEST_DIR")/test.db"
  export PORT="$port"
  export JWT_SECRET="${JWT_SECRET:-test-secret-$(date +%s)-0123456789abcdef}"
  export DEMO_PASSWORD="${DEMO_PASSWORD:-ChangeMe123!}"
  export NODE_ENV=development
  BASE="http://localhost:$port"

  ( cd "$TEST_DIR" && "$NODE" "$NATIVE_BACKEND/src/seed.js" > "$TEST_DIR/seed.log" 2>&1 )     || { c_red "seed failed"; cat "$TEST_DIR/seed.log"; exit 1; }

  pushd "$TEST_DIR" > /dev/null || exit 1
  "$NODE" "$NATIVE_BACKEND/src/server.js" > "$TEST_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  popd > /dev/null || exit 1

  for _ in $(seq 1 40); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/candidates")" = "401" ]; then
      # Guard: a test must never run against the real database.
      case "$DATABASE_PATH" in
        *lalco.db) c_red "refusing to run: DATABASE_PATH points at the production database"; exit 1 ;;
      esac
      return 0
    fi
    sleep 0.25
  done
  c_red "server did not start"; cat "$TEST_DIR/server.log"; exit 1
}

# Restart the running server with extra environment (used by the production
# HTTPS checks). Returns with BASE pointing at the new instance.
restart_server_with() { # restart_server_with <port> <VAR=value> ...
  stop_server
  local port="$1"; shift
  require_free_port "$port"
  export PORT="$port"
  BASE="http://localhost:$port"
  pushd "$TEST_DIR" > /dev/null || exit 1
  env "$@" "$NODE" "$NATIVE_BACKEND/src/server.js" > "$TEST_DIR/server-$port.log" 2>&1 &
  SERVER_PID=$!
  popd > /dev/null || exit 1
  for _ in $(seq 1 40); do
    curl -s -o /dev/null -m 1 "$BASE/" && return 0
    sleep 0.25
  done
  c_red "server did not restart"; cat "$TEST_DIR/server-$port.log"; exit 1
}

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  fi
}

server_log() { [ -n "$TEST_DIR" ] && cat "$TEST_DIR/server.log"; }

summary() { # summary <suite name>
  printf '\n\033[1m---- %s ----\033[0m\n' "$1"
  c_green "Passed: $PASS_COUNT"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    c_red "Failed: $FAIL_COUNT"
    for f in "${FAILURES[@]}"; do c_red "   - $f"; done
    return 1
  fi
  c_green "Failed: 0"
  return 0
}

trap 'stop_server' EXIT
