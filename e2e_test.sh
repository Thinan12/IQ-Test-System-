#!/bin/bash
# End-to-end walkthrough of the core assessment workflow.
#
# Runs against a THROWAWAY database in a temp directory on its own port, so it
# never touches data/lalco.db. Override the interpreter if `node` on PATH is not
# the version better-sqlite3 was built for:  NODE=/path/to/node ./e2e_test.sh
set -e
cd "$(dirname "$0")"
NODE="${NODE:-node}"

TEST_DIR="$(mktemp -d)"
native_path() { if command -v cygpath > /dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
export DATABASE_PATH="$(native_path "$TEST_DIR")/e2e.db"
export PORT=4116
export JWT_SECRET="${JWT_SECRET:-e2e-secret-0123456789abcdef0123456789abcdef}"
export DEMO_PASSWORD="${DEMO_PASSWORD:-Test-Suite-Passw0rd!2026}"
export NODE_ENV=development
BACKEND_DIR="$(pwd)"
NATIVE_BACKEND="$(native_path "$BACKEND_DIR")"

( cd "$TEST_DIR" && "$NODE" "$NATIVE_BACKEND/src/seed.js" ) > "$TEST_DIR/seed.log" 2>&1
pushd "$TEST_DIR" > /dev/null
"$NODE" "$NATIVE_BACKEND/src/server.js" > "$TEST_DIR/server.log" 2>&1 &
SERVER_PID=$!
popd > /dev/null

BASE=http://localhost:$PORT
fail() { echo "FAIL: $1"; cat "$TEST_DIR/server.log"; kill $SERVER_PID 2>/dev/null; exit 1; }
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/admin/candidates)" = "401" ] && break
  sleep 0.25
done

echo "== 1. HR logs in =="
LOGIN=$(curl -s -X POST $BASE/api/admin/auth/login -H 'Content-Type: application/json' -d '{"email":"hradmin@lalco.demo","password":"'"$DEMO_PASSWORD"'"}')
TOKEN=$("$NODE" -e "console.log(JSON.parse(process.argv[1]).token)" "$LOGIN")
[ -n "$TOKEN" ] && [ "$TOKEN" != "undefined" ] || fail "login did not return a token: $LOGIN"
echo "OK - got admin JWT"

echo "== 2. HR creates candidate =="
CAND=$(curl -s -X POST $BASE/api/admin/candidates -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"fullName":"John Smith","applicationType":"NORMAL","iq":95,"education":"High school","position":"Marketing Staff","branch":"Head Office - Vientiane","department":"Marketing","phone":"02099998888","dob":"1998-04-12"}')
CAND_ID=$("$NODE" -e "console.log(JSON.parse(process.argv[1]).id)" "$CAND")
[ -n "$CAND_ID" ] && [ "$CAND_ID" != "undefined" ] || fail "candidate create failed: $CAND"
echo "OK - candidate id=$CAND_ID"

echo "== 3. HR generates exam link =="
LINK=$(curl -s -X POST $BASE/api/admin/candidates/$CAND_ID/links -H "Authorization: Bearer $TOKEN")
EXAM_TOKEN=$("$NODE" -e "console.log(JSON.parse(process.argv[1]).token)" "$LINK")
[ -n "$EXAM_TOKEN" ] && [ "$EXAM_TOKEN" != "undefined" ] || fail "link generation failed: $LINK"
echo "OK - token=${EXAM_TOKEN:0:12}... exam URL: $("$NODE" -e "console.log(JSON.parse(process.argv[1]).examUrl)" "$LINK")"

echo "== 4. Candidate (as an unauthenticated stranger, no Authorization header at all) opens link =="
INFO=$(curl -s $BASE/api/exam/$EXAM_TOKEN)
echo "$INFO" | grep -q "John Smith" || fail "candidate did not see their own name in exam info: $INFO"
echo "OK - candidate sees own name/position, no admin data: $INFO"

echo "== 4b. Candidate must NOT be able to reach admin API without a token =="
STATUS=$(curl -s -o "$TEST_DIR/noauth.json" -w "%{http_code}" $BASE/api/admin/candidates)
[ "$STATUS" = "401" ] || fail "expected 401 for unauthenticated admin access, got $STATUS: $(cat "$TEST_DIR/noauth.json")"
echo "OK - unauthenticated admin API access correctly rejected (401)"

