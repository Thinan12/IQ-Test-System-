#!/bin/bash
# Sections 1-8 — genuine server-backed auto-submission on time expiry.
#
# Uses a 1-minute assessment duration so the deadline can actually be waited out.
# Runs against a throwaway database.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

# Sweep quickly so the abandoned-session case is testable in reasonable time.
# Production defaults to 60s; this proves the setting is honoured too.
export AUTO_SUBMIT_SWEEP_SECONDS=5

start_server 4120

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
[ -n "$SUPER" ] || { c_red "could not log in"; server_log; exit 1; }

# 1-minute exam, 10-minute invitation link. The assessment owns both timers.
AS_ASMT=$(dbq "SELECT id AS v FROM assessments WHERE assessment_type='GENERAL_ASSESSMENT' ORDER BY created_at LIMIT 1")
http_body PATCH "$BASE/api/admin/assessments/$AS_ASMT" "$SUPER" '{"duration_minutes":1,"link_expiry_minutes":10}' > /dev/null
expect_eq "assessment duration configured to 1 minute" 1 "$(dbq "SELECT duration_minutes AS v FROM assessments WHERE id = '$AS_ASMT'")"

# Answer only SOME questions, so answered/unanswered can be told apart.
partial_attempt() { # partial_attempt <token> <code> <how-many-calc-questions>
  local token="$1" code="$2" howmany="$3"
  complete_profile "$token"
  http_body POST "$BASE/api/exam/$token/start" '' "{\"candidateCode\":\"$code\"}" > /dev/null
  local qlist; qlist=$(http_body GET "$BASE/api/exam/$token/questions")
  local qids; qids=$(jsonval "$qlist" "d.questions.filter(q=>q.type==='CALC').map(q=>q.id).join(',')")
  local i=0
  local IFS=','
  for qid in $qids; do
    [ "$i" -ge "$howmany" ] && break
    http_body POST "$BASE/api/exam/$token/answer" '' \
      "{\"questionId\":\"$qid\",\"answer\":${CORRECT_ANSWERS[$i]},\"timeSpentDeltaSeconds\":5}" > /dev/null
    i=$((i + 1))
  done
  unset IFS
}

c_head "1-minute assessment, 3 of 7 questions answered, then time runs out"
read -r A_ID A_CODE <<< "$(new_candidate "$HR" "Auto Submit Candidate")"
A_TOKEN=$(new_link "$HR" "$A_ID")
partial_attempt "$A_TOKEN" "$A_CODE" 3
SESSION_A=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$A_ID'")
expect_eq "session is IN_PROGRESS before the deadline" "IN_PROGRESS" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$SESSION_A'")"
expect_eq "3 answers are saved on the server" 3 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$SESSION_A' AND answer_json IS NOT NULL")"
SCHEDULED_END=$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$SESSION_A'")
echo "  scheduled end: $SCHEDULED_END"

c_head "Candidate walks away — no further request is ever sent from the browser"
# Nothing below touches the exam API for this candidate. The only thing that can
# finalize it is the server's own sweep.
echo "  waiting for the 1-minute deadline to pass (sweep runs every ${AUTO_SUBMIT_SWEEP_SECONDS}s)..."
DEADLINE_WAITED=no
for _ in $(seq 1 60); do
  STATUS=$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$SESSION_A'")
  if [ "$STATUS" = "SUBMITTED" ]; then DEADLINE_WAITED=yes; break; fi
  sleep 2
done
expect_eq "the abandoned assessment was finalized by the server with no candidate action" yes "$DEADLINE_WAITED"
expect_eq "status is SUBMITTED (lifecycle lock)" "SUBMITTED" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$SESSION_A'")"
expect_eq "submission type is AUTO_SUBMITTED" "AUTO_SUBMITTED" "$(dbq "SELECT submission_type AS v FROM assessment_sessions WHERE id = '$SESSION_A'")"
expect_eq "reason is TIME_EXPIRED" "TIME_EXPIRED" "$(dbq "SELECT submission_reason AS v FROM assessment_sessions WHERE id = '$SESSION_A'")"

