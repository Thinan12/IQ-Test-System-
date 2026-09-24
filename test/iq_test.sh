#!/bin/bash
# IQ test module — admin bank, candidate journey, bilingual rendering,
# server-side scoring and the security boundaries around all of it.
#
# Runs against a throwaway database on its own port, like every other suite.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4133

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
INTERVIEWER=$(login_token interviewer@lalco.demo "$DEMO_PASSWORD")
EVALUATOR=$(login_token evaluator@lalco.demo "$DEMO_PASSWORD")
[ -n "$HR" ] || { c_red "could not log in"; server_log; exit 1; }

# Non-ASCII through curl -d is mangled on Windows, so bodies go via a UTF-8 file.
post_json() {
  local m="$1" u="$2" tok="$3" body="$4"
  printf '%s' "$body" > "$TEST_DIR/body.json"
  curl -s -X "$m" "$u" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/body.json"
}
post_json_code() {
  local m="$1" u="$2" tok="$3" body="$4"
  printf '%s' "$body" > "$TEST_DIR/body.json"
  curl -s -o /dev/null -w '%{http_code}' -X "$m" "$u" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/body.json"
}
public_json() {
  printf '%s' "$3" > "$TEST_DIR/pbody.json"
  curl -s -X "$1" "$2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/pbody.json"
}

IQ_ASMT=$(dbq "SELECT id AS v FROM assessments WHERE assessment_type='IQ_TEST' LIMIT 1")
GEN_ASMT=$(dbq "SELECT id AS v FROM assessments WHERE assessment_type='GENERAL_ASSESSMENT' LIMIT 1")

# ===========================================================================
c_head "MIGRATION — the IQ module is additive"
expect_eq "the seeded IQ bank exists" 18 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='IQ'")"
expect_eq "across six reasoning categories" 6 "$(dbq "SELECT COUNT(DISTINCT iq_category) AS v FROM questions WHERE question_family='IQ'")"
expect_eq "the recruitment bank is untouched" 7 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='GENERAL'")"
expect_eq "every pre-existing question defaulted to the GENERAL family" 0 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family IS NULL")"
expect_eq "the recruitment assessment kept its type" "GENERAL_ASSESSMENT" "$(dbq "SELECT assessment_type AS v FROM assessments WHERE id='$GEN_ASMT'")"
check "an IQ test was created" "$([ -n "$IQ_ASMT" ] && echo 0 || echo 1)"
expect_eq "with its own duration" 30 "$(dbq "SELECT duration_minutes AS v FROM assessments WHERE id='$IQ_ASMT'")"
expect_eq "and all 18 questions attached" 18 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$IQ_ASMT'")"
expect_eq "no Lao was invented for the IQ bank" 0 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='IQ' AND text_lo IS NOT NULL")"
expect_eq "so every IQ question starts MISSING a translation" 18 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='IQ' AND translation_status='MISSING'")"
expect_eq "the IQ results table exists and is empty" 0 "$(dbq "SELECT COUNT(*) AS v FROM iq_results")"

c_head "RBAC — the IQ bank holds the answer key"
expect_eq "Super Admin can read the IQ bank" 200 "$(http_code GET "$BASE/api/admin/iq/questions" "$SUPER")"
expect_eq "HR Admin can read it" 200 "$(http_code GET "$BASE/api/admin/iq/questions" "$HR")"
expect_eq "Evaluator can read it" 200 "$(http_code GET "$BASE/api/admin/iq/questions" "$EVALUATOR")"
expect_eq "Recruiter is refused — could leak the answer key" 403 "$(http_code GET "$BASE/api/admin/iq/questions" "$RECRUITER")"
expect_eq "Interviewer is refused" 403 "$(http_code GET "$BASE/api/admin/iq/questions" "$INTERVIEWER")"
expect_eq "an unauthenticated request is refused" 401 "$(http_code GET "$BASE/api/admin/iq/questions")"
expect_eq "Evaluator cannot create IQ questions" 403 "$(post_json_code POST "$BASE/api/admin/iq/questions" "$EVALUATOR" '{"text":"x","category":"LOGICAL","options":[{"value":"A","label":"a"},{"value":"B","label":"b"}],"correct":"A"}')"
expect_eq "Recruiter cannot archive an IQ question" 403 "$(http_code POST "$BASE/api/admin/iq/questions/x/archive" "$RECRUITER")"
expect_eq "an unauthenticated request cannot read results" 401 "$(http_code GET "$BASE/api/admin/iq/results")"

