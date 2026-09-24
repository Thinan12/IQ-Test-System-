#!/bin/bash
# Phase 2 — assessment management: CRUD, configuration, and the guarantee that
# reconfiguring an assessment never re-judges somebody who already sat it.
# Runs against a throwaway database. Never point this at production.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4128

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
EVALUATOR=$(login_token evaluator@lalco.demo "$DEMO_PASSWORD")
MANAGER=$(login_token manager@lalco.demo "$DEMO_PASSWORD")
INTERVIEWER=$(login_token interviewer@lalco.demo "$DEMO_PASSWORD")
[ -n "$SUPER" ] || { c_red "could not log in"; server_log; exit 1; }

A="$BASE/api/admin/assessments"

# ===========================================================================
c_head "MIGRATION — the existing exam becomes an assessment, unchanged"
expect_eq "exactly one recruitment assessment exists after migration" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessments WHERE assessment_type='GENERAL_ASSESSMENT'")"
expect_eq "alongside the seeded IQ test" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessments WHERE assessment_type='IQ_TEST'")"
DEF=$(dbq "SELECT id AS v FROM assessments WHERE assessment_type='GENERAL_ASSESSMENT' ORDER BY created_at LIMIT 1")
expect_eq "it is active" 1 "$(dbq "SELECT active AS v FROM assessments WHERE id='$DEF'")"
expect_eq "and not archived" 0 "$(dbq "SELECT COALESCE(archived,0) AS v FROM assessments WHERE id='$DEF'")"
expect_eq "it carries the existing exam duration" 45 "$(dbq "SELECT duration_minutes AS v FROM assessments WHERE id='$DEF'")"
expect_eq "it carries the existing invitation expiry" 10 "$(dbq "SELECT link_expiry_minutes AS v FROM assessments WHERE id='$DEF'")"
expect_eq "it carries the existing pass threshold" 70 "$(dbq "SELECT pass_threshold AS v FROM assessments WHERE id='$DEF'")"
expect_eq "scoring components add up to the total" 100 "$(dbq "SELECT calc_max+written_max+interview_max AS v FROM assessments WHERE id='$DEF'")"
expect_eq "every active question was attached" 7 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$DEF'")"
expect_eq "no question row was copied — they are referenced" 7 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='GENERAL'")"
expect_eq "the attached questions all resolve to real questions" 0 \
  "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions aq LEFT JOIN questions q ON q.id=aq.question_id WHERE aq.assessment_id='$DEF' AND q.id IS NULL")"
expect_eq "the essay is attached last, after the calculations" "ESSAY" \
  "$(dbq "SELECT q.type AS v FROM assessment_questions aq JOIN questions q ON q.id=aq.question_id WHERE aq.assessment_id='$DEF' ORDER BY aq.order_index DESC LIMIT 1")"

# ===========================================================================
c_head "RBAC — who may look, who may change"
expect_eq "an unauthenticated request cannot list assessments" 401 "$(http_code GET "$A")"
expect_eq "an unauthenticated request cannot create one" 401 "$(http_code POST "$A" '' '{"name":"Sneaky"}')"
expect_eq "a garbage token is rejected" 401 "$(http_code GET "$A" 'not.a.token')"
for who in SUPER HR MANAGER EVALUATOR RECRUITER INTERVIEWER; do
  expect_eq "$who can view the assessment list" 200 "$(http_code GET "$A" "${!who}")"
done
expect_eq "SUPER_ADMIN may create" 201 "$(http_code POST "$A" "$SUPER" '{"name":"RBAC probe super","questionIds":[]}')"
expect_eq "HR_ADMIN may create" 201 "$(http_code POST "$A" "$HR" '{"name":"RBAC probe hr","questionIds":[]}')"
expect_eq "a RECRUITER may not create" 403 "$(http_code POST "$A" "$RECRUITER" '{"name":"RBAC probe recruiter"}')"
expect_eq "an EVALUATOR may not create" 403 "$(http_code POST "$A" "$EVALUATOR" '{"name":"RBAC probe evaluator"}')"
expect_eq "a MANAGER may not create" 403 "$(http_code POST "$A" "$MANAGER" '{"name":"RBAC probe manager"}')"
expect_eq "an INTERVIEWER may not create" 403 "$(http_code POST "$A" "$INTERVIEWER" '{"name":"RBAC probe interviewer"}')"
expect_eq "a RECRUITER may not edit" 403 "$(http_code PATCH "$A/$DEF" "$RECRUITER" '{"name":"Renamed by recruiter"}')"
expect_eq "a MANAGER may not archive" 403 "$(http_code POST "$A/$DEF/archive" "$MANAGER")"
expect_eq "an EVALUATOR may not deactivate" 403 "$(http_code POST "$A/$DEF/active" "$EVALUATOR" '{"active":false}')"
expect_eq "a RECRUITER may not duplicate" 403 "$(http_code POST "$A/$DEF/duplicate" "$RECRUITER")"
expect_eq "the refused edit changed nothing" "LALCO Recruitment Assessment" "$(dbq "SELECT name AS v FROM assessments WHERE id='$DEF'")"
expect_eq "read-only roles are told they cannot edit" "false" \
  "$(jsonval "$(http_body GET "$A" "$RECRUITER")" 'String(d.canEdit)')"