c_head "Saved answers are preserved; unanswered stay unanswered"
expect_eq "the 3 saved answers are still there" 3 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$SESSION_A' AND answer_json IS NOT NULL")"
expect_eq "answered count recorded as 3" 3 "$(dbq "SELECT answered_count AS v FROM assessment_sessions WHERE id = '$SESSION_A'")"
expect_eq "unanswered count recorded as 4" 4 "$(dbq "SELECT unanswered_count AS v FROM assessment_sessions WHERE id = '$SESSION_A'")"
expect_eq "no answers were invented" 3 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$SESSION_A'")"
expect_eq "a result exists" 1 "$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = '$SESSION_A'")"
EXPECTED_PARTIAL=$(dbq "SELECT COALESCE(SUM(max_marks),0) AS v FROM (SELECT max_marks FROM questions WHERE type='CALC' AND active=1 AND question_family='GENERAL' ORDER BY order_index LIMIT 3)")
CALC_TOTAL=$(dbq "SELECT COALESCE(SUM(max_marks),0) AS v FROM questions WHERE type='CALC' AND active=1 AND question_family='GENERAL'")
expect_eq "only the 3 answered questions scored (full marks on those)" "$EXPECTED_PARTIAL" "$(dbq "SELECT calc_marks AS v FROM scores WHERE session_id = '$SESSION_A'")"
check "the partial score is below the full calculation total ($EXPECTED_PARTIAL of $CALC_TOTAL)" "$([ "$EXPECTED_PARTIAL" -lt "$CALC_TOTAL" ] && echo 0 || echo 1)"
expect_eq "question timing was finalized" 0 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$SESSION_A' AND submitted_at IS NULL")"
expect_eq "integrity record was produced" 1 "$(dbq "SELECT COUNT(*) AS v FROM integrity_assessments WHERE session_id = '$SESSION_A'")"

c_head "The assessment is locked — the candidate cannot continue"
expect_eq "answers can no longer be saved" 409 "$(http_code POST "$BASE/api/exam/$A_TOKEN/answer" '' '{"questionId":"x","answer":{"a":1}}')"
expect_eq "the question list is no longer served" 409 "$(http_code GET "$BASE/api/exam/$A_TOKEN/questions")"
complete_profile "$A_TOKEN"
expect_eq "the assessment cannot be restarted" 409 "$(http_code POST "$BASE/api/exam/$A_TOKEN/start" '' "{\"candidateCode\":\"$A_CODE\"}")"
expect_eq "submitting again is refused" 409 "$(http_code POST "$BASE/api/exam/$A_TOKEN/submit")"
REOPEN=$(http_body GET "$BASE/api/exam/$A_TOKEN")
expect_contains "reopening the link reports AUTO_SUBMITTED" 'AUTO_SUBMITTED' "$REOPEN"
expect_contains "reopening the link reports the reason" 'TIME_EXPIRED' "$REOPEN"
expect_eq "the score was not changed by any of those attempts" "$EXPECTED_PARTIAL" "$(dbq "SELECT calc_marks AS v FROM scores WHERE session_id = '$SESSION_A'")"

c_head "HR sees the full submission record"
DETAIL=$(http_body GET "$BASE/api/admin/candidates/$A_ID" "$HR")
expect_eq "Status: AUTO_SUBMITTED" "AUTO_SUBMITTED" "$(jsonval "$DETAIL" 'd.session.displayStatus')"
expect_eq "Reason: TIME_EXPIRED" "TIME_EXPIRED" "$(jsonval "$DETAIL" 'd.session.submissionReason')"
check "Started is recorded" "$([ -n "$(jsonval "$DETAIL" 'd.session.started_at')" ] && echo 0 || echo 1)"
check "Scheduled End is recorded" "$([ -n "$(jsonval "$DETAIL" 'd.session.scheduledEndAt')" ] && echo 0 || echo 1)"
check "Actual End is recorded" "$([ -n "$(jsonval "$DETAIL" 'd.session.actualEndAt')" ] && echo 0 || echo 1)"
expect_contains "Duration is reported" "min" "$(jsonval "$DETAIL" 'd.session.durationLabel')"
expect_eq "Answered is reported" 3 "$(jsonval "$DETAIL" 'd.session.answeredCount')"
expect_eq "Unanswered is reported" 4 "$(jsonval "$DETAIL" 'd.session.unansweredCount')"

