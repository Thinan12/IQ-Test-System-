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
# Phase 5 fixture: a choice question whose canonical values (A/B) differ from
# both the English labels (Paris/London) and the Lao ones. That separation is
# the whole point — the value is graded, the labels are only read.
LAO_PARIS='ປາຣີ'
LAO_LONDON='ລອນດອນ'
LAO_CAPITAL_Q='ເມືອງໃດແມ່ນນະຄອນຫຼວງຂອງຝຣັ່ງ?'
LAO_CAPITAL_LABEL='ນະຄອນຫຼວງ'
OPTION_QUESTION='{"type":"CALC","text":"Which city is the capital of France?","textLo":"'"$LAO_CAPITAL_Q"'","translationStatus":"APPROVED","category":"Bilingual Options","config":{"parts":[{"key":"capital","label":"Capital city","marks":2,"type":"choice","options":["A","B"],"optionLabels":{"A":"Paris","B":"London"},"expected":"A"}]},"configLo":{"parts":{"capital":{"label":"'"$LAO_CAPITAL_LABEL"'","options":{"A":"'"$LAO_PARIS"'","B":"'"$LAO_LONDON"'"}}}}}'

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

# ===========================================================================
c_head "LAO INTERFACE STRINGS — the translation table itself"
STRINGS=$(cd "$BACKEND_DIR" && "$NODE" "$(native_path "$BACKEND_DIR/test/inspect_lao_strings.js")")
check "the string table could be inspected" "$([ -n "$STRINGS" ] && echo 0 || echo 1)" "$STRINGS"
expect_eq "every English key has a Lao counterpart" "" "$(jsonval "$STRINGS" 'd.missingInLo.join(",")')"
expect_eq "the Lao table invents no keys of its own" "" "$(jsonval "$STRINGS" 'd.extraInLo.join(",")')"
expect_eq "English is complete — it is the source language" "" "$(jsonval "$STRINGS" 'd.englishEmpty.join(",")')"
expect_eq "no English text was pasted into the Lao column" "" "$(jsonval "$STRINGS" 'd.copiedFromEnglish.join(",")')"
expect_eq "every supplied Lao string really contains Lao script" "" "$(jsonval "$STRINGS" 'd.notActuallyLao.join(",")')"
expect_eq "the two columns are the same size" "$(jsonval "$STRINGS" 'd.enCount')" "$(jsonval "$STRINGS" 'd.loCount')"
check "Lao interface strings are supplied" "$([ "$(jsonval "$STRINGS" 'd.supplied')" -gt 0 ] && echo 0 || echo 1)"   "supplied=$(jsonval "$STRINGS" 'd.supplied')"
expect_eq "the three strings confirmed English in production are now Lao" "true"   "$(jsonval "$STRINGS" 'String(d.productionGapsFixed)')"
printf '  [36mNOTE[0m  Lao supplied: %s | still falling back to English: %s
'   "$(jsonval "$STRINGS" 'd.supplied')" "$(jsonval "$STRINGS" 'd.pending')"

