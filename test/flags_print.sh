#!/bin/bash
# Phase 3 — question flags and print views.
# A flag is the candidate's own bookmark: it must be durable, private to them,
# and completely inert with respect to answers, marks, the clock and the order
# the questions are asked in. Print must never carry an answer key.
# Runs against a throwaway database. Never point this at production.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4129

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
EVALUATOR=$(login_token evaluator@lalco.demo "$DEMO_PASSWORD")
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
[ -n "$SUPER" ] || { c_red "could not log in"; server_log; exit 1; }

# Non-ASCII through curl -d is mangled on Windows, so bodies go via a UTF-8 file.
post_json() { # post_json <method> <url> <token> <json-string>
  local m="$1" u="$2" tok="$3" body="$4"
  printf '%s' "$body" > "$TEST_DIR/body.json"
  curl -s -X "$m" "$u" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/body.json"
}

# A candidate part-way through the assessment.
read -r C1 C1CODE <<< "$(new_candidate "$SUPER" "Flag Test Candidate")"
T1=$(new_link "$SUPER" "$C1")
http_body POST "$BASE/api/exam/$T1/start" '' "{\"candidateCode\":\"$C1CODE\"}" > /dev/null
S1=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$C1'")
QL=$(http_body GET "$BASE/api/exam/$T1/questions")
QA=$(jsonval "$QL" "d.questions[0].id")
QB=$(jsonval "$QL" "d.questions[1].id")
QC=$(jsonval "$QL" "d.questions[2].id")

# ===========================================================================
c_head "FLAG — the candidate marks a question to come back to"
expect_eq "nothing is flagged to begin with" 0 "$(jsonval "$QL" 'd.flagged.length')"
FLAG1=$(http_body POST "$BASE/api/exam/$T1/flag" '' "{\"questionId\":\"$QA\"}")
expect_eq "flagging succeeds" "true" "$(jsonval "$FLAG1" 'String(d.flagged)')"
expect_eq "the server reports it actually changed" "true" "$(jsonval "$FLAG1" 'String(d.changed)')"
expect_eq "the flag is stored against this session and this question" 1 \
  "$(dbq "SELECT flagged AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QA'")"
expect_eq "a flag timestamp is recorded" 0 \
  "$(dbq "SELECT CASE WHEN flagged_at IS NULL OR flagged_at = '' THEN 1 ELSE 0 END AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QA'")"
expect_eq "flagging created no duplicate question row" 7 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='GENERAL'")"
expect_eq "and no second answer row for the same question" 1 \
  "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QA'")"

c_head "FLAG STATE — readable three ways, all agreeing"
expect_eq "the dedicated flag endpoint lists it" "$QA" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/flags")" 'd.flagged.join(",")')"
expect_eq "the flag endpoint reports when it was flagged" "true" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/flags")" "String(!!d.flaggedAt['$QA'])")"
expect_eq "the question list carries it" "$QA" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/questions")" 'd.flagged.join(",")')"
expect_eq "the single question carries it" "true" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/question/$QA")" 'String(d.flagged)')"
expect_eq "an unflagged question says so" "false" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/question/$QB")" 'String(d.flagged)')"

c_head "REPEAT FLAGGING — acknowledged, but written and audited only once"
AUDIT_AFTER_ONE=$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action = 'QUESTION_FLAGGED' AND target = '$C1CODE'")
AGAIN=$(http_body POST "$BASE/api/exam/$T1/flag" '' "{\"questionId\":\"$QA\"}")
expect_eq "flagging an already-flagged question still succeeds" "true" "$(jsonval "$AGAIN" 'String(d.flagged)')"
expect_eq "but reports that nothing changed" "false" "$(jsonval "$AGAIN" 'String(d.changed)')"
http_body POST "$BASE/api/exam/$T1/flag" '' "{\"questionId\":\"$QA\"}" > /dev/null
http_body POST "$BASE/api/exam/$T1/flag" '' "{\"questionId\":\"$QA\"}" > /dev/null
expect_eq "repeated taps do not flood the audit trail" "$AUDIT_AFTER_ONE" \
  "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action = 'QUESTION_FLAGGED' AND target = '$C1CODE'")"