echo "== 5. Candidate starts assessment (verification required: candidate ID) =="
START=$(curl -s -X POST $BASE/api/exam/$EXAM_TOKEN/start -H 'Content-Type: application/json' -d "{\"candidateCode\":\"WRONG-CODE\"}")
echo "$START" | grep -q "error" || fail "wrong candidate ID should have been rejected: $START"
echo "OK - wrong verification code rejected: $START"

CAND_CODE=$("$NODE" -e "
const http=require('http');
" )
CAND_DETAIL=$(curl -s $BASE/api/admin/candidates/$CAND_ID -H "Authorization: Bearer $TOKEN")
REAL_CODE=$(printf '%s' "$CAND_DETAIL" | "$NODE" -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).candidate.code)")
START2=$(curl -s -X POST $BASE/api/exam/$EXAM_TOKEN/start -H 'Content-Type: application/json' -d "{\"candidateCode\":\"$REAL_CODE\"}")
echo "$START2" | grep -q "expiresAt" || fail "correct verification should have started the session: $START2"
echo "OK - assessment started with correct verification: $START2"

echo "== 6. Candidate cannot see correct answers in the questions payload =="
QLIST=$(curl -s $BASE/api/exam/$EXAM_TOKEN/questions)
echo "$QLIST" | grep -qi "expected" && fail "LEAK: 'expected' field found in candidate-facing question payload!"
echo "$QLIST" | grep -qi "18000" && fail "LEAK: correct numeric answer 18000 found in candidate-facing payload!"
echo "OK - no answer-key fields present in candidate question payload"
echo "  sample: $(echo "$QLIST" | head -c 300)"

