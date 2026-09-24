#!/bin/bash
# Section 19 — three candidates, three separate links, three separate sessions.
# Each candidate is exercised through its own independent HTTP client with its
# own cookie jar, which is what "separate browser sessions" means to the server.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4113

HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
[ -n "$HR" ] || { c_red "could not log in"; server_log; exit 1; }

c_head "Create candidates A, B and C with separate links"
read -r A_ID A_CODE <<< "$(new_candidate "$HR" "Candidate A Multi")"
read -r B_ID B_CODE <<< "$(new_candidate "$HR" "Candidate B Multi")"
read -r C_ID C_CODE <<< "$(new_candidate "$HR" "Candidate C Multi")"
A_TOKEN=$(new_link "$HR" "$A_ID")
B_TOKEN=$(new_link "$HR" "$B_ID")
C_TOKEN=$(new_link "$HR" "$C_ID")
check "three distinct candidates created" "$([ "$A_ID" != "$B_ID" ] && [ "$B_ID" != "$C_ID" ] && [ "$A_ID" != "$C_ID" ] && echo 0 || echo 1)"
check "three distinct candidate codes issued" "$([ "$A_CODE" != "$B_CODE" ] && [ "$B_CODE" != "$C_CODE" ] && [ "$A_CODE" != "$C_CODE" ] && echo 0 || echo 1)" "$A_CODE / $B_CODE / $C_CODE"
check "three distinct exam tokens issued" "$([ "$A_TOKEN" != "$B_TOKEN" ] && [ "$B_TOKEN" != "$C_TOKEN" ] && [ "$A_TOKEN" != "$C_TOKEN" ] && echo 0 || echo 1)"

c_head "A only sees A, B only sees B, C only sees C"
A_INFO=$(http_body GET "$BASE/api/exam/$A_TOKEN")
B_INFO=$(http_body GET "$BASE/api/exam/$B_TOKEN")
C_INFO=$(http_body GET "$BASE/api/exam/$C_TOKEN")
expect_contains "A sees A's own name" "Candidate A Multi" "$A_INFO"
expect_not_contains "A does not see B" "Candidate B Multi" "$A_INFO"
expect_not_contains "A does not see C" "Candidate C Multi" "$A_INFO"
expect_contains "B sees B's own name" "Candidate B Multi" "$B_INFO"
expect_not_contains "B does not see A" "Candidate A Multi" "$B_INFO"
expect_contains "C sees C's own name" "Candidate C Multi" "$C_INFO"
expect_not_contains "C does not see A" "Candidate A Multi" "$C_INFO"

c_head "Identity verification is bound to the individual candidate"
complete_profile "$A_TOKEN"
expect_eq "B's code cannot start A's assessment" 401 "$(http_code POST "$BASE/api/exam/$A_TOKEN/start" '' "{\"candidateCode\":\"$B_CODE\"}")"
complete_profile "$B_TOKEN"
expect_eq "C's code cannot start B's assessment" 401 "$(http_code POST "$BASE/api/exam/$B_TOKEN/start" '' "{\"candidateCode\":\"$C_CODE\"}")"

c_head "All three complete their assessments independently"
# Interleaved on purpose: A starts, then B starts, then C, then all submit —
# a session must never be confused with another candidate's.
complete_profile "$A_TOKEN"
http_body POST "$BASE/api/exam/$A_TOKEN/start" '' "{\"candidateCode\":\"$A_CODE\"}" > /dev/null
complete_profile "$B_TOKEN"
http_body POST "$BASE/api/exam/$B_TOKEN/start" '' "{\"candidateCode\":\"$B_CODE\"}" > /dev/null
complete_profile "$C_TOKEN"
http_body POST "$BASE/api/exam/$C_TOKEN/start" '' "{\"candidateCode\":\"$C_CODE\"}" > /dev/null

A_SESSIONS=$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE candidate_id = '$A_ID'")
expect_eq "candidate A has exactly one session" 1 "$A_SESSIONS"

