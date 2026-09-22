#!/bin/bash
# Sections 13-16 — Google Sheets as an HR reporting destination.
#
# The point of this suite is the failure path: SQLite is the source of truth, so
# an unreachable or unconfigured Google must never affect a candidate's exam.
# It deliberately uses credentials that cannot work, which is the realistic
# failure mode (expired key, revoked service account, no network).
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4118

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
[ -n "$SUPER" ] || { c_red "could not log in"; server_log; exit 1; }
DM=/api/admin/settings/data-management

c_head "Unconfigured: the app works and says so plainly"
STATUS=$(http_body GET "$BASE$DM" "$SUPER")
expect_eq "Data Management reports Google Sheets as not configured" "false" "$(jsonval "$STATUS" 'String(d.googleSyncConfigured)')"
expect_eq "auto-sync on submit is off by default" "false" "$(jsonval "$STATUS" 'String(d.googleAutoSyncOnSubmit)')"
SYNC=$(http_body POST "$BASE$DM/google-sync" "$SUPER")
expect_contains "a sync attempt explains what is missing" 'not configured' "$SYNC"
expect_contains "it names the variables an administrator must set" 'GOOGLE_SHEET_ID' "$SYNC"
expect_eq "it responds 503, not a crash" 503 "$(http_code POST "$BASE$DM/google-sync" "$SUPER")"
expect_eq "the report export route agrees it is unconfigured" "false" "$(jsonval "$(http_body GET "$BASE/api/admin/reports/google-sheets/status" "$HR")" 'String(d.configured)')"

c_head "Unconfigured: an assessment still completes and is stored in SQLite"
read -r U_ID U_CODE <<< "$(new_candidate "$HR" "No Sheets Candidate")"
U_SUBMIT=$(take_assessment "$(new_link "$HR" "$U_ID")" "$U_CODE" correct "Essay with no Sheets configured.")
expect_contains "the candidate submits successfully" '"ok":true' "$U_SUBMIT"
expect_not_contains "the candidate is never shown a storage or sync problem" 'Google' "$U_SUBMIT"
expect_not_contains "the candidate is never shown a database problem" 'database' "$U_SUBMIT"
expect_eq "the result is stored and marked server-side" 30 "$(dbq "SELECT calc_marks AS v FROM scores ORDER BY computed_at DESC LIMIT 1")"
expect_eq "no sync was requested, so nothing is left pending" "NOT_REQUESTED" "$(dbq "SELECT google_sync_status AS v FROM assessment_sessions ORDER BY submitted_at DESC LIMIT 1")"

c_head "Configured but unreachable: the exam is still unaffected"
# Credentials that are well-formed enough to load but cannot authenticate.
FAKE_KEY='-----BEGIN PRIVATE KEY-----\nTk9UQVJFQUxLRVk=\n-----END PRIVATE KEY-----\n'
restart_server_with 4119 \
  GOOGLE_SHEET_ID=not-a-real-spreadsheet-id \
  GOOGLE_SERVICE_ACCOUNT_EMAIL=nobody@example.invalid \
  GOOGLE_PRIVATE_KEY="$FAKE_KEY" \
  GOOGLE_SYNC_ON_SUBMIT=true

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
STATUS=$(http_body GET "$BASE$DM" "$SUPER")
expect_eq "Google Sheets now reports as configured" "true" "$(jsonval "$STATUS" 'String(d.googleSyncConfigured)')"
expect_eq "auto-sync on submit is on" "true" "$(jsonval "$STATUS" 'String(d.googleAutoSyncOnSubmit)')"
expect_not_contains "the credentials themselves are still not sent to the browser" 'not-a-real-spreadsheet-id' "$STATUS"
expect_not_contains "the service account is not sent to the browser" 'example.invalid' "$STATUS"
expect_not_contains "the private key is not sent to the browser" 'PRIVATE KEY' "$STATUS"

