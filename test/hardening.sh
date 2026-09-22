#!/bin/bash
# Production hardening — password policy, session invalidation, JWT rotation
# readiness, and the optional custom LALCO ID.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4128

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
INTERVIEWER=$(login_token interviewer@lalco.demo "$DEMO_PASSWORD")
[ -n "$SUPER" ] || { c_red "could not log in"; server_log; exit 1; }
STRONG='Vt7#qLm2Zx!pR9dK'   # 16 chars, 4 classes — test-only, never a real credential

c_head "1. PASSWORD POLICY"
expect_eq "a 12-character password is rejected" 400 "$(http_code POST "$BASE/api/admin/users" "$SUPER" '{"name":"T","email":"t1@lalco.demo","role":"RECRUITER","password":"Abcdef123456"}')"
expect_contains "the error states the 14-character minimum" '14 characters' "$(http_body POST "$BASE/api/admin/users" "$SUPER" '{"name":"T","email":"t1@lalco.demo","role":"RECRUITER","password":"Abcdef123456"}')"
expect_eq "a long but single-class password is rejected" 400 "$(http_code POST "$BASE/api/admin/users" "$SUPER" '{"name":"T","email":"t2@lalco.demo","role":"RECRUITER","password":"abcdefghijklmnopq"}')"
expect_contains "the error names the missing character classes" 'uppercase' "$(http_body POST "$BASE/api/admin/users" "$SUPER" '{"name":"T","email":"t2@lalco.demo","role":"RECRUITER","password":"abcdefghijklmnopq"}')"
expect_eq "the published default password is rejected outright" 400 "$(http_code POST "$BASE/api/admin/users" "$SUPER" '{"name":"T","email":"t3@lalco.demo","role":"RECRUITER","password":"ChangeMe123!!!!"}')"
expect_contains "and is called out as publicly known" 'publicly known' "$(http_body POST "$BASE/api/admin/users" "$SUPER" '{"name":"T","email":"t3@lalco.demo","role":"RECRUITER","password":"ChangeMe123!!!!"}')"
expect_eq "a password containing the account name is rejected" 400 "$(http_code POST "$BASE/api/admin/users" "$SUPER" '{"name":"T","email":"policycheck@lalco.demo","role":"RECRUITER","password":"policycheck-A9#zz"}')"
expect_eq "a compliant password is accepted" 201 "$(http_code POST "$BASE/api/admin/users" "$SUPER" "{\"name\":\"Policy User\",\"email\":\"policy@lalco.demo\",\"role\":\"RECRUITER\",\"password\":\"$STRONG\"}")"
PUID=$(dbq "SELECT id AS v FROM users WHERE email = 'policy@lalco.demo'")
expect_eq "it is stored as a bcrypt hash" 1 "$(dbq "SELECT CASE WHEN password_hash LIKE '\$2%' THEN 1 ELSE 0 END AS v FROM users WHERE id = '$PUID'")"
expect_eq "the plaintext is nowhere in the users table" 0 "$(dbq "SELECT COUNT(*) AS v FROM users WHERE password_hash = '$STRONG'")"
expect_not_contains "no hash is returned by the API" 'password_hash' "$(http_body GET "$BASE/api/admin/users" "$SUPER")"
expect_not_contains "no token_version is leaked either" 'token_version' "$(http_body GET "$BASE/api/admin/users" "$SUPER")"

c_head "1b. RESET PASSWORD — generated, shown once, never audited"
RESET=$(http_body POST "$BASE/api/admin/users/$PUID/reset-password" "$SUPER" '{"generate":true}')
GEN=$(jsonval "$RESET" 'd.generatedPassword')
check "a generated password is returned once (length ${#GEN})" "$([ ${#GEN} -ge 14 ] && echo 0 || echo 1)"
expect_contains "the response says it will not be shown again" 'not be shown again' "$RESET"
expect_eq "the generated password satisfies the policy" 1 "$("$NODE" -e "console.log(require('./src/lib/passwordPolicy').validatePassword(process.argv[1]).ok?1:0)" "$GEN")"
expect_eq "the old password no longer works" "" "$(jsonval "$(login policy@lalco.demo "$STRONG")" 'd.token')"
expect_eq "the new password works" 1 "$(jsonval "$(login policy@lalco.demo "$GEN")" 'd.token ? 1 : 0')"
expect_eq "the reset is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'USER_PASSWORD_RESET'")"
AUD=$(dbq "SELECT COALESCE(new_value,'')||COALESCE(old_value,'') AS v FROM audit_logs WHERE action = 'USER_PASSWORD_RESET' ORDER BY created_at DESC LIMIT 1")
expect_not_contains "the audit record does NOT contain the password" "$GEN" "$AUD"
expect_contains "but does record who did it" 'by' "$AUD"
expect_eq "a weak explicit password is refused on reset" 400 "$(http_code POST "$BASE/api/admin/users/$PUID/reset-password" "$SUPER" '{"password":"short"}')"
expect_eq "only Super Admin may reset a password" 403 "$(http_code POST "$BASE/api/admin/users/$PUID/reset-password" "$HR" '{"generate":true}')"

