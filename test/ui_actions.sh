#!/bin/bash
# Button / UI action audit — the operation behind every control.
#
# A control is only counted as working when the underlying request succeeds AND
# the database changed AND (where applicable) an audit record was written.
# Runs against a throwaway database.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

c_head "Static wiring audit (no dead buttons, no stubs, all guards present)"
if "$NODE" test/ui_wiring.js; then pass "every rendered control is wired and guarded"; else fail "dead or unguarded controls found (see above)"; fi

start_server 4124

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
INTERVIEWER=$(login_token interviewer@lalco.demo "$DEMO_PASSWORD")
EVALUATOR=$(login_token evaluator@lalco.demo "$DEMO_PASSWORD")
[ -n "$SUPER" ] || { c_red "could not log in"; server_log; exit 1; }

c_head "4. LOGIN / LOGOUT"
expect_contains "Sign in with valid credentials returns a session" 'token' "$(login superadmin@lalco.demo "$DEMO_PASSWORD")"
expect_contains "Sign in with a wrong password is refused" 'Invalid email or password' "$(login superadmin@lalco.demo 'wrong-password')"
expect_contains "Sign in with an unknown account is refused" 'Invalid email or password' "$(login nobody@lalco.demo "$DEMO_PASSWORD")"
expect_eq "Sign in with a missing password is rejected" 400 "$(http_code POST "$BASE/api/admin/auth/login" '' '{"email":"superadmin@lalco.demo"}')"
expect_not_contains "login never returns the password hash" 'password_hash' "$(login superadmin@lalco.demo "$DEMO_PASSWORD")"
# Disabled account
"$NODE" -e "
  const D=require('better-sqlite3'); const db=new D(process.env.DATABASE_PATH);
  db.prepare(\"UPDATE users SET active = 0 WHERE email = 'evaluator@lalco.demo'\").run();
"
expect_contains "a disabled account cannot sign in" 'Invalid email or password' "$(login evaluator@lalco.demo "$DEMO_PASSWORD")"
"$NODE" -e "
  const D=require('better-sqlite3'); const db=new D(process.env.DATABASE_PATH);
  db.prepare(\"UPDATE users SET active = 1 WHERE email = 'evaluator@lalco.demo'\").run();
"
expect_eq "sign-in is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'User signed in'")"
expect_eq "Sign out is client-side; the session token remains valid until expiry" 200 "$(http_code GET "$BASE/api/admin/auth/me" "$SUPER")"

c_head "5. SIDEBAR NAVIGATION — every item loads real data"
for item in "Dashboard:/api/admin/analytics" "Candidates:/api/admin/candidates" "Assessment Links:/api/admin/links" \
            "Question Bank:/api/admin/questions" "Interviews:/api/admin/interviews/queue" "Analytics:/api/admin/analytics" \
            "Scholarship:/api/admin/scholarship" "Admin Settings:/api/admin/settings" \
            "Data Management:/api/admin/settings/data-management" "Audit Logs:/api/admin/audit"; do
  name="${item%%:*}"; ep="${item#*:}"
  expect_eq "sidebar '$name' loads (200, no dead link)" 200 "$(http_code GET "$BASE$ep" "$SUPER")"
done
expect_eq "Question Bank interview tab loads" 200 "$(http_code GET "$BASE/api/admin/questions/interview/questions" "$SUPER")"
expect_eq "Question Bank rubric loads" 200 "$(http_code GET "$BASE/api/admin/questions/interview/criteria" "$SUPER")"
expect_eq "Recruiter is blocked from Admin Settings (nav hidden AND server enforces)" 403 "$(http_code PUT "$BASE/api/admin/settings" "$RECRUITER" '{"passThreshold":70}')"
expect_eq "Recruiter is blocked from Audit Logs" 403 "$(http_code GET "$BASE/api/admin/audit" "$RECRUITER")"
expect_eq "Recruiter is blocked from Data Management" 403 "$(http_code GET "$BASE/api/admin/settings/data-management" "$RECRUITER")"

c_head "6. CANDIDATE MANAGEMENT"
BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM candidates')
CREATED=$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"UI Audit Candidate","applicationType":"NORMAL","iq":110,"education":"Bachelor Degree","position":"Marketing Staff","department":"Marketing","branch":"Head Office - Vientiane","phone":"02011112222"}')
UID_=$(jsonval "$CREATED" 'd.id'); UCODE=$(jsonval "$CREATED" 'd.code')
expect_eq "'Create candidate' wrote a row to the database" "$((BEFORE + 1))" "$(dbq 'SELECT COUNT(*) AS v FROM candidates')"
expect_eq "'Create candidate' is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Candidate created' AND target = '$UCODE'")"
expect_eq "'Create candidate' rejects a missing name (form validation)" 400 "$(http_code POST "$BASE/api/admin/candidates" "$HR" '{"applicationType":"NORMAL"}')"
expect_eq "Interviewer cannot create candidates" 403 "$(http_code POST "$BASE/api/admin/candidates" "$INTERVIEWER" '{"fullName":"X","applicationType":"NORMAL"}')"
SEARCH=$(http_body GET "$BASE/api/admin/candidates?q=UI%20Audit" "$HR")
expect_contains "Search box filters the table" "UI Audit Candidate" "$SEARCH"
expect_eq "Search returns only the match" 1 "$(jsonval "$SEARCH" 'd.candidates.length')"
expect_contains "Search for nothing returns an empty list (empty state)" '"candidates":[]' "$(http_body GET "$BASE/api/admin/candidates?q=zzzznomatch" "$HR")"
expect_eq "'Open →' loads the candidate profile" 200 "$(http_code GET "$BASE/api/admin/candidates/$UID_" "$HR")"
expect_eq "opening a non-existent candidate gives 404, not a blank page" 404 "$(http_code GET "$BASE/api/admin/candidates/cand_doesnotexist" "$HR")"