expect_eq "editors are told they can" "true" \
  "$(jsonval "$(http_body GET "$A" "$HR")" 'String(d.canEdit)')"

# ===========================================================================
c_head "VALIDATION — an unusable configuration is refused, not stored"
BEFORE_COUNT=$(dbq 'SELECT COUNT(*) AS v FROM assessments')
expect_eq "a nameless assessment is refused" 400 "$(http_code POST "$A" "$SUPER" '{"name":"   "}')"
expect_eq "a duplicate name is refused" 400 "$(http_code POST "$A" "$SUPER" '{"name":"LALCO Recruitment Assessment"}')"
expect_eq "a zero-minute exam is refused" 400 "$(http_code POST "$A" "$SUPER" '{"name":"Bad duration","duration_minutes":0}')"
expect_eq "a negative invitation expiry is refused" 400 "$(http_code POST "$A" "$SUPER" '{"name":"Bad expiry","link_expiry_minutes":-5}')"
expect_eq "a threshold above the total is refused" 400 "$(http_code POST "$A" "$SUPER" '{"name":"Unreachable","total_max":100,"pass_threshold":140}')"
expect_eq "components that do not add up to the total are refused" 400 \
  "$(http_code POST "$A" "$SUPER" '{"name":"Bad sum","calc_max":10,"written_max":10,"interview_max":10,"total_max":100}')"
expect_eq "a non-existent question is refused" 400 "$(http_code POST "$A" "$SUPER" '{"name":"Ghost question","questionIds":["q_does_not_exist"]}')"
expect_eq "the same question twice is refused" 400 \
  "$(http_code POST "$A" "$SUPER" "{\"name\":\"Doubled\",\"questionIds\":[\"$(dbq "SELECT id AS v FROM questions WHERE question_family='GENERAL' LIMIT 1")\",\"$(dbq "SELECT id AS v FROM questions WHERE question_family='GENERAL' LIMIT 1")\"]}")"
expect_eq "an unknown eligibility policy is refused" 400 "$(http_code POST "$A" "$SUPER" '{"name":"Ghost policy","eligibility_rules_id":9999}')"
expect_eq "not one of the refused configurations was written" "$BEFORE_COUNT" "$(dbq 'SELECT COUNT(*) AS v FROM assessments')"
expect_contains "the refusal explains the sum in plain words" "must equal the total marks" \
  "$(http_body POST "$A" "$SUPER" '{"name":"Bad sum 2","calc_max":10,"written_max":10,"interview_max":10,"total_max":100}')"
expect_contains "the refusal names the clashing assessment rule" "already uses that name" \
  "$(http_body POST "$A" "$SUPER" '{"name":"LALCO Recruitment Assessment"}')"

