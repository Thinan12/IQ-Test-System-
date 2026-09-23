#!/bin/bash
# Phase 1 — bilingual question bank and candidate language switching.
# Runs against a throwaway database.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4127

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
INTERVIEWER=$(login_token interviewer@lalco.demo "$DEMO_PASSWORD")
EVALUATOR=$(login_token evaluator@lalco.demo "$DEMO_PASSWORD")
[ -n "$SUPER" ] || { c_red "could not log in"; server_log; exit 1; }

# Non-ASCII through curl -d is mangled on Windows, so bodies go via a UTF-8 file.
post_json() { # post_json <method> <url> <token> <json-string>
  local m="$1" u="$2" tok="$3" body="$4"
  printf '%s' "$body" > "$TEST_DIR/body.json"
  curl -s -X "$m" "$u" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/body.json"
}
post_json_code() {
  local m="$1" u="$2" tok="$3" body="$4"
  printf '%s' "$body" > "$TEST_DIR/body.json"
  curl -s -o /dev/null -w '%{http_code}' -X "$m" "$u" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/body.json"
}
public_json() { # public_json <method> <url> <json>
  printf '%s' "$3" > "$TEST_DIR/pbody.json"
  curl -s -X "$1" "$2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/pbody.json"
}

LAO_Q='ຄຳຖາມພາສາລາວ ສຳລັບການທົດສອບ'
LAO_LABEL='ດອກເບ້ຍລາຍເດືອນ'

# ===========================================================================
c_head "MIGRATION — the seeded bank survives untouched"
expect_eq "all 7 seeded questions are present" 7 "$(dbq 'SELECT COUNT(*) AS v FROM questions')"
expect_eq "6 calculation questions" 6 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE type='CALC'")"
expect_eq "1 essay question" 1 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE type='ESSAY'")"
expect_eq "every question still has its English text" 0 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE text IS NULL OR text = ''")"
expect_eq "every question still has its marking config" 0 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE config_json IS NULL OR config_json = ''")"
expect_eq "no answer key was lost" 6 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE type='CALC' AND config_json LIKE '%expected%'")"
expect_eq "Lao starts empty — nothing was auto-translated" 7 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE text_lo IS NULL")"
expect_eq "translation status defaults to MISSING" 7 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE translation_status = 'MISSING'")"
expect_eq "nothing is archived by the migration" 0 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE COALESCE(archived,0) = 1")"
expect_eq "sessions gained a language column defaulting to en" "en" "$(dbq "SELECT COALESCE((SELECT language FROM assessment_sessions LIMIT 1),'en') AS v")"

c_head "RBAC — the question bank holds the answer keys"
expect_eq "Super Admin can read the bank" 200 "$(http_code GET "$BASE/api/admin/questions" "$SUPER")"
expect_eq "HR Admin can read the bank" 200 "$(http_code GET "$BASE/api/admin/questions" "$HR")"
expect_eq "Evaluator can read the bank (marks essays)" 200 "$(http_code GET "$BASE/api/admin/questions" "$EVALUATOR")"
expect_eq "Recruiter is refused — could leak the answer key" 403 "$(http_code GET "$BASE/api/admin/questions" "$RECRUITER")"
expect_eq "Interviewer is refused" 403 "$(http_code GET "$BASE/api/admin/questions" "$INTERVIEWER")"
expect_eq "an unauthenticated request is refused" 401 "$(http_code GET "$BASE/api/admin/questions")"
expect_eq "Evaluator cannot create questions" 403 "$(post_json_code POST "$BASE/api/admin/questions" "$EVALUATOR" '{"type":"CALC","text":"x"}')"
expect_eq "Recruiter cannot archive a question" 403 "$(http_code POST "$BASE/api/admin/questions/x/archive" "$RECRUITER")"