expect_eq "and do not multiply rows" 1 \
  "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QA'")"

# ===========================================================================
c_head "INERT — flagging changes nothing else about the assessment"
# Answer a question, then flag it, and prove nothing but the flag moved.
http_body POST "$BASE/api/exam/$T1/answer" '' \
  "{\"questionId\":\"$QB\",\"answer\":{\"monthlyInterest\":3000,\"totalInterest\":18000},\"timeSpentDeltaSeconds\":45}" > /dev/null
ANS_BEFORE=$(dbq "SELECT answer_json AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QB'")
TIME_BEFORE=$(dbq "SELECT time_spent_seconds AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QB'")
VISITS_BEFORE=$(dbq "SELECT visits AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QB'")
MODIFIED_BEFORE=$(dbq "SELECT last_modified_at AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QB'")
DEADLINE_BEFORE=$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$S1'")
STATUS_BEFORE=$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$S1'")
DURATION_BEFORE=$(dbq "SELECT duration_minutes AS v FROM assessment_sessions WHERE id = '$S1'")
ORDER_BEFORE=$(jsonval "$(http_body GET "$BASE/api/exam/$T1/questions")" 'd.questions.map(q=>q.id).join(",")')
SCORES_BEFORE=$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = '$S1'")

http_body POST "$BASE/api/exam/$T1/flag" '' "{\"questionId\":\"$QB\"}" > /dev/null

expect_eq "the ANSWER is untouched" "$ANS_BEFORE" "$(dbq "SELECT answer_json AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QB'")"
expect_eq "the time spent on the question is untouched" "$TIME_BEFORE" "$(dbq "SELECT time_spent_seconds AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QB'")"
expect_eq "the visit count is untouched" "$VISITS_BEFORE" "$(dbq "SELECT visits AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QB'")"
expect_eq "the answer's last-modified stamp is untouched" "$MODIFIED_BEFORE" "$(dbq "SELECT last_modified_at AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QB'")"
expect_eq "the DEADLINE is untouched" "$DEADLINE_BEFORE" "$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$S1'")"
expect_eq "the exam duration is untouched" "$DURATION_BEFORE" "$(dbq "SELECT duration_minutes AS v FROM assessment_sessions WHERE id = '$S1'")"
expect_eq "the assessment was NOT submitted by flagging" "$STATUS_BEFORE" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$S1'")"
expect_eq "no score was produced by flagging" "$SCORES_BEFORE" "$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = '$S1'")"
expect_eq "the QUESTION ORDER is untouched" "$ORDER_BEFORE" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/questions")" 'd.questions.map(q=>q.id).join(",")')"
expect_eq "the answered list still contains the answered question" "true" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/questions")" "String(d.answered.includes('$QB'))")"
expect_eq "the saved answer is still served back for prefill" "3000" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/question/$QB")" 'String(d.savedAnswer.monthlyInterest)')"

c_head "FLAGGING A QUESTION NOT YET ANSWERED"
http_body POST "$BASE/api/exam/$T1/flag" '' "{\"questionId\":\"$QC\"}" > /dev/null
expect_eq "the flag is stored" 1 "$(dbq "SELECT flagged AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QC'")"
expect_eq "with no answer invented for it" 1 \
  "$(dbq "SELECT CASE WHEN answer_json IS NULL THEN 1 ELSE 0 END AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QC'")"
expect_eq "and it is NOT counted as answered" "false" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/questions")" "String(d.answered.includes('$QC'))")"

# ===========================================================================
c_head "PERSISTENCE — reload, reconnect, navigation, language"
# A reload is simply a fresh request with the same token: nothing is held in
# the browser, so this is exactly what the candidate's browser would do.
RELOADED=$(http_body GET "$BASE/api/exam/$T1/questions")
expect_eq "flags survive a reload" 3 "$(jsonval "$RELOADED" 'd.flagged.length')"
expect_eq "navigating back to the question still shows it flagged" "true" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/question/$QA")" 'String(d.flagged)')"
expect_eq "and forward to another flagged question too" "true" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/question/$QC")" 'String(d.flagged)')"