# ===========================================================================
c_head "CREATE + VIEW — a new assessment with a chosen question set and order"
Q_IDS=$(dbq "SELECT GROUP_CONCAT(id) AS v FROM (SELECT id FROM questions WHERE type='CALC' AND question_family='GENERAL' ORDER BY order_index LIMIT 3)")
Q1=$(printf '%s' "$Q_IDS" | cut -d, -f1)
Q2=$(printf '%s' "$Q_IDS" | cut -d, -f2)
Q3=$(printf '%s' "$Q_IDS" | cut -d, -f3)
CREATED=$(http_body POST "$A" "$SUPER" "{\"name\":\"Branch Officer Screening\",\"description\":\"Shorter screening exam for branch roles.\",\"duration_minutes\":20,\"link_expiry_minutes\":3,\"calc_max\":15,\"written_max\":10,\"interview_max\":25,\"total_max\":50,\"pass_threshold\":25,\"questionIds\":[\"$Q3\",\"$Q1\",\"$Q2\"]}")
NEW_ID=$(jsonval "$CREATED" 'd.id')
check "the new assessment has an id" "$([ -n "$NEW_ID" ] && echo 0 || echo 1)" "$NEW_ID"
expect_eq "it is stored" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "the create response reports the question count" 3 "$(jsonval "$CREATED" 'd.assessment.questionCount')"
expect_eq "the marks available from those questions are reported" "$(dbq "SELECT SUM(max_marks) AS v FROM questions WHERE id IN ('$Q1','$Q2','$Q3')")" "$(jsonval "$CREATED" 'd.assessment.questionMarks')"
expect_eq "nobody has sat it yet" 0 "$(jsonval "$CREATED" 'd.assessment.sessionCount')"
VIEW=$(http_body GET "$A/$NEW_ID" "$SUPER")
expect_eq "viewing it returns the exam duration" 20 "$(jsonval "$VIEW" 'd.assessment.duration_minutes')"
expect_eq "viewing it returns the invitation expiry" 3 "$(jsonval "$VIEW" 'd.assessment.link_expiry_minutes')"
expect_eq "viewing it returns the pass threshold" 25 "$(jsonval "$VIEW" 'd.assessment.pass_threshold')"
expect_eq "viewing it returns the total marks" 50 "$(jsonval "$VIEW" 'd.assessment.total_max')"
expect_eq "viewing it returns the eligibility policy" 1 "$(jsonval "$VIEW" 'd.assessment.eligibility_rules_id')"
expect_eq "the questions come back in the order they were given" "$Q3,$Q1,$Q2" "$(jsonval "$VIEW" 'd.assessment.questions.map(q=>q.id).join(",")')"
expect_eq "the order indexes are consecutive from zero" "0,1,2" "$(jsonval "$VIEW" 'd.assessment.questions.map(q=>q.order_index).join(",")')"
expect_eq "the original question IDs are preserved, not regenerated" 3 \
  "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$NEW_ID' AND question_id IN ('$Q1','$Q2','$Q3')")"
expect_eq "creating an assessment is audited" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='ASSESSMENT_CREATED' AND target='$NEW_ID'")"
expect_eq "a missing assessment is a clean 404" 404 "$(http_code GET "$A/asmt_nope" "$SUPER")"
expect_eq "searching by name finds it" 1 "$(jsonval "$(http_body GET "$A?q=branch%20officer" "$SUPER")" 'd.assessments.length')"
expect_eq "searching by description finds it too" 1 "$(jsonval "$(http_body GET "$A?q=screening%20exam" "$SUPER")" 'd.assessments.length')"
expect_eq "a search that matches nothing returns nothing" 0 "$(jsonval "$(http_body GET "$A?q=zzzznothing" "$SUPER")" 'd.assessments.length')"

# ===========================================================================
c_head "EDIT — configuration changes are stored and explained in the audit trail"
EDITED=$(http_body PATCH "$A/$NEW_ID" "$HR" '{"name":"Branch Officer Screening v2","duration_minutes":25,"link_expiry_minutes":5,"pass_threshold":30}')
expect_eq "the rename is stored" "Branch Officer Screening v2" "$(dbq "SELECT name AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "the new duration is stored" 25 "$(dbq "SELECT duration_minutes AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "the new invitation expiry is stored" 5 "$(dbq "SELECT link_expiry_minutes AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "the new threshold is stored" 30 "$(dbq "SELECT pass_threshold AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "an untouched field is left alone" 50 "$(dbq "SELECT total_max AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "the question set was not disturbed by a config-only edit" 3 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$NEW_ID'")"
expect_eq "the edit is audited" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='ASSESSMENT_EDITED' AND target='$NEW_ID'")"
expect_eq "the timing change is audited separately" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='ASSESSMENT_TIMING_CHANGED' AND target='$NEW_ID'")"
expect_eq "the scoring change is audited separately" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='ASSESSMENT_SCORING_CHANGED' AND target='$NEW_ID'")"
expect_contains "the timing audit warns that issued links keep their own expiry" "keep their own expiry" \
  "$(dbq "SELECT new_value AS v FROM audit_logs WHERE action='ASSESSMENT_TIMING_CHANGED' AND target='$NEW_ID'")"
expect_contains "the scoring audit warns that completed results are untouched" "keep the threshold they were judged under" \
  "$(dbq "SELECT new_value AS v FROM audit_logs WHERE action='ASSESSMENT_SCORING_CHANGED' AND target='$NEW_ID'")"
expect_eq "renaming onto another assessment's name is refused" 400 "$(http_code PATCH "$A/$NEW_ID" "$HR" '{"name":"LALCO Recruitment Assessment"}')"
expect_eq "and the name survived that refusal" "Branch Officer Screening v2" "$(dbq "SELECT name AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "keeping its own name is not treated as a clash" 200 "$(http_code PATCH "$A/$NEW_ID" "$HR" '{"name":"Branch Officer Screening v2","description":"Updated."}')"
expect_eq "an edit that breaks the scoring sum is refused" 400 "$(http_code PATCH "$A/$NEW_ID" "$HR" '{"total_max":80}')"
expect_eq "and the total survived that refusal" 50 "$(dbq "SELECT total_max AS v FROM assessments WHERE id='$NEW_ID'")"