c_head "CREATE — an IQ question through the admin API"
NEWQ='{"category":"NUMERICAL","difficulty":"EASY","marks":2,"text":"What number comes next?\n\n3, 6, 12, 24, ?","options":[{"value":"A","label":"36"},{"value":"B","label":"48"},{"value":"C","label":"30"},{"value":"D","label":"60"}],"correct":"B","explanation":"Each term doubles."}'
NEWQ_ID=$(jsonval "$(post_json POST "$BASE/api/admin/iq/questions" "$HR" "$NEWQ")" 'd.id')
check "an IQ question is created" "$([ -n "$NEWQ_ID" ] && echo 0 || echo 1)"
expect_eq "it joins the IQ family" "IQ" "$(dbq "SELECT question_family AS v FROM questions WHERE id='$NEWQ_ID'")"
expect_eq "with its reasoning category stored" "NUMERICAL" "$(dbq "SELECT iq_category AS v FROM questions WHERE id='$NEWQ_ID'")"
expect_eq "marks come from the form" 2 "$(dbq "SELECT max_marks AS v FROM questions WHERE id='$NEWQ_ID'")"
expect_eq "it is marked by the existing CALC engine" "CALC" "$(dbq "SELECT type AS v FROM questions WHERE id='$NEWQ_ID'")"
expect_contains "the canonical values are letters, never the answer text" '"options":["A","B","C","D"]' "$(dbq "SELECT config_json AS v FROM questions WHERE id='$NEWQ_ID'")"
expect_contains "the expected answer is the VALUE" '"expected":"B"' "$(dbq "SELECT config_json AS v FROM questions WHERE id='$NEWQ_ID'")"
expect_contains "the visible text lives in labels" '"48"' "$(dbq "SELECT config_json AS v FROM questions WHERE id='$NEWQ_ID'")"
expect_eq "creation is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*)>0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action='IQ_QUESTION_CREATED'")"
expect_eq "it is not attached to any test yet" 0 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE question_id='$NEWQ_ID'")"

c_head "VALIDATION — nothing that could break marking is accepted"
v() { post_json_code POST "$BASE/api/admin/iq/questions" "$HR" "$1"; }
expect_eq "no question text is rejected" 400 "$(v '{"category":"LOGICAL","options":[{"value":"A","label":"a"},{"value":"B","label":"b"}],"correct":"A"}')"
expect_eq "a blank question is rejected" 400 "$(v '{"text":"   ","category":"LOGICAL","options":[{"value":"A","label":"a"},{"value":"B","label":"b"}],"correct":"A"}')"
expect_eq "an unknown category is rejected" 400 "$(v '{"text":"x","category":"ASTROLOGY","options":[{"value":"A","label":"a"},{"value":"B","label":"b"}],"correct":"A"}')"
expect_eq "one option is rejected" 400 "$(v '{"text":"x","category":"LOGICAL","options":[{"value":"A","label":"a"}],"correct":"A"}')"
expect_eq "a duplicate option value is rejected" 400 "$(v '{"text":"x","category":"LOGICAL","options":[{"value":"A","label":"a"},{"value":"A","label":"b"}],"correct":"A"}')"
expect_eq "an option with no text is rejected" 400 "$(v '{"text":"x","category":"LOGICAL","options":[{"value":"A","label":""},{"value":"B","label":"b"}],"correct":"A"}')"
expect_eq "a correct answer that is not an option is rejected" 400 "$(v '{"text":"x","category":"LOGICAL","options":[{"value":"A","label":"a"},{"value":"B","label":"b"}],"correct":"Z"}')"
expect_eq "no correct answer at all is rejected" 400 "$(v '{"text":"x","category":"LOGICAL","options":[{"value":"A","label":"a"},{"value":"B","label":"b"}]}')"
expect_eq "a non-letter canonical value is rejected" 400 "$(v '{"text":"x","category":"LOGICAL","options":[{"value":"Paris","label":"a"},{"value":"B","label":"b"}],"correct":"B"}')"
expect_eq "zero marks are rejected" 400 "$(v '{"text":"x","category":"LOGICAL","marks":0,"options":[{"value":"A","label":"a"},{"value":"B","label":"b"}],"correct":"A"}')"
expect_eq "editing a question that does not exist is 404" 404 "$(post_json_code PATCH "$BASE/api/admin/iq/questions/nope" "$HR" '{"text":"x"}')"
expect_eq "a recruitment question cannot be edited through the IQ route" 404 "$(post_json_code PATCH "$BASE/api/admin/iq/questions/$(dbq "SELECT id AS v FROM questions WHERE question_family='GENERAL' LIMIT 1")" "$HR" '{"text":"x"}')"

