#!/bin/bash
# Priorities 1-5 and 10 — candidate lifecycle, link control, exam time control,
# live assessments, user management, and NULL-vs-zero / encoding rules.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

export AUTO_SUBMIT_SWEEP_SECONDS=5
start_server 4125

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
INTERVIEWER=$(login_token interviewer@lalco.demo "$DEMO_PASSWORD")
MANAGER=$(login_token manager@lalco.demo "$DEMO_PASSWORD")
[ -n "$SUPER" ] || { c_red "could not log in"; server_log; exit 1; }
EC=/api/admin/exam-control

# ===========================================================================
c_head "P1. CANDIDATE EDIT"
read -r C1 C1CODE <<< "$(new_candidate "$HR" "Lifecycle Candidate")"
expect_eq "edit candidate succeeds" 200 "$(http_code PATCH "$BASE/api/admin/candidates/$C1" "$HR" '{"full_name":"Lifecycle Candidate Renamed","phone":"02099887766","education":"Master Degree","iq":121}')"
D=$(http_body GET "$BASE/api/admin/candidates/$C1" "$HR")
expect_eq "the new name is persisted" "Lifecycle Candidate Renamed" "$(jsonval "$D" 'd.candidate.full_name')"
expect_eq "the new phone is persisted" "02099887766" "$(jsonval "$D" 'd.candidate.phone')"
expect_eq "the new IQ is persisted" 121 "$(jsonval "$D" 'd.candidate.iq')"
expect_eq "the edit is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Candidate updated' AND target = '$C1CODE'")"
expect_eq "Interviewer cannot edit a candidate" 403 "$(http_code PATCH "$BASE/api/admin/candidates/$C1" "$INTERVIEWER" '{"full_name":"nope"}')"
expect_eq "an edit with no valid field is rejected" 400 "$(http_code PATCH "$BASE/api/admin/candidates/$C1" "$HR" '{"not_a_column":"x"}')"

c_head "P1. ARCHIVE / RESTORE"
expect_eq "archive succeeds" 200 "$(http_code POST "$BASE/api/admin/candidates/$C1/archive" "$HR")"
expect_eq "the candidate is archived in the database" 1 "$(dbq "SELECT archived AS v FROM candidates WHERE id = '$C1'")"
expect_eq "archiving is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'CANDIDATE_ARCHIVED' AND target = '$C1CODE'")"
expect_not_contains "archived candidates are hidden from the active list" "$C1CODE" "$(http_body GET "$BASE/api/admin/candidates" "$HR")"
expect_contains "archived candidates appear under ?archived=1" "$C1CODE" "$(http_body GET "$BASE/api/admin/candidates?archived=1" "$HR")"
expect_eq "archiving twice is refused" 409 "$(http_code POST "$BASE/api/admin/candidates/$C1/archive" "$HR")"
expect_eq "restore succeeds" 200 "$(http_code POST "$BASE/api/admin/candidates/$C1/restore" "$HR")"
expect_eq "the candidate is no longer archived" 0 "$(dbq "SELECT archived AS v FROM candidates WHERE id = '$C1'")"
expect_contains "and is back in the active list" "$C1CODE" "$(http_body GET "$BASE/api/admin/candidates" "$HR")"
expect_eq "restoring a non-archived candidate is refused" 409 "$(http_code POST "$BASE/api/admin/candidates/$C1/restore" "$HR")"
expect_eq "Recruiter cannot archive" 403 "$(http_code POST "$BASE/api/admin/candidates/$C1/archive" "$RECRUITER")"