# reordering and including/excluding questions
http_body PATCH "$A/$NEW_ID" "$HR" "{\"questionIds\":[\"$Q2\",\"$Q3\"]}" > /dev/null
expect_eq "excluding a question removes it from the assessment" 2 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$NEW_ID'")"
expect_eq "the excluded question still exists in the bank" 1 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE id='$Q1'")"
expect_eq "the remaining questions are renumbered in the new order" "$Q2,$Q3" \
  "$(jsonval "$(http_body GET "$A/$NEW_ID" "$SUPER")" 'd.assessment.questions.map(q=>q.id).join(",")')"
expect_eq "changing the question set is audited" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='ASSESSMENT_QUESTIONS_CHANGED' AND target='$NEW_ID'")"
expect_contains "the audit records which question was removed" "$Q1" \
  "$(dbq "SELECT new_value AS v FROM audit_logs WHERE action='ASSESSMENT_QUESTIONS_CHANGED' AND target='$NEW_ID'")"
http_body PATCH "$A/$NEW_ID" "$HR" "{\"questionIds\":[\"$Q3\",\"$Q2\",\"$Q1\"]}" > /dev/null
expect_eq "re-including a question restores it at the chosen position" "$Q3,$Q2,$Q1" \
  "$(jsonval "$(http_body GET "$A/$NEW_ID" "$SUPER")" 'd.assessment.questions.map(q=>q.id).join(",")')"

# ===========================================================================
c_head "DUPLICATE — configuration is copied, candidate history never is"
DUP=$(http_body POST "$A/$NEW_ID/duplicate" "$SUPER")
DUP_ID=$(jsonval "$DUP" 'd.id')
check "the duplicate has its own id" "$([ -n "$DUP_ID" ] && [ "$DUP_ID" != "$NEW_ID" ] && echo 0 || echo 1)" "$DUP_ID"
expect_eq "the copy is named distinctly" "Branch Officer Screening v2 (copy)" "$(dbq "SELECT name AS v FROM assessments WHERE id='$DUP_ID'")"
expect_eq "the copy starts INACTIVE so it is reviewed before use" 0 "$(dbq "SELECT active AS v FROM assessments WHERE id='$DUP_ID'")"
expect_eq "the copy is not archived" 0 "$(dbq "SELECT COALESCE(archived,0) AS v FROM assessments WHERE id='$DUP_ID'")"
expect_eq "the timing was copied" 25 "$(dbq "SELECT duration_minutes AS v FROM assessments WHERE id='$DUP_ID'")"
expect_eq "the scoring was copied" 30 "$(dbq "SELECT pass_threshold AS v FROM assessments WHERE id='$DUP_ID'")"
expect_eq "the eligibility policy was copied" 1 "$(dbq "SELECT eligibility_rules_id AS v FROM assessments WHERE id='$DUP_ID'")"
expect_eq "the question references were copied" 3 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$DUP_ID'")"
expect_eq "in the same order" "$Q3,$Q2,$Q1" \
  "$(jsonval "$(http_body GET "$A/$DUP_ID" "$SUPER")" 'd.assessment.questions.map(q=>q.id).join(",")')"
expect_eq "the copy references the same question rows — nothing was cloned" 7 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='GENERAL'")"
expect_eq "no candidate session came with the copy" 0 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE assessment_id='$DUP_ID'")"
expect_eq "no invitation link came with the copy" 0 "$(dbq "SELECT COUNT(*) AS v FROM assessment_links WHERE assessment_id='$DUP_ID'")"
expect_eq "duplicating is audited" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='ASSESSMENT_DUPLICATED' AND target='$DUP_ID'")"
expect_contains "the audit states what was deliberately not copied" "candidate sessions" \
  "$(dbq "SELECT new_value AS v FROM audit_logs WHERE action='ASSESSMENT_DUPLICATED' AND target='$DUP_ID'")"
DUP2_ID=$(jsonval "$(http_body POST "$A/$NEW_ID/duplicate" "$SUPER")" 'd.id')
expect_eq "duplicating twice does not collide on the name" "Branch Officer Screening v2 (copy) 2" "$(dbq "SELECT name AS v FROM assessments WHERE id='$DUP2_ID'")"
expect_eq "a duplicate can be given its own name" "Pilot Exam" \
  "$(dbq "SELECT name AS v FROM assessments WHERE id='$(jsonval "$(http_body POST "$A/$NEW_ID/duplicate" "$SUPER" '{"name":"Pilot Exam"}')" 'd.id')'")"