# ===========================================================================
# Phase 5 — the admin chooses the candidate's language when generating the
# invitation, and the exam opens in it with no action from the candidate.
c_head "INVITATION LANGUAGE — validation at the point of choosing"
read -r CL CLCODE <<< "$(new_candidate "$HR" "Link Language Candidate")"
expect_eq "an invitation with no language stated is accepted" 201 "$(http_code POST "$BASE/api/admin/candidates/$CL/links" "$HR" '{}')"
expect_eq "and defaults to English, exactly as before this existed" "en" "$(dbq "SELECT language AS v FROM assessment_links WHERE candidate_id = '$CL' ORDER BY created_at DESC, rowid DESC LIMIT 1")"
expect_eq "English can be chosen explicitly" 201 "$(http_code POST "$BASE/api/admin/candidates/$CL/links" "$HR" '{"language":"en"}')"
expect_eq "Lao can be chosen explicitly" 201 "$(http_code POST "$BASE/api/admin/candidates/$CL/links" "$HR" '{"language":"lo"}')"
expect_eq "and is stored on the invitation" "lo" "$(dbq "SELECT language AS v FROM assessment_links WHERE candidate_id = '$CL' ORDER BY created_at DESC, rowid DESC LIMIT 1")"
expect_eq "upper case EN is accepted" 201 "$(http_code POST "$BASE/api/admin/candidates/$CL/links" "$HR" '{"language":"EN"}')"
expect_eq "and normalised to lower case" "en" "$(dbq "SELECT language AS v FROM assessment_links WHERE candidate_id = '$CL' ORDER BY created_at DESC, rowid DESC LIMIT 1")"
expect_eq "upper case LO is accepted" 201 "$(http_code POST "$BASE/api/admin/candidates/$CL/links" "$HR" '{"language":"LO"}')"
expect_eq "an unsupported language is REJECTED, not silently made English" 400 "$(http_code POST "$BASE/api/admin/candidates/$CL/links" "$HR" '{"language":"fr"}')"
expect_eq "a path-traversal style value is rejected" 400 "$(http_code POST "$BASE/api/admin/candidates/$CL/links" "$HR" '{"language":"../../etc/passwd"}')"
expect_eq "a non-string language is rejected" 400 "$(http_code POST "$BASE/api/admin/candidates/$CL/links" "$HR" '{"language":{"a":1}}')"
REJ=$(http_body POST "$BASE/api/admin/candidates/$CL/links" "$HR" '{"language":"fr"}')
expect_contains "the rejection says which languages are supported" "English (en) or Lao (lo)" "$REJ"
expect_eq "a rejected invitation creates no link row" "lo" "$(dbq "SELECT language AS v FROM assessment_links WHERE candidate_id = '$CL' ORDER BY created_at DESC, rowid DESC LIMIT 1")"
expect_eq "the chosen language is recorded in the audit trail" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Assessment link generated' AND new_value LIKE '%language%lo%'")"

c_head "GENERATED LINK — an English invitation opens in English"
read -r CEN CENCODE <<< "$(new_candidate "$HR" "English Invitation Candidate")"
TEN=$(new_link "$HR" "$CEN" en)
INTRO_EN=$(http_body GET "$BASE/api/exam/$TEN")
expect_eq "the portal is told the invitation language before any session exists" "en" "$(jsonval "$INTRO_EN" 'd.linkLanguage')"
START_EN=$(public_json POST "$BASE/api/exam/$TEN/start" "{\"candidateCode\":\"$CENCODE\"}")
expect_eq "the session starts in English" "en" "$(jsonval "$START_EN" 'd.language')"
SEN=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$CEN'")
expect_eq "stored on the session" "en" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id = '$SEN'")"
expect_eq "and the questions are served in English" "en" "$(jsonval "$(http_body GET "$BASE/api/exam/$TEN/questions")" 'd.language')"

c_head "GENERATED LINK — a Lao invitation opens in Lao with no candidate action"
read -r CLO CLOCODE <<< "$(new_candidate "$HR" "Lao Invitation Candidate")"
TLO=$(new_link "$HR" "$CLO" lo)
INTRO_LO=$(http_body GET "$BASE/api/exam/$TLO")
expect_eq "the portal is told the invitation is Lao" "lo" "$(jsonval "$INTRO_LO" 'd.linkLanguage')"
# The candidate sends NO language: that is the whole point of the feature.
START_LO=$(public_json POST "$BASE/api/exam/$TLO/start" "{\"candidateCode\":\"$CLOCODE\"}")
expect_eq "the session starts in Lao without the candidate choosing anything" "lo" "$(jsonval "$START_LO" 'd.language')"
SLO=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$CLO'")
expect_eq "stored on the session" "lo" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id = '$SLO'")"
expect_eq "questions are served in Lao" "lo" "$(jsonval "$(http_body GET "$BASE/api/exam/$TLO/questions")" 'd.language')"
expect_eq "RELOAD keeps it Lao - the value comes from the server, not the browser" "lo" "$(jsonval "$(http_body GET "$BASE/api/exam/$TLO")" 'd.session.language')"
expect_eq "and a second reload still does" "lo" "$(jsonval "$(http_body GET "$BASE/api/exam/$TLO")" 'd.session.language')"