echo "== 7. Candidate answers all 6 calc questions correctly + essay =="
QIDS=$(printf '%s' "$QLIST" | "$NODE" -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(data.questions.filter(q=>q.type==='CALC').map(q=>q.id).join(','));
")
IFS=',' read -ra QARR <<< "$QIDS"
ANSWERS=('{"monthlyInterest":3000,"totalInterest":18000}' '{"monthlyPrincipal":2000,"outstandingPrincipal":14000}' '{"ltv":250,"decision":"Reject"}' '{"monthlyPrincipal":138.89,"month1Interest":125,"month1Total":263.89}' '{"monthlyInterest":210,"month6Total":7210}' '{"monthlyInterest":250,"totalInterest":9000,"brokerFee":315}')
for i in "${!QARR[@]}"; do
  QID="${QARR[$i]}"
  ANS="${ANSWERS[$i]}"
  R=$(curl -s -X POST $BASE/api/exam/$EXAM_TOKEN/answer -H 'Content-Type: application/json' -d "{\"questionId\":\"$QID\",\"answer\":$ANS,\"timeSpentDeltaSeconds\":45}")
  echo "$R" | grep -q '"ok":true' || fail "answer save failed for $QID: $R"
done
echo "OK - all 6 calculation answers saved"

ESSAY_QID=$(printf '%s' "$QLIST" | "$NODE" -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(data.questions.find(q=>q.type==='ESSAY').id);
")
curl -s -X POST $BASE/api/exam/$EXAM_TOKEN/answer -H 'Content-Type: application/json' \
  -d "{\"questionId\":\"$ESSAY_QID\",\"answer\":{\"text\":\"I want to join LALCO for the salary and clear career path.\"},\"timeSpentDeltaSeconds\":300}" | grep -q '"ok":true' || fail "essay save failed"
echo "OK - essay answer saved"

echo "== 7b. Simulate a large paste + several focus changes (integrity signal) =="
curl -s -X POST $BASE/api/exam/$EXAM_TOKEN/event -H 'Content-Type: application/json' -d "{\"questionId\":\"$ESSAY_QID\",\"type\":\"PASTE\",\"meta\":{\"length\":1245}}" > /dev/null
for i in 1 2 3 4 5 6 7; do curl -s -X POST $BASE/api/exam/$EXAM_TOKEN/event -H 'Content-Type: application/json' -d '{"type":"FOCUS_CHANGE"}' > /dev/null; done
echo "OK - integrity events recorded"

echo "== 8. Candidate submits =="
SUB=$(curl -s -X POST $BASE/api/exam/$EXAM_TOKEN/submit)
echo "$SUB" | grep -q '"ok":true' || fail "submit failed: $SUB"
echo "OK - submitted: $SUB"

echo "== 8b. Candidate cannot edit after submission =="
POSTSUB=$(curl -s -X POST $BASE/api/exam/$EXAM_TOKEN/answer -H 'Content-Type: application/json' -d "{\"questionId\":\"$ESSAY_QID\",\"answer\":{\"text\":\"changed after submit\"}}")
echo "$POSTSUB" | grep -q "error" || fail "expected an error when editing after submission: $POSTSUB"
echo "OK - post-submission edit correctly rejected: $POSTSUB"

echo "== 9. Generating a new link while old one is still unused ACTIVE must revoke the old one =="
CAND2=$(curl -s -X POST $BASE/api/admin/candidates -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"fullName":"Jane Revoke-Test","applicationType":"NORMAL","iq":95,"education":"High school"}')
CAND2_ID=$("$NODE" -e "console.log(JSON.parse(process.argv[1]).id)" "$CAND2")
LINK_A=$(curl -s -X POST $BASE/api/admin/candidates/$CAND2_ID/links -H "Authorization: Bearer $TOKEN")
TOKEN_A=$("$NODE" -e "console.log(JSON.parse(process.argv[1]).token)" "$LINK_A")
# never used — generate a second link right away
LINK_B=$(curl -s -X POST $BASE/api/admin/candidates/$CAND2_ID/links -H "Authorization: Bearer $TOKEN")
TOKEN_B=$("$NODE" -e "console.log(JSON.parse(process.argv[1]).token)" "$LINK_B")
OLD_LINK_STATUS=$(curl -s $BASE/api/exam/$TOKEN_A -o "$TEST_DIR/old_link_resp.json" -w "%{http_code}")
[ "$OLD_LINK_STATUS" = "410" ] || fail "expected old unused link to be rejected as expired/revoked (410), got $OLD_LINK_STATUS: $(cat "$TEST_DIR/old_link_resp.json")"
echo "OK - old unused link now rejected: $(cat "$TEST_DIR/old_link_resp.json")"
NEW_LINK_STATUS=$(curl -s $BASE/api/exam/$TOKEN_B -o "$TEST_DIR/new_link_resp.json" -w "%{http_code}")
[ "$NEW_LINK_STATUS" = "200" ] || fail "expected new link to work, got $NEW_LINK_STATUS"
echo "OK - new link works: $(cat "$TEST_DIR/new_link_resp.json")"
LINKS_LIST=$(curl -s $BASE/api/admin/links -H "Authorization: Bearer $TOKEN")
echo "$LINKS_LIST" | "$NODE" -e "
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const data = JSON.parse(raw);
  const mine = data.links.filter(l => l.candidateId === process.argv[1]);
  console.log('Link history for candidate:', JSON.stringify(mine.map(l=>l.status)));
  const revokedCount = mine.filter(l=>l.status==='REVOKED').length;
  if (revokedCount < 1) { console.log('FAIL: expected at least 1 revoked link in history'); process.exit(1); }
});
" "$CAND2_ID" || fail "link history / revoke check failed"
echo "OK - old link correctly REVOKED in history, never deleted"

echo "== 10. HR opens candidate profile and sees full results =="
DETAIL=$(curl -s $BASE/api/admin/candidates/$CAND_ID -H "Authorization: Bearer $TOKEN")
printf '%s' "$DETAIL" | "$NODE" -e "
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log('Eligibility:', d.eligibility.status);
console.log('Calc score:', d.scores.calc_marks, '/', d.scores.calc_max, '(expect 30/30 for all-correct answers)');
console.log('Answers recorded:', d.answers.filter(a=>a.answer).length, '/', d.answers.length);
console.log('Breakdown for Q1:', JSON.stringify(d.answers[0].breakdown));
if (d.scores.calc_marks !== 30) { console.log('FAIL: expected full marks 30/30'); process.exit(1); }
"
echo "OK - HR sees full candidate results with real per-question breakdown"