expect_eq "duplicating something that does not exist is a clean 404" 404 "$(http_code POST "$A/asmt_nope/duplicate" "$SUPER")"

# ===========================================================================
c_head "ACTIVATE / DEACTIVATE — only an active assessment can be invited to"
expect_eq "an assessment with no questions cannot be activated" 409 \
  "$(http_code POST "$A/$(jsonval "$(http_body GET "$A?q=RBAC%20probe%20super" "$SUPER")" 'd.assessments[0].id')/active" "$SUPER" '{"active":true}')"
expect_eq "activating the reviewed copy works" 200 "$(http_code POST "$A/$DUP_ID/active" "$SUPER" '{"active":true}')"
expect_eq "it is now active" 1 "$(dbq "SELECT active AS v FROM assessments WHERE id='$DUP_ID'")"
expect_eq "activating it again is refused rather than silently repeated" 409 "$(http_code POST "$A/$DUP_ID/active" "$SUPER" '{"active":true}')"
expect_eq "activation is audited" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='ASSESSMENT_ACTIVATED' AND target='$DUP_ID'")"
expect_eq "deactivating works" 200 "$(http_code POST "$A/$DUP_ID/active" "$SUPER" '{"active":false}')"
expect_eq "deactivation is audited" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='ASSESSMENT_DEACTIVATED' AND target='$DUP_ID'")"

read -r INACT_CAND_ID INACT_CAND_CODE <<< "$(new_candidate "$SUPER" "Inactive Target Candidate")"
expect_eq "an inactive assessment refuses a new invitation" 409 \
  "$(http_code POST "$BASE/api/admin/candidates/$INACT_CAND_ID/links" "$SUPER" "{\"assessmentId\":\"$DUP_ID\"}")"
expect_contains "and says why in plain words" "inactive" \
  "$(http_body POST "$BASE/api/admin/candidates/$INACT_CAND_ID/links" "$SUPER" "{\"assessmentId\":\"$DUP_ID\"}")"
expect_eq "no link was created by the refusal" 0 "$(dbq "SELECT COUNT(*) AS v FROM assessment_links WHERE candidate_id='$INACT_CAND_ID'")"
expect_eq "an invitation for an assessment that does not exist is a clean 404" 404 \
  "$(http_code POST "$BASE/api/admin/candidates/$INACT_CAND_ID/links" "$SUPER" '{"assessmentId":"asmt_nope"}')"

# ===========================================================================
c_head "TIMING — the assessment governs the exam clock and the invitation window"
http_body POST "$A/$NEW_ID/active" "$SUPER" '{"active":true}' > /dev/null
read -r TIME_CAND_ID TIME_CAND_CODE <<< "$(new_candidate "$SUPER" "Timing Candidate")"
TIME_LINK=$(http_body POST "$BASE/api/admin/candidates/$TIME_CAND_ID/links" "$SUPER" "{\"assessmentId\":\"$NEW_ID\"}")
TIME_TOKEN=$(jsonval "$TIME_LINK" 'd.token')
check "the invitation was issued" "$([ -n "$TIME_TOKEN" ] && echo 0 || echo 1)" "$TIME_TOKEN"
expect_eq "the link records which assessment it is for" "$NEW_ID" "$(dbq "SELECT assessment_id AS v FROM assessment_links WHERE candidate_id='$TIME_CAND_ID'")"
expect_eq "the link expires after the assessment's 5-minute window, not the global 10" 5 \
  "$(dbq "SELECT CAST(ROUND((julianday(expires_at)-julianday('now'))*1440) AS INT) AS v FROM assessment_links WHERE candidate_id='$TIME_CAND_ID'")"
complete_profile "$TIME_TOKEN"
http_body POST "$BASE/api/exam/$TIME_TOKEN/start" '' "{\"candidateCode\":\"$TIME_CAND_CODE\"}" > /dev/null
expect_eq "the session records which assessment was sat" "$NEW_ID" "$(dbq "SELECT assessment_id AS v FROM assessment_sessions WHERE candidate_id='$TIME_CAND_ID'")"
expect_eq "the exam clock is the assessment's 25 minutes, not the global 45" 25 \
  "$(dbq "SELECT duration_minutes AS v FROM assessment_sessions WHERE candidate_id='$TIME_CAND_ID'")"
expect_eq "and the deadline matches that duration" 25 \
  "$(dbq "SELECT CAST(ROUND((julianday(expires_at)-julianday(started_at))*1440) AS INT) AS v FROM assessment_sessions WHERE candidate_id='$TIME_CAND_ID'")"
expect_eq "the session snapshots the pass threshold it will be judged by" 30 \
  "$(dbq "SELECT pass_threshold AS v FROM assessment_sessions WHERE candidate_id='$TIME_CAND_ID'")"