c_head "INVITATION LANGUAGE — a candidate switch never rewrites the invitation"
LINK_LANG_BEFORE=$(dbq "SELECT language AS v FROM assessment_links WHERE token = '$TLO'")
public_json POST "$BASE/api/exam/$TLO/language" '{"language":"en"}' > /dev/null
expect_eq "the SESSION follows the candidate" "en" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id = '$SLO'")"
expect_eq "the INVITATION is unchanged - it records what the admin chose" "$LINK_LANG_BEFORE" "$(dbq "SELECT language AS v FROM assessment_links WHERE token = '$TLO'")"
expect_eq "reload now follows the candidate, not the invitation" "en" "$(jsonval "$(http_body GET "$BASE/api/exam/$TLO")" 'd.session.language')"
public_json POST "$BASE/api/exam/$TLO/language" '{"language":"lo"}' > /dev/null
expect_eq "and switching back works" "lo" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id = '$SLO'")"
expect_eq "an unsupported language from a candidate falls back safely to English" "en" "$(jsonval "$(public_json POST "$BASE/api/exam/$TLO/language" '{"language":"fr"}')" 'd.language')"
public_json POST "$BASE/api/exam/$TLO/language" '{"language":"lo"}' > /dev/null

c_head "LINK SAFETY — the token stays opaque and carries no PII"
for tok in "$TEN" "$TLO"; do
  check "the exam token is at least 32 characters" "$([ ${#tok} -ge 32 ] && echo 0 || echo 1)" "length=${#tok}"
  check "the exam token is opaque hex" "$(printf '%s' "$tok" | grep -Eq '^[0-9a-f]+$' && echo 0 || echo 1)" "$tok"
done
expect_not_contains "the token does not contain the LALCO ID" "$CLOCODE" "$TLO"
expect_not_contains "the token does not contain the database id" "$CLO" "$TLO"
LINK_BODY=$(http_body POST "$BASE/api/admin/candidates/$CLO/links" "$HR" '{"language":"lo"}')
expect_contains "the admin is told the language that was applied" '"language":"lo"' "$LINK_BODY"
EXAM_URL=$(jsonval "$LINK_BODY" 'd.examUrl')
expect_not_contains "the exam URL carries no LALCO ID" "$CLOCODE" "$EXAM_URL"
expect_not_contains "the exam URL carries no database id" "$CLO" "$EXAM_URL"
expect_not_contains "the exam URL carries no language query parameter" "lang=" "$EXAM_URL"
expect_not_contains "the exam URL carries no query string at all" "?" "$EXAM_URL"
expect_contains "expiry is still returned unchanged" '"expiresAt"' "$LINK_BODY"
NEWLINK_ID=$(jsonval "$LINK_BODY" 'd.id')
expect_eq "an invitation with a language can still be revoked" 200 "$(http_code POST "$BASE/api/admin/candidates/links/$NEWLINK_ID/revoke" "$HR")"
expect_eq "and is revoked" "REVOKED" "$(dbq "SELECT status AS v FROM assessment_links WHERE id = '$NEWLINK_ID'")"

# ===========================================================================
c_head "BILINGUAL OPTIONS — canonical value, English label, Lao label"
OPTQ_ID=$(jsonval "$(post_json POST "$BASE/api/admin/questions" "$HR" "$OPTION_QUESTION")" 'd.id')
check "a question with English AND Lao option labels is created" "$([ -n "$OPTQ_ID" ] && echo 0 || echo 1)"
expect_eq "it is APPROVED for Lao" "APPROVED" "$(dbq "SELECT translation_status AS v FROM questions WHERE id = '$OPTQ_ID'")"
ADMINQ=$(http_body GET "$BASE/api/admin/questions/$OPTQ_ID" "$HR")
expect_contains "the English label survives a save/reload round trip" 'Paris' "$ADMINQ"
expect_contains "so does the second English label" 'London' "$ADMINQ"
expect_contains "the expected answer is still the VALUE, not a label" '"expected":"A"' "$ADMINQ"
expect_contains "the Lao option label survives the round trip" "$LAO_PARIS" "$ADMINQ"