SUB_A=$(take_assessment "$A_TOKEN" "$A_CODE" correct "Answer written by candidate A.")
SUB_B=$(take_assessment "$B_TOKEN" "$B_CODE" partial "Answer written by candidate B.")
SUB_C=$(take_assessment "$C_TOKEN" "$C_CODE" wrong   "Answer written by candidate C.")
expect_contains "A submitted successfully" '"ok":true' "$SUB_A"
expect_contains "B submitted successfully" '"ok":true' "$SUB_B"
expect_contains "C submitted successfully" '"ok":true' "$SUB_C"

c_head "Results remain separate"
A_DETAIL=$(http_body GET "$BASE/api/admin/candidates/$A_ID" "$HR")
B_DETAIL=$(http_body GET "$BASE/api/admin/candidates/$B_ID" "$HR")
C_DETAIL=$(http_body GET "$BASE/api/admin/candidates/$C_ID" "$HR")
A_CALC=$(jsonval "$A_DETAIL" 'd.scores.calc_marks')
B_CALC=$(jsonval "$B_DETAIL" 'd.scores.calc_marks')
C_CALC=$(jsonval "$C_DETAIL" 'd.scores.calc_marks')
expect_eq "A scored full marks on the calculation section" 30 "$A_CALC"
check "B scored a partial mark, distinct from A and C (got $B_CALC)" "$([ "$B_CALC" != "$A_CALC" ] && [ "$B_CALC" != "$C_CALC" ] && echo 0 || echo 1)"
expect_eq "C scored zero on the calculation section" 0 "$C_CALC"

expect_contains "A's essay text is stored against A" "candidate A" "$A_DETAIL"
expect_not_contains "A's record contains no text written by B" "candidate B" "$A_DETAIL"
expect_not_contains "B's record contains no text written by C" "candidate C" "$B_DETAIL"
expect_contains "C's essay text is stored against C" "candidate C" "$C_DETAIL"

CROSS=$(dbq "SELECT COUNT(*) AS v FROM candidate_answers a JOIN assessment_sessions s ON s.id = a.session_id WHERE s.candidate_id NOT IN ('$A_ID','$B_ID','$C_ID') AND a.answer_json LIKE '%candidate A%'")
expect_eq "no answer written by A is attached to any other candidate" 0 "$CROSS"

ORPHANS=$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id NOT IN (SELECT id FROM assessment_sessions)")
expect_eq "no orphaned answers exist" 0 "$ORPHANS"

c_head "Each submission is independently locked"
expect_eq "A cannot resubmit" 409 "$(http_code POST "$BASE/api/exam/$A_TOKEN/submit")"
expect_eq "B cannot resubmit" 409 "$(http_code POST "$BASE/api/exam/$B_TOKEN/submit")"
expect_eq "C cannot resubmit" 409 "$(http_code POST "$BASE/api/exam/$C_TOKEN/submit")"

c_head "Marking one candidate does not change another"
http_body POST "$BASE/api/admin/candidates/$A_ID/essay-score" "$HR" \
  '{"rubricScores":{"content":6,"accuracy":6,"reasoning":6,"communication":6,"professionalism":6},"comments":"A only."}' > /dev/null
http_body POST "$BASE/api/admin/candidates/$A_ID/interview-score" "$HR" \
  '{"scores":{"communication":10,"responsiveness":10,"professionalism":10,"jobUnderstanding":10},"comments":"A only."}' > /dev/null
A_AFTER=$(http_body GET "$BASE/api/admin/candidates/$A_ID" "$HR")
B_AFTER=$(http_body GET "$BASE/api/admin/candidates/$B_ID" "$HR")
expect_eq "A now has a final score" 100 "$(jsonval "$A_AFTER" 'd.scores.final_marks')"
expect_eq "A is marked as passed" 1 "$(jsonval "$A_AFTER" 'd.scores.pass')"
expect_eq "B still has no essay mark" "" "$(jsonval "$B_AFTER" 'd.scores.essay_marks')"
expect_eq "B still has no final score" "" "$(jsonval "$B_AFTER" 'd.scores.final_marks')"

summary "MULTI-CANDIDATE TEST (section 19)"