expect_eq "and the total it is out of" 50 \
  "$(dbq "SELECT total_max AS v FROM assessment_sessions WHERE candidate_id='$TIME_CAND_ID'")"

c_head "QUESTION SET — the candidate is served this assessment's questions, in order"
TIME_QS=$(http_body GET "$BASE/api/exam/$TIME_TOKEN/questions")
expect_eq "only the three attached questions are served" 3 "$(jsonval "$TIME_QS" 'd.questions.length')"
expect_eq "in the assessment's own order" "$Q3,$Q2,$Q1" "$(jsonval "$TIME_QS" 'd.questions.map(q=>q.id).join(",")')"
expect_eq "a question this assessment excludes is not served" 0 \
  "$(jsonval "$TIME_QS" "d.questions.filter(q=>q.type==='ESSAY').length")"
expect_not_contains "no answer key reaches the candidate" '"expected"' "$TIME_QS"
expect_not_contains "no tolerance reaches the candidate" '"tol"' "$TIME_QS"
expect_not_contains "no marking rubric reaches the candidate" '"rubric"' "$TIME_QS"
expect_not_contains "no explanation reaches the candidate" '"explanation"' "$TIME_QS"

c_head "CANDIDATE ISOLATION — the exam token is not an admin key"
expect_eq "an exam token cannot list assessments" 401 "$(http_code GET "$A" "$TIME_TOKEN")"
expect_eq "an exam token cannot create an assessment" 401 "$(http_code POST "$A" "$TIME_TOKEN" '{"name":"From a candidate"}')"
expect_eq "an exam token cannot archive one" 401 "$(http_code POST "$A/$NEW_ID/archive" "$TIME_TOKEN")"
expect_not_contains "the candidate is never told the pass threshold" 'pass_threshold' "$TIME_QS"
expect_not_contains "nor the internal assessment id" "$NEW_ID" "$TIME_QS"

# ===========================================================================
c_head "ARCHIVE — withdraws from new invitations, never touches results"
expect_eq "an assessment being sat right now cannot be archived" 409 "$(http_code POST "$A/$NEW_ID/archive" "$SUPER")"
expect_contains "and the refusal says how many are sitting it" "sitting this assessment right now" \
  "$(http_body POST "$A/$NEW_ID/archive" "$SUPER")"
expect_eq "the assessment is still there after the refusal" 0 "$(dbq "SELECT COALESCE(archived,0) AS v FROM assessments WHERE id='$NEW_ID'")"
http_body POST "$BASE/api/exam/$TIME_TOKEN/answer" '' "{\"questionId\":\"$Q3\",\"answer\":{\"monthlyInterest\":1},\"timeSpentDeltaSeconds\":30}" > /dev/null
http_body POST "$BASE/api/exam/$TIME_TOKEN/submit" > /dev/null
expect_eq "the candidate finished" "SUBMITTED" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE candidate_id='$TIME_CAND_ID'")"

ARCHIVED=$(http_body POST "$A/$NEW_ID/archive" "$SUPER")
expect_eq "it archives once nobody is sitting it" 1 "$(dbq "SELECT COALESCE(archived,0) AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "archiving also deactivates it" 0 "$(dbq "SELECT active AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "it records who archived it" "Super Admin" "$(dbq "SELECT archived_by AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "the response reports the history it kept" 1 "$(jsonval "$ARCHIVED" 'd.historicalSessions')"
expect_eq "the assessment row was NOT deleted" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "the completed session was NOT deleted" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE assessment_id='$NEW_ID'")"
expect_eq "the candidate's answers were NOT deleted" 1 \
  "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM candidate_answers WHERE session_id=(SELECT id FROM assessment_sessions WHERE candidate_id='$TIME_CAND_ID')")"
expect_eq "the question links were NOT deleted" 3 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$NEW_ID'")"
expect_eq "archiving is audited" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='ASSESSMENT_ARCHIVED' AND target='$NEW_ID'")"
expect_eq "an archived assessment is hidden from the normal list" 0 \
  "$(jsonval "$(http_body GET "$A" "$SUPER")" "d.assessments.filter(a=>a.id==='$NEW_ID').length")"
expect_eq "but appears under archived" 1 \
  "$(jsonval "$(http_body GET "$A?archived=1" "$SUPER")" "d.assessments.filter(a=>a.id==='$NEW_ID').length")"
expect_eq "an archived assessment refuses a new invitation" 409 \
  "$(http_code POST "$BASE/api/admin/candidates/$INACT_CAND_ID/links" "$SUPER" "{\"assessmentId\":\"$NEW_ID\"}")"