LANG_DEADLINE_BEFORE=$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$S1'")
http_body POST "$BASE/api/exam/$T1/language" '' '{"language":"lo"}' > /dev/null
expect_eq "the session really did switch to Lao" "lo" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id = '$S1'")"
expect_eq "flags survive switching to Lao" 3 \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/questions")" 'd.flagged.length')"
expect_eq "the individual question is still flagged in Lao" "true" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/question/$QA")" 'String(d.flagged)')"
expect_eq "the answer survived the language switch too" "3000" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/question/$QB")" 'String(d.savedAnswer.monthlyInterest)')"
http_body POST "$BASE/api/exam/$T1/language" '' '{"language":"en"}' > /dev/null
expect_eq "flags survive switching back to English" 3 \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/questions")" 'd.flagged.length')"
expect_eq "the deadline did not move across either switch" "$LANG_DEADLINE_BEFORE" \
  "$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$S1'")"

# ===========================================================================
c_head "UNFLAG"
UNFLAG=$(http_body POST "$BASE/api/exam/$T1/unflag" '' "{\"questionId\":\"$QC\"}")
expect_eq "unflagging succeeds" "false" "$(jsonval "$UNFLAG" 'String(d.flagged)')"
expect_eq "it reports the change" "true" "$(jsonval "$UNFLAG" 'String(d.changed)')"
expect_eq "the flag is cleared" 0 "$(dbq "SELECT flagged AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QC'")"
expect_eq "the flag timestamp is cleared with it" 1 \
  "$(dbq "SELECT CASE WHEN flagged_at IS NULL THEN 1 ELSE 0 END AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QC'")"
expect_eq "but the change is still stamped for the record" 0 \
  "$(dbq "SELECT CASE WHEN flag_changed_at IS NULL THEN 1 ELSE 0 END AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QC'")"
expect_eq "the row itself was NOT deleted" 1 \
  "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QC'")"
expect_eq "unflagging an already-unflagged question is a no-op" "false" \
  "$(jsonval "$(http_body POST "$BASE/api/exam/$T1/unflag" '' "{\"questionId\":\"$QC\"}")" 'String(d.changed)')"
expect_eq "two flags remain" 2 "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/flags")" 'd.flagged.length')"
expect_eq "unflagging did not disturb the answer" "$ANS_BEFORE" \
  "$(dbq "SELECT answer_json AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QB'")"

# ===========================================================================
c_head "AUTHORIZATION — a candidate can only flag their own questions"
read -r C2 C2CODE <<< "$(new_candidate "$SUPER" "Other Flag Candidate")"
T2=$(new_link "$SUPER" "$C2")
http_body POST "$BASE/api/exam/$T2/start" '' "{\"candidateCode\":\"$C2CODE\"}" > /dev/null
S2=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$C2'")
expect_eq "the second candidate sees none of the first candidate's flags" 0 \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T2/flags")" 'd.flagged.length')"
http_body POST "$BASE/api/exam/$T2/flag" '' "{\"questionId\":\"$QA\"}" > /dev/null
expect_eq "their own flag lands on their own session" 1 \
  "$(dbq "SELECT flagged AS v FROM candidate_answers WHERE session_id = '$S2' AND question_id = '$QA'")"
expect_eq "and did not touch the first candidate's row" 1 \
  "$(dbq "SELECT flagged AS v FROM candidate_answers WHERE session_id = '$S1' AND question_id = '$QA'")"
expect_eq "the first candidate's flag count is unchanged" 2 \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/flags")" 'd.flagged.length')"
expect_eq "an invented token cannot flag" 404 "$(http_code POST "$BASE/api/exam/not-a-real-token/flag" '' "{\"questionId\":\"$QA\"}")"
expect_eq "an invented token cannot read flags" 404 "$(http_code GET "$BASE/api/exam/not-a-real-token/flags")"
expect_eq "a question outside this assessment cannot be flagged" 404 \
  "$(http_code POST "$BASE/api/exam/$T1/flag" '' '{"questionId":"q_does_not_exist"}')"
expect_eq "no question id at all is refused" 400 "$(http_code POST "$BASE/api/exam/$T1/flag" '' '{}')"
expect_eq "an admin JWT is not accepted as an exam token" 404 \
  "$(http_code POST "$BASE/api/exam/$SUPER/flag" '' "{\"questionId\":\"$QA\"}")"