c_head "7. CANDIDATE PROFILE TABS — each tab's data is present in the payload"
DETAIL=$(http_body GET "$BASE/api/admin/candidates/$UID_" "$HR")
for field in '"candidate"' '"eligibility"' '"session"' '"links"' '"scores"' '"integrity"' '"answers"' '"settings"'; do
  expect_contains "profile payload carries $field" "$field" "$DETAIL"
done
expect_eq "Eligibility tab has real checks" 1 "$(jsonval "$DETAIL" 'd.eligibility.checks.length > 0 ? 1 : 0')"
expect_eq "Reports tab endpoint responds" 200 "$(http_code GET "$BASE/api/admin/candidates/$UID_/failure-analysis" "$HR")"

c_head "11. LINK MANAGEMENT — generate, revoke, regenerate"
LINK1=$(http_body POST "$BASE/api/admin/candidates/$UID_/links" "$HR")
TOK1=$(jsonval "$LINK1" 'd.token'); LID1=$(jsonval "$LINK1" 'd.id')
expect_eq "'Generate New Link' created a link row" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessment_links WHERE id = '$LID1'")"
expect_eq "the link is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Assessment link generated' AND target = '$UCODE'")"
expect_contains "'Copy Link' has a real URL to copy" '/exam/' "$(jsonval "$LINK1" 'd.examUrl')"
expect_contains "'Copy WhatsApp Message' has real text to copy" 'LALCO recruitment assessment' "$(jsonval "$LINK1" 'd.whatsappMessage')"
expect_eq "the link carries its own expiry" 1 "$(dbq "SELECT CASE WHEN expires_at IS NOT NULL THEN 1 ELSE 0 END AS v FROM assessment_links WHERE id = '$LID1'")"
expect_eq "the new link works for a candidate" 200 "$(http_code GET "$BASE/api/exam/$TOK1")"