c_head "The automatic submission is audited"
expect_eq "an ASSESSMENT_AUTO_SUBMITTED record exists" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action = 'ASSESSMENT_AUTO_SUBMITTED'")"
AUDIT_ROW=$(dbq "SELECT new_value AS v FROM audit_logs WHERE action = 'ASSESSMENT_AUTO_SUBMITTED' ORDER BY created_at DESC LIMIT 1")
expect_contains "audit names the candidate" "$A_CODE" "$AUDIT_ROW"
expect_contains "audit names the assessment" "$SESSION_A" "$AUDIT_ROW"
expect_contains "audit carries a timestamp" 'timestamp' "$AUDIT_ROW"
expect_contains "audit carries the reason" 'TIME_EXPIRED' "$AUDIT_ROW"
expect_contains "audit carries the answered count" 'answered' "$AUDIT_ROW"
expect_contains "audit carries the unanswered count" 'unanswered' "$AUDIT_ROW"

c_head "Auto-submit also fires on a request arriving after the deadline"
read -r B_ID B_CODE <<< "$(new_candidate "$HR" "Request Path Candidate")"
B_TOKEN=$(new_link "$HR" "$B_ID")
partial_attempt "$B_TOKEN" "$B_CODE" 2
SESSION_B=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$B_ID'")
# Move this one session's deadline into the past, so the NEXT request is what
# discovers it — independently of the background sweep.
#
# The deadline is moved and the request is sent inside ONE process, back to
# back. Doing it in two steps left a process-startup gap between them, and the
# sweep — which ticks every few seconds — could finalize the session inside that
# gap, so which path did the work depended on timing rather than on the
# behaviour being tested.
SAVE_RESPONSE=$("$NODE" -e "
  const Database = require('better-sqlite3');
  const http = require('http');
  const db = new Database(process.env.DATABASE_PATH);
  db.prepare(\"UPDATE assessment_sessions SET expires_at = datetime('now','-5 seconds') WHERE id = ?\").run(process.argv[1]);
  const base = new URL(process.argv[2]);
  const body = JSON.stringify({ questionId: 'any', answer: { a: 1 } });
  const rq = http.request({
    hostname: base.hostname, port: base.port,
    path: '/api/exam/' + process.argv[3] + '/answer', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (r) => { let out = ''; r.setEncoding('utf8'); r.on('data', (c) => out += c); r.on('end', () => console.log(out)); });
  rq.on('error', (e) => { console.log('{\"error\":\"' + e.message + '\"}'); });
  rq.end(body);
" "$SESSION_B" "$BASE" "$B_TOKEN")
expect_contains "the request itself triggers finalization" 'automatically' "$SAVE_RESPONSE"
expect_contains "and reports AUTO_SUBMITTED" 'AUTO_SUBMITTED' "$SAVE_RESPONSE"
expect_eq "the session is now finalized" "AUTO_SUBMITTED" "$(dbq "SELECT submission_type AS v FROM assessment_sessions WHERE id = '$SESSION_B'")"
expect_eq "the late answer was NOT stored" 2 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$SESSION_B'")"
expect_eq "answered count is 2" 2 "$(dbq "SELECT answered_count AS v FROM assessment_sessions WHERE id = '$SESSION_B'")"

c_head "Manual submission just before expiry is NOT duplicated"
read -r C_ID C_CODE <<< "$(new_candidate "$HR" "Manual Before Expiry")"
C_TOKEN=$(new_link "$HR" "$C_ID")
partial_attempt "$C_TOKEN" "$C_CODE" 6
SESSION_C=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$C_ID'")
MANUAL=$(http_body POST "$BASE/api/exam/$C_TOKEN/submit")
expect_contains "the manual submission succeeds" '"ok":true' "$MANUAL"
expect_eq "it is recorded as MANUAL" "MANUAL" "$(dbq "SELECT submission_type AS v FROM assessment_sessions WHERE id = '$SESSION_C'")"
expect_eq "reason is CANDIDATE_SUBMITTED" "CANDIDATE_SUBMITTED" "$(dbq "SELECT submission_reason AS v FROM assessment_sessions WHERE id = '$SESSION_C'")"
MANUAL_AT=$(dbq "SELECT submitted_at AS v FROM assessment_sessions WHERE id = '$SESSION_C'")
MANUAL_MARKS=$(dbq "SELECT calc_marks AS v FROM scores WHERE session_id = '$SESSION_C'")

# Now push its deadline into the past and let every other trigger fire at it.
"$NODE" -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH);
  db.prepare(\"UPDATE assessment_sessions SET expires_at = datetime('now','-5 seconds') WHERE id = ?\").run(process.argv[1]);
" "$SESSION_C"
http_code POST "$BASE/api/exam/$C_TOKEN/submit" > /dev/null
http_code GET "$BASE/api/exam/$C_TOKEN" > /dev/null
sleep 2
expect_eq "still exactly one score row" 1 "$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = '$SESSION_C'")"
expect_eq "still exactly one integrity row" 1 "$(dbq "SELECT COUNT(*) AS v FROM integrity_assessments WHERE session_id = '$SESSION_C'")"
expect_eq "submission type was not overwritten to AUTO" "MANUAL" "$(dbq "SELECT submission_type AS v FROM assessment_sessions WHERE id = '$SESSION_C'")"
expect_eq "submitted_at was not moved" "$MANUAL_AT" "$(dbq "SELECT submitted_at AS v FROM assessment_sessions WHERE id = '$SESSION_C'")"
expect_eq "the marks were not recomputed" "$MANUAL_MARKS" "$(dbq "SELECT calc_marks AS v FROM scores WHERE session_id = '$SESSION_C'")"
expect_eq "exactly one session exists for this candidate" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE candidate_id = '$C_ID'")"
expect_eq "no auto-submit audit entry for this candidate" 0 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action = 'ASSESSMENT_AUTO_SUBMITTED' AND target = '$C_CODE'")"

c_head "Concurrent submissions produce one final state"
read -r D_ID D_CODE <<< "$(new_candidate "$HR" "Race Condition Candidate")"
D_TOKEN=$(new_link "$HR" "$D_ID")
partial_attempt "$D_TOKEN" "$D_CODE" 4
SESSION_D=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$D_ID'")
RACE_PIDS=()
for _ in 1 2 3 4 5 6; do
  curl -s -o /dev/null -X POST "$BASE/api/exam/$D_TOKEN/submit" &
  RACE_PIDS+=($!)
done
# Wait only on these — a bare `wait` would also block on the test server.
for pid in "${RACE_PIDS[@]}"; do wait "$pid" 2>/dev/null; done
expect_eq "exactly one score row after 6 simultaneous submits" 1 "$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = '$SESSION_D'")"
expect_eq "exactly one integrity row" 1 "$(dbq "SELECT COUNT(*) AS v FROM integrity_assessments WHERE session_id = '$SESSION_D'")"
expect_eq "exactly one 'Assessment submitted' audit entry" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action = 'Assessment submitted' AND target = '$D_CODE'")"

c_head "The browser countdown is only a prompt — the server decides"
read -r E_ID E_CODE <<< "$(new_candidate "$HR" "Clock Manipulation Candidate")"
E_TOKEN=$(new_link "$HR" "$E_ID")
partial_attempt "$E_TOKEN" "$E_CODE" 1
SESSION_E=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$E_ID'")
# A client claiming its timer has not expired cannot extend anything: the
# deadline lives in the database and only the server reads it.
"$NODE" -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH);
  db.prepare(\"UPDATE assessment_sessions SET expires_at = datetime('now','-1 minutes') WHERE id = ?\").run(process.argv[1]);
" "$SESSION_E"
SNEAKY=$(http_body POST "$BASE/api/exam/$E_TOKEN/answer" '' '{"questionId":"any","answer":{"a":1},"expiresAt":"2099-01-01T00:00:00Z","timeRemaining":9999}')
expect_contains "a client-supplied deadline is ignored" 'AUTO_SUBMITTED' "$SNEAKY"
expect_eq "the session was finalized anyway" "AUTO_SUBMITTED" "$(dbq "SELECT submission_type AS v FROM assessment_sessions WHERE id = '$SESSION_E'")"
expect_eq "only the 1 genuinely saved answer counts" 1 "$(dbq "SELECT answered_count AS v FROM assessment_sessions WHERE id = '$SESSION_E'")"

# Restore the normal exam duration for any later suite reusing this database.
http_body PATCH "$BASE/api/admin/assessments/$AS_ASMT" "$SUPER" '{"duration_minutes":45}' > /dev/null

summary "AUTO-SUBMIT ON TIME EXPIRY (sections 1-8)"