c_head "AUTHORIZATION — session state is respected"
PAUSE_SESSION=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$C2'")
http_body POST "$BASE/api/admin/exam-control/sessions/$PAUSE_SESSION/pause" "$SUPER" '{"reason":"Flag test"}' > /dev/null
expect_eq "a paused candidate cannot flag" 423 "$(http_code POST "$BASE/api/exam/$T2/flag" '' "{\"questionId\":\"$QB\"}")"
expect_eq "a paused candidate cannot unflag either" 423 "$(http_code POST "$BASE/api/exam/$T2/unflag" '' "{\"questionId\":\"$QA\"}")"
expect_eq "and their existing flag is untouched by the refusal" 1 \
  "$(dbq "SELECT flagged AS v FROM candidate_answers WHERE session_id = '$S2' AND question_id = '$QA'")"
http_body POST "$BASE/api/admin/exam-control/sessions/$PAUSE_SESSION/resume" "$SUPER" > /dev/null
expect_eq "flagging works again after resume" 200 "$(http_code POST "$BASE/api/exam/$T2/flag" '' "{\"questionId\":\"$QB\"}")"

read -r C3 C3CODE <<< "$(new_candidate "$SUPER" "Submitted Flag Candidate")"
T3=$(new_link "$SUPER" "$C3")
take_assessment "$T3" "$C3CODE" correct "Essay answer." > /dev/null
expect_eq "a submitted assessment cannot be flagged" 409 "$(http_code POST "$BASE/api/exam/$T3/flag" '' "{\"questionId\":\"$QA\"}")"
expect_eq "a submitted assessment cannot be unflagged" 409 "$(http_code POST "$BASE/api/exam/$T3/unflag" '' "{\"questionId\":\"$QA\"}")"

# ===========================================================================
c_head "AUDIT"
expect_eq "flagging is audited" 1 \
  "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'QUESTION_FLAGGED' AND target = '$C1CODE'")"
expect_eq "unflagging is audited" 1 \
  "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'QUESTION_UNFLAGGED' AND target = '$C1CODE'")"
expect_eq "the audit identifies the candidate, not a token" "$C1CODE" \
  "$(dbq "SELECT target AS v FROM audit_logs WHERE action = 'QUESTION_FLAGGED' AND target = '$C1CODE' LIMIT 1")"
expect_eq "the acting party is recorded as the candidate" "CANDIDATE" \
  "$(dbq "SELECT role AS v FROM audit_logs WHERE action = 'QUESTION_FLAGGED' AND target = '$C1CODE' LIMIT 1")"
expect_eq "every flag audit entry is timestamped" 0 \
  "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action LIKE 'QUESTION_%FLAGGED' AND (created_at IS NULL OR created_at = '')")"
expect_contains "the audit names the question" "$QA" \
  "$(dbq "SELECT new_value AS v FROM audit_logs WHERE action = 'QUESTION_FLAGGED' AND target = '$C1CODE' LIMIT 1")"
expect_contains "and the session it belongs to" "$S1" \
  "$(dbq "SELECT new_value AS v FROM audit_logs WHERE action = 'QUESTION_FLAGGED' AND target = '$C1CODE' LIMIT 1")"
expect_not_contains "the exam token is NEVER written to the audit log" "$T1" \
  "$(dbq "SELECT COALESCE(GROUP_CONCAT(COALESCE(new_value,'') || COALESCE(old_value,'') || COALESCE(target,'')),'') AS v FROM audit_logs WHERE action LIKE 'QUESTION_%FLAGGED'")"

# ===========================================================================
c_head "ADMIN / EVALUATOR VISIBILITY"
DETAIL=$(http_body GET "$BASE/api/admin/candidates/$C1" "$EVALUATOR")
expect_eq "an evaluator can see the candidate's flags" 2 \
  "$(jsonval "$DETAIL" 'd.answers.filter(a=>a.flagged).length')"
expect_eq "each flag carries its timestamp" "true" \
  "$(jsonval "$DETAIL" 'String(d.answers.filter(a=>a.flagged).every(a=>!!a.flaggedAt))')"