c_head "EDIT — the canonical value survives every change"
post_json PATCH "$BASE/api/admin/iq/questions/$NEWQ_ID" "$HR" '{"options":[{"value":"A","label":"thirty-six"},{"value":"B","label":"forty-eight"},{"value":"C","label":"thirty"},{"value":"D","label":"sixty"}],"correct":"B"}' > /dev/null
expect_contains "relabelling every option leaves the values alone" '"options":["A","B","C","D"]' "$(dbq "SELECT config_json AS v FROM questions WHERE id='$NEWQ_ID'")"
expect_contains "and the correct answer is still B" '"expected":"B"' "$(dbq "SELECT config_json AS v FROM questions WHERE id='$NEWQ_ID'")"
expect_contains "the new English text is stored" 'forty-eight' "$(dbq "SELECT config_json AS v FROM questions WHERE id='$NEWQ_ID'")"
post_json PATCH "$BASE/api/admin/iq/questions/$NEWQ_ID" "$HR" '{"difficulty":"HARD"}' > /dev/null
expect_eq "an unrelated edit does not disturb the options" "B" "$(dbq "SELECT json_extract(config_json,'\$.parts[0].expected') AS v FROM questions WHERE id='$NEWQ_ID'")"
expect_eq "and applies the change it was asked for" "HARD" "$(dbq "SELECT difficulty AS v FROM questions WHERE id='$NEWQ_ID'")"

c_head "BILINGUAL — Lao is supplied by a human and gated on approval"
LAOQ='{"category":"VERBAL","difficulty":"EASY","text":"Which word means the opposite of large?","textLo":"ຄຳໃດມີຄວາມໝາຍກົງກັນຂ້າມກັບ ໃຫຍ່?","translationStatus":"APPROVED","options":[{"value":"A","label":"Small","labelLo":"ນ້ອຍ"},{"value":"B","label":"Wide","labelLo":"ກວ້າງ"},{"value":"C","label":"Tall","labelLo":"ສູງ"},{"value":"D","label":"Heavy","labelLo":"ໜັກ"}],"correct":"A"}'
LAOQ_ID=$(jsonval "$(post_json POST "$BASE/api/admin/iq/questions" "$HR" "$LAOQ")" 'd.id')
check "a bilingual IQ question is created" "$([ -n "$LAOQ_ID" ] && echo 0 || echo 1)"
expect_eq "its translation is APPROVED" "APPROVED" "$(dbq "SELECT translation_status AS v FROM questions WHERE id='$LAOQ_ID'")"
expect_eq "and recorded as human-written" "HUMAN" "$(dbq "SELECT translation_source AS v FROM questions WHERE id='$LAOQ_ID'")"
expect_contains "the Lao option labels are stored as an overlay keyed by value" '"A":"ນ້ອຍ"' "$(dbq "SELECT config_lo_json AS v FROM questions WHERE id='$LAOQ_ID'")"
expect_not_contains "the Lao overlay carries no expected answer" 'expected' "$(dbq "SELECT config_lo_json AS v FROM questions WHERE id='$LAOQ_ID'")"

# Attach both new questions to the IQ test so a candidate actually sees them.
IQ_QIDS=$(dbq "SELECT '[\"' || REPLACE(GROUP_CONCAT(question_id), ',', '\",\"') || '\"]' AS v FROM (SELECT aq.question_id FROM assessment_questions aq JOIN questions q ON q.id=aq.question_id WHERE aq.assessment_id='$IQ_ASMT' AND COALESCE(q.archived,0)=0 ORDER BY aq.order_index)")
post_json PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" "{\"questionIds\": $(printf '%s' "$IQ_QIDS" | sed "s/]$/,\"$NEWQ_ID\",\"$LAOQ_ID\"]/")}" > /dev/null
expect_eq "both new questions are on the test" 2 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$IQ_ASMT' AND question_id IN ('$NEWQ_ID','$LAOQ_ID')")"