c_head "P1. PERMANENT DELETE — Super Admin only, blocked while live"
read -r C2 C2CODE <<< "$(new_candidate "$HR" "Delete Me Candidate")"
take_assessment "$(new_link "$HR" "$C2")" "$C2CODE" correct "Essay." > /dev/null
expect_eq "HR Admin cannot permanently delete" 403 "$(http_code DELETE "$BASE/api/admin/candidates/$C2" "$HR" "{\"confirmation\":\"$C2CODE\",\"password\":\"$DEMO_PASSWORD\"}")"
expect_eq "wrong confirmation code is refused" 400 "$(http_code DELETE "$BASE/api/admin/candidates/$C2" "$SUPER" '{"confirmation":"WRONG","password":"x"}')"
expect_eq "wrong password is refused" 401 "$(http_code DELETE "$BASE/api/admin/candidates/$C2" "$SUPER" "{\"confirmation\":\"$C2CODE\",\"password\":\"not-the-password\"}")"
expect_eq "the candidate still exists after refused attempts" 1 "$(dbq "SELECT COUNT(*) AS v FROM candidates WHERE id = '$C2'")"
SESS_C2=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$C2'")
DEL=$(http_body DELETE "$BASE/api/admin/candidates/$C2" "$SUPER" "{\"confirmation\":\"$C2CODE\",\"password\":\"$DEMO_PASSWORD\"}")
expect_contains "correct code + password deletes" 'permanently deleted' "$DEL"
expect_eq "the candidate row is gone" 0 "$(dbq "SELECT COUNT(*) AS v FROM candidates WHERE id = '$C2'")"
expect_eq "their session is gone" 0 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE id = '$SESS_C2'")"
expect_eq "their answers are gone" 0 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$SESS_C2'")"
expect_eq "their scores are gone" 0 "$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = '$SESS_C2'")"
expect_eq "the deletion is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'CANDIDATE_DELETED' AND target = '$C2CODE'")"
expect_eq "other candidates are untouched" 1 "$(dbq "SELECT COUNT(*) AS v FROM candidates WHERE id = '$C1'")"

# A candidate mid-assessment must not be deletable.
read -r C3 C3CODE <<< "$(new_candidate "$HR" "Live Delete Guard")"
T3=$(new_link "$HR" "$C3")
http_body POST "$BASE/api/exam/$T3/start" '' "{\"candidateCode\":\"$C3CODE\"}" > /dev/null
DELLIVE=$(http_body DELETE "$BASE/api/admin/candidates/$C3" "$SUPER" "{\"confirmation\":\"$C3CODE\",\"password\":\"$DEMO_PASSWORD\"}")
expect_contains "a candidate with a running assessment cannot be deleted" 'IN_PROGRESS' "$DELLIVE"
expect_eq "they still exist" 1 "$(dbq "SELECT COUNT(*) AS v FROM candidates WHERE id = '$C3'")"

# ===========================================================================
c_head "P2. LINK DISABLE / ENABLE / EXTEND"
read -r C4 C4CODE <<< "$(new_candidate "$HR" "Link Control Candidate")"
LINK=$(http_body POST "$BASE/api/admin/candidates/$C4/links" "$HR")
L4=$(jsonval "$LINK" 'd.id'); T4=$(jsonval "$LINK" 'd.token')
expect_eq "the fresh link works" 200 "$(http_code GET "$BASE/api/exam/$T4")"
expect_eq "disable succeeds" 200 "$(http_code POST "$BASE$EC/links/$L4/disable" "$HR")"
DIS=$(http_body GET "$BASE/api/exam/$T4")
expect_eq "a disabled link is rejected (410)" 410 "$(http_code GET "$BASE/api/exam/$T4")"
expect_contains "with a message that says it is disabled" 'temporarily disabled' "$DIS"
expect_eq "the link reports DISABLED" "DISABLED" "$(jsonval "$DIS" 'd.linkStatus')"
expect_eq "disabling is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'LINK_DISABLED'")"
expect_eq "disabling twice is refused" 409 "$(http_code POST "$BASE$EC/links/$L4/disable" "$HR")"
expect_eq "re-enable succeeds" 200 "$(http_code POST "$BASE$EC/links/$L4/enable" "$HR")"
expect_eq "the link works again" 200 "$(http_code GET "$BASE/api/exam/$T4")"
expect_eq "re-enabling is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'LINK_ENABLED'")"
expect_eq "enabling a non-disabled link is refused" 409 "$(http_code POST "$BASE$EC/links/$L4/enable" "$HR")"
expect_eq "Interviewer cannot disable a link" 403 "$(http_code POST "$BASE$EC/links/$L4/disable" "$INTERVIEWER")"