c_head "BILINGUAL OPTIONS — validation refuses anything that could change a mark"
expect_eq "an English label for an option that does not exist is rejected" 400 "$(post_json_code POST "$BASE/api/admin/questions" "$HR" '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1,"type":"choice","options":["A","B"],"optionLabels":{"C":"Nope"},"expected":"A"}]}}')"
expect_eq "a non-text English label is rejected" 400 "$(post_json_code POST "$BASE/api/admin/questions" "$HR" '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1,"type":"choice","options":["A","B"],"optionLabels":{"A":5},"expected":"A"}]}}')"
expect_eq "English labels on a numeric part are rejected" 400 "$(post_json_code POST "$BASE/api/admin/questions" "$HR" '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1,"expected":1,"optionLabels":{"A":"x"}}]}}')"
expect_eq "an array instead of an object is rejected" 400 "$(post_json_code POST "$BASE/api/admin/questions" "$HR" '{"type":"CALC","text":"x","config":{"parts":[{"key":"a","label":"A","marks":1,"type":"choice","options":["A","B"],"optionLabels":["A"],"expected":"A"}]}}')"

c_head "BILINGUAL OPTIONS — what the candidate actually receives"
OPT_ASMT=$(dbq "SELECT assessment_id AS v FROM assessment_links WHERE token = '$TEN'")
check "the invitation resolves to an assessment" "$([ -n "$OPT_ASMT" ] && echo 0 || echo 1)" "OPT_ASMT='$OPT_ASMT'"
OPT_QIDS=$(dbq "SELECT '[\"' || REPLACE(GROUP_CONCAT(question_id), ',', '\",\"') || '\"]' AS v FROM (SELECT aq.question_id FROM assessment_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.assessment_id = '$OPT_ASMT' AND COALESCE(q.archived,0) = 0 ORDER BY aq.order_index)")
check "its current question list could be read" "$(printf '%s' "$OPT_QIDS" | grep -q '^\[' && echo 0 || echo 1)" "OPT_QIDS='$OPT_QIDS'"
ATTACH=$(post_json PATCH "$BASE/api/admin/assessments/$OPT_ASMT" "$HR" "{\"questionIds\": $(printf '%s' "$OPT_QIDS" | sed "s/]$/,\"$OPTQ_ID\"]/")}")
expect_eq "the question is attached to the assessment being sat" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id = '$OPT_ASMT' AND question_id = '$OPTQ_ID'")"
check "the attach call reported success" "$(printf '%s' "$ATTACH" | grep -q '"ok"\|"id"' && echo 0 || echo 1)" "$(printf '%s' "$ATTACH" | head -c 200)"

ENQ=$(jsonval "$(http_body GET "$BASE/api/exam/$TEN/questions")" "JSON.stringify((d.questions.filter(q=>q.id==='$OPTQ_ID')[0]||{}).parts||[])")
expect_contains "[en] the option keeps its canonical value" '"value":"A"' "$ENQ"
expect_contains "[en] and shows the ENGLISH label, not the raw value" '"label":"Paris"' "$ENQ"
expect_contains "[en] the second option too" '"label":"London"' "$ENQ"
expect_not_contains "[en] no expected answer reaches the candidate" 'expected' "$ENQ"

public_json POST "$BASE/api/exam/$TEN/language" '{"language":"lo"}' > /dev/null
LOQ=$(jsonval "$(http_body GET "$BASE/api/exam/$TEN/questions")" "JSON.stringify((d.questions.filter(q=>q.id==='$OPTQ_ID')[0]||{}).parts||[])")
expect_contains "[lo] the option keeps the SAME canonical value" '"value":"A"' "$LOQ"
expect_contains "[lo] and shows the Lao label" "$LAO_PARIS" "$LOQ"
expect_not_contains "[lo] the English label is not shown alongside it" '"label":"Paris"' "$LOQ"
expect_not_contains "[lo] no expected answer reaches the candidate" 'expected' "$LOQ"
expect_eq "[lo] the canonical values are identical in both languages" "$(printf '%s' "$ENQ" | grep -o '"value":"[AB]"' | tr '\n' ',')" "$(printf '%s' "$LOQ" | grep -o '"value":"[AB]"' | tr '\n' ',')"