expect_eq "an unflagged question reports no timestamp" "true" \
  "$(jsonval "$DETAIL" 'String(d.answers.filter(a=>!a.flagged).every(a=>a.flaggedAt === null))')"
expect_eq "the candidate is identified" "$C1CODE" "$(jsonval "$DETAIL" 'd.candidate.code')"
expect_eq "the assessment sat is identified" "LALCO Recruitment Assessment" "$(jsonval "$DETAIL" 'd.session.assessmentName')"
expect_eq "the session state is reported alongside" "IN_PROGRESS" "$(jsonval "$DETAIL" 'd.session.status')"
expect_eq "HR can see them too" 2 \
  "$(jsonval "$(http_body GET "$BASE/api/admin/candidates/$C1" "$HR")" 'd.answers.filter(a=>a.flagged).length')"
expect_eq "an unauthenticated request cannot read flags" 401 "$(http_code GET "$BASE/api/admin/candidates/$C1")"
expect_eq "an exam token cannot read the admin candidate record" 401 "$(http_code GET "$BASE/api/admin/candidates/$C1" "$T1")"

# ===========================================================================
c_head "PRINT — the report carries the right context"
PRINT_SRC=$(cat public/admin/app.js)
expect_contains "an admin print view exists" "viewPrintCandidate" "$PRINT_SRC"
expect_contains "it is reachable from the Reports tab" "printBtn" "$PRINT_SRC"
expect_contains "it uses the browser's own print dialogue" "window.print()" "$PRINT_SRC"
expect_contains "it prints the LALCO ID" "LALCO ID" "$PRINT_SRC"
expect_contains "it prints the assessment" "assessmentName" "$PRINT_SRC"
expect_contains "it prints the assessment status" "printh" "$PRINT_SRC"
expect_contains "it prints the pass threshold that was applied" "Pass threshold applied" "$PRINT_SRC"
expect_contains "it prints the candidate's flags" "Flagged for review by the candidate" "$PRINT_SRC"

PRINT_CSS=$(cat public/admin/index.html)
expect_contains "a print stylesheet exists" "@media print" "$PRINT_CSS"
expect_contains "the sidebar is removed from the printout" ".sidebar,.topbar,.no-print" "$PRINT_CSS"
expect_contains "page margins are set for paper" "@page" "$PRINT_CSS"

c_head "PRINT SECURITY — no answer key on any printout"
expect_not_contains "the print view never renders an expected answer" "a.expected" "$PRINT_SRC"
expect_not_contains "nor a tolerance" "\.tol" "$PRINT_SRC"
EXAM_SRC=$(cat public/exam/app.js)
EXAM_CSS=$(cat public/exam/index.html)
expect_contains "the candidate gets a submission confirmation only" "renderDone" "$EXAM_SRC"
expect_contains "which they can print" "printReceipt" "$EXAM_SRC"
expect_not_contains "the candidate print carries no marks" "final_marks" "$EXAM_SRC"
expect_not_contains "the candidate print carries no pass/fail" "passLabel" "$EXAM_SRC"
expect_not_contains "the candidate app never handles an answer key" "expected" "$EXAM_SRC"
expect_not_contains "nor a marking rubric" "rubric" "$EXAM_SRC"
expect_contains "the candidate printout hides the exam chrome" ".ptop,.pnav,.no-print" "$EXAM_CSS"

# What actually reaches the candidate over the wire, flagged or not.
CAND_Q=$(http_body GET "$BASE/api/exam/$T1/questions")
expect_not_contains "no answer key reaches a flagging candidate" '"expected"' "$CAND_Q"
expect_not_contains "no tolerance reaches them" '"tol"' "$CAND_Q"
expect_not_contains "no rubric reaches them" '"rubric"' "$CAND_Q"
expect_not_contains "no marking explanation reaches them" '"explanation"' "$CAND_Q"
expect_not_contains "the internal session id is not handed to the candidate" "$S1" "$CAND_Q"
FLAGS_RES=$(http_body GET "$BASE/api/exam/$T1/flags")
expect_not_contains "the flag endpoint leaks no session id" "$S1" "$FLAGS_RES"
expect_not_contains "and no candidate id" "$C1" "$FLAGS_RES"