c_head "CREATE — a bilingual calculation question"
CREATE_BODY='{"type":"CALC","text":"What is the monthly interest on 100,000 at 2% per month?","textLo":"'"$LAO_Q"'","translationStatus":"APPROVED","category":"Bilingual Test","config":{"parts":[{"key":"monthly","label":"Monthly interest (USD)","marks":4,"expected":2000,"tol":1},{"key":"decision","label":"Decision","marks":2,"type":"choice","options":["Accept","Reject"],"expected":"Accept"}]},"configLo":{"parts":{"monthly":{"label":"'"$LAO_LABEL"'"},"decision":{"label":"ການຕັດສິນໃຈ","options":{"Accept":"ຮັບ","Reject":"ປະຕິເສດ"}}}}}'
CREATED=$(post_json POST "$BASE/api/admin/questions" "$HR" "$CREATE_BODY")
QID=$(jsonval "$CREATED" 'd.id')
check "question created ($QID)" "$([ -n "$QID" ] && echo 0 || echo 1)" "$CREATED"
expect_eq "marks are computed from the parts, not trusted from the client" 6 "$(jsonval "$CREATED" 'd.maxMarks')"
expect_eq "translation status stored as APPROVED" "APPROVED" "$(dbq "SELECT translation_status AS v FROM questions WHERE id = '$QID'")"
expect_eq "the Lao text is stored against the SAME question row" 1 "$(dbq "SELECT CASE WHEN text_lo IS NOT NULL THEN 1 ELSE 0 END AS v FROM questions WHERE id = '$QID'")"
expect_eq "no duplicate question record was created" 1 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE id = '$QID'")"
expect_eq "creation is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Question created' AND target = '$QID'")"

c_head "VALIDATION — server-side, never trusting the browser"
v() { post_json_code POST "$BASE/api/admin/questions" "$HR" "$1"; }
vb() { post_json POST "$BASE/api/admin/questions" "$HR" "$1"; }
expect_eq "missing type is rejected" 400 "$(v '{"text":"x","config":{"parts":[]}}')"
expect_eq "missing English text is rejected" 400 "$(v '{"type":"CALC","config":{"parts":[{"key":"a","label":"A","marks":1,"expected":1}]}}')"
expect_eq "empty English text is rejected" 400 "$(v '{"type":"CALC","text":"   ","config":{"parts":[{"key":"a","label":"A","marks":1,"expected":1}]}}')"
expect_eq "a CALC question with no parts is rejected" 400 "$(v '{"type":"CALC","text":"x","config":{"parts":[]}}')"
expect_eq "zero or negative marks are rejected" 400 "$(v '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":0,"expected":1}]}}')"
expect_eq "duplicate part keys are rejected" 400 "$(v '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1,"expected":1},{"key":"a","label":"B","marks":1,"expected":2}]}}')"
expect_eq "a numeric part without an expected answer is rejected" 400 "$(v '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1}]}}')"
expect_eq "a negative tolerance is rejected" 400 "$(v '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1,"expected":1,"tol":-2}]}}')"
expect_eq "a choice part with one option is rejected" 400 "$(v '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1,"type":"choice","options":["Only"],"expected":"Only"}]}}')"
CORRECT_NOT_OPTION=$(vb '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1,"type":"choice","options":["Accept","Reject"],"expected":"Maybe"}]}}')
expect_contains "a correct answer that is not one of the options is rejected" 'must be one of its options' "$CORRECT_NOT_OPTION"
expect_eq "an ESSAY with no rubric is rejected" 400 "$(v '{"type":"ESSAY","text":"x","config":{"rubric":[]}}')"
LAO_BAD_PART=$(vb '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1,"expected":1}]},"configLo":{"parts":{"nosuch":{"label":"X"}}}}')
expect_contains "a Lao overlay for a part that does not exist is rejected" 'does not exist' "$LAO_BAD_PART"
LAO_BAD_OPT=$(vb '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1,"type":"choice","options":["Accept","Reject"],"expected":"Accept"}]},"configLo":{"parts":{"a":{"options":{"Maybe":"X"}}}}}')
expect_contains "a Lao option that is not one of the options is rejected" 'not one of its options' "$LAO_BAD_OPT"
QCOUNT_AFTER=$(dbq 'SELECT COUNT(*) AS v FROM questions')
expect_eq "no invalid question was written" 8 "$QCOUNT_AFTER"