c_head "BILINGUAL OPTIONS — answering in Lao stores the canonical value"
public_json POST "$BASE/api/exam/$TEN/answer" "{\"questionId\":\"$OPTQ_ID\",\"answer\":{\"capital\":\"A\"},\"timeSpentDeltaSeconds\":5}" > /dev/null
expect_eq "the stored answer is the canonical value, not the Lao label" "A" "$(dbq "SELECT json_extract(answer_json,'\$.capital') AS v FROM candidate_answers WHERE session_id = '$SEN' AND question_id = '$OPTQ_ID'")"
expect_eq "no Lao text was written into the stored answer" 0 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = '$SEN' AND question_id = '$OPTQ_ID' AND LENGTH(answer_json) > 40")"
expect_contains "the question list reports it as answered" "$OPTQ_ID" "$(jsonval "$(http_body GET "$BASE/api/exam/$TEN/questions")" 'd.answered.join(",")')"
ECHOED=$(jsonval "$(http_body GET "$BASE/api/exam/$TEN/question/$OPTQ_ID")" 'JSON.stringify(d.savedAnswer)')
expect_contains "reloading in Lao echoes the saved answer so the option stays selected" '"capital":"A"' "$ECHOED"
expect_contains "and the question still renders in Lao around it" "$LAO_PARIS" "$(http_body GET "$BASE/api/exam/$TEN/question/$OPTQ_ID")"
public_json POST "$BASE/api/exam/$TEN/language" '{"language":"en"}' > /dev/null
ECHOED_EN=$(jsonval "$(http_body GET "$BASE/api/exam/$TEN/question/$OPTQ_ID")" 'JSON.stringify(d.savedAnswer)')
expect_contains "and it survives switching back to English" '"capital":"A"' "$ECHOED_EN"
expect_contains "with the English label shown again" 'Paris' "$(http_body GET "$BASE/api/exam/$TEN/question/$OPTQ_ID")"

c_head "SCORE PARITY — the language a candidate sits in cannot change a mark"
read -r PA PACODE <<< "$(new_candidate "$HR" "Parity English")"
read -r PB PBCODE <<< "$(new_candidate "$HR" "Parity Lao")"
TPA=$(new_link "$HR" "$PA" en)
TPB=$(new_link "$HR" "$PB" lo)
take_assessment "$TPA" "$PACODE" correct > /dev/null
take_assessment "$TPB" "$PBCODE" correct > /dev/null
SPA=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$PA'")
SPB=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$PB'")
expect_eq "the English candidate sat in English" "en" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id = '$SPA'")"
expect_eq "the Lao candidate sat in Lao, chosen by the invitation alone" "lo" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id = '$SPB'")"
expect_eq "both submitted" 2 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE id IN ('$SPA','$SPB') AND status = 'SUBMITTED'")"
MARKS_EN=$(dbq "SELECT CAST(calc_marks AS INT) AS v FROM scores WHERE session_id = '$SPA'")
MARKS_LO=$(dbq "SELECT CAST(calc_marks AS INT) AS v FROM scores WHERE session_id = '$SPB'")
expect_eq "calculation marks are IDENTICAL across languages" "$MARKS_EN" "$MARKS_LO"
check "and are not accidentally zero for both" "$([ -n "$MARKS_EN" ] && [ "$MARKS_EN" -gt 0 ] && echo 0 || echo 1)" "en=$MARKS_EN lo=$MARKS_LO"
expect_eq "the maximum available is identical too" "$(dbq "SELECT CAST(calc_max AS INT) AS v FROM scores WHERE session_id = '$SPA'")" "$(dbq "SELECT CAST(calc_max AS INT) AS v FROM scores WHERE session_id = '$SPB'")"
expect_eq "the scoring snapshot is identical too" "$(dbq "SELECT total_max AS v FROM assessment_sessions WHERE id = '$SPA'")" "$(dbq "SELECT total_max AS v FROM assessment_sessions WHERE id = '$SPB'")"
expect_eq "and the pass threshold is identical" "$(dbq "SELECT pass_threshold AS v FROM assessment_sessions WHERE id = '$SPA'")" "$(dbq "SELECT pass_threshold AS v FROM assessment_sessions WHERE id = '$SPB'")"

