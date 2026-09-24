#!/bin/bash
# Section 18 — security verification.
# Runs against a throwaway database; never touches data/lalco.db.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4111

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
INTERVIEWER=$(login_token interviewer@lalco.demo "$DEMO_PASSWORD")
[ -n "$SUPER" ] || { c_red "could not log in as super admin"; server_log; exit 1; }

# Two candidates with live exam links, used across several checks.
CAND_A=$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Sec Test A","applicationType":"NORMAL","iq":110,"education":"Bachelor Degree","phone":"02011110000"}')
A_ID=$(jsonval "$CAND_A" 'd.id'); A_CODE=$(jsonval "$CAND_A" 'd.code')
CAND_B=$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Sec Test B","applicationType":"NORMAL","iq":110,"education":"Bachelor Degree","phone":"02022220000"}')
B_ID=$(jsonval "$CAND_B" 'd.id'); B_CODE=$(jsonval "$CAND_B" 'd.code')
A_TOKEN=$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$A_ID/links" "$HR")" 'd.token')
B_TOKEN=$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$B_ID/links" "$HR")" 'd.token')

c_head "1. Candidate cannot access /admin"
expect_eq "unauthenticated GET /api/admin/candidates -> 401" 401 "$(http_code GET "$BASE/api/admin/candidates")"
expect_eq "unauthenticated GET /api/admin/settings -> 401" 401 "$(http_code GET "$BASE/api/admin/settings")"
expect_eq "unauthenticated GET /api/admin/audit -> 401" 401 "$(http_code GET "$BASE/api/admin/audit")"
ADMIN_HTML=$(curl -s "$BASE/admin/")
expect_not_contains "admin bundle ships no answer key" '"expected"' "$ADMIN_HTML"

c_head "2. Candidate cannot access another candidate"
A_INFO=$(http_body GET "$BASE/api/exam/$A_TOKEN")
expect_contains "A's token shows A's own name" "Sec Test A" "$A_INFO"
expect_not_contains "A's token does not leak candidate B" "Sec Test B" "$A_INFO"
http_body POST "$BASE/api/exam/$A_TOKEN/start" '' "{\"candidateCode\":\"$A_CODE\"}" > /dev/null
expect_eq "A's code cannot start B's assessment" 401 "$(http_code POST "$BASE/api/exam/$B_TOKEN/start" '' "{\"candidateCode\":\"$A_CODE\"}")"
expect_eq "candidate cannot read a candidate profile via the admin API" 401 "$(http_code GET "$BASE/api/admin/candidates/$B_ID")"

c_head "3. Candidate cannot modify their score"
QLIST=$(http_body GET "$BASE/api/exam/$A_TOKEN/questions")
QID=$(jsonval "$QLIST" "d.questions.filter(q=>q.type==='CALC')[0].id")
# Answer wrongly, and try to smuggle marks/score fields into the payload.
http_body POST "$BASE/api/exam/$A_TOKEN/answer" '' \
  "{\"questionId\":\"$QID\",\"answer\":{\"monthlyInterest\":1,\"totalInterest\":1},\"marks\":30,\"calc_marks\":30,\"pass\":1}" > /dev/null
expect_eq "no exam route accepts a score write" 404 "$(http_code POST "$BASE/api/exam/$A_TOKEN/score" '' '{"marks":100}')"
expect_eq "essay scoring requires admin auth" 401 "$(http_code POST "$BASE/api/admin/candidates/$A_ID/essay-score" '' '{"rubricScores":{}}')"
expect_eq "interview scoring requires admin auth" 401 "$(http_code POST "$BASE/api/admin/candidates/$A_ID/interview-score" '' '{"scores":{}}')"

c_head "4. Candidate cannot modify correct answers"
expect_eq "question bank write requires admin auth" 401 "$(http_code POST "$BASE/api/admin/questions" '' '{"text":"x"}')"
expect_not_contains "candidate question payload has no 'expected' key" '"expected"' "$QLIST"
expect_not_contains "candidate question payload has no tolerance" '"tol"' "$QLIST"
expect_not_contains "candidate question payload has no explanation" '"explanation"' "$QLIST"
expect_not_contains "candidate question payload has no config_json" 'config_json' "$QLIST"