BEFORE_EXP=$(dbq "SELECT expires_at AS v FROM assessment_links WHERE id = '$L4'")
expect_eq "extend link expiry succeeds" 200 "$(http_code POST "$BASE$EC/links/$L4/extend" "$HR" '{"addMinutes":30}')"
AFTER_EXP=$(dbq "SELECT expires_at AS v FROM assessment_links WHERE id = '$L4'")
check "the expiry moved later ($BEFORE_EXP -> $AFTER_EXP)" "$([ "$AFTER_EXP" != "$BEFORE_EXP" ] && echo 0 || echo 1)"
expect_eq "extending is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'LINK_EXPIRY_EXTENDED'")"
expect_eq "a zero extension is rejected" 400 "$(http_code POST "$BASE$EC/links/$L4/extend" "$HR" '{"addMinutes":0}')"
expect_eq "an absurd extension is rejected" 400 "$(http_code POST "$BASE$EC/links/$L4/extend" "$HR" '{"addMinutes":99999}')"

# A revoked link is permanently dead.
http_body POST "$BASE/api/admin/candidates/links/$L4/revoke" "$HR" > /dev/null
expect_eq "a revoked link cannot be re-enabled" 409 "$(http_code POST "$BASE$EC/links/$L4/enable" "$HR")"
expect_eq "a revoked link cannot be extended" 409 "$(http_code POST "$BASE$EC/links/$L4/extend" "$HR" '{"addMinutes":10}')"

c_head "P2. INVITATION EXPIRY IS CONFIGURABLE AND PER-LINK"
# Since assessment management, the ASSESSMENT owns the invitation window; the
# value in Settings is only the default a new assessment starts with.
ASMT=$(dbq 'SELECT id AS v FROM assessments ORDER BY created_at LIMIT 1')
http_body PATCH "$BASE/api/admin/assessments/$ASMT" "$SUPER" '{"link_expiry_minutes":5}' > /dev/null
L5=$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$C4/links" "$HR")" 'd.id')
EXP5=$(dbq "SELECT CAST((julianday(expires_at) - julianday(created_at)) * 24 * 60 + 0.5 AS INTEGER) AS v FROM assessment_links WHERE id = '$L5'")
expect_eq "a 5-minute assessment setting yields a 5-minute link" 5 "$EXP5"
http_body PATCH "$BASE/api/admin/assessments/$ASMT" "$SUPER" '{"link_expiry_minutes":30}' > /dev/null
L6=$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$C4/links" "$HR")" 'd.id')
EXP6=$(dbq "SELECT CAST((julianday(expires_at) - julianday(created_at)) * 24 * 60 + 0.5 AS INTEGER) AS v FROM assessment_links WHERE id = '$L6'")
expect_eq "a 30-minute assessment setting yields a 30-minute link" 30 "$EXP6"
EXP5_AGAIN=$(dbq "SELECT CAST((julianday(expires_at) - julianday(created_at)) * 24 * 60 + 0.5 AS INTEGER) AS v FROM assessment_links WHERE id = '$L5'")
expect_eq "the earlier link kept its own 5-minute expiry" 5 "$EXP5_AGAIN"
expect_eq "the global setting did not change the assessment" 10 "$(dbq 'SELECT link_expiry_minutes AS v FROM settings WHERE id = 1')"
http_body PATCH "$BASE/api/admin/assessments/$ASMT" "$SUPER" '{"link_expiry_minutes":10}' > /dev/null

# ===========================================================================
c_head "P3/P4. LIVE ASSESSMENTS dashboard"
read -r C7 C7CODE <<< "$(new_candidate "$HR" "Live Control Candidate")"
T7=$(new_link "$HR" "$C7")
http_body POST "$BASE/api/exam/$T7/start" '' "{\"candidateCode\":\"$C7CODE\"}" > /dev/null
QL=$(http_body GET "$BASE/api/exam/$T7/questions")
Q1=$(jsonval "$QL" "d.questions.filter(q=>q.type==='CALC')[0].id")
http_body POST "$BASE/api/exam/$T7/answer" '' "{\"questionId\":\"$Q1\",\"answer\":{\"monthlyInterest\":3000,\"totalInterest\":18000},\"timeSpentDeltaSeconds\":10}" > /dev/null
LIVE=$(http_body GET "$BASE$EC/live" "$HR")
expect_contains "the running assessment is listed" "$C7CODE" "$LIVE"
S7=$(jsonval "$LIVE" "d.assessments.filter(a=>a.candidateCode==='$C7CODE')[0].sessionId")
for field in candidateName startedAt remainingSeconds progressPercent status linkStatus integrityRisk lastActivityAt; do
  expect_eq "live row carries $field" 1 "$(jsonval "$LIVE" "d.assessments[0].$field !== undefined ? 1 : 0")"