expect_eq "an archived assessment cannot be edited until it is restored" 409 \
  "$(http_code PATCH "$A/$NEW_ID" "$SUPER" '{"duration_minutes":99}')"
expect_eq "an archived assessment cannot be activated directly" 409 "$(http_code POST "$A/$NEW_ID/active" "$SUPER" '{"active":true}')"
expect_eq "archiving twice is refused" 409 "$(http_code POST "$A/$NEW_ID/archive" "$SUPER")"

c_head "RESTORE"
expect_eq "restoring works" 200 "$(http_code POST "$A/$NEW_ID/restore" "$SUPER")"
expect_eq "it is no longer archived" 0 "$(dbq "SELECT COALESCE(archived,0) AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "it comes back INACTIVE so somebody confirms it first" 0 "$(dbq "SELECT active AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "the archive stamp is cleared" "" "$(dbq "SELECT COALESCE(archived_by,'') AS v FROM assessments WHERE id='$NEW_ID'")"
expect_eq "its questions are intact after the round trip" 3 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$NEW_ID'")"
expect_eq "restoring is audited" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='ASSESSMENT_RESTORED' AND target='$NEW_ID'")"
expect_eq "restoring something that is not archived is refused" 409 "$(http_code POST "$A/$NEW_ID/restore" "$SUPER")"
expect_eq "it can be edited again once restored" 200 "$(http_code PATCH "$A/$NEW_ID" "$SUPER" '{"description":"Back in service."}')"

# ===========================================================================
c_head "HISTORICAL SAFETY — changing the rules never re-judges a past candidate"
# A candidate sits the default assessment while the threshold is low enough to
# pass on the calculation section alone.
http_body PATCH "$A/$DEF" "$SUPER" '{"pass_threshold":20}' > /dev/null
read -r HIST_ID HIST_CODE <<< "$(new_candidate "$SUPER" "Historical Safety Candidate")"
HIST_TOKEN=$(new_link "$SUPER" "$HIST_ID")
take_assessment "$HIST_TOKEN" "$HIST_CODE" correct "Essay answer for the historical safety check." > /dev/null
HIST_SESSION=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id='$HIST_ID'")
expect_eq "the session snapshotted the threshold in force when it was sat" 20 "$(dbq "SELECT pass_threshold AS v FROM assessment_sessions WHERE id='$HIST_SESSION'")"
expect_eq "and the total it was out of" 100 "$(dbq "SELECT total_max AS v FROM assessment_sessions WHERE id='$HIST_SESSION'")"
http_body POST "$BASE/api/admin/candidates/$HIST_ID/essay-score" "$SUPER" '{"rubricScores":{},"comments":"Initial marking."}' > /dev/null
MARKS_BEFORE=$(dbq "SELECT final_marks AS v FROM scores WHERE session_id='$HIST_SESSION'")
PASS_BEFORE=$(dbq "SELECT pass AS v FROM scores WHERE session_id='$HIST_SESSION'")
PCT_BEFORE=$(dbq "SELECT CAST(percentage AS INT) AS v FROM scores WHERE session_id='$HIST_SESSION'")
expect_eq "the candidate passed under the rules they sat" 1 "$PASS_BEFORE"

# Now the threshold is raised far above what they scored.
http_body PATCH "$A/$DEF" "$SUPER" '{"pass_threshold":95}' > /dev/null
expect_eq "the assessment now demands 95" 95 "$(dbq "SELECT pass_threshold AS v FROM assessments WHERE id='$DEF'")"
expect_eq "the stored session snapshot is untouched by that change" 20 "$(dbq "SELECT pass_threshold AS v FROM assessment_sessions WHERE id='$HIST_SESSION'")"
expect_eq "the past result did not silently flip to a fail" "$PASS_BEFORE" "$(dbq "SELECT pass AS v FROM scores WHERE session_id='$HIST_SESSION'")"
# Re-marking the essay recomputes the result — under the OLD threshold.
http_body POST "$BASE/api/admin/candidates/$HIST_ID/essay-score" "$SUPER" '{"rubricScores":{},"comments":"Second look, same marks."}' > /dev/null
expect_eq "re-marking keeps the same final marks" "$MARKS_BEFORE" "$(dbq "SELECT final_marks AS v FROM scores WHERE session_id='$HIST_SESSION'")"
expect_eq "re-marking still judges them by the threshold they sat under" "$PASS_BEFORE" "$(dbq "SELECT pass AS v FROM scores WHERE session_id='$HIST_SESSION'")"
expect_eq "and the percentage is unchanged" "$PCT_BEFORE" "$(dbq "SELECT CAST(percentage AS INT) AS v FROM scores WHERE session_id='$HIST_SESSION'")"
expect_eq "the percentage is computed from the snapshotted total" "$MARKS_BEFORE" "$PCT_BEFORE"