# ===========================================================================
c_head "CANDIDATE LINK — separate, secure and opaque"
read -r CID CCODE <<< "$(new_candidate "$HR" "IQ Candidate English")"
LINK=$(http_body POST "$BASE/api/admin/candidates/$CID/links" "$HR" "{\"assessmentId\":\"$IQ_ASMT\",\"language\":\"en\"}")
TOK=$(jsonval "$LINK" 'd.token')
expect_eq "the invitation knows it is an IQ test" "IQ_TEST" "$(jsonval "$LINK" 'd.assessmentType')"
expect_contains "and points at the IQ portal, not the assessment portal" "/iq/" "$(jsonval "$LINK" 'd.examUrl')"
expect_not_contains "the URL carries no LALCO ID" "$CCODE" "$(jsonval "$LINK" 'd.examUrl')"
expect_not_contains "the URL carries no database id" "$CID" "$(jsonval "$LINK" 'd.examUrl')"
check "the token is 64 hex characters" "$([ ${#TOK} -eq 64 ] && printf '%s' "$TOK" | grep -Eq '^[0-9a-f]+$' && echo 0 || echo 1)" "length=${#TOK}"
expect_eq "the IQ portal page is served" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/iq/$TOK")"
expect_eq "an invalid token still serves the page, and the API refuses it" 404 "$(http_code GET "$BASE/api/exam/not-a-real-token")"
expect_eq "expiry behaviour is unchanged" 1 "$(dbq "SELECT CASE WHEN expires_at IS NOT NULL THEN 1 ELSE 0 END AS v FROM assessment_links WHERE token='$TOK'")"

c_head "CANDIDATE — the English journey"
INTRO=$(http_body GET "$BASE/api/exam/$TOK")
expect_eq "the portal is told it is an IQ test" "IQ_TEST" "$(jsonval "$INTRO" 'd.assessmentType')"
expect_eq "with the configured duration" 30 "$(jsonval "$INTRO" 'd.durationMinutes')"
expect_eq "and the right number of questions" 20 "$(jsonval "$INTRO" 'd.questionCount')"
START=$(public_json POST "$BASE/api/exam/$TOK/start" "{\"candidateCode\":\"$CCODE\"}")
expect_eq "the test starts" "true" "$(jsonval "$START" 'String(d.started)')"
SID=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id='$CID'")
expect_eq "a server-side deadline exists" 1 "$(dbq "SELECT CASE WHEN expires_at IS NOT NULL THEN 1 ELSE 0 END AS v FROM assessment_sessions WHERE id='$SID'")"
QS=$(http_body GET "$BASE/api/exam/$TOK/questions")
expect_eq "every attached question is served" 20 "$(jsonval "$QS" 'd.questions.length')"
expect_eq "the reasoning category is shown to the candidate" "NUMERICAL" "$(jsonval "$QS" "d.questions.filter(q=>q.id==='$NEWQ_ID')[0].category")"
expect_contains "options carry a canonical value" '"value":"B"' "$(jsonval "$QS" "JSON.stringify(d.questions.filter(q=>q.id==='$NEWQ_ID')[0].parts[0].options)")"
expect_contains "and readable English text" 'forty-eight' "$(jsonval "$QS" "JSON.stringify(d.questions.filter(q=>q.id==='$NEWQ_ID')[0].parts[0].options)")"

c_head "SECURITY — the candidate payload carries no answer key"
expect_not_contains "no expected answer" '"expected"' "$QS"
expect_not_contains "no explanation" 'explanation' "$QS"
expect_not_contains "no raw marking config" 'config_json' "$QS"
expect_not_contains "no Lao overlay" 'config_lo_json' "$QS"
expect_not_contains "no correct-answer field" '"correct"' "$QS"
expect_not_contains "no internal question family" 'question_family' "$QS"
expect_not_contains "no database candidate id" "$CID" "$QS"
expect_eq "a candidate token cannot read the IQ bank" 401 "$(http_code GET "$BASE/api/admin/iq/questions" "$TOK")"
expect_eq "a candidate token cannot read IQ results" 401 "$(http_code GET "$BASE/api/admin/iq/results" "$TOK")"
ONEQ=$(http_body GET "$BASE/api/exam/$TOK/question/$NEWQ_ID")
expect_not_contains "the single-question view leaks no expected answer" '"expected"' "$ONEQ"
expect_not_contains "and no explanation" 'Each term doubles' "$ONEQ"

c_head "ANSWERS — stored as the canonical value, and they persist"
public_json POST "$BASE/api/exam/$TOK/answer" "{\"questionId\":\"$NEWQ_ID\",\"answer\":{\"answer\":\"B\"},\"timeSpentDeltaSeconds\":4}" > /dev/null
expect_eq "the answer is stored as the option value" "B" "$(dbq "SELECT json_extract(answer_json,'\$.answer') AS v FROM candidate_answers WHERE session_id='$SID' AND question_id='$NEWQ_ID'")"
expect_eq "no label text was stored" 0 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id='$SID' AND answer_json LIKE '%forty-eight%'")"
expect_contains "reloading echoes the saved answer back" '"answer":"B"' "$(jsonval "$(http_body GET "$BASE/api/exam/$TOK/question/$NEWQ_ID")" 'JSON.stringify(d.savedAnswer)')"
expect_contains "and the question list reports it as answered" "$NEWQ_ID" "$(jsonval "$(http_body GET "$BASE/api/exam/$TOK/questions")" 'd.answered.join(",")')"