done
expect_eq "progress reflects the one answered question" 1 "$(jsonval "$LIVE" "d.assessments.filter(a=>a.candidateCode==='$C7CODE')[0].answered")"
expect_eq "status is IN_PROGRESS" "IN_PROGRESS" "$(jsonval "$LIVE" "d.assessments.filter(a=>a.candidateCode==='$C7CODE')[0].status")"
expect_contains "PAUSE is offered for a running exam" "PAUSE" "$(jsonval "$LIVE" "d.assessments.filter(a=>a.candidateCode==='$C7CODE')[0].availableActions.join(',')")"
expect_eq "Recruiter cannot see Live Assessments" 403 "$(http_code POST "$BASE$EC/sessions/$S7/pause" "$RECRUITER")"

c_head "P3. PAUSE — candidate is locked out and the clock freezes"
REMAIN_BEFORE=$(jsonval "$(http_body GET "$BASE$EC/sessions/$S7" "$HR")" 'd.session.remainingSeconds')
expect_eq "pause succeeds" 200 "$(http_code POST "$BASE$EC/sessions/$S7/pause" "$HR")"
expect_eq "status is PAUSED" "PAUSED" "$(jsonval "$(http_body GET "$BASE$EC/sessions/$S7" "$HR")" 'd.session.liveStatus')"
expect_eq "the candidate cannot read questions while paused (423)" 423 "$(http_code GET "$BASE/api/exam/$T7/questions")"
expect_eq "the candidate cannot save answers while paused (423)" 423 "$(http_code POST "$BASE/api/exam/$T7/answer" '' "{\"questionId\":\"$Q1\",\"answer\":{\"monthlyInterest\":1}}")"
PAUSED_BODY=$(http_body GET "$BASE/api/exam/$T7/questions")
expect_contains "the candidate is told it was paused by the administrator" 'paused by the administrator' "$PAUSED_BODY"
expect_contains "and reassured their answers are safe" 'safe' "$PAUSED_BODY"
expect_eq "pausing is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'EXAM_PAUSED'")"
expect_eq "pausing twice is refused" 409 "$(http_code POST "$BASE$EC/sessions/$S7/pause" "$HR")"
sleep 3
REMAIN_PAUSED=$(jsonval "$(http_body GET "$BASE$EC/sessions/$S7" "$HR")" 'd.session.remainingSeconds')
check "the countdown is frozen while paused (${REMAIN_BEFORE}s -> ${REMAIN_PAUSED}s after 3s)" \
  "$([ "$REMAIN_PAUSED" -ge "$((REMAIN_BEFORE - 1))" ] && echo 0 || echo 1)"

c_head "P3. RESUME — paused time is credited back"
EXPIRY_BEFORE=$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$S7'")
RESUMED=$(http_body POST "$BASE$EC/sessions/$S7/resume" "$HR")
expect_contains "resume succeeds" '"ok":true' "$RESUMED"
EXPIRY_AFTER=$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$S7'")
check "the deadline moved out by the paused duration ($EXPIRY_BEFORE -> $EXPIRY_AFTER)" "$([ "$EXPIRY_AFTER" != "$EXPIRY_BEFORE" ] && echo 0 || echo 1)"
check "total paused time was recorded ($(dbq "SELECT total_paused_seconds AS v FROM assessment_sessions WHERE id = '$S7'")s)" \
  "$([ "$(dbq "SELECT total_paused_seconds AS v FROM assessment_sessions WHERE id = '$S7'")" -ge 2 ] && echo 0 || echo 1)"
expect_eq "the candidate can work again" 200 "$(http_code GET "$BASE/api/exam/$T7/questions")"
expect_eq "resuming is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'EXAM_RESUMED'")"
expect_eq "resuming a running exam is refused" 409 "$(http_code POST "$BASE$EC/sessions/$S7/resume" "$HR")"
expect_eq "answers saved before the pause survived" 1 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$S7' AND answer_json IS NOT NULL")"

c_head "P3. EXTEND TIME vs CHANGE TIME (they are different operations)"
EXP_A=$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$S7'")
expect_eq "extend adds minutes" 200 "$(http_code POST "$BASE$EC/sessions/$S7/extend-time" "$HR" '{"addMinutes":10}')"
EXP_B=$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$S7'")
DIFF=$(dbq "SELECT CAST((julianday('$EXP_B') - julianday('$EXP_A')) * 24 * 60 + 0.5 AS INTEGER) AS v")
expect_eq "the deadline moved out by exactly 10 minutes" 10 "$DIFF"
expect_eq "extending is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'EXAM_TIME_EXTENDED'")"
expect_eq "a negative extension is rejected" 400 "$(http_code POST "$BASE$EC/sessions/$S7/extend-time" "$HR" '{"addMinutes":-5}')"