c_head "5. Candidate cannot submit twice"
FIRST_SUBMIT=$(http_body POST "$BASE/api/exam/$A_TOKEN/submit")
expect_contains "first submission accepted" '"ok":true' "$FIRST_SUBMIT"
expect_eq "second submission rejected (409)" 409 "$(http_code POST "$BASE/api/exam/$A_TOKEN/submit")"
expect_eq "answer edit after submission rejected (409)" 409 "$(http_code POST "$BASE/api/exam/$A_TOKEN/answer" '' "{\"questionId\":\"$QID\",\"answer\":{\"monthlyInterest\":3000}}")"
SCORE_AFTER=$(dbq "SELECT calc_marks AS v FROM scores ORDER BY computed_at DESC LIMIT 1")
check "score was computed server-side, not taken from the candidate payload (got '$SCORE_AFTER', not 30)" "$([ "$SCORE_AFTER" != "30" ] && echo 0 || echo 1)"

c_head "6. Expired token rejected"
# The assessment owns the invitation window, so the link is issued with a
# 1-minute expiry and then pushed into the past directly — the invitation
# window is validated on every request, not only at issue time.
EXP_ASMT=$(dbq "SELECT id AS v FROM assessments WHERE assessment_type='GENERAL_ASSESSMENT' ORDER BY created_at LIMIT 1")
http_body PATCH "$BASE/api/admin/assessments/$EXP_ASMT" "$SUPER" '{"link_expiry_minutes":1}' > /dev/null
EXP_CAND=$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Expiry Test","applicationType":"NORMAL","iq":110,"education":"Bachelor Degree"}')
EXP_ID=$(jsonval "$EXP_CAND" 'd.id')
EXP_LINK=$(http_body POST "$BASE/api/admin/candidates/$EXP_ID/links" "$HR")
EXP_TOKEN=$(jsonval "$EXP_LINK" 'd.token')
expect_eq "the link took the assessment's 1-minute invitation window" 1   "$(dbq "SELECT CAST((julianday(expires_at) - julianday(created_at)) * 24 * 60 + 0.5 AS INTEGER) AS v FROM assessment_links WHERE id = '$(jsonval "$EXP_LINK" 'd.id')'")"
dbx "UPDATE assessment_links SET expires_at = datetime('now','-1 minute') WHERE id = '$(jsonval "$EXP_LINK" 'd.id')'"
expect_eq "expired invitation link rejected (410)" 410 "$(http_code GET "$BASE/api/exam/$EXP_TOKEN")"
expect_eq "expired link cannot start an assessment (410)" 410 "$(http_code POST "$BASE/api/exam/$EXP_TOKEN/start" '' '{"candidateCode":"x"}')"
http_body PATCH "$BASE/api/admin/assessments/$EXP_ASMT" "$SUPER" '{"link_expiry_minutes":10}' > /dev/null

c_head "7. Revoked token rejected"
REV_CAND=$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Revoke Test","applicationType":"NORMAL","iq":110,"education":"Bachelor Degree"}')
REV_ID=$(jsonval "$REV_CAND" 'd.id')
REV_LINK=$(http_body POST "$BASE/api/admin/candidates/$REV_ID/links" "$HR")
REV_TOKEN=$(jsonval "$REV_LINK" 'd.token'); REV_LINK_ID=$(jsonval "$REV_LINK" 'd.id')
expect_eq "link works before revocation" 200 "$(http_code GET "$BASE/api/exam/$REV_TOKEN")"
http_body POST "$BASE/api/admin/candidates/links/$REV_LINK_ID/revoke" "$HR" > /dev/null
expect_eq "revoked link rejected (410)" 410 "$(http_code GET "$BASE/api/exam/$REV_TOKEN")"