c_head "LANGUAGE — switching changes presentation only"
DEADLINE_BEFORE=$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id='$SID'")
ANSWERS_BEFORE=$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id='$SID' AND answer_json IS NOT NULL")
SW=$(public_json POST "$BASE/api/exam/$TOK/language" '{"language":"lo"}')
expect_eq "the switch succeeds" "lo" "$(jsonval "$SW" 'd.language')"
expect_eq "the deadline did not move" "$DEADLINE_BEFORE" "$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id='$SID'")"
expect_eq "no answer was lost" "$ANSWERS_BEFORE" "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id='$SID' AND answer_json IS NOT NULL")"
expect_eq "the saved answer is still the same value" "B" "$(dbq "SELECT json_extract(answer_json,'\$.answer') AS v FROM candidate_answers WHERE session_id='$SID' AND question_id='$NEWQ_ID'")"
expect_eq "no second attempt was created" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE candidate_id='$CID'")"
expect_eq "the test is still in progress" "IN_PROGRESS" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE id='$SID'")"

QS_LO=$(http_body GET "$BASE/api/exam/$TOK/questions")
expect_eq "the payload reports Lao" "lo" "$(jsonval "$QS_LO" 'd.language')"
expect_contains "an APPROVED question renders its Lao stem" "ຄຳໃດມີຄວາມໝາຍກົງກັນຂ້າມກັບ" "$QS_LO"
expect_contains "and its Lao option labels" "ນ້ອຍ" "$QS_LO"
expect_contains "with the SAME canonical values" '"value":"A"' "$(jsonval "$QS_LO" "JSON.stringify(d.questions.filter(q=>q.id==='$LAOQ_ID')[0].parts[0].options)")"
expect_eq "every question without approved Lao is flagged, not silently English" 19 "$(jsonval "$QS_LO" 'd.questions.filter(q=>q.laoUnavailable).length')"
expect_eq "and exactly one question really is translated" 1 "$(jsonval "$QS_LO" 'd.questions.filter(q=>!q.laoUnavailable).length')"
expect_not_contains "the Lao payload still carries no answer key" '"expected"' "$QS_LO"

public_json POST "$BASE/api/exam/$TOK/language" '{"language":"en"}' > /dev/null
expect_eq "switching back works" "en" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id='$SID'")"
expect_eq "and the answer is still there" "B" "$(dbq "SELECT json_extract(answer_json,'\$.answer') AS v FROM candidate_answers WHERE session_id='$SID' AND question_id='$NEWQ_ID'")"

c_head "SUBMISSION — marked on the server, once"
public_json POST "$BASE/api/exam/$TOK/answer" "{\"questionId\":\"$LAOQ_ID\",\"answer\":{\"answer\":\"A\"},\"timeSpentDeltaSeconds\":3}" > /dev/null
SUB=$(public_json POST "$BASE/api/exam/$TOK/submit" '')
expect_contains "submission succeeds" '"ok":true' "$SUB"
expect_eq "the session is finalized" "SUBMITTED" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE id='$SID'")"
expect_eq "a resubmission is refused" 409 "$(http_code POST "$BASE/api/exam/$TOK/submit")"
expect_eq "exactly one IQ result was recorded" 1 "$(dbq "SELECT COUNT(*) AS v FROM iq_results WHERE session_id='$SID'")"
expect_eq "sitting an IQ test does NOT put the candidate in the interview queue" 0 "$(dbq "SELECT CASE WHEN status='INTERVIEW_PENDING' THEN 1 ELSE 0 END AS v FROM candidates WHERE id='$CID'")"