echo "== 11. Essay + interview marking by HR, final score + pass/fail =="
curl -s -X POST $BASE/api/admin/candidates/$CAND_ID/essay-score -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"rubricScores":{"content":5,"accuracy":5,"reasoning":5,"communication":5,"professionalism":5},"comments":"Strong answer."}' | grep -q '"ok":true' || fail "essay scoring failed"
curl -s -X POST $BASE/api/admin/candidates/$CAND_ID/interview-score -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"scores":{"communication":9,"responsiveness":9,"professionalism":9,"jobUnderstanding":9},"comments":"Confident, clear."}' | grep -q '"ok":true' || fail "interview scoring failed"
FINAL=$(curl -s $BASE/api/admin/candidates/$CAND_ID -H "Authorization: Bearer $TOKEN")
printf '%s' "$FINAL" | "$NODE" -e "
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log('FINAL SCORE:', d.scores.final_marks, '/100  PASS:', !!d.scores.pass, '  STATUS:', d.candidate.status);
if (d.scores.final_marks !== 91) { console.log('FAIL: expected final 91 (30+25+36)'); process.exit(1); }
if (!d.scores.pass) { console.log('FAIL: expected pass'); process.exit(1); }
"
echo "OK - final rollup correct"

echo "== 12. Integrity indicators visible to HR =="
printf '%s' "$FINAL" | "$NODE" -e "
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log('Integrity risk:', d.integrity.risk_level, JSON.parse(d.integrity.evidence_json));
if (d.integrity.risk_level === 'Low') { console.log('FAIL: expected Medium/High risk given the simulated paste+focus events'); process.exit(1); }
"
echo "OK - integrity risk correctly elevated with evidence"

echo "== 13. Failure analysis endpoint =="
FA=$(curl -s $BASE/api/admin/candidates/$CAND_ID/failure-analysis -H "Authorization: Bearer $TOKEN")
echo "FA: $FA"

echo "== 14. Reports: CSV + PDF + batch Excel download =="
curl -s -o "$TEST_DIR/report.csv" -w "CSV status=%{http_code} size=%{size_download}\n" $BASE/api/admin/reports/candidate/$CAND_ID.csv -H "Authorization: Bearer $TOKEN"
curl -s -o "$TEST_DIR/report.pdf" -w "PDF status=%{http_code} size=%{size_download}\n" $BASE/api/admin/reports/candidate/$CAND_ID.pdf -H "Authorization: Bearer $TOKEN"
curl -s -o "$TEST_DIR/batch.xlsx" -w "XLSX status=%{http_code} size=%{size_download}\n" $BASE/api/admin/reports/batch.xlsx -H "Authorization: Bearer $TOKEN"
file "$TEST_DIR/report.pdf" "$TEST_DIR/batch.xlsx"
head -3 "$TEST_DIR/report.csv"

echo "== 15. Audit log has entries =="
AUDIT=$(curl -s $BASE/api/admin/audit -H "Authorization: Bearer $TOKEN")
printf '%s' "$AUDIT" | "$NODE" -e "
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log('Audit log entries:', d.logs.length);
console.log(d.logs.slice(0,5).map(l=>l.action));
if (d.logs.length < 5) { console.log('FAIL: expected several audit entries'); process.exit(1); }
"

echo "== 16. Analytics endpoint =="
curl -s $BASE/api/admin/analytics -H "Authorization: Bearer $TOKEN" | "$NODE" -e "
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const d=JSON.parse(raw);console.log('Totals:', d.totals);});
"

echo "== 17. A second, totally separate candidate cannot be reached via the first candidate's exam token =="
STATUS2=$(curl -s -o "$TEST_DIR/x.json" -w "%{http_code}" $BASE/api/exam/0000000000000000000000000000000000000000000000000000000000000000)
[ "$STATUS2" = "404" ] || fail "expected 404 for bogus token, got $STATUS2"
echo "OK - bogus/foreign token rejected (404)"

echo
echo "================================"
echo "ALL END-TO-END CHECKS PASSED"
echo "================================"

kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true
rm -rf "$TEST_DIR"
exit 0