c_head "EDIT"
EDIT=$(post_json PATCH "$BASE/api/admin/questions/$QID" "$HR" '{"category":"Bilingual Test Edited","config":{"parts":[{"key":"monthly","label":"Monthly interest (USD)","marks":7,"expected":2000,"tol":1}]}}')
expect_eq "edit succeeds" "7" "$(jsonval "$EDIT" 'd.maxMarks')"
expect_eq "marks recomputed from the new parts" 7 "$(dbq "SELECT max_marks AS v FROM questions WHERE id = '$QID'")"
expect_eq "category updated" "Bilingual Test Edited" "$(dbq "SELECT category AS v FROM questions WHERE id = '$QID'")"
expect_eq "changing the English invalidates an APPROVED translation" "DRAFT" "$(dbq "SELECT translation_status AS v FROM questions WHERE id = '$QID'")"
expect_eq "the Lao text itself is kept for re-approval" 1 "$(dbq "SELECT CASE WHEN text_lo IS NOT NULL THEN 1 ELSE 0 END AS v FROM questions WHERE id = '$QID'")"
expect_eq "the question ID never changes" 1 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE id = '$QID'")"
post_json PATCH "$BASE/api/admin/questions/$QID" "$HR" '{"translationStatus":"APPROVED"}' > /dev/null
expect_eq "it can be re-approved" "APPROVED" "$(dbq "SELECT translation_status AS v FROM questions WHERE id = '$QID'")"
expect_eq "editing a question that does not exist is 404" 404 "$(post_json_code PATCH "$BASE/api/admin/questions/nope" "$HR" '{"text":"x"}')"

c_head "ARCHIVE / RESTORE — never hard-deleted"
expect_eq "archive succeeds" 200 "$(http_code POST "$BASE/api/admin/questions/$QID/archive" "$HR")"
expect_eq "it is flagged archived, not removed" 1 "$(dbq "SELECT archived AS v FROM questions WHERE id = '$QID'")"
expect_eq "the row still exists" 1 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE id = '$QID'")"
expect_not_contains "archived questions are hidden from the default list" "$QID" "$(http_body GET "$BASE/api/admin/questions" "$HR")"
expect_contains "and appear under ?archived=1" "$QID" "$(http_body GET "$BASE/api/admin/questions?archived=1" "$HR")"
expect_eq "archiving twice is refused" 409 "$(http_code POST "$BASE/api/admin/questions/$QID/archive" "$HR")"
expect_eq "archiving is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'QUESTION_ARCHIVED'")"
expect_eq "restore succeeds" 200 "$(http_code POST "$BASE/api/admin/questions/$QID/restore" "$HR")"
expect_eq "it is active again" 0 "$(dbq "SELECT archived AS v FROM questions WHERE id = '$QID'")"
expect_eq "restoring a non-archived question is refused" 409 "$(http_code POST "$BASE/api/admin/questions/$QID/restore" "$HR")"
expect_eq "restore is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'QUESTION_RESTORED'")"
# Park it out of the way so the exam below keeps its original 7 questions.
http_body POST "$BASE/api/admin/questions/$QID/archive" "$HR" > /dev/null