c_head "SCORING — the numbers are the server's"
expect_eq "every question was counted" 20 "$(dbq "SELECT total_questions AS v FROM iq_results WHERE session_id='$SID'")"
expect_eq "two answers were given" 2 "$(dbq "SELECT correct_count + incorrect_count AS v FROM iq_results WHERE session_id='$SID'")"
expect_eq "both were correct" 2 "$(dbq "SELECT correct_count AS v FROM iq_results WHERE session_id='$SID'")"
expect_eq "the rest are unanswered, not wrong" 18 "$(dbq "SELECT unanswered_count AS v FROM iq_results WHERE session_id='$SID'")"
expect_eq "the raw score is the marks actually earned" 3 "$(dbq "SELECT raw_score AS v FROM iq_results WHERE session_id='$SID'")"
expect_eq "out of the marks available" 21 "$(dbq "SELECT raw_max AS v FROM iq_results WHERE session_id='$SID'")"
check "the percentage is consistent with the raw score" "$([ "$(dbq "SELECT CAST(ROUND(percentage) AS INT) AS v FROM iq_results WHERE session_id='$SID'")" = "14" ] && echo 0 || echo 1)" "got $(dbq "SELECT percentage AS v FROM iq_results WHERE session_id='$SID'")"
expect_contains "a category breakdown was stored" 'NUMERICAL' "$(dbq "SELECT category_scores_json AS v FROM iq_results WHERE session_id='$SID'")"
expect_contains "covering every category on the test" 'SPATIAL' "$(dbq "SELECT category_scores_json AS v FROM iq_results WHERE session_id='$SID'")"
expect_eq "the duration was recorded" 1 "$(dbq "SELECT CASE WHEN duration_seconds IS NOT NULL THEN 1 ELSE 0 END AS v FROM iq_results WHERE session_id='$SID'")"
expect_eq "the scoring model was snapshotted with the attempt" 1 "$(dbq "SELECT CASE WHEN scoring_model_json LIKE '%LINEAR_FROM_PERCENTAGE%' THEN 1 ELSE 0 END AS v FROM iq_results WHERE session_id='$SID'")"

c_head "SCORING — the estimated figure is configurable and never claimed to be clinical"
expect_eq "an estimate was produced under the seeded model" 1 "$(dbq "SELECT CASE WHEN estimated_iq IS NOT NULL THEN 1 ELSE 0 END AS v FROM iq_results WHERE session_id='$SID'")"
check "and it sits inside the configured bounds" "$([ "$(dbq "SELECT CASE WHEN estimated_iq BETWEEN 55 AND 145 THEN 1 ELSE 0 END AS v FROM iq_results WHERE session_id='$SID'")" = "1" ] && echo 0 || echo 1)"
RESULTS=$(http_body GET "$BASE/api/admin/iq/results" "$HR")
expect_contains "the results API carries the disclaimer" 'not a clinically validated IQ' "$RESULTS"
expect_contains "the detail API carries it too" 'not a clinically validated IQ' "$(http_body GET "$BASE/api/admin/iq/results/$SID" "$HR")"
expect_not_contains "nothing claims a diagnosis" 'diagnos' "$RESULTS"
SCORING=$(jsonval "$(http_body GET "$BASE/api/admin/assessments/$IQ_ASMT" "$HR")" 'JSON.stringify(d.assessment.iqScoring)')
expect_contains "the scoring model is exposed as configuration" 'LINEAR_FROM_PERCENTAGE' "$SCORING"
expect_eq "turning the estimate off is accepted" 200 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"iqScoring":{"model":"RAW_ONLY","estimatedIqEnabled":false}}')"
expect_eq "and then no estimate is published" "false" "$(jsonval "$(http_body GET "$BASE/api/admin/assessments/$IQ_ASMT" "$HR")" 'String(d.assessment.iqScoring.estimatedIqEnabled)')"
expect_eq "an unknown scoring model is rejected" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"iqScoring":{"model":"MAGIC"}}')"
expect_eq "a pass threshold outside 0-100 is rejected" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"iqScoring":{"passThreshold":500}}')"
# Put the model back so the rest of the suite sees the seeded configuration.
post_json PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"iqScoring":{"model":"LINEAR_FROM_PERCENTAGE","mean":100,"scale":0.6,"min":55,"max":145,"estimatedIqEnabled":true,"passThreshold":50}}' > /dev/null
expect_eq "an attempt already sat keeps the model it was judged under" 1 "$(dbq "SELECT CASE WHEN scoring_model_json LIKE '%LINEAR_FROM_PERCENTAGE%' THEN 1 ELSE 0 END AS v FROM iq_results WHERE session_id='$SID'")"