read -r F_ID F_CODE <<< "$(new_candidate "$HR" "Broken Sheets Candidate")"
START_MS=$(date +%s%N)
F_SUBMIT=$(take_assessment "$(new_link "$HR" "$F_ID")" "$F_CODE" correct "Essay while Google is down.")
END_MS=$(date +%s%N)
ELAPSED_MS=$(( (END_MS - START_MS) / 1000000 ))
expect_contains "the exam is NOT failed by Google being down" '"ok":true' "$F_SUBMIT"
expect_not_contains "the candidate is told nothing about Google" 'Google' "$F_SUBMIT"
expect_not_contains "the candidate is told nothing about a database problem" 'database' "$F_SUBMIT"
check "the whole assessment was not blocked waiting on Google (${ELAPSED_MS}ms for 8 requests)" \
  "$([ "$ELAPSED_MS" -lt 20000 ] && echo 0 || echo 1)"
F_SESSION=$(dbq "SELECT id AS v FROM assessment_sessions ORDER BY submitted_at DESC LIMIT 1")
expect_eq "the result is safely stored in SQLite" 30 "$(dbq "SELECT calc_marks AS v FROM scores WHERE session_id = '$F_SESSION'")"

c_head "The failed sync is recorded as pending, not lost"
# The background sync runs after the response; give it a moment to report back.
for _ in $(seq 1 40); do
  SYNC_STATE=$(dbq "SELECT google_sync_status AS v FROM assessment_sessions WHERE id = '$F_SESSION'")
  [ "$SYNC_STATE" = "PENDING" ] && break
  sleep 0.5
done
expect_eq "the session is left at google_sync_status = PENDING" "PENDING" "$SYNC_STATE"
PENDING=$(http_body GET "$BASE$DM/google-sync/pending" "$SUPER")
expect_contains "the pending assessment is listed for the administrator" "$F_CODE" "$PENDING"
expect_eq "Data Management surfaces the pending count" 1 "$(jsonval "$(http_body GET "$BASE$DM" "$SUPER")" 'd.googleSyncPending')"

c_head "RETRY GOOGLE SHEETS SYNC reports the failure honestly"
RETRY=$(http_body POST "$BASE$DM/google-sync/retry" "$SUPER")
expect_eq "retry responds 503 while Google is still unreachable" 503 "$(http_code POST "$BASE$DM/google-sync/retry" "$SUPER")"
expect_contains "the failure is reported, not swallowed" 'errors' "$RETRY"
expect_eq "at least one error is counted" 1 "$(jsonval "$RETRY" 'd.errors')"
expect_eq "the assessment stays pending so it can be retried again" "PENDING" "$(dbq "SELECT google_sync_status AS v FROM assessment_sessions WHERE id = '$F_SESSION'")"
expect_eq "candidate data is untouched by the failed sync" 30 "$(dbq "SELECT calc_marks AS v FROM scores WHERE session_id = '$F_SESSION'")"
expect_eq "the failed sync is written to the audit log" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action LIKE 'GOOGLE_SHEETS_SYNC%FAILED'")"

c_head "Role restrictions on the sync endpoints"
expect_eq "HR Admin cannot run the Data Management sync" 403 "$(http_code POST "$BASE$DM/google-sync" "$HR")"
expect_eq "HR Admin cannot retry the pending sync" 403 "$(http_code POST "$BASE$DM/google-sync/retry" "$HR")"
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
expect_eq "Recruiter cannot export to Google Sheets from Reports" 403 "$(http_code POST "$BASE/api/admin/reports/google-sheets" "$RECRUITER")"
expect_eq "HR Admin CAN export to Google Sheets from Reports (503 = tried and failed, not refused)" 503 "$(http_code POST "$BASE/api/admin/reports/google-sheets" "$HR")"

c_head "The workbook the sync would have written is still correct"
WORKBOOK=$(cd "$BACKEND_DIR" && "$NODE" -e "
  const sheets = require('./src/lib/googleSheets').buildAllSheets();
  console.log(JSON.stringify({ names: sheets.map((s) => s.name), rows: sheets.map((s) => s.rows.length) }));
")
expect_contains "the Candidates sheet is still built from SQLite" 'Candidates' "$WORKBOOK"
expect_contains "the Integrity sheet is still built from SQLite" 'Integrity Events' "$WORKBOOK"
check "it contains the candidates whose sync failed" "$([ "$(jsonval "$WORKBOOK" 'd.rows[0]')" -ge 2 ] && echo 0 || echo 1)" "rows: $(jsonval "$WORKBOOK" 'd.rows[0]')"

summary "GOOGLE SHEETS SYNC (sections 13-16)"