# A candidate sitting it NOW is judged by the new rules.
read -r NEW_RULES_ID NEW_RULES_CODE <<< "$(new_candidate "$SUPER" "New Rules Candidate")"
NEW_RULES_TOKEN=$(new_link "$SUPER" "$NEW_RULES_ID")
complete_profile "$NEW_RULES_TOKEN"
http_body POST "$BASE/api/exam/$NEW_RULES_TOKEN/start" '' "{\"candidateCode\":\"$NEW_RULES_CODE\"}" > /dev/null
expect_eq "a candidate starting now snapshots the NEW threshold" 95 \
  "$(dbq "SELECT pass_threshold AS v FROM assessment_sessions WHERE candidate_id='$NEW_RULES_ID'")"
expect_eq "two candidates therefore carry two different thresholds" 2 \
  "$(dbq "SELECT COUNT(DISTINCT pass_threshold) AS v FROM assessment_sessions WHERE candidate_id IN ('$HIST_ID','$NEW_RULES_ID')")"

c_head "HISTORY SURVIVES THE QUESTION SET CHANGING"
ANSWERS_BEFORE=$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id='$HIST_SESSION'")
FIRST_Q=$(dbq "SELECT question_id AS v FROM assessment_questions WHERE assessment_id='$DEF' ORDER BY order_index LIMIT 1")
http_body PATCH "$A/$DEF" "$SUPER" "{\"questionIds\":[\"$Q1\",\"$Q2\"]}" > /dev/null
expect_eq "the default assessment now asks only two questions" 2 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$DEF'")"
expect_eq "the completed candidate keeps every answer they gave" "$ANSWERS_BEFORE" "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id='$HIST_SESSION'")"
expect_eq "including answers to questions the assessment no longer asks" 1 \
  "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM candidate_answers WHERE session_id='$HIST_SESSION' AND question_id='$FIRST_Q'")"
expect_eq "their marks are unchanged" "$MARKS_BEFORE" "$(dbq "SELECT final_marks AS v FROM scores WHERE session_id='$HIST_SESSION'")"
expect_eq "no question was deleted from the bank" 7 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='GENERAL'")"

# ===========================================================================
c_head "AUDIT TRAIL — every state change is attributable"
for action in ASSESSMENT_CREATED ASSESSMENT_EDITED ASSESSMENT_DUPLICATED ASSESSMENT_ACTIVATED \
              ASSESSMENT_DEACTIVATED ASSESSMENT_ARCHIVED ASSESSMENT_RESTORED \
              ASSESSMENT_TIMING_CHANGED ASSESSMENT_SCORING_CHANGED ASSESSMENT_QUESTIONS_CHANGED; do
  check "$action is recorded" "$([ "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action='$action'")" -gt 0 ] && echo 0 || echo 1)"
done
expect_eq "every assessment audit entry names the actor" 0 \
  "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action LIKE 'ASSESSMENT_%' AND (user_name IS NULL OR user_name = '')")"
expect_eq "every assessment audit entry is timestamped" 0 \
  "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action LIKE 'ASSESSMENT_%' AND (created_at IS NULL OR created_at = '')")"
expect_eq "nothing a refused request attempted was audited as done" 0 \
  "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action LIKE 'ASSESSMENT_%' AND target='asmt_nope'")"

# ===========================================================================
c_head "REFERENTIAL INTEGRITY"
expect_eq "every link's assessment resolves" 0 \
  "$(dbq 'SELECT COUNT(*) AS v FROM assessment_links l LEFT JOIN assessments a ON a.id = l.assessment_id WHERE l.assessment_id IS NOT NULL AND a.id IS NULL')"
expect_eq "every session's assessment resolves" 0 \
  "$(dbq 'SELECT COUNT(*) AS v FROM assessment_sessions s LEFT JOIN assessments a ON a.id = s.assessment_id WHERE s.assessment_id IS NOT NULL AND a.id IS NULL')"
expect_eq "every attached question resolves" 0 \
  "$(dbq 'SELECT COUNT(*) AS v FROM assessment_questions aq LEFT JOIN questions q ON q.id = aq.question_id WHERE q.id IS NULL')"
expect_eq "no assessment is both active and archived" 0 \
  "$(dbq 'SELECT COUNT(*) AS v FROM assessments WHERE active = 1 AND COALESCE(archived,0) = 1')"
expect_eq "no completed session lost its scoring snapshot" 0 \
  "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE status='SUBMITTED' AND (pass_threshold IS NULL OR total_max IS NULL)")"

summary "ASSESSMENT MANAGEMENT"