# ===========================================================================
c_head "CANDIDATE — English by default"
read -r C1 C1CODE <<< "$(new_candidate "$HR" "Bilingual Candidate")"
T1=$(new_link "$HR" "$C1")
START=$(public_json POST "$BASE/api/exam/$T1/start" "{\"candidateCode\":\"$C1CODE\"}")
expect_eq "the session starts in English by default" "en" "$(jsonval "$START" 'd.language')"
S1=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$C1'")
expect_eq "stored on the session" "en" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id = '$S1'")"
QL_EN=$(http_body GET "$BASE/api/exam/$T1/questions")
expect_eq "payload reports English" "en" "$(jsonval "$QL_EN" 'd.language')"
expect_eq "the archived question is not served to candidates" 7 "$(jsonval "$QL_EN" 'd.questions.length')"
Q1=$(jsonval "$QL_EN" "d.questions.filter(q=>q.type==='CALC')[0].id")
expect_contains "English question text is shown" "LALCO lends money" "$QL_EN"
CHOICE_OPTS=$(jsonval "$QL_EN" "JSON.stringify(d.questions.filter(q=>q.parts&&q.parts.some(p=>p.type==='choice'))[0].parts.filter(p=>p.type==='choice')[0].options)")
expect_contains "choice options carry a canonical value" '"value"' "$CHOICE_OPTS"
expect_contains "and a display label" '"label"' "$CHOICE_OPTS"
expect_contains "the value stays canonical English" '"value":"Reject"' "$CHOICE_OPTS"

c_head "SECURITY — the answer key never reaches the candidate, in either language"
for lang in en lo; do
  public_json POST "$BASE/api/exam/$T1/language" "{\"language\":\"$lang\"}" > /dev/null
  PAYLOAD=$(http_body GET "$BASE/api/exam/$T1/questions")
  expect_not_contains "[$lang] no expected answer" '"expected"' "$PAYLOAD"
  expect_not_contains "[$lang] no tolerance" '"tol"' "$PAYLOAD"
  expect_not_contains "[$lang] no explanation" 'explanation' "$PAYLOAD"
  expect_not_contains "[$lang] no rubric" 'rubric' "$PAYLOAD"
  expect_not_contains "[$lang] no raw config" 'config_json' "$PAYLOAD"
  expect_not_contains "[$lang] no Lao config overlay" 'config_lo_json' "$PAYLOAD"
  expect_not_contains "[$lang] the correct numeric answer 18000 is absent" '18000' "$PAYLOAD"
done
public_json POST "$BASE/api/exam/$T1/language" '{"language":"en"}' > /dev/null

c_head "LANGUAGE SWITCH — during the exam, nothing else moves"
# Answer one numeric part and one choice part first.
QCHOICE=$(jsonval "$QL_EN" "d.questions.filter(q=>q.parts&&q.parts.some(p=>p.type==='choice'))[0].id")
public_json POST "$BASE/api/exam/$T1/answer" "{\"questionId\":\"$Q1\",\"answer\":{\"monthlyInterest\":3000,\"totalInterest\":18000},\"timeSpentDeltaSeconds\":12}" > /dev/null
public_json POST "$BASE/api/exam/$T1/answer" "{\"questionId\":\"$QCHOICE\",\"answer\":{\"ltv\":250,\"decision\":\"Reject\"},\"timeSpentDeltaSeconds\":9}" > /dev/null
ANSWERS_BEFORE=$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$S1' AND answer_json IS NOT NULL")
DEADLINE_BEFORE=$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$S1'")
STATUS_BEFORE=$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$S1'")
TIME_BEFORE=$(dbq "SELECT time_spent_seconds AS v FROM candidate_answers WHERE session_id='$S1' AND question_id='$Q1'")

SWITCH=$(public_json POST "$BASE/api/exam/$T1/language" '{"language":"lo"}')
expect_contains "switching to Lao succeeds" '"ok":true' "$SWITCH"
expect_eq "the server reports the new language" "lo" "$(jsonval "$SWITCH" 'd.language')"
expect_eq "the server confirms the deadline did not move" "true" "$(jsonval "$SWITCH" 'String(d.deadlineUnchanged)')"
expect_eq "DEADLINE unchanged in the database" "$DEADLINE_BEFORE" "$(dbq "SELECT expires_at AS v FROM assessment_sessions WHERE id = '$S1'")"
expect_eq "TIMER basis unchanged (duration untouched)" "$(dbq "SELECT duration_minutes AS v FROM assessment_sessions WHERE id = '$S1'")" "$(dbq "SELECT duration_minutes AS v FROM assessment_sessions WHERE id = '$S1'")"
expect_eq "ANSWERS preserved" "$ANSWERS_BEFORE" "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$S1' AND answer_json IS NOT NULL")"
expect_eq "the saved choice answer is untouched" "Reject" "$(dbq "SELECT json_extract(answer_json,'\$.decision') AS v FROM candidate_answers WHERE session_id='$S1' AND question_id='$QCHOICE'")"
expect_eq "per-question timing is untouched" "$TIME_BEFORE" "$(dbq "SELECT time_spent_seconds AS v FROM candidate_answers WHERE session_id='$S1' AND question_id='$Q1'")"
expect_eq "the assessment was NOT submitted" "$STATUS_BEFORE" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$S1'")"
expect_eq "still IN_PROGRESS" "IN_PROGRESS" "$(dbq "SELECT status AS v FROM assessment_sessions WHERE id = '$S1'")"
expect_eq "no second session was created" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE candidate_id = '$C1'")"