c_head "1c. SESSION INVALIDATION after a reset"
VICTIM=$(login_token policy@lalco.demo "$GEN")
expect_eq "the session works before the reset" 200 "$(http_code GET "$BASE/api/admin/candidates" "$VICTIM")"
http_body POST "$BASE/api/admin/users/$PUID/reset-password" "$SUPER" '{"generate":true}' > /dev/null
expect_eq "the existing session is invalidated by the reset (401)" 401 "$(http_code GET "$BASE/api/admin/candidates" "$VICTIM")"
expect_contains "with a message telling them to sign in again" 'sign in again' "$(http_body GET "$BASE/api/admin/candidates" "$VICTIM")"
expect_eq "the Super Admin's own session is unaffected" 200 "$(http_code GET "$BASE/api/admin/candidates" "$SUPER")"

c_head "1d. SESSION INVALIDATION on role change and disable"
NEW=$(jsonval "$(http_body POST "$BASE/api/admin/users/$PUID/reset-password" "$SUPER" '{"generate":true}')" 'd.generatedPassword')
TOK=$(login_token policy@lalco.demo "$NEW")
expect_eq "session valid" 200 "$(http_code GET "$BASE/api/admin/candidates" "$TOK")"
http_body POST "$BASE/api/admin/users/$PUID/role" "$SUPER" '{"role":"MANAGER"}' > /dev/null
expect_eq "a role change invalidates the old session" 401 "$(http_code GET "$BASE/api/admin/candidates" "$TOK")"
TOK2=$(login_token policy@lalco.demo "$NEW")
expect_eq "signing in again works and carries the new role" 200 "$(http_code GET "$BASE/api/admin/analytics" "$TOK2")"
http_body POST "$BASE/api/admin/users/$PUID/active" "$SUPER" '{"active":false}' > /dev/null
expect_eq "disabling the account kills its session immediately" 401 "$(http_code GET "$BASE/api/admin/candidates" "$TOK2")"
expect_contains "with a clear reason" 'no longer active' "$(http_body GET "$BASE/api/admin/candidates" "$TOK2")"

c_head "3. JWT ROTATION READINESS"
OLD_TOKEN=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
expect_eq "a token issued under the current secret works" 200 "$(http_code GET "$BASE/api/admin/candidates" "$OLD_TOKEN")"
# Restart with a NEW secret and the old one as JWT_SECRET_PREVIOUS.
NEW_SECRET="rotated-secret-$(date +%s)-0123456789abcdef0123456789"
restart_server_with 4129 JWT_SECRET="$NEW_SECRET" JWT_SECRET_PREVIOUS="$JWT_SECRET"
expect_eq "after rotation, the OLD session still works (no disruption)" 200 "$(http_code GET "$BASE/api/admin/candidates" "$OLD_TOKEN")"
NEW_TOKEN=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
expect_eq "a NEW sign-in works under the new secret" 200 "$(http_code GET "$BASE/api/admin/candidates" "$NEW_TOKEN")"
# Now drop the previous secret: old sessions must stop working.
restart_server_with 4130 JWT_SECRET="$NEW_SECRET"
expect_eq "once JWT_SECRET_PREVIOUS is removed, the old session is rejected" 401 "$(http_code GET "$BASE/api/admin/candidates" "$OLD_TOKEN")"
expect_eq "tokens signed with the new secret still work" 200 "$(http_code GET "$BASE/api/admin/candidates" "$NEW_TOKEN")"
REFUSE=$(cd "$BACKEND_DIR" && JWT_SECRET=same-secret-0123456789abcdef JWT_SECRET_PREVIOUS=same-secret-0123456789abcdef "$NODE" -e "
  try { require('./src/middleware/auth'); console.log('STARTED'); } catch (e) { console.log('REFUSED: ' + e.message); }" 2>&1)
expect_contains "the server refuses a rotation where old and new secrets are identical" 'REFUSED' "$REFUSE"
# Back to the original secret for the rest of the suite.
restart_server_with 4131 JWT_SECRET="$JWT_SECRET"
SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
INTERVIEWER=$(login_token interviewer@lalco.demo "$DEMO_PASSWORD")

c_head "4. CUSTOM LALCO ID"
CUSTOM=$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Custom Code Candidate","applicationType":"NORMAL","iq":110,"education":"Bachelor Degree","code":"TEST-LIVE-001"}')
CC_ID=$(jsonval "$CUSTOM" 'd.id')
expect_eq "a valid custom LALCO ID is accepted" "TEST-LIVE-001" "$(jsonval "$CUSTOM" 'd.code')"
expect_eq "and is what is stored" "TEST-LIVE-001" "$(dbq "SELECT code AS v FROM candidates WHERE id = '$CC_ID'")"
expect_eq "creation is audited against the custom ID" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Candidate created' AND target = 'TEST-LIVE-001'")"

expect_eq "whitespace is trimmed and case normalised" "TEST-LIVE-002" "$(jsonval "$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Trim Me","applicationType":"NORMAL","code":"  test-live-002  "}')" 'd.code')"
expect_eq "a duplicate custom ID is rejected" 400 "$(http_code POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Dup","applicationType":"NORMAL","code":"TEST-LIVE-001"}')"
expect_contains "with a message naming the clash" 'already in use' "$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Dup","applicationType":"NORMAL","code":"TEST-LIVE-001"}')"
expect_eq "a duplicate in different case is also rejected" 400 "$(http_code POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Dup","applicationType":"NORMAL","code":"test-live-001"}')"