c_head "ASSESSMENT TYPE — the two products stay apart"
expect_eq "a new IQ test can be created" 201 "$(post_json_code POST "$BASE/api/admin/assessments" "$HR" '{"name":"Second IQ Test","assessmentType":"IQ_TEST","duration_minutes":20}')"
expect_eq "an unknown type is rejected" 400 "$(post_json_code POST "$BASE/api/admin/assessments" "$HR" '{"name":"Nope Test","assessmentType":"PERSONALITY"}')"
expect_eq "an existing assessment cannot change type" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"assessmentType":"GENERAL_ASSESSMENT"}')"
expect_eq "a recruitment assessment cannot become an IQ test either" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$GEN_ASMT" "$HR" '{"assessmentType":"IQ_TEST"}')"
expect_eq "a recruitment invitation still points at the assessment portal" 1 "$(printf '%s' "$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$CID/links" "$HR" "{\"assessmentId\":\"$GEN_ASMT\"}")" 'd.examUrl')" | grep -c '/exam/')"
expect_eq "and reports the general type" "GENERAL_ASSESSMENT" "$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$CID/links" "$HR" "{\"assessmentId\":\"$GEN_ASMT\"}")" 'd.assessmentType')"
expect_eq "no IQ result was created for a recruitment assessment" 1 "$(dbq "SELECT COUNT(*) AS v FROM iq_results")"

c_head "RESULTS API — admins see the marking, candidates never do"
DETAIL=$(http_body GET "$BASE/api/admin/iq/results/$SID" "$HR")
expect_contains "the admin review shows the correct answer" '"expected"' "$DETAIL"
expect_contains "and the category breakdown" 'categoryScores' "$DETAIL"
expect_eq "a Recruiter may read results but not the bank" 200 "$(http_code GET "$BASE/api/admin/iq/results" "$RECRUITER")"
expect_eq "an unknown session is 404" 404 "$(http_code GET "$BASE/api/admin/iq/results/sess_nope" "$HR")"
expect_eq "the candidate portal never reads an expected answer" 0 "$(grep -c '\.expected\|\[.expected.\]' public/iq/app.js)"
expect_eq "nor an explanation" 0 "$(grep -c '\.explanation' public/iq/app.js)"
expect_eq "nor a marking configuration" 0 "$(grep -c 'config_json\|optionLabels' public/iq/app.js)"
expect_not_contains "and no correct-answer handling" 'correctAnswer' "$(cat public/iq/app.js)"

c_head "UNANSWERED — an untouched test scores zero, not an error"
read -r CID2 CCODE2 <<< "$(new_candidate "$HR" "IQ Candidate Silent")"
TOK2=$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$CID2/links" "$HR" "{\"assessmentId\":\"$IQ_ASMT\",\"language\":\"lo\"}")" 'd.token')
expect_eq "a Lao invitation opens in Lao" "lo" "$(jsonval "$(http_body GET "$BASE/api/exam/$TOK2")" 'd.linkLanguage')"
public_json POST "$BASE/api/exam/$TOK2/start" "{\"candidateCode\":\"$CCODE2\"}" > /dev/null
SID2=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id='$CID2'")
expect_eq "the session inherited Lao from the invitation alone" "lo" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id='$SID2'")"
public_json POST "$BASE/api/exam/$TOK2/submit" '' > /dev/null
expect_eq "an untouched test still produces a result" 1 "$(dbq "SELECT COUNT(*) AS v FROM iq_results WHERE session_id='$SID2'")"
expect_eq "with everything unanswered" 20 "$(dbq "SELECT unanswered_count AS v FROM iq_results WHERE session_id='$SID2'")"
expect_eq "a raw score of zero" 0 "$(dbq "SELECT raw_score AS v FROM iq_results WHERE session_id='$SID2'")"
expect_eq "and zero percent" 0 "$(dbq "SELECT CAST(percentage AS INT) AS v FROM iq_results WHERE session_id='$SID2'")"
expect_eq "no correct answers were invented" 0 "$(dbq "SELECT correct_count AS v FROM iq_results WHERE session_id='$SID2'")"

c_head "TWO BANKS, ONE TABLE — the products must not bleed into each other"
# An IQ item IS a CALC question with a single choice part, stored in the same
# table as the recruitment bank. Family is the only thing separating them, so
# every query that means "the recruitment bank" has to say so: otherwise the
# recruitment exam serves reasoning puzzles, the /30 calculation section marks
# them, and the HR reports list them.
IQ_QID=$(dbq "SELECT id AS v FROM questions WHERE question_family='IQ' ORDER BY order_index LIMIT 1")
GEN_QID=$(dbq "SELECT id AS v FROM questions WHERE question_family='GENERAL' ORDER BY order_index LIMIT 1")
GEN_BANK=$(http_body GET "$BASE/api/admin/questions" "$HR")
expect_eq "the recruitment bank lists exactly the recruitment questions" \
  "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='GENERAL' AND COALESCE(archived,0)=0")" \
  "$(jsonval "$GEN_BANK" 'd.questions.length')"