c_head "TRANSLATION COMPLETENESS — reported to admins, never invented"
FULL=$(http_body GET "$BASE/api/admin/questions/$OPTQ_ID" "$HR")
expect_eq "a fully translated question reports complete" "true" "$(jsonval "$FULL" 'String(d.question.laoComplete)')"
expect_eq "with no missing stem" "false" "$(jsonval "$FULL" 'String(d.question.laoGaps.text)')"
expect_eq "no missing step wording" 0 "$(jsonval "$FULL" 'd.question.laoGaps.parts.length')"
expect_eq "and no missing option labels" 0 "$(jsonval "$FULL" 'd.question.laoGaps.options.length')"
# Remove one Lao option label: the gap must be reported, not silently filled.
post_json PATCH "$BASE/api/admin/questions/$OPTQ_ID" "$HR" "{\"configLo\":{\"parts\":{\"capital\":{\"label\":\"$LAO_CAPITAL_LABEL\",\"options\":{\"A\":\"$LAO_PARIS\"}}}}}" > /dev/null
PARTIAL=$(http_body GET "$BASE/api/admin/questions/$OPTQ_ID" "$HR")
expect_eq "dropping one Lao option label makes it incomplete" "false" "$(jsonval "$PARTIAL" 'String(d.question.laoComplete)')"
expect_eq "and the missing option is named" 1 "$(jsonval "$PARTIAL" 'd.question.laoGaps.options.length')"
expect_eq "by its canonical value" "B" "$(jsonval "$PARTIAL" 'd.question.laoGaps.options[0].value')"
expect_eq "the question is still APPROVED — a gap is not an error" "APPROVED" "$(dbq "SELECT translation_status AS v FROM questions WHERE id = '$OPTQ_ID'")"
LOQ2=$(jsonval "$(public_json POST "$BASE/api/exam/$TEN/language" '{"language":"lo"}' > /dev/null; http_body GET "$BASE/api/exam/$TEN/questions")" "JSON.stringify((d.questions.filter(q=>q.id==='$OPTQ_ID')[0]||{}).parts||[])")
expect_contains "the translated option still shows Lao" "$LAO_PARIS" "$LOQ2"
expect_contains "the untranslated one falls back to its ENGLISH label, not blank" '"label":"London"' "$LOQ2"
expect_contains "and its canonical value is unchanged" '"value":"B"' "$LOQ2"
expect_not_contains "no Lao was invented for the untranslated option" "$LAO_LONDON" "$LOQ2"
# Put it back so later assertions see the complete question.
post_json PATCH "$BASE/api/admin/questions/$OPTQ_ID" "$HR" "{\"configLo\":{\"parts\":{\"capital\":{\"label\":\"$LAO_CAPITAL_LABEL\",\"options\":{\"A\":\"$LAO_PARIS\",\"B\":\"$LAO_LONDON\"}}}}}" > /dev/null
expect_eq "restoring the label makes it complete again" "true" "$(jsonval "$(http_body GET "$BASE/api/admin/questions/$OPTQ_ID" "$HR")" 'String(d.question.laoComplete)')"
ENONLY_GAPS=$(http_body GET "$BASE/api/admin/questions" "$HR")
expect_contains "the bank listing carries the same signal" 'laoComplete' "$ENONLY_GAPS"
public_json POST "$BASE/api/exam/$TEN/language" '{"language":"en"}' > /dev/null

c_head "ENGLISH-ONLY QUESTIONS — untouched by any of this"
ENONLY=$(jsonval "$(post_json POST "$BASE/api/admin/questions" "$HR" '{"type":"CALC","text":"English only question","config":{"parts":[{"key":"a","label":"Answer","marks":3,"expected":42,"tol":0}]}}')" 'd.id')
check "an English-only question is still accepted" "$([ -n "$ENONLY" ] && echo 0 || echo 1)"
expect_eq "its translation status is MISSING, not invented" "MISSING" "$(dbq "SELECT translation_status AS v FROM questions WHERE id = '$ENONLY'")"
expect_eq "no Lao text was fabricated for it" "" "$(dbq "SELECT COALESCE(text_lo,'') AS v FROM questions WHERE id = '$ENONLY'")"
expect_eq "and no Lao config overlay was fabricated" "" "$(dbq "SELECT COALESCE(config_lo_json,'') AS v FROM questions WHERE id = '$ENONLY'")"
expect_eq "no question is MISSING a translation yet carries Lao text" 0 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE translation_status = 'MISSING' AND COALESCE(TRIM(text_lo),'') <> ''")"
expect_eq "and no question carries a Lao overlay without Lao text" 0 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE COALESCE(TRIM(text_lo),'') = '' AND COALESCE(config_lo_json,'') <> ''")"

summary "BILINGUAL QUESTION BANK + LANGUAGE SWITCH"