for bad_code in '"AB"' '"HAS SPACE"' '"has/slash"' '"semi;colon"' '"quote'"'"'s"' '"-leading"' '"trailing-"' '"<script>"' '"has space"'; do
  CODE=$(http_code POST "$BASE/api/admin/candidates" "$HR" "{\"fullName\":\"Bad\",\"applicationType\":\"NORMAL\",\"code\":$bad_code}")
  expect_eq "invalid ID $bad_code rejected" 400 "$CODE"
done
INJ=$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Inject","applicationType":"NORMAL","code":"X'"'"'); DROP TABLE candidates;--"}')
expect_contains "an SQL-injection-shaped ID is rejected by validation" 'only letters' "$INJ"
expect_eq "the candidates table is intact after that attempt" 1 "$(dbq "SELECT CASE WHEN COUNT(*) >= 0 THEN 1 ELSE 0 END AS v FROM candidates")"

AUTO=$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Auto Code Candidate","applicationType":"NORMAL","iq":110,"education":"Bachelor Degree"}')
expect_contains "omitting the field still auto-generates a LALCO ID" "LALCO-" "$(jsonval "$AUTO" 'd.code')"
AUTO2=$(http_body POST "$BASE/api/admin/candidates" "$HR" '{"fullName":"Auto Two","applicationType":"NORMAL","code":""}')
expect_contains "an empty string also falls back to auto-generation" "LALCO-" "$(jsonval "$AUTO2" 'd.code')"
check "auto codes remain unique" "$([ "$(jsonval "$AUTO" 'd.code')" != "$(jsonval "$AUTO2" 'd.code')" ] && echo 0 || echo 1)"

c_head "4b. RBAC on the custom ID"
expect_eq "Interviewer cannot create a candidate at all" 403 "$(http_code POST "$BASE/api/admin/candidates" "$INTERVIEWER" '{"fullName":"X","applicationType":"NORMAL","code":"RBAC-001"}')"
expect_eq "Recruiter CAN (existing candidate-management RBAC)" 201 "$(http_code POST "$BASE/api/admin/candidates" "$RECRUITER" '{"fullName":"Recruiter Made","applicationType":"NORMAL","code":"RBAC-002"}')"
expect_eq "Interviewer cannot change a LALCO ID" 403 "$(http_code PATCH "$BASE/api/admin/candidates/$CC_ID" "$INTERVIEWER" '{"code":"NOPE-001"}')"