expect_eq "an IQ question is not among them" 0 "$(jsonval "$GEN_BANK" "d.questions.filter(q => q.id === '$IQ_QID').length")"
expect_eq "the IQ bank lists exactly the IQ questions" \
  "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='IQ' AND COALESCE(archived,0)=0")" \
  "$(jsonval "$(http_body GET "$BASE/api/admin/iq/questions" "$HR")" 'd.questions.length')"

# The recruitment editor knows nothing about reasoning categories or IQ
# scoring, so it must not be able to reach an IQ question at all.
expect_eq "the recruitment editor cannot open an IQ question" 404 "$(http_code GET "$BASE/api/admin/questions/$IQ_QID" "$HR")"
expect_eq "nor edit one" 404 "$(post_json_code PATCH "$BASE/api/admin/questions/$IQ_QID" "$HR" '{"text":"hijacked by the wrong editor"}')"
expect_eq "nor archive one" 404 "$(http_code POST "$BASE/api/admin/questions/$IQ_QID/archive" "$HR")"
expect_eq "and the IQ question is untouched" 0 "$(dbq "SELECT CASE WHEN text LIKE '%hijacked%' THEN 1 ELSE 0 END AS v FROM questions WHERE id='$IQ_QID'")"
expect_eq "and still active" 0 "$(dbq "SELECT COALESCE(archived,0) AS v FROM questions WHERE id='$IQ_QID'")"

# A question set belongs to one product.
expect_eq "an IQ question cannot be attached to a recruitment assessment" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$GEN_ASMT" "$HR" "{\"questionIds\":[\"$IQ_QID\"]}")"
expect_eq "and a recruitment question cannot be attached to an IQ test" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" "{\"questionIds\":[\"$GEN_QID\"]}")"
expect_eq "the recruitment assessment kept its own question set" 0 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions aq JOIN questions q ON q.id=aq.question_id WHERE aq.assessment_id='$GEN_ASMT' AND q.question_family='IQ'")"

# A recruitment sitting must see, and be marked on, only recruitment questions.
read -r CID3 CCODE3 <<< "$(new_candidate "$HR" "Recruitment Not IQ")"
TOK3=$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$CID3/links" "$HR" "{\"assessmentId\":\"$GEN_ASMT\"}")" 'd.token')
public_json POST "$BASE/api/exam/$TOK3/start" "{\"candidateCode\":\"$CCODE3\"}" > /dev/null
SID3=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id='$CID3'")
GQS=$(http_body GET "$BASE/api/exam/$TOK3/questions")
expect_eq "a recruitment candidate is served no IQ question" 0 "$(jsonval "$GQS" "d.questions.filter(q => q.id === '$IQ_QID').length")"
expect_eq "and no reasoning category reaches them" 0 "$(printf '%s' "$GQS" | grep -c 'NUMERICAL\|SEQUENCE\|SPATIAL')"
expect_eq "and an IQ question cannot be fetched through a recruitment sitting" 404 "$(http_code GET "$BASE/api/exam/$TOK3/question/$IQ_QID")"
expect_eq "nor answered through one" 404 "$(http_code POST "$BASE/api/exam/$TOK3/answer" '' "{\"questionId\":\"$IQ_QID\",\"answer\":{\"answer\":\"A\"}}")"
expect_eq "no answer row was created for it in this sitting" 0 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE question_id='$IQ_QID' AND session_id='$SID3'")"

public_json POST "$BASE/api/exam/$TOK3/submit" '' > /dev/null
expect_eq "the recruitment sitting counts only recruitment questions" \
  "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE question_family='GENERAL' AND active=1")" \
  "$(dbq "SELECT answered_count + unanswered_count AS v FROM assessment_sessions WHERE id='$SID3'")"
expect_eq "the calculation section is still marked out of 30" 30 "$(dbq "SELECT calc_max AS v FROM scores WHERE session_id='$SID3'")"
expect_eq "and the sitting is still judged out of 100" 100 "$(dbq "SELECT total_max AS v FROM assessment_sessions WHERE id='$SID3'")"
expect_eq "no IQ result was recorded for a recruitment sitting" 0 "$(dbq "SELECT COUNT(*) AS v FROM iq_results WHERE session_id='$SID3'")"

# The HR reports draw the /30 section from the recruitment bank only.
CSV=$(curl -s -H "Authorization: Bearer $HR" "$BASE/api/admin/reports/candidate/$CID3.csv")
expect_eq "the candidate report lists no reasoning question" 0 "$(printf '%s' "$CSV" | grep -c 'NUMERICAL\|SEQUENCE\|SPATIAL')"

summary "IQ TEST MODULE"