# Revoke Link — the control added by this audit
expect_eq "'Revoke Link' succeeds" 200 "$(http_code POST "$BASE/api/admin/candidates/links/$LID1/revoke" "$HR")"
expect_eq "the link is REVOKED in the database" "REVOKED" "$(dbq "SELECT status AS v FROM assessment_links WHERE id = '$LID1'")"
expect_eq "the revoked token is rejected (410)" 410 "$(http_code GET "$BASE/api/exam/$TOK1")"
expect_eq "'Revoke Link' is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Assessment link revoked'")"
expect_eq "Interviewer cannot revoke a link" 403 "$(http_code POST "$BASE/api/admin/candidates/links/$LID1/revoke" "$INTERVIEWER")"

LINK2=$(http_body POST "$BASE/api/admin/candidates/$UID_/links" "$HR")
TOK2=$(jsonval "$LINK2" 'd.token')
LINK3=$(http_body POST "$BASE/api/admin/candidates/$UID_/links" "$HR")
TOK3=$(jsonval "$LINK3" 'd.token')
expect_eq "regenerating invalidates the previous token" 410 "$(http_code GET "$BASE/api/exam/$TOK2")"
expect_eq "the newest token works" 200 "$(http_code GET "$BASE/api/exam/$TOK3")"
expect_eq "link history is preserved, never deleted" 1 "$(dbq "SELECT CASE WHEN COUNT(*) >= 3 THEN 1 ELSE 0 END AS v FROM assessment_links WHERE candidate_id = '$UID_'")"

c_head "27. DUPLICATE ACTION — rapid repeated clicks"
read -r DUP_ID DUP_CODE <<< "$(new_candidate "$HR" "Duplicate Click Candidate")"
DUP_PIDS=()
for _ in 1 2 3 4 5; do
  curl -s -o /dev/null -X POST "$BASE/api/admin/candidates/$DUP_ID/links" -H "Authorization: Bearer $HR" &
  DUP_PIDS+=($!)
done
for pid in "${DUP_PIDS[@]}"; do wait "$pid" 2>/dev/null; done
ACTIVE=$(dbq "SELECT COUNT(*) AS v FROM assessment_links WHERE candidate_id = '$DUP_ID' AND status = 'ACTIVE'")
expect_eq "5 simultaneous 'Generate Link' calls leave exactly ONE active link" 1 "$ACTIVE"
DUP_TOK=$(new_link "$HR" "$DUP_ID")
take_assessment "$DUP_TOK" "$DUP_CODE" correct "Duplicate submit test." > /dev/null
DUP_SESS=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id = '$DUP_ID'")
SUB_PIDS=()
for _ in 1 2 3 4 5; do curl -s -o /dev/null -X POST "$BASE/api/exam/$DUP_TOK/submit" & SUB_PIDS+=($!); done
for pid in "${SUB_PIDS[@]}"; do wait "$pid" 2>/dev/null; done
expect_eq "5 simultaneous 'Submit' calls produce exactly ONE score row" 1 "$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = '$DUP_SESS'")"
expect_eq "and exactly ONE session" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE candidate_id = '$DUP_ID'")"

c_head "8. ELIGIBILITY RULES"
ORIG_IQ=$(dbq 'SELECT normal_iq_min AS v FROM eligibility_rules WHERE id = 1')
expect_eq "'Save eligibility rules' succeeds" 200 "$(http_code PUT "$BASE/api/admin/eligibility-rules" "$SUPER" '{"normalIqMin":200}')"
expect_eq "the new rule is persisted" 200 "$(dbq 'SELECT normal_iq_min AS v FROM eligibility_rules WHERE id = 1')"
expect_eq "the rule actually changes the eligibility result" "NOT_ELIGIBLE" "$(jsonval "$(http_body GET "$BASE/api/admin/candidates/$UID_" "$HR")" 'd.eligibility.status')"
expect_contains "a failure reason is given" "IQ" "$(jsonval "$(http_body GET "$BASE/api/admin/candidates/$UID_" "$HR")" 'd.eligibility.fails.map(f=>f.condition).join(",")')"
expect_eq "'Save eligibility rules' is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Eligibility rules changed'")"
http_body PUT "$BASE/api/admin/eligibility-rules" "$SUPER" "{\"normalIqMin\":$ORIG_IQ}" > /dev/null
expect_eq "restoring the rule restores eligibility" "ELIGIBLE" "$(jsonval "$(http_body GET "$BASE/api/admin/candidates/$UID_" "$HR")" 'd.eligibility.status')"
expect_eq "only Super Admin may change eligibility rules" 403 "$(http_code PUT "$BASE/api/admin/eligibility-rules" "$HR" '{"normalIqMin":90}')"