c_head "4c. CHANGING the LALCO ID"
expect_eq "it can be corrected before any assessment exists" 200 "$(http_code PATCH "$BASE/api/admin/candidates/$CC_ID" "$HR" '{"code":"TEST-LIVE-001-B"}')"
expect_eq "the new ID is stored" "TEST-LIVE-001-B" "$(dbq "SELECT code AS v FROM candidates WHERE id = '$CC_ID'")"
expect_eq "the change is audited separately" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'CANDIDATE_CODE_CHANGED'")"
expect_eq "changing it to an existing ID is rejected" 400 "$(http_code PATCH "$BASE/api/admin/candidates/$CC_ID" "$HR" '{"code":"TEST-LIVE-002"}')"
# Start an assessment, then the ID must lock.
CC_CODE=$(dbq "SELECT code AS v FROM candidates WHERE id = '$CC_ID'")
TOKEN_CC=$(new_link "$HR" "$CC_ID")
http_body POST "$BASE/api/exam/$TOKEN_CC/start" '' "{\"candidateCode\":\"$CC_CODE\"}" > /dev/null
LOCKED=$(http_body PATCH "$BASE/api/admin/candidates/$CC_ID" "$HR" '{"code":"TEST-LIVE-999"}')
expect_contains "once an assessment has started the ID is locked" 'cannot be changed' "$LOCKED"
expect_eq "and the stored ID is unchanged" "$CC_CODE" "$(dbq "SELECT code AS v FROM candidates WHERE id = '$CC_ID'")"
expect_eq "other fields can still be edited" 200 "$(http_code PATCH "$BASE/api/admin/candidates/$CC_ID" "$HR" '{"phone":"02011112222"}')"

c_head "4d. THE EXAM URL STILL USES THE SECURE RANDOM TOKEN"
LNK=$(http_body POST "$BASE/api/admin/candidates/$CC_ID/links" "$HR")
EXAM_URL=$(jsonval "$LNK" 'd.examUrl')
TOK_ONLY=$(jsonval "$LNK" 'd.token')
expect_eq "the token is 64 hex characters" 64 "${#TOK_ONLY}"
expect_eq "the token is pure hex (random, not derived)" 1 "$("$NODE" -e "console.log(/^[0-9a-f]{64}\$/.test(process.argv[1])?1:0)" "$TOK_ONLY")"
expect_not_contains "the exam URL does NOT contain the LALCO ID" "$CC_CODE" "$EXAM_URL"
expect_not_contains "the exam URL does NOT contain the internal database id" "$CC_ID" "$EXAM_URL"
TOK_A=$(new_link "$HR" "$CC_ID"); TOK_B=$(new_link "$HR" "$CC_ID")
check "two tokens for the same candidate are completely different" "$([ "$TOK_A" != "$TOK_B" ] && echo 0 || echo 1)"
expect_eq "a token cannot be guessed from the LALCO ID" 404 "$(http_code GET "$BASE/api/exam/TEST-LIVE-001-B")"
expect_eq "nor from the internal id" 404 "$(http_code GET "$BASE/api/exam/$CC_ID")"

c_head "4e. THE CUSTOM ID FLOWS THROUGH REPORTS AND EXPORTS"
CSV=$(curl -s -H "Authorization: Bearer $HR" "$BASE/api/admin/reports/candidate/$CC_ID.csv")
expect_contains "the candidate CSV carries the LALCO ID" "$CC_CODE" "$CSV"
BATCH=$(curl -s -H "Authorization: Bearer $HR" "$BASE/api/admin/reports/batch.csv")
expect_contains "the batch CSV carries it" "$CC_CODE" "$BATCH"
EXPORT=$(curl -s -H "Authorization: Bearer $SUPER" "$BASE/api/admin/settings/data-management/export-candidates.csv")
expect_contains "the Super Admin export carries it" "$CC_CODE" "$EXPORT"
SHEETS=$(cd "$BACKEND_DIR" && GOOGLE_SYNC_INCLUDE_DEMO=true "$NODE" -e "
  const s = require('./src/lib/googleSheets').buildAllSheets().find((x) => x.name === 'Candidates');
  console.log(JSON.stringify(s.rows.map((r) => r[0])));")
expect_contains "the Google Sheets Candidates sheet carries it" "$CC_CODE" "$SHEETS"
expect_contains "the candidate profile shows it" "$CC_CODE" "$(http_body GET "$BASE/api/admin/candidates/$CC_ID" "$HR")"

c_head "5. EXISTING DATA PRESERVED BY THE MIGRATION"
expect_eq "users table intact" 1 "$(dbq 'SELECT CASE WHEN COUNT(*) >= 6 THEN 1 ELSE 0 END AS v FROM users')"
expect_eq "token_version column added with a safe default" 1 "$(dbq 'SELECT CASE WHEN MIN(COALESCE(token_version,-1)) >= 0 THEN 1 ELSE 0 END AS v FROM users')"
expect_eq "questions intact" 1 "$(dbq 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM questions')"
expect_eq "candidates intact" 1 "$(dbq 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM candidates')"
expect_eq "sessions intact" 1 "$(dbq 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM assessment_sessions')"
expect_eq "links intact" 1 "$(dbq 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM assessment_links')"
expect_eq "audit log intact" 1 "$(dbq 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs')"

summary "PRODUCTION HARDENING (passwords, JWT rotation, custom LALCO ID)"