expect_eq "change-time sets a new total duration" 200 "$(http_code POST "$BASE$EC/sessions/$S7/change-time" "$HR" '{"durationMinutes":90}')"
NEWDUR=$(dbq "SELECT duration_minutes AS v FROM assessment_sessions WHERE id = '$S7'")
expect_eq "the stored duration is now 90" 90 "$NEWDUR"
FROM_START=$(dbq "SELECT CAST((julianday(expires_at) - julianday(started_at)) * 24 * 60 + 0.5 AS INTEGER) AS v FROM assessment_sessions WHERE id = '$S7'")
check "the deadline is 90 minutes from the start plus credited pause time (got ${FROM_START}m)" \
  "$([ "$FROM_START" -ge 90 ] && [ "$FROM_START" -le 92 ] && echo 0 || echo 1)"
expect_eq "change-time is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'EXAM_TIME_CHANGED'")"
expect_eq "an out-of-range duration is rejected" 400 "$(http_code POST "$BASE$EC/sessions/$S7/change-time" "$HR" '{"durationMinutes":0}')"
expect_eq "the original deadline is preserved for the audit trail" 1 "$(dbq "SELECT CASE WHEN original_expires_at IS NOT NULL THEN 1 ELSE 0 END AS v FROM assessment_sessions WHERE id = '$S7'")"

c_head "P3. TERMINATE"
TERM=$(http_body POST "$BASE$EC/sessions/$S7/terminate" "$HR" '{"note":"Candidate left the room."}')
expect_contains "terminate succeeds" '"ok":true' "$TERM"
expect_eq "status is TERMINATED" "TERMINATED" "$(jsonval "$(http_body GET "$BASE$EC/sessions/$S7" "$HR")" 'd.session.liveStatus')"
expect_eq "submission_type is TERMINATED" "TERMINATED" "$(dbq "SELECT submission_type AS v FROM assessment_sessions WHERE id = '$S7'")"
expect_eq "reason is TERMINATED_BY_ADMIN" "TERMINATED_BY_ADMIN" "$(dbq "SELECT submission_reason AS v FROM assessment_sessions WHERE id = '$S7'")"
expect_eq "the assessment is locked (409)" 409 "$(http_code GET "$BASE/api/exam/$T7/questions")"
expect_eq "the candidate cannot submit afterwards" 409 "$(http_code POST "$BASE/api/exam/$T7/submit")"
expect_eq "it was still marked from the saved answers" 1 "$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = '$S7'")"
expect_eq "answered/unanswered were counted" 1 "$(dbq "SELECT CASE WHEN answered_count IS NOT NULL THEN 1 ELSE 0 END AS v FROM assessment_sessions WHERE id = '$S7'")"
expect_eq "terminating is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'EXAM_TERMINATED'")"
expect_eq "the admin finalization is recorded too" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'ASSESSMENT_TERMINATED'")"
expect_eq "terminating twice is refused" 409 "$(http_code POST "$BASE$EC/sessions/$S7/terminate" "$HR")"
expect_eq "a terminated exam can no longer be paused" 409 "$(http_code POST "$BASE$EC/sessions/$S7/pause" "$HR")"
expect_eq "a terminated exam can no longer be extended" 409 "$(http_code POST "$BASE$EC/sessions/$S7/extend-time" "$HR" '{"addMinutes":5}')"
expect_not_contains "it disappears from Live Assessments" "$C7CODE" "$(http_body GET "$BASE$EC/live" "$HR")"

c_head "P12. RACE CONDITIONS"
# submit vs terminate
read -r R1 R1CODE <<< "$(new_candidate "$HR" "Race Submit Terminate")"
RT=$(new_link "$HR" "$R1")
http_body POST "$BASE/api/exam/$RT/start" '' "{\"candidateCode\":\"$R1CODE\"}" > /dev/null
RS=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$R1'")
curl -s -o /dev/null -X POST "$BASE/api/exam/$RT/submit" &
P1=$!
curl -s -o /dev/null -X POST "$BASE$EC/sessions/$RS/terminate" -H "Authorization: Bearer $HR" &
P2=$!
wait "$P1" 2>/dev/null; wait "$P2" 2>/dev/null
expect_eq "submit racing terminate leaves exactly one score row" 1 "$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = '$RS'")"
expect_eq "and exactly one final state" "SUBMITTED" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$RS'")"