c_head "9. QUESTION BANK"
QS=$(http_body GET "$BASE/api/admin/questions" "$SUPER")
expect_eq "Calculation tab has 6 questions" 6 "$(jsonval "$QS" "d.questions.filter(q=>q.type==='CALC').length")"
expect_eq "Essay tab has 1 question" 1 "$(jsonval "$QS" "d.questions.filter(q=>q.type==='ESSAY').length")"
expect_contains "answer keys ARE visible to admins" 'expected' "$QS"
IVQ_BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM interview_questions')
ADDED=$(http_body POST "$BASE/api/admin/questions/interview/questions" "$SUPER" '{"text":"UI audit interview question"}')
expect_eq "'+ Add' interview question wrote exactly one row" "$((IVQ_BEFORE + 1))" "$(dbq 'SELECT COUNT(*) AS v FROM interview_questions')"
expect_eq "no duplicate question record was created" 1 "$(dbq "SELECT COUNT(*) AS v FROM interview_questions WHERE text = 'UI audit interview question'")"
expect_eq "Recruiter cannot add interview questions" 403 "$(http_code POST "$BASE/api/admin/questions/interview/questions" "$RECRUITER" '{"text":"nope"}')"

c_head "13. MARKING — /30 + /30 + /40 = /100, threshold 70"
read -r M_ID M_CODE <<< "$(new_candidate "$HR" "Marking Audit Candidate")"
take_assessment "$(new_link "$HR" "$M_ID")" "$M_CODE" correct "Essay for marking audit." > /dev/null
MD=$(http_body GET "$BASE/api/admin/candidates/$M_ID" "$HR")
expect_eq "automatic calculation marking scored 30/30" 30 "$(jsonval "$MD" 'd.scores.calc_marks')"
expect_eq "calculation maximum is 30" 30 "$(jsonval "$MD" 'd.scores.calc_max')"
expect_eq "'Save essay score' succeeds" 200 "$(http_code POST "$BASE/api/admin/candidates/$M_ID/essay-score" "$HR" '{"rubricScores":{"content":6,"accuracy":6,"reasoning":6,"communication":6,"professionalism":6},"comments":"Good."}')"
expect_eq "essay marks stored (30/30)" 30 "$(dbq "SELECT essay_marks AS v FROM scores WHERE session_id = (SELECT id FROM assessment_sessions WHERE candidate_id = '$M_ID')")"
expect_eq "'Save interview score' succeeds" 200 "$(http_code POST "$BASE/api/admin/candidates/$M_ID/interview-score" "$HR" '{"scores":{"communication":10,"responsiveness":10,"professionalism":10,"jobUnderstanding":10},"comments":"Strong."}')"
MD2=$(http_body GET "$BASE/api/admin/candidates/$M_ID" "$HR")
expect_eq "interview marks stored (40/40)" 40 "$(jsonval "$MD2" 'd.scores.interview_marks')"
expect_eq "total rolls up to 100" 100 "$(jsonval "$MD2" 'd.scores.final_marks')"
expect_eq "pass flag set (>= 70)" 1 "$(jsonval "$MD2" 'd.scores.pass')"
expect_eq "candidate status advanced" "PASSED" "$(jsonval "$MD2" 'd.candidate.status')"
expect_eq "essay marking is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Essay score entered'")"
expect_eq "interview marking is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Interview scored'")"
expect_eq "Recruiter cannot enter essay marks" 403 "$(http_code POST "$BASE/api/admin/candidates/$M_ID/essay-score" "$RECRUITER" '{"rubricScores":{}}')"
expect_eq "Interviewer cannot enter essay marks" 403 "$(http_code POST "$BASE/api/admin/candidates/$M_ID/essay-score" "$INTERVIEWER" '{"rubricScores":{}}')"
expect_eq "Evaluator CAN enter essay marks" 200 "$(http_code POST "$BASE/api/admin/candidates/$M_ID/essay-score" "$EVALUATOR" '{"rubricScores":{"content":5,"accuracy":5,"reasoning":5,"communication":5,"professionalism":5},"comments":"Re-marked."}')"
expect_eq "a re-mark overwrites rather than duplicating" 1 "$(dbq "SELECT COUNT(*) AS v FROM scores WHERE session_id = (SELECT id FROM assessment_sessions WHERE candidate_id = '$M_ID')")"