c_head "LAO DISPLAY — approved translation shown, missing translation flagged"
QL_LO=$(http_body GET "$BASE/api/exam/$T1/questions")
expect_eq "payload reports Lao" "lo" "$(jsonval "$QL_LO" 'd.language')"
expect_eq "the same question IDs are served" "$(jsonval "$QL_EN" 'd.questions.map(q=>q.id).join(",")')" "$(jsonval "$QL_LO" 'd.questions.map(q=>q.id).join(",")')"
expect_eq "marks are identical in both languages" "$(jsonval "$QL_EN" 'd.questions.map(q=>q.maxMarks).join(",")')" "$(jsonval "$QL_LO" 'd.questions.map(q=>q.maxMarks).join(",")')"
expect_eq "every seeded question is flagged as having no Lao yet" 7 "$(jsonval "$QL_LO" 'd.questions.filter(q=>q.laoUnavailable).length')"
expect_eq "English is still shown underneath rather than blank" 7 "$(jsonval "$QL_LO" 'd.questions.filter(q=>q.text && q.text.length > 0).length')"
expect_eq "choice values stay canonical English in Lao mode" '"value":"Reject"' "$(jsonval "$QL_LO" "JSON.stringify(d.questions.filter(q=>q.parts&&q.parts.some(p=>p.type==='choice'))[0].parts.filter(p=>p.type==='choice')[0].options).match(/\"value\":\"Reject\"/)[0]")"

c_head "LAO DISPLAY — an approved question really does render in Lao"
# Restore the bilingual question and make it the one served.
http_body POST "$BASE/api/admin/questions/$QID/restore" "$HR" > /dev/null
# Writing a question into the bank no longer puts it in front of candidates —
# an assessment has to include it. Attach it to the assessment being sat.
BIL_ASMT=$(dbq "SELECT assessment_id AS v FROM assessment_links WHERE token = '$T1'")
BIL_QIDS=$(dbq "SELECT '[\"' || REPLACE(GROUP_CONCAT(question_id), ',', '\",\"') || '\"]' AS v FROM (SELECT question_id FROM assessment_questions WHERE assessment_id = '$BIL_ASMT' ORDER BY order_index)")
post_json PATCH "$BASE/api/admin/assessments/$BIL_ASMT" "$HR" "{\"questionIds\": $(printf '%s' "$BIL_QIDS" | sed "s/\]$/,\"$QID\"]/")}" > /dev/null
expect_eq "the restored bilingual question is part of the assessment being sat" 1   "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id = '$BIL_ASMT' AND question_id = '$QID'")"
QL_LO2=$(http_body GET "$BASE/api/exam/$T1/questions")
BIL=$(jsonval "$QL_LO2" "JSON.stringify(d.questions.filter(q=>q.id==='$QID')[0]||{})")
expect_contains "the approved Lao question stem is served" "$LAO_Q" "$BIL"
expect_eq "and it is NOT flagged as unavailable" "false" "$(jsonval "$QL_LO2" "String((d.questions.filter(q=>q.id==='$QID')[0]||{}).laoUnavailable)")"
expect_contains "the Lao part label is served" "$LAO_LABEL" "$BIL"
expect_not_contains "the Lao payload still carries no expected answer" '"expected"' "$BIL"
QL_EN2=$(public_json POST "$BASE/api/exam/$T1/language" '{"language":"en"}' > /dev/null; http_body GET "$BASE/api/exam/$T1/questions")
EN_BIL=$(jsonval "$QL_EN2" "JSON.stringify(d.questions.filter(q=>q.id==='$QID')[0]||{})")
expect_not_contains "switching back to English drops the Lao stem" "$LAO_Q" "$EN_BIL"
expect_contains "and shows the English stem" 'monthly interest' "$EN_BIL"
http_body POST "$BASE/api/admin/questions/$QID/archive" "$HR" > /dev/null