# pause vs expiry: a paused session must never be auto-submitted
read -r R2 R2CODE <<< "$(new_candidate "$HR" "Race Pause Expiry")"
RT2=$(new_link "$HR" "$R2")
http_body POST "$BASE/api/exam/$RT2/start" '' "{\"candidateCode\":\"$R2CODE\"}" > /dev/null
RS2=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$R2'")
http_body POST "$BASE$EC/sessions/$RS2/pause" "$HR" > /dev/null
"$NODE" -e "
  const D=require('better-sqlite3'); const db=new D(process.env.DATABASE_PATH);
  db.prepare(\"UPDATE assessment_sessions SET expires_at = datetime('now','-10 minutes') WHERE id = ?\").run(process.argv[1]);
" "$RS2"
sleep 8
expect_eq "a PAUSED session past its deadline is NOT auto-submitted" "IN_PROGRESS" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$RS2'")"
expect_eq "it is still paused" 1 "$(dbq "SELECT CASE WHEN paused_at IS NOT NULL THEN 1 ELSE 0 END AS v FROM assessment_sessions WHERE id = '$RS2'")"
RES2=$(http_body POST "$BASE$EC/sessions/$RS2/resume" "$HR")
expect_contains "resuming it credits the paused time back" '"ok":true' "$RES2"

# extend vs expiry: extending past the deadline revives the exam
read -r R3 R3CODE <<< "$(new_candidate "$HR" "Race Extend Expiry")"
RT3=$(new_link "$HR" "$R3")
http_body POST "$BASE/api/exam/$RT3/start" '' "{\"candidateCode\":\"$R3CODE\"}" > /dev/null
RS3=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$R3'")
"$NODE" -e "
  const D=require('better-sqlite3'); const db=new D(process.env.DATABASE_PATH);
  db.prepare(\"UPDATE assessment_sessions SET expires_at = datetime('now','+2 seconds') WHERE id = ?\").run(process.argv[1]);
" "$RS3"
http_body POST "$BASE$EC/sessions/$RS3/extend-time" "$HR" '{"addMinutes":30}' > /dev/null
sleep 8
expect_eq "an extended exam is not auto-submitted at the old deadline" "IN_PROGRESS" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$RS3'")"
expect_eq "the candidate can still work" 200 "$(http_code GET "$BASE/api/exam/$RT3/questions")"

# ===========================================================================
c_head "P5. USER MANAGEMENT"
expect_eq "only Super Admin may list users" 403 "$(http_code GET "$BASE/api/admin/users" "$HR")"
USERS=$(http_body GET "$BASE/api/admin/users" "$SUPER")
expect_eq "the seeded accounts are listed" 6 "$(jsonval "$USERS" 'd.users.length')"
expect_not_contains "no password hash is ever returned" 'password_hash' "$USERS"
expect_not_contains "no password field is returned" '"password"' "$USERS"

NEWU=$(http_body POST "$BASE/api/admin/users" "$SUPER" '{"name":"Audit Test User","email":"audit.user@lalco.demo","role":"RECRUITER","password":"Kx9#mQr4Tz!vLp2"}')
NUID=$(jsonval "$NEWU" 'd.user.id')
expect_eq "create user succeeds" 201 "$(http_code POST "$BASE/api/admin/users" "$SUPER" '{"name":"Second User","email":"second.user@lalco.demo","role":"EVALUATOR","password":"Kx9#mQr4Tz!vLp2"}')"
expect_eq "the new user can sign in" 1 "$(jsonval "$(login audit.user@lalco.demo 'Kx9#mQr4Tz!vLp2')" 'd.token ? 1 : 0')"
expect_eq "their password is bcrypt-hashed" 1 "$(dbq "SELECT CASE WHEN password_hash LIKE '\$2%' THEN 1 ELSE 0 END AS v FROM users WHERE email = 'audit.user@lalco.demo'")"
expect_eq "a duplicate email is refused" 409 "$(http_code POST "$BASE/api/admin/users" "$SUPER" '{"name":"Dup","email":"audit.user@lalco.demo","role":"RECRUITER","password":"Kx9#mQr4Tz!vLp2"}')"
expect_eq "a weak password is refused" 400 "$(http_code POST "$BASE/api/admin/users" "$SUPER" '{"name":"Weak","email":"weak@lalco.demo","role":"RECRUITER","password":"short"}')"
expect_eq "an invalid email is refused" 400 "$(http_code POST "$BASE/api/admin/users" "$SUPER" '{"name":"Bad","email":"not-an-email","role":"RECRUITER","password":"Kx9#mQr4Tz!vLp2"}')"
expect_eq "an invalid role is refused" 400 "$(http_code POST "$BASE/api/admin/users" "$SUPER" '{"name":"Bad","email":"role@lalco.demo","role":"WIZARD","password":"Kx9#mQr4Tz!vLp2"}')"
expect_eq "user creation is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'USER_CREATED'")"

expect_eq "edit user succeeds" 200 "$(http_code PATCH "$BASE/api/admin/users/$NUID" "$SUPER" '{"name":"Audit Test User Renamed"}')"
expect_eq "the new name is stored" "Audit Test User Renamed" "$(dbq "SELECT name AS v FROM users WHERE id = '$NUID'")"

expect_eq "change role succeeds" 200 "$(http_code POST "$BASE/api/admin/users/$NUID/role" "$SUPER" '{"role":"MANAGER"}')"
expect_eq "the role changed" "MANAGER" "$(dbq "SELECT role AS v FROM users WHERE id = '$NUID'")"
expect_eq "role change is audited separately" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'USER_ROLE_CHANGED'")"
expect_eq "setting the same role again is refused" 400 "$(http_code POST "$BASE/api/admin/users/$NUID/role" "$SUPER" '{"role":"MANAGER"}')"

expect_eq "disable user succeeds" 200 "$(http_code POST "$BASE/api/admin/users/$NUID/active" "$SUPER" '{"active":false}')"
expect_eq "the disabled user cannot sign in" "" "$(jsonval "$(login audit.user@lalco.demo 'Kx9#mQr4Tz!vLp2')" 'd.token')"
expect_eq "disabling is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'USER_DISABLED'")"
expect_eq "enable user succeeds" 200 "$(http_code POST "$BASE/api/admin/users/$NUID/active" "$SUPER" '{"active":true}')"
expect_eq "the re-enabled user can sign in again" 1 "$(jsonval "$(login audit.user@lalco.demo 'Kx9#mQr4Tz!vLp2')" 'd.token ? 1 : 0')"