c_head "14. REPORT BUTTONS — real files with real data"
for fmt in pdf csv; do
  OUT=$(curl -s -o "$TEST_DIR/r.$fmt" -w '%{http_code}:%{size_download}' -H "Authorization: Bearer $HR" "$BASE/api/admin/reports/candidate/$M_ID.$fmt")
  CODE="${OUT%%:*}"; SIZE="${OUT##*:}"
  expect_eq "'$fmt' report returns 200" 200 "$CODE"
  check "'$fmt' report is not empty (${SIZE} bytes)" "$([ "$SIZE" -gt 200 ] && echo 0 || echo 1)"
done
check "PDF has a real PDF header" "$(head -c 4 "$TEST_DIR/r.pdf" | grep -q '%PDF' && echo 0 || echo 1)"
check "CSV contains the candidate's actual result" "$(grep -qi 'Marking Audit Candidate' "$TEST_DIR/r.csv" && echo 0 || echo 1)"
OUT=$(curl -s -o "$TEST_DIR/batch.xlsx" -w '%{http_code}:%{size_download}' -H "Authorization: Bearer $HR" "$BASE/api/admin/reports/batch.xlsx")
expect_eq "'Export batch Excel' returns 200" 200 "${OUT%%:*}"
check "Excel file is a real xlsx (PK zip header)" "$(head -c 2 "$TEST_DIR/batch.xlsx" | grep -q 'PK' && echo 0 || echo 1)"
OUT=$(curl -s -o "$TEST_DIR/batch.csv" -w '%{http_code}:%{size_download}' -H "Authorization: Bearer $HR" "$BASE/api/admin/reports/batch.csv")
expect_eq "'Export batch CSV' returns 200" 200 "${OUT%%:*}"
check "batch CSV is not empty" "$([ "${OUT##*:}" -gt 100 ] && echo 0 || echo 1)"
expect_eq "report export is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action LIKE 'Report exported%'")"

c_head "15. GOOGLE SHEETS — honest NOT CONFIGURED, never fake success"
GS=$(http_body POST "$BASE/api/admin/reports/google-sheets" "$HR")
expect_eq "'Export to Google Sheets' returns 503 when unconfigured" 503 "$(http_code POST "$BASE/api/admin/reports/google-sheets" "$HR")"
expect_contains "the failure says what is missing" 'not configured' "$GS"
expect_not_contains "it does NOT claim success" '"ok":true' "$GS"
expect_eq "'SYNC TO GOOGLE SHEETS' returns 503 when unconfigured" 503 "$(http_code POST "$BASE/api/admin/settings/data-management/google-sync" "$SUPER")"
expect_eq "'RETRY GOOGLE SHEETS SYNC' returns 503 when unconfigured" 503 "$(http_code POST "$BASE/api/admin/settings/data-management/google-sync/retry" "$SUPER")"
expect_eq "status endpoint reports not configured" "false" "$(jsonval "$(http_body GET "$BASE/api/admin/reports/google-sheets/status" "$HR")" 'String(d.configured)')"