c_head "8. Old token rejected after a new link is generated"
OLD_CAND=$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Regen Test","applicationType":"NORMAL","iq":110,"education":"Bachelor Degree"}')
OLD_ID=$(jsonval "$OLD_CAND" 'd.id')
OLD_TOKEN=$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$OLD_ID/links" "$HR")" 'd.token')
NEW_TOKEN=$(jsonval "$(http_body POST "$BASE/api/admin/candidates/$OLD_ID/links" "$HR")" 'd.token')
expect_eq "superseded link rejected (410)" 410 "$(http_code GET "$BASE/api/exam/$OLD_TOKEN")"
expect_eq "newly issued link works (200)" 200 "$(http_code GET "$BASE/api/exam/$NEW_TOKEN")"

c_head "9. Invalid token rejected"
expect_eq "unknown 64-hex token -> 404" 404 "$(http_code GET "$BASE/api/exam/$(printf '0%.0s' $(seq 1 64))")"
expect_eq "garbage token -> 404" 404 "$(http_code GET "$BASE/api/exam/not-a-real-token")"
expect_eq "SQL-injection-shaped token -> 404" 404 "$(http_code GET "$BASE/api/exam/%27%20OR%201%3D1--")"

c_head "10. Admin endpoints require authentication"
for endpoint in \
  "GET /api/admin/candidates" "GET /api/admin/questions" "GET /api/admin/links" \
  "GET /api/admin/analytics" "GET /api/admin/audit" "GET /api/admin/settings" \
  "GET /api/admin/interviews/queue" "GET /api/admin/scholarship" \
  "GET /api/admin/reports/batch.csv" "GET /api/admin/reports/batch.xlsx" \
  "GET /api/admin/settings/data-management" \
  "POST /api/admin/settings/data-management/backup" \
  "POST /api/admin/settings/data-management/google-sync" \
  "POST /api/admin/settings/data-management/demo/create" \
  "POST /api/admin/settings/data-management/delete-all-candidate-data"
do
  set -- $endpoint
  expect_eq "unauthenticated $1 $2 -> 401" 401 "$(http_code "$1" "$BASE$2")"
done
expect_eq "forged/garbage JWT rejected" 401 "$(http_code GET "$BASE/api/admin/candidates" "not.a.valid.jwt")"

c_head "11. Role permissions work"
expect_eq "Recruiter cannot change system settings" 403 "$(http_code PUT "$BASE/api/admin/settings" "$RECRUITER" '{"passThreshold":1}')"
expect_eq "Recruiter cannot change eligibility rules" 403 "$(http_code PUT "$BASE/api/admin/eligibility-rules" "$RECRUITER" '{"normalIqMin":1}')"
expect_eq "Interviewer cannot create candidates" 403 "$(http_code POST "$BASE/api/admin/candidates" "$INTERVIEWER" '{"fullName":"X","applicationType":"NORMAL"}')"
expect_eq "Interviewer cannot generate assessment links" 403 "$(http_code POST "$BASE/api/admin/candidates/$A_ID/links" "$INTERVIEWER")"
expect_eq "Recruiter cannot read the audit log" 403 "$(http_code GET "$BASE/api/admin/audit" "$RECRUITER")"
expect_eq "HR Admin CAN read the audit log" 200 "$(http_code GET "$BASE/api/admin/audit" "$HR")"
expect_eq "Recruiter CAN create candidates" 201 "$(http_code POST "$BASE/api/admin/candidates" "$RECRUITER" '{"fullName":"Role Check","applicationType":"NORMAL","iq":110,"education":"Bachelor Degree"}')"

c_head "12. Super Admin only can delete candidate data"
for role_token in "HR_ADMIN:$HR" "RECRUITER:$RECRUITER" "INTERVIEWER:$INTERVIEWER"; do
  rname="${role_token%%:*}"; rtok="${role_token#*:}"
  expect_eq "$rname cannot open Data Management" 403 "$(http_code GET "$BASE/api/admin/settings/data-management" "$rtok")"
  expect_eq "$rname cannot DELETE ALL CANDIDATE DATA" 403 "$(http_code POST "$BASE/api/admin/settings/data-management/delete-all-candidate-data" "$rtok" "{\"confirmation\":\"DELETE ALL CANDIDATES\",\"password\":\"$DEMO_PASSWORD\"}")"
  expect_eq "$rname cannot create demo candidates" 403 "$(http_code POST "$BASE/api/admin/settings/data-management/demo/create" "$rtok")"
  expect_eq "$rname cannot back up the database" 403 "$(http_code POST "$BASE/api/admin/settings/data-management/backup" "$rtok")"
