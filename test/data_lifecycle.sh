#!/bin/bash
# Section 21 — demo data lifecycle, then the full Super Admin deletion, proving
# that configuration, the question bank, admin accounts and the audit log all
# survive. Runs against a throwaway database.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4114

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
[ -n "$SUPER" ] || { c_red "could not log in as super admin"; server_log; exit 1; }
DM=/api/admin/settings/data-management

# Baseline the seeded sample data so the counts below are unambiguous.
http_body POST "$BASE$DM/demo/delete" "$SUPER" > /dev/null
expect_eq "baseline: no demo candidates remain from seeding" 0 "$(dbq 'SELECT COUNT(*) AS v FROM candidates WHERE is_demo = 1')"

QUESTIONS_BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM questions')
USERS_BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM users')
CRITERIA_BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM interview_criteria')
IVQ_BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM interview_questions')
POLICY_BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM scholarship_policies')
DEPT_BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM departments')
POS_BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM positions')
BRANCH_BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM branches')

c_head "Create 5 demo candidates"
CREATE=$(http_body POST "$BASE$DM/demo/create" "$SUPER" '{"count":5}')
expect_eq "API reports 5 demo candidates created" 5 "$(jsonval "$CREATE" 'd.count')"
expect_eq "5 demo candidates exist" 5 "$(dbq 'SELECT COUNT(*) AS v FROM candidates WHERE is_demo = 1')"
expect_eq "every demo candidate is flagged is_demo = 1" 0 "$(dbq "SELECT COUNT(*) AS v FROM candidates WHERE full_name LIKE '%Demo Candidate%' AND is_demo = 0")"
expect_eq "no real candidates were created alongside them" 0 "$(dbq 'SELECT COUNT(*) AS v FROM candidates WHERE is_demo = 0')"

c_head "Complete assessments for every demo candidate"
DEMO_IDS=$(cd "$BACKEND_DIR" && "$NODE" -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH, { readonly: true });
  console.log(db.prepare('SELECT id, code FROM candidates WHERE is_demo = 1 ORDER BY code').all().map((r) => r.id + ':' + r.code).join(' '));
")
COMPLETED=0
for pair in $DEMO_IDS; do
  cid="${pair%%:*}"; ccode="${pair#*:}"
  tok=$(new_link "$SUPER" "$cid")
  out=$(take_assessment "$tok" "$ccode" correct "Demo essay for $ccode.")
  case "$out" in *'"ok":true'*) COMPLETED=$((COMPLETED + 1)) ;; esac
done
expect_eq "all 5 demo assessments were submitted" 5 "$COMPLETED"
expect_eq "5 submitted sessions are stored" 5 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE status = 'SUBMITTED'")"
expect_eq "every demo assessment was marked 30/30 by the server" 5 "$(dbq 'SELECT COUNT(*) AS v FROM scores WHERE calc_marks = 30')"

STATS=$(http_body GET "$BASE$DM" "$SUPER")
expect_eq "Data Management reports 5 total candidates" 5 "$(jsonval "$STATS" 'd.stats.totalCandidates')"
expect_eq "Data Management reports 5 completed assessments" 5 "$(jsonval "$STATS" 'd.stats.completedAssessments')"
expect_eq "Data Management reports 5 demo candidates" 5 "$(jsonval "$STATS" 'd.stats.demoCandidates')"