RESET=$(http_body POST "$BASE/api/admin/users/$NUID/reset-password" "$SUPER" '{"generate":true}')
GENPW=$(jsonval "$RESET" 'd.generatedPassword')
check "a generated password is returned once" "$([ ${#GENPW} -ge 10 ] && echo 0 || echo 1)"
expect_eq "the old password no longer works" "" "$(jsonval "$(login audit.user@lalco.demo 'Kx9#mQr4Tz!vLp2')" 'd.token')"
expect_eq "the new password works" 1 "$(jsonval "$(login audit.user@lalco.demo "$GENPW")" 'd.token ? 1 : 0')"
expect_eq "the reset is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'USER_PASSWORD_RESET'")"
AUDIT_PW=$(dbq "SELECT COALESCE(new_value,'') AS v FROM audit_logs WHERE action = 'USER_PASSWORD_RESET' LIMIT 1")
expect_not_contains "the audit record never stores the password itself" "$GENPW" "$AUDIT_PW"

SUPER_ID=$(dbq "SELECT id AS v FROM users WHERE email = 'superadmin@lalco.demo'")
expect_eq "you cannot disable your own account" 409 "$(http_code POST "$BASE/api/admin/users/$SUPER_ID/active" "$SUPER" '{"active":false}')"
expect_eq "the last Super Admin cannot be demoted" 409 "$(http_code POST "$BASE/api/admin/users/$SUPER_ID/role" "$SUPER" '{"role":"RECRUITER"}')"