done
for evrole in evaluator manager; do
  EVTOK=$(login_token "$evrole@lalco.demo" "$DEMO_PASSWORD")
  expect_eq "${evrole} cannot DELETE ALL CANDIDATE DATA" 403 "$(http_code POST "$BASE/api/admin/settings/data-management/delete-all-candidate-data" "$EVTOK" "{\"confirmation\":\"DELETE ALL CANDIDATES\",\"password\":\"$DEMO_PASSWORD\"}")"
done
expect_eq "Super Admin CAN open Data Management" 200 "$(http_code GET "$BASE/api/admin/settings/data-management" "$SUPER")"
expect_eq "Super Admin with the wrong phrase is refused (400)" 400 "$(http_code POST "$BASE/api/admin/settings/data-management/delete-all-candidate-data" "$SUPER" "{\"confirmation\":\"delete all candidates\",\"password\":\"$DEMO_PASSWORD\"}")"
expect_eq "Super Admin with the wrong password is refused (401)" 401 "$(http_code POST "$BASE/api/admin/settings/data-management/delete-all-candidate-data" "$SUPER" '{"confirmation":"DELETE ALL CANDIDATES","password":"wrong-password"}')"
CAND_COUNT_AFTER_REFUSALS=$(dbq "SELECT COUNT(*) AS v FROM candidates")
check "refused deletion attempts removed nothing (still $CAND_COUNT_AFTER_REFUSALS candidates)" "$([ -n "$CAND_COUNT_AFTER_REFUSALS" ] && [ "$CAND_COUNT_AFTER_REFUSALS" -gt 0 ] && echo 0 || echo 1)"

c_head "13. Google credentials are never exposed to the frontend"
DM=$(http_body GET "$BASE/api/admin/settings/data-management" "$SUPER")
expect_contains "Data Management reports only a configured boolean" '"googleSyncConfigured"' "$DM"
expect_not_contains "no sheet ID in the API response" 'GOOGLE_SHEET_ID' "$DM"
expect_not_contains "no service account email in the API response" 'serviceAccount' "$DM"
expect_not_contains "no private key in the API response" 'PRIVATE KEY' "$DM"
GREP_HITS=$(grep -rlE 'GOOGLE_PRIVATE_KEY|GOOGLE_SERVICE_ACCOUNT_EMAIL|GOOGLE_SHEET_ID|BEGIN PRIVATE KEY' public/ 2>/dev/null | tr '\n' ' ')
expect_eq "no Google credential names anywhere in public/" "" "$GREP_HITS"
ENV_IN_PUBLIC=$(grep -rl 'process.env' public/ 2>/dev/null | tr '\n' ' ')
expect_eq "no server environment access in browser code" "" "$ENV_IN_PUBLIC"

c_head "14. Database file is not publicly downloadable"
for dbpath in "/data/lalco.db" "/lalco.db" "/data/test.db" "/../data/lalco.db" "/admin/../data/lalco.db" "/data/lalco.db-wal" "/data/backups"; do
  CODE=$(http_code GET "$BASE$dbpath")
  check "$dbpath is not served (got $CODE)" "$([ "$CODE" = "404" ] || [ "$CODE" = "403" ] || [ "$CODE" = "301" ] && echo 0 || echo 1)"
done
expect_eq "backup download rejects path traversal" 400 "$(http_code GET "$BASE/api/admin/settings/data-management/backup/download?file=../../.env" "$SUPER")"
expect_eq "backup download rejects an arbitrary filename" 400 "$(http_code GET "$BASE/api/admin/settings/data-management/backup/download?file=lalco.db" "$SUPER")"