c_head "PRINT — the LALCO ID is released only to a verified candidate"
read -r C4 C4CODE <<< "$(new_candidate "$SUPER" "Unstarted Print Candidate")"
T4=$(new_link "$SUPER" "$C4")
BEFORE_START=$(http_body GET "$BASE/api/exam/$T4")
expect_not_contains "merely holding a link does not reveal the LALCO ID" "$C4CODE" "$BEFORE_START"
http_body POST "$BASE/api/exam/$T4/start" '' "{\"candidateCode\":\"$C4CODE\"}" > /dev/null
AFTER_START=$(http_body GET "$BASE/api/exam/$T4")
expect_contains "once they prove they know it, the receipt can show it" "$C4CODE" "$AFTER_START"
expect_contains "the receipt names the assessment" "LALCO Recruitment Assessment" "$AFTER_START"

# ===========================================================================
c_head "LAO UNICODE — flags and print survive non-Latin text"
LAO_NAME='ທ້າວ ສົມຊາຍ ພົມມະວົງ'
LAO_CAND=$(post_json POST "$BASE/api/admin/candidates" "$SUPER" \
  "{\"fullName\":\"$LAO_NAME\",\"applicationType\":\"NORMAL\",\"iq\":115,\"education\":\"Bachelor Degree\"}")
LAO_ID=$(jsonval "$LAO_CAND" 'd.id')
LAO_CODE=$(jsonval "$LAO_CAND" 'd.code')
expect_eq "a candidate with a Lao name is stored intact" "$LAO_NAME" "$(dbq "SELECT full_name AS v FROM candidates WHERE id = '$LAO_ID'")"
LAO_TOKEN=$(new_link "$SUPER" "$LAO_ID")
http_body POST "$BASE/api/exam/$LAO_TOKEN/start" '' "{\"candidateCode\":\"$LAO_CODE\",\"language\":\"lo\"}" > /dev/null
LAO_S=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$LAO_ID'")
http_body POST "$BASE/api/exam/$LAO_TOKEN/flag" '' "{\"questionId\":\"$QA\"}" > /dev/null
expect_eq "they can flag while sitting the assessment in Lao" 1 \
  "$(dbq "SELECT flagged AS v FROM candidate_answers WHERE session_id = '$LAO_S' AND question_id = '$QA'")"
LAO_DETAIL=$(http_body GET "$BASE/api/admin/candidates/$LAO_ID" "$SUPER")
expect_contains "the print data carries the Lao name unmangled" "$LAO_NAME" "$LAO_DETAIL"
expect_eq "the flag is visible on their record" 1 "$(jsonval "$LAO_DETAIL" 'd.answers.filter(a=>a.flagged).length')"
expect_eq "the language they sat in is recorded for the report" "lo" "$(jsonval "$LAO_DETAIL" 'd.session.language')"
expect_contains "an English-named candidate prints correctly alongside" "Flag Test Candidate" \
  "$(http_body GET "$BASE/api/admin/candidates/$C1" "$SUPER")"
expect_eq "the Lao candidate's audit entry survives the round trip" 1 \
  "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'QUESTION_FLAGGED' AND target = '$LAO_CODE'")"

# ===========================================================================
c_head "NOTHING WAS BROKEN BY ANY OF THIS"
expect_eq "the candidate's answers are all still present" "true" \
  "$(jsonval "$(http_body GET "$BASE/api/exam/$T1/question/$QB")" 'String(d.savedAnswer !== null)')"
expect_eq "the assessment can still be submitted normally" 200 "$(http_code POST "$BASE/api/exam/$T1/submit")"
expect_eq "and it marked as usual" 1 "$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = '$S1'")"
expect_eq "the flags survive submission as a record of how they worked" 2 \
  "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$S1' AND flagged = 1")"
expect_eq "and remain visible to the evaluator afterwards" 2 \
  "$(jsonval "$(http_body GET "$BASE/api/admin/candidates/$C1" "$EVALUATOR")" 'd.answers.filter(a=>a.flagged).length')"
expect_eq "deleting a session would take its flags with it" 0 \
  "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id NOT IN (SELECT id FROM assessment_sessions)")"

summary "QUESTION FLAGS + PRINT"