# ===========================================================================
c_head "P10. NULL vs ZERO"
read -r N1 N1CODE <<< "$(new_candidate "$HR" "Null Display Candidate")"
take_assessment "$(new_link "$HR" "$N1")" "$N1CODE" wrong "Essay text." > /dev/null
CSV=$(curl -s -H "Authorization: Bearer $HR" "$BASE/api/admin/reports/candidate/$N1.csv")
expect_contains "an unmarked written score reads 'Not graded'" 'Not graded' "$CSV"
expect_contains "an unheld interview reads 'Not completed'" 'Not completed' "$CSV"
expect_contains "an incomplete final reads 'Not calculated'" 'Not calculated' "$CSV"
expect_not_contains "an unmarked essay is NOT shown as 0/30" 'Written,0/30' "$CSV"
expect_contains "a genuine zero on the calculation section still shows 0/30" '0/30' "$CSV"

# Now mark the essay as a real zero and confirm it is displayed as 0, not "not graded".
http_body POST "$BASE/api/admin/candidates/$N1/essay-score" "$HR" '{"rubricScores":{"content":0,"accuracy":0,"reasoning":0,"communication":0,"professionalism":0},"comments":"Nothing usable."}' > /dev/null
CSV2=$(curl -s -H "Authorization: Bearer $HR" "$BASE/api/admin/reports/candidate/$N1.csv")
expect_contains "an essay genuinely scored zero reads 0/30" 'Written,0/30' "$CSV2"
expect_not_contains "and is no longer 'Not graded'" 'Written,Not graded' "$CSV2"

c_head "P10. ENCODING — CSV BOM, Excel and PDF Unicode"
LAO_NAME="ນາງ ສົມໃຈ"
# curl.exe on Windows mangles non-ASCII passed via -d, so the payload is written
# as a UTF-8 file by node and posted with --data-binary. This is a limitation of
# the test harness, not of the application.
"$NODE" -e "
  require('fs').writeFileSync(process.argv[1], JSON.stringify({fullName: process.argv[2], applicationType:'NORMAL', iq:110, education:'Bachelor Degree'}), 'utf8');
" "$(native_path "$TEST_DIR/lao.json")" "$LAO_NAME"
LAOC=$(curl -s -X POST "$BASE/api/admin/candidates" -H "Authorization: Bearer $HR" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/lao.json")
LAOID=$(jsonval "$LAOC" 'd.id')
expect_eq "a Lao name is stored intact" "$LAO_NAME" "$(dbq "SELECT full_name AS v FROM candidates WHERE id = '$LAOID'")"
curl -s -H "Authorization: Bearer $HR" -o "$TEST_DIR/lao.csv" "$BASE/api/admin/reports/candidate/$LAOID.csv"
BOM=$("$NODE" -e "const b=require('fs').readFileSync(process.argv[1]); console.log(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF ? 'yes':'no')" "$(native_path "$TEST_DIR/lao.csv")")
expect_eq "the CSV starts with a UTF-8 BOM" "yes" "$BOM"
expect_contains "and the Lao name survives round-trip" "$LAO_NAME" "$(cat "$TEST_DIR/lao.csv")"
curl -s -H "Authorization: Bearer $HR" -o "$TEST_DIR/lao.pdf" "$BASE/api/admin/reports/candidate/$LAOID.pdf"
PDFOK=$("$NODE" -e "
  const b=require('fs').readFileSync(process.argv[1]);
  const isPdf = b.slice(0,5).toString()==='%PDF-';
  const embedded = b.includes(Buffer.from('FontFile2'));
  console.log(isPdf && embedded ? 'yes' : 'no');
" "$(native_path "$TEST_DIR/lao.pdf")")
expect_eq "the PDF embeds a Unicode font for Lao" "yes" "$PDFOK"
curl -s -H "Authorization: Bearer $HR" -o "$TEST_DIR/lao.xlsx" "$BASE/api/admin/reports/batch.xlsx"
XLSXOK=$("$NODE" -e "
  const ExcelJS=require('exceljs');
  const wb=new ExcelJS.Workbook();
  wb.xlsx.readFile(process.argv[1]).then(()=>{
    const ws=wb.worksheets[0]; let found=false;
    ws.eachRow((r)=>{ r.eachCell((c)=>{ if(String(c.value).includes(process.argv[2])) found=true; }); });
    console.log(found?'yes':'no');
  }).catch(()=>console.log('error'));
" "$(native_path "$TEST_DIR/lao.xlsx")" "$LAO_NAME")
expect_eq "Excel round-trips the Lao name correctly" "yes" "$XLSXOK"

summary "ADMIN CONTROLS (priorities 1-5, 10, 12)"