c_head "15. Passwords are hashed"
HASH=$(dbq "SELECT password_hash AS v FROM users WHERE role = 'SUPER_ADMIN'")
check "stored password is a bcrypt hash" "$(case "$HASH" in \$2*) echo 0;; *) echo 1;; esac)" "got: ${HASH:0:12}"
check "stored password is not the plaintext" "$([ "$HASH" != "$DEMO_PASSWORD" ] && echo 0 || echo 1)"
PLAIN=$(dbq "SELECT COUNT(*) AS v FROM users WHERE password_hash = '$DEMO_PASSWORD'")
expect_eq "no user row stores a plaintext password" "0" "$PLAIN"
LOGIN_BODY=$(login superadmin@lalco.demo "$DEMO_PASSWORD")
expect_not_contains "login response never returns a password hash" 'password_hash' "$LOGIN_BODY"

c_head "16. JWT secret is loaded from environment variables"
expect_not_contains "no hardcoded JWT secret in the auth middleware" 'JWT_SECRET =  ' "$(grep -n 'JWT_SECRET' src/middleware/auth.js)"
HARDCODED=$(grep -rnE "jwt\.(sign|verify)\([^,]+,\s*['\"]" src/ | tr '\n' ' ')
expect_eq "no string literal is ever used as the signing secret" "" "$HARDCODED"
NO_SECRET_OUT=$(cd "$BACKEND_DIR" && JWT_SECRET="" DOTENV_CONFIG_QUIET=true "$NODE" -e "
  process.env.JWT_SECRET='';
  try { require('./src/middleware/auth'); console.log('STARTED-WITHOUT-SECRET'); }
  catch (e) { console.log('REFUSED: ' + e.message); }
" 2>&1)
expect_contains "server refuses to start without JWT_SECRET" 'REFUSED' "$NO_SECRET_OUT"
WEAK_OUT=$(cd "$BACKEND_DIR" && "$NODE" -e "
  process.env.JWT_SECRET='short';
  try { require('./src/middleware/auth'); console.log('STARTED-WITH-WEAK-SECRET'); }
  catch (e) { console.log('REFUSED: ' + e.message); }
" 2>&1)
expect_contains "server refuses a weak JWT_SECRET" 'REFUSED' "$WEAK_OUT"

c_head "17. Rate limiting works"
LOGIN_LIMITED=no
for i in $(seq 1 25); do
  CODE=$(http_code POST "$BASE/api/admin/auth/login" '' '{"email":"superadmin@lalco.demo","password":"wrong"}')
  if [ "$CODE" = "429" ]; then LOGIN_LIMITED=yes; break; fi
done
expect_eq "brute-forcing the login is rate limited (429)" yes "$LOGIN_LIMITED"

# The exam limiter defaults to a ceiling far above real candidate traffic, so
# it is exercised here with the floor value instead of firing hundreds of
# requests. A non-default value also proves the setting is honoured.
restart_server_with 4115 EXAM_RATE_LIMIT_PER_MINUTE=60
EXAM_LIMITED=no
for i in $(seq 1 70); do
  CODE=$(http_code GET "$BASE/api/exam/deadbeef")
  if [ "$CODE" = "429" ]; then EXAM_LIMITED=yes; break; fi
done
expect_eq "public exam endpoints are rate limited (429)" yes "$EXAM_LIMITED"
expect_eq "EXAM_RATE_LIMIT_PER_MINUTE is honoured (limit reached on request $i)" 61 "$i"

c_head "18. HTTPS is required in production"
restart_server_with 4112 NODE_ENV=production
REDIRECT_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin")
REDIRECT_TO=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/admin")
expect_eq "plain HTTP GET is redirected in production (308)" 308 "$REDIRECT_CODE"
expect_contains "redirect target uses https" 'https://' "$REDIRECT_TO"
expect_eq "plain HTTP API write is refused in production (403)" 403 "$(http_code POST "$BASE/api/admin/auth/login" '' '{"email":"a","password":"b"}')"
HSTS=$(curl -s -D - -o /dev/null -H 'X-Forwarded-Proto: https' "$BASE/api/admin/candidates" | grep -i 'strict-transport-security')
expect_contains "HSTS header is sent in production" 'max-age=31536000' "$HSTS"
expect_eq "a proxied HTTPS request is served normally" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' "$BASE/api/admin/candidates")"
stop_server

# ===========================================================================
# A malformed request body is the CLIENT's mistake. It used to surface as a
# 500 "Internal server error", which reads to a candidate as "the assessment
# platform broke" and buries genuine faults in the logs.
start_server 4113
c_head "MALFORMED REQUEST BODIES ARE CLIENT ERRORS, NOT SERVER FAULTS"

JSUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
read -r JC JCODE <<< "$(new_candidate "$JSUPER" "Malformed JSON Candidate")"
JTOKEN=$(new_link "$JSUPER" "$JC")
http_body POST "$BASE/api/exam/$JTOKEN/start" '' "{\"candidateCode\":\"$JCODE\"}" > /dev/null
JQ=$(jsonval "$(http_body GET "$BASE/api/exam/$JTOKEN/questions")" 'd.questions[0].id')

bad_json() { # bad_json <method> <url> <raw body>
  printf '%s' "$3" > "$TEST_DIR/bad.json"
  curl -s -o /dev/null -w '%{http_code}' -X "$1" "$2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/bad.json"
}
bad_json_body() {
  printf '%s' "$3" > "$TEST_DIR/bad.json"
  curl -s -X "$1" "$2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/bad.json"
}

expect_eq "malformed JSON on the answer route is 400, not 500" 400   "$(bad_json POST "$BASE/api/exam/$JTOKEN/answer" '{\"questionId\":\"x\"}')"
expect_eq "truncated JSON is 400" 400 "$(bad_json POST "$BASE/api/exam/$JTOKEN/answer" '{"questionId":')"
expect_eq "a bare string body is 400" 400 "$(bad_json POST "$BASE/api/exam/$JTOKEN/answer" 'not json at all')"
expect_eq "malformed JSON on the flag route is 400" 400   "$(bad_json POST "$BASE/api/exam/$JTOKEN/flag" '{oops}')"
expect_eq "malformed JSON on the language route is 400" 400   "$(bad_json POST "$BASE/api/exam/$JTOKEN/language" '{oops}')"
expect_eq "malformed JSON on the admin login route is 400" 400   "$(bad_json POST "$BASE/api/admin/auth/login" '{oops}')"

BADRES=$(bad_json_body POST "$BASE/api/exam/$JTOKEN/answer" '{oops}')
expect_contains "the message is safe and human" 'Invalid JSON request body.' "$BADRES"
expect_not_contains "no stack trace is returned" 'at ' "$BADRES"
expect_not_contains "no file path is returned" 'node_modules' "$BADRES"
expect_not_contains "the offending body is not echoed back" 'oops' "$BADRES"
expect_not_contains "no JSON parser internals leak" 'SyntaxError' "$BADRES"
expect_not_contains "no secret leaks in the error" "$DEMO_PASSWORD" "$BADRES"

# The server must be unharmed and valid requests must behave exactly as before.
expect_eq "the server is still healthy afterwards" 200 "$(http_code GET "$BASE/api/health")"
expect_eq "a VALID answer still saves normally" 200   "$(http_code POST "$BASE/api/exam/$JTOKEN/answer" '' "{\"questionId\":\"$JQ\",\"answer\":{\"monthlyInterest\":3000},\"timeSpentDeltaSeconds\":5}")"
expect_eq "and the valid answer really was stored" 1   "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = (SELECT id FROM assessment_sessions WHERE candidate_id='$JC') AND answer_json IS NOT NULL")"
expect_eq "the malformed attempts stored nothing" 1   "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id = (SELECT id FROM assessment_sessions WHERE candidate_id='$JC')")"
expect_eq "an empty body is still accepted where the route allows it" 200 "$(http_code POST "$BASE/api/exam/$JTOKEN/submit")"
expect_eq "admin login still works with valid JSON" 200   "$(http_code POST "$BASE/api/admin/auth/login" '' "{\"email\":\"superadmin@lalco.demo\",\"password\":\"$DEMO_PASSWORD\"}")"
stop_server

summary "SECURITY CHECK (section 18)"