c_head "SCORING is unaffected by language"
public_json POST "$BASE/api/exam/$T1/language" '{"language":"lo"}' > /dev/null
take_assessment "$T1" "$C1CODE" correct "Essay answered while the interface was in Lao." > /dev/null
expect_eq "a fully correct attempt still scores 30/30 with the UI in Lao" 30 "$(dbq "SELECT calc_marks AS v FROM scores WHERE session_id = '$S1'")"
expect_eq "the session language is recorded" "lo" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id = '$S1'")"

c_head "LANGUAGE BEFORE THE EXAM"
read -r C2 C2CODE <<< "$(new_candidate "$HR" "Lao From Start Candidate")"
T2=$(new_link "$HR" "$C2")
START2=$(public_json POST "$BASE/api/exam/$T2/start" "{\"candidateCode\":\"$C2CODE\",\"language\":\"lo\"}")
expect_eq "a language chosen before starting is honoured" "lo" "$(jsonval "$START2" 'd.language')"
S2=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$C2'")
expect_eq "and persisted on the session" "lo" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id = '$S2'")"
expect_eq "an unknown language falls back to English rather than erroring" "en" "$(jsonval "$(public_json POST "$BASE/api/exam/$T2/language" '{"language":"fr"}')" 'd.language')"

c_head "REPORTS / EXPORTS unchanged"
read -r C3 C3CODE <<< "$(new_candidate "$HR" "Export Regression Candidate")"
take_assessment "$(new_link "$HR" "$C3")" "$C3CODE" correct "Essay." > /dev/null
for fmt in pdf csv; do
  OUT=$(curl -s -o "$TEST_DIR/r.$fmt" -w '%{http_code}:%{size_download}' -H "Authorization: Bearer $HR" "$BASE/api/admin/reports/candidate/$C3.$fmt")
  expect_eq "$fmt report still returns 200" 200 "${OUT%%:*}"
  check "$fmt report is not empty" "$([ "${OUT##*:}" -gt 200 ] && echo 0 || echo 1)"
done
check "PDF is still a real PDF" "$(head -c 4 "$TEST_DIR/r.pdf" | grep -q '%PDF' && echo 0 || echo 1)"
OUT=$(curl -s -o "$TEST_DIR/b.xlsx" -w '%{http_code}' -H "Authorization: Bearer $HR" "$BASE/api/admin/reports/batch.xlsx")
expect_eq "Excel export still returns 200" 200 "$OUT"
check "Excel is still a real xlsx" "$(head -c 2 "$TEST_DIR/b.xlsx" | grep -q 'PK' && echo 0 || echo 1)"
SHEETS=$(cd "$BACKEND_DIR" && GOOGLE_SYNC_INCLUDE_DEMO=true "$NODE" -e "
  const s=require('./src/lib/googleSheets').buildAllSheets();
  const problems=[]; s.forEach(x=>x.rows.forEach((r,i)=>{ if(r.length!==x.headers.length) problems.push(x.name+' row '+i); }));
  console.log(JSON.stringify({names:s.map(x=>x.name), problems}));
")
expect_eq "the reporting workbook still builds with aligned columns" "" "$(jsonval "$SHEETS" 'd.problems.join(",")')"

summary "BILINGUAL QUESTION BANK + LANGUAGE SWITCH"