c_head "Demo records are kept out of HR reporting"
REPORT_ROWS=$(cd "$BACKEND_DIR" && DATABASE_PATH="$DATABASE_PATH" "$NODE" -e "
  const { buildAllSheets } = require('./src/lib/googleSheets');
  const s = buildAllSheets();
  console.log(s.find((x) => x.name === 'Candidates').rows.length);
")
expect_eq "the Candidates report sheet excludes demo records" 0 "$REPORT_ROWS"

c_head "Back up the database while data exists"
BACKUP=$(http_body POST "$BASE$DM/backup" "$SUPER")
BACKUP_FILE=$(jsonval "$BACKUP" 'd.fileName')
expect_contains "backup reports its creation time" "$(date +%Y)" "$(jsonval "$BACKUP" 'd.createdAtDisplay')"
# Backups are written beside the live database, so a test backup lands in the
# throwaway directory and never in the project's own data folder.
BACKUP_PATH="$TEST_DIR/backups/$BACKUP_FILE"
check "the backup was written next to the database under test, not into the project"   "$([ -f "$BACKUP_PATH" ] && echo 0 || echo 1)" "expected $BACKUP_PATH"
check "the backup is a single self-contained file with no -wal sidecar"   "$([ ! -f "$BACKUP_PATH-wal" ] && echo 0 || echo 1)"
check "the backup has no -shm sidecar"   "$([ ! -f "$BACKUP_PATH-shm" ] && echo 0 || echo 1)"
BACKUP_CONTENTS=$(cd "$BACKEND_DIR" && "$NODE" -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.argv[1], { readonly: true });
  const t = (n) => db.prepare('SELECT COUNT(*) AS n FROM ' + n).get().n;
  console.log([t('candidates'), t('assessment_sessions'), t('candidate_answers'), t('scores'), t('audit_logs'), t('integrity_assessments'), t('assessment_links')].join(','));
" "$(native_path "$BACKUP_PATH")" 2>&1)
expect_eq "the backup contains candidates, sessions, answers and scores" "5,5,35,5" "$(printf '%s' "$BACKUP_CONTENTS" | cut -d, -f1-4)"
check "the backup contains audit records" "$([ "$(printf '%s' "$BACKUP_CONTENTS" | cut -d, -f5)" -gt 0 ] && echo 0 || echo 1)" "$BACKUP_CONTENTS"
expect_eq "the backup contains integrity events" 5 "$(printf '%s' "$BACKUP_CONTENTS" | cut -d, -f6)"
expect_eq "the backup contains assessment links" 5 "$(printf '%s' "$BACKUP_CONTENTS" | cut -d, -f7)"
LISTED=$(http_body GET "$BASE$DM/backups" "$SUPER")
expect_contains "the backup is listed for download" "$BACKUP_FILE" "$LISTED"
expect_eq "the backup can be downloaded by the Super Admin" 200 "$(http_code GET "$BASE$DM/backup/download?file=$BACKUP_FILE" "$SUPER")"
expect_eq "HR Admin cannot download a backup" 403 "$(http_code GET "$BASE$DM/backup/download?file=$BACKUP_FILE" "$HR")"

c_head "DELETE DEMO CANDIDATES"
DEL_DEMO=$(http_body POST "$BASE$DM/demo/delete" "$SUPER")
expect_eq "API reports 5 demo candidates removed" 5 "$(jsonval "$DEL_DEMO" 'd.candidates')"
expect_eq "0 demo candidates remain" 0 "$(dbq 'SELECT COUNT(*) AS v FROM candidates WHERE is_demo = 1')"
expect_eq "their assessment sessions are gone" 0 "$(dbq 'SELECT COUNT(*) AS v FROM assessment_sessions')"
expect_eq "their answers are gone" 0 "$(dbq 'SELECT COUNT(*) AS v FROM candidate_answers')"
expect_eq "their scores are gone" 0 "$(dbq 'SELECT COUNT(*) AS v FROM scores')"
expect_eq "question bank still exists" "$QUESTIONS_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM questions')"
expect_eq "admin users still exist" "$USERS_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM users')"
expect_eq "scoring rules (interview criteria) still exist" "$CRITERIA_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM interview_criteria')"

c_head "Codes are never reused after a deletion"
http_body POST "$BASE$DM/demo/create" "$SUPER" '{"count":2}' > /dev/null
NEW_CODE=$(dbq "SELECT code AS v FROM candidates WHERE is_demo = 1 ORDER BY code DESC LIMIT 1")
check "a re-created demo candidate gets a fresh code ($NEW_CODE, not DEMO-$(date +%Y)-00001)" \
  "$([ "$NEW_CODE" != "DEMO-$(date +%Y)-00001" ] && echo 0 || echo 1)"
http_body POST "$BASE$DM/demo/delete" "$SUPER" > /dev/null

c_head "Set up real candidate data, then DELETE ALL CANDIDATE DATA"
read -r R1_ID R1_CODE <<< "$(new_candidate "$HR" "Real Candidate One")"
read -r R2_ID R2_CODE <<< "$(new_candidate "$HR" "Real Candidate Two")"
take_assessment "$(new_link "$HR" "$R1_ID")" "$R1_CODE" correct "Real essay one." > /dev/null
take_assessment "$(new_link "$HR" "$R2_ID")" "$R2_CODE" partial "Real essay two." > /dev/null
http_body POST "$BASE/api/admin/candidates/$R1_ID/essay-score" "$HR" \
  '{"rubricScores":{"content":6,"accuracy":6,"reasoning":6,"communication":6,"professionalism":6},"comments":"ok"}' > /dev/null
http_body POST "$BASE/api/admin/candidates/$R1_ID/interview-score" "$HR" \
  '{"scores":{"communication":10,"responsiveness":10,"professionalism":10,"jobUnderstanding":10},"comments":"ok"}' > /dev/null

c_head "HR reporting workbook layout"
# The seven sheets are built from SQLite without contacting Google, so the
# column mapping can be verified even when no credentials are configured.
SHEETS=$(cd "$BACKEND_DIR" && GOOGLE_SYNC_INCLUDE_DEMO=true "$NODE" -e "
  const sheets = require('./src/lib/googleSheets').buildAllSheets();
  const problems = [];
  sheets.forEach((s) => {
    s.rows.forEach((r, i) => {
      if (r.length !== s.headers.length) problems.push(s.name + ' row ' + i + ' has ' + r.length + ' cells, header has ' + s.headers.length);
      r.forEach((c) => { if (typeof c !== 'string') problems.push(s.name + ' row ' + i + ' has a non-string cell'); });
    });
  });
  console.log(JSON.stringify({
    names: sheets.map((s) => s.name),
    rows: Object.fromEntries(sheets.map((s) => [s.name, s.rows.length])),
    problems,
    assessment: sheets.find((s) => s.name === 'Assessment Results'),
    question: sheets.find((s) => s.name === 'Question Results'),
    interview: sheets.find((s) => s.name === 'Interview Results'),
    integrity: sheets.find((s) => s.name === 'Integrity Events'),
    candidates: sheets.find((s) => s.name === 'Candidates'),
  }));
")
expect_eq "all seven workbook sheets are produced" "Candidates,Applications,Assessment Results,Question Results,Interview Results,Integrity Events,Audit Summary" "$(jsonval "$SHEETS" 'd.names.join(",")')"
expect_eq "every row matches its header width" "" "$(jsonval "$SHEETS" 'd.problems.join(" | ")')"
expect_eq "Candidates sheet ends with Assessment Status and Final Status" "Assessment Status,Final Status" "$(jsonval "$SHEETS" 'd.candidates.headers.slice(-2).join(",")')"
expect_eq "Assessment Results carries the pass threshold column" "Pass Threshold" "$(jsonval "$SHEETS" 'd.assessment.headers[9]')"
expect_eq "Assessment Results carries average question time" "Average Question Time" "$(jsonval "$SHEETS" 'd.assessment.headers[12]')"
expect_contains "Assessment Results records a PASS/FAIL verdict for the fully marked candidate" "PASS" "$(jsonval "$SHEETS" 'd.assessment.rows.map(r=>r[10]).join(",")')"
expect_eq "Question Results reports awarded marks, not the raw answer" "5" "$(jsonval "$SHEETS" 'd.question.rows.filter(r=>/Calculation/.test(r[4]))[0][6]')"
expect_contains "Question Results reports a percentage" "%" "$(jsonval "$SHEETS" 'd.question.rows[0][7]')"
expect_eq "Interview Results uses the live rubric criteria as columns" "Communication,Responsiveness,Professionalism,Job Understanding" "$(jsonval "$SHEETS" 'd.interview.headers.slice(4,8).join(",")')"
check "Interview Results carries real criterion scores, not zeros" "$([ "$(jsonval "$SHEETS" 'd.interview.rows[0][4]')" = "10" ] && echo 0 || echo 1)" "got $(jsonval "$SHEETS" 'd.interview.rows[0][4]')"
expect_eq "Integrity sheet separates focus from visibility changes" "Focus Changes,Visibility Changes" "$(jsonval "$SHEETS" 'd.integrity.headers.slice(4,6).join(",")')"
expect_eq "Integrity reviewer column is blank until a human records a conclusion" "" "$(jsonval "$SHEETS" 'd.integrity.rows[0][8]')"
SHEET_TEXT=$(printf '%s' "$SHEETS")
expect_not_contains "the workbook never asserts that a candidate used AI" "used AI" "$SHEET_TEXT"
expect_not_contains "the workbook never states an AI conclusion as fact" "Candidate used" "$SHEET_TEXT"

c_head "A human reviewer conclusion reaches the Integrity sheet"
REVIEW_SESSION=$(dbq "SELECT id AS v FROM assessment_sessions ORDER BY submitted_at DESC LIMIT 1")
http_body PUT "$BASE/api/admin/integrity/$REVIEW_SESSION/review" "$HR"   '{"conclusion":"POTENTIAL_AI_ASSISTANCE_INDICATOR","comment":"Reviewed the paste evidence manually."}' > /dev/null
REVIEWED=$(cd "$BACKEND_DIR" && GOOGLE_SYNC_INCLUDE_DEMO=true "$NODE" -e "
  const s = require('./src/lib/googleSheets').buildAllSheets().find((x) => x.name === 'Integrity Events');
  console.log(JSON.stringify(s.rows));
")
expect_contains "the reviewer's name is recorded" "HR Admin" "$REVIEWED"
expect_contains "the conclusion is labelled as an indicator, not a fact" "POTENTIAL_AI_ASSISTANCE_INDICATOR" "$REVIEWED"
expect_eq "an invalid conclusion value is rejected" 400 "$(http_code PUT "$BASE/api/admin/integrity/$REVIEW_SESSION/review" "$HR" '{"conclusion":"CANDIDATE_USED_AI"}')"

AUDIT_BEFORE=$(dbq 'SELECT COUNT(*) AS v FROM audit_logs')
expect_eq "2 real candidates exist before deletion" 2 "$(dbq 'SELECT COUNT(*) AS v FROM candidates')"

PREVIEW=$(http_body GET "$BASE$DM/delete-all-candidate-data/preview" "$SUPER")
expect_eq "the confirmation preview reports 2 candidates" 2 "$(jsonval "$PREVIEW" 'd.preview.candidates')"

DELETE=$(http_body POST "$BASE$DM/delete-all-candidate-data" "$SUPER" \
  "{\"confirmation\":\"DELETE ALL CANDIDATES\",\"password\":\"$DEMO_PASSWORD\"}")
expect_contains "deletion reports success" 'Candidate data successfully deleted.' "$DELETE"
expect_eq "response reports 2 candidates removed" 2 "$(jsonval "$DELETE" 'd.candidates')"
expect_eq "response reports 2 assessments removed" 2 "$(jsonval "$DELETE" 'd.assessments')"
check "response reports the number of answers removed ($(jsonval "$DELETE" 'd.answers'))" \
  "$([ "$(jsonval "$DELETE" 'd.answers')" -gt 0 ] && echo 0 || echo 1)"

c_head "All candidate-related records are removed"
for table in candidates assessment_sessions assessment_links candidate_answers answer_events scores integrity_assessments integrity_reviews link_access_log; do
  expect_eq "$table is empty" 0 "$(dbq "SELECT COUNT(*) AS v FROM $table")"
done

c_head "Nothing that must survive was touched"
expect_eq "question bank remains" "$QUESTIONS_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM questions')"
expect_eq "answer keys remain intact" 0 "$(dbq "SELECT COUNT(*) AS v FROM questions WHERE config_json IS NULL OR config_json = ''")"
expect_eq "admin accounts remain" "$USERS_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM users')"
expect_eq "every role still has its account" 6 "$(dbq 'SELECT COUNT(DISTINCT role) AS v FROM users')"
expect_eq "interview questions remain" "$IVQ_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM interview_questions')"
expect_eq "interview scoring rules remain" "$CRITERIA_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM interview_criteria')"
expect_eq "eligibility rules remain" 1 "$(dbq 'SELECT COUNT(*) AS v FROM eligibility_rules')"
expect_eq "system configuration remains" 1 "$(dbq 'SELECT COUNT(*) AS v FROM settings')"
expect_eq "departments remain" "$DEPT_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM departments')"
expect_eq "positions remain" "$POS_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM positions')"
expect_eq "branches remain" "$BRANCH_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM branches')"
expect_eq "scholarship policies remain" "$POLICY_BEFORE" "$(dbq 'SELECT COUNT(*) AS v FROM scholarship_policies')"

c_head "The audit log survives and records the deletion"
AUDIT_AFTER=$(dbq 'SELECT COUNT(*) AS v FROM audit_logs')
check "audit log was not deleted ($AUDIT_BEFORE before, $AUDIT_AFTER after)" \
  "$([ "$AUDIT_AFTER" -gt "$AUDIT_BEFORE" ] && echo 0 || echo 1)"
expect_eq "a DELETE_ALL_CANDIDATE_DATA record exists" 1 "$(dbq "SELECT COUNT(*) AS v FROM audit_logs WHERE action = 'DELETE_ALL_CANDIDATE_DATA'")"
AUDIT_ROW=$(dbq "SELECT new_value AS v FROM audit_logs WHERE action = 'DELETE_ALL_CANDIDATE_DATA' ORDER BY created_at DESC LIMIT 1")
expect_contains "the audit record names who performed it" 'performedBy' "$AUDIT_ROW"
expect_contains "the audit record carries a timestamp" 'timestamp' "$AUDIT_ROW"
expect_contains "the audit record states how many candidates were deleted" 'candidatesDeleted' "$AUDIT_ROW"
expect_contains "the audit record states how many assessments were deleted" 'assessmentsDeleted' "$AUDIT_ROW"
expect_contains "the audit record states how many answers were deleted" 'answersDeleted' "$AUDIT_ROW"
AUDIT_ROLE=$(dbq "SELECT role AS v FROM audit_logs WHERE action = 'DELETE_ALL_CANDIDATE_DATA' LIMIT 1")
expect_eq "the deletion is attributed to the Super Admin role" 'SUPER_ADMIN' "$AUDIT_ROLE"
expect_eq "earlier audit history is still present" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action = 'Candidate created'")"

c_head "The system still works after the wipe"
read -r POST_ID POST_CODE <<< "$(new_candidate "$HR" "Post Wipe Candidate")"
check "a new candidate can still be created ($POST_CODE)" "$([ -n "$POST_ID" ] && echo 0 || echo 1)"
POST_TOKEN=$(new_link "$HR" "$POST_ID")
POST_SUBMIT=$(take_assessment "$POST_TOKEN" "$POST_CODE" correct "Post-wipe essay.")
expect_contains "a new assessment can still be completed" '"ok":true' "$POST_SUBMIT"
expect_eq "the new assessment is marked correctly" 30 "$(dbq 'SELECT calc_marks AS v FROM scores LIMIT 1')"

summary "DATA LIFECYCLE TEST (section 21)"