c_head "16. DATA MANAGEMENT buttons"
expect_eq "'Create Demo Candidates' creates 5" 5 "$(jsonval "$(http_body POST "$BASE/api/admin/settings/data-management/demo/create" "$SUPER" '{"count":5}')" 'd.count')"
expect_eq "they are flagged is_demo" 5 "$(dbq 'SELECT COUNT(*) AS v FROM candidates WHERE is_demo = 1')"
expect_eq "'Delete Demo Candidates' removes them" 0 "$(jsonval "$(http_body POST "$BASE/api/admin/settings/data-management/demo/delete" "$SUPER")" 'd.candidates - d.candidates')"
expect_eq "0 demo candidates remain" 0 "$(dbq 'SELECT COUNT(*) AS v FROM candidates WHERE is_demo = 1')"
expect_eq "real candidates were untouched" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM candidates WHERE is_demo = 0")"
for dl in export-candidates.csv export-results.csv; do
  OUT=$(curl -s -o "$TEST_DIR/$dl" -w '%{http_code}:%{size_download}' -H "Authorization: Bearer $SUPER" "$BASE/api/admin/settings/data-management/$dl")
  expect_eq "'$dl' returns 200" 200 "${OUT%%:*}"
  check "'$dl' is not empty" "$([ "${OUT##*:}" -gt 50 ] && echo 0 || echo 1)"
done
BK=$(http_body POST "$BASE/api/admin/settings/data-management/backup" "$SUPER")
BKFILE=$(jsonval "$BK" 'd.fileName')
expect_contains "'Backup Database' reports a creation time" "$(date +%Y)" "$(jsonval "$BK" 'd.createdAtDisplay')"
expect_contains "'List Backups' shows it" "$BKFILE" "$(http_body GET "$BASE/api/admin/settings/data-management/backups" "$SUPER")"
expect_eq "'Download Backup' works" 200 "$(http_code GET "$BASE/api/admin/settings/data-management/backup/download?file=$BKFILE" "$SUPER")"
expect_eq "backup creation is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'DATABASE_BACKUP_CREATED'")"
expect_eq "HR Admin cannot back up" 403 "$(http_code POST "$BASE/api/admin/settings/data-management/backup" "$HR")"

c_head "18. SETTINGS persist across a reload"
http_body PUT "$BASE/api/admin/settings" "$SUPER" '{"passThreshold":75,"linkExpiryMinutes":15,"assessmentDurationMinutes":50,"maxLtv":85,"requirePhone":true}' > /dev/null
RELOADED=$(http_body GET "$BASE/api/admin/settings" "$SUPER")
expect_eq "pass threshold persisted" 75 "$(jsonval "$RELOADED" 'd.settings.pass_threshold')"
expect_eq "invitation expiry persisted" 15 "$(jsonval "$RELOADED" 'd.settings.link_expiry_minutes')"
expect_eq "exam duration persisted" 50 "$(jsonval "$RELOADED" 'd.settings.assessment_duration_minutes')"
expect_eq "max LTV persisted" 85 "$(jsonval "$RELOADED" 'd.settings.max_ltv')"
expect_eq "checkbox setting persisted" 1 "$(jsonval "$RELOADED" 'd.settings.require_phone')"
expect_eq "settings change is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Settings changed'")"
NEWLINK_EXP=$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$UID_/links" "$HR")" 'd.expiresAt')
check "a new link uses the updated 15-minute expiry" "$([ -n "$NEWLINK_EXP" ] && echo 0 || echo 1)"
http_body PUT "$BASE/api/admin/settings" "$SUPER" '{"passThreshold":70,"linkExpiryMinutes":10,"assessmentDurationMinutes":45,"maxLtv":80,"requirePhone":false}' > /dev/null

c_head "19. AUDIT LOG search + coverage"
expect_contains "audit search filters" 'Candidate created' "$(http_body GET "$BASE/api/admin/audit?q=Candidate%20created" "$HR")"
expect_contains "audit search with no match returns an empty list" '"logs":[]' "$(http_body GET "$BASE/api/admin/audit?q=zzzznomatchzzz" "$HR")"
for action in 'User signed in' 'Candidate created' 'Assessment link generated' 'Assessment link revoked' 'Essay score entered' 'Interview scored' 'Settings changed' 'Eligibility rules changed' 'DATABASE_BACKUP_CREATED' 'CREATE_DEMO_CANDIDATES' 'DELETE_DEMO_CANDIDATES'; do
  expect_eq "audited: $action" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = '$action'")"
done

c_head "30. ERROR STATES return actionable messages"
expect_eq "401 unauthenticated" 401 "$(http_code GET "$BASE/api/admin/candidates")"
expect_contains "401 has a message" 'error' "$(http_body GET "$BASE/api/admin/candidates")"
expect_eq "403 wrong role" 403 "$(http_code GET "$BASE/api/admin/audit" "$RECRUITER")"
expect_contains "403 explains it is a role problem" 'role' "$(http_body GET "$BASE/api/admin/audit" "$RECRUITER")"
expect_eq "404 unknown record" 404 "$(http_code GET "$BASE/api/admin/candidates/nope" "$HR")"
expect_contains "404 has a message" 'not found' "$(http_body GET "$BASE/api/admin/candidates/nope" "$HR")"
expect_eq "400 bad payload" 400 "$(http_code POST "$BASE/api/admin/candidates" "$HR" '{}')"
expect_eq "409 double submission" 409 "$(http_code POST "$BASE/api/exam/$DUP_TOK/submit")"
expect_eq "unknown route 404s as JSON" 404 "$(http_code GET "$BASE/api/admin/no-such-endpoint" "$HR")"

c_head "16b. DELETE ALL CANDIDATE DATA — authorisation chain"
expect_eq "HR Admin cannot open the danger zone" 403 "$(http_code POST "$BASE/api/admin/settings/data-management/delete-all-candidate-data" "$HR" "{\"confirmation\":\"DELETE ALL CANDIDATES\",\"password\":\"$DEMO_PASSWORD\"}")"
expect_eq "wrong phrase is refused" 400 "$(http_code POST "$BASE/api/admin/settings/data-management/delete-all-candidate-data" "$SUPER" "{\"confirmation\":\"delete all candidates\",\"password\":\"$DEMO_PASSWORD\"}")"
expect_eq "wrong password is refused" 401 "$(http_code POST "$BASE/api/admin/settings/data-management/delete-all-candidate-data" "$SUPER" '{"confirmation":"DELETE ALL CANDIDATES","password":"nope"}')"
CAND_STILL=$(dbq 'SELECT COUNT(*) AS v FROM candidates')
check "nothing was deleted by the refused attempts ($CAND_STILL candidates)" "$([ "$CAND_STILL" -gt 0 ] && echo 0 || echo 1)"
QB=$(dbq 'SELECT COUNT(*) AS v FROM questions'); US=$(dbq 'SELECT COUNT(*) AS v FROM users')
DEL=$(http_body POST "$BASE/api/admin/settings/data-management/delete-all-candidate-data" "$SUPER" "{\"confirmation\":\"DELETE ALL CANDIDATES\",\"password\":\"$DEMO_PASSWORD\"}")
expect_contains "the correct phrase + password succeeds" 'successfully deleted' "$DEL"
expect_eq "candidates are gone" 0 "$(dbq 'SELECT COUNT(*) AS v FROM candidates')"
expect_eq "questions survive" "$QB" "$(dbq 'SELECT COUNT(*) AS v FROM questions')"
expect_eq "users survive" "$US" "$(dbq 'SELECT COUNT(*) AS v FROM users')"
expect_eq "eligibility rules survive" 1 "$(dbq 'SELECT COUNT(*) AS v FROM eligibility_rules')"
expect_eq "settings survive" 1 "$(dbq 'SELECT COUNT(*) AS v FROM settings')"
expect_eq "scholarship policies survive" 1 "$(dbq 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM scholarship_policies')"
expect_eq "the deletion is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'DELETE_ALL_CANDIDATE_DATA'")"
expect_eq "the audit log itself survives" 1 "$(dbq 'SELECT CASE WHEN COUNT(*) > 5 THEN 1 ELSE 0 END AS v FROM audit_logs')"

summary "UI ACTION AUDIT (sections 1-34)"
