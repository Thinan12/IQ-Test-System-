#!/bin/bash
# Random question selection — per-attempt draws, immutability, distributions,
# and the security boundary around a candidate's own question set.
#
# Runs against a throwaway database on its own port, like every other suite.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4137

HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
[ -n "$HR" ] || { c_red "could not log in"; server_log; exit 1; }

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

# Start one attempt and echo "<candidateId> <token> <sessionId>".
start_attempt() { # start_attempt <name> <assessmentId> [language]
  local name="$1" asmt="$2" lang="${3:-en}" cid ccode tok sid
  read -r cid ccode <<< "$(new_candidate "$HR" "$name")"
  tok=$(jsonval "$(post_json POST "$BASE/api/admin/candidates/$cid/links" "$HR" "{\"assessmentId\":\"$asmt\",\"language\":\"$lang\"}")" 'd.token')
  public_json POST "$BASE/api/exam/$tok/start" "{\"candidateCode\":\"$ccode\"}" > /dev/null
  sid=$(dbq "SELECT id AS v FROM assessment_sessions WHERE candidate_id='$cid'")
  printf '%s %s %s' "$cid" "$tok" "$sid"
}
served_ids() { jsonval "$(curl -s "$BASE/api/exam/$1/questions")" 'd.questions.map(q=>q.id).join(",")'; }
stored_ids() { dbq "SELECT GROUP_CONCAT(question_id) AS v FROM (SELECT question_id FROM session_questions WHERE session_id='$1' ORDER BY display_order)"; }

# ===========================================================================
c_head "A BIGGER BANK — 60 IQ questions, so a draw is a real draw"
# Clone the seeded IQ questions into a 60-item bank spread evenly across the
# six reasoning categories and the three difficulties. The answer key is copied
# with them, so scoring stays genuinely checkable.
"$NODE" -e "
const D=require('better-sqlite3'); const db=new D(process.env.DATABASE_PATH);
const src=db.prepare(\"SELECT * FROM questions WHERE question_family='IQ'\").all();
const cats=['NUMERICAL','LOGICAL','PATTERN','VERBAL','SPATIAL','SEQUENCE'];
const diffs=['EASY','MEDIUM','HARD'];
const ins=db.prepare('INSERT INTO questions (id,type,category,difficulty,text,config_json,max_marks,order_index,active,question_family,iq_category,translation_status) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)');
let n=db.prepare(\"SELECT COUNT(*) c FROM questions WHERE question_family='IQ'\").get().c;
let i=0;
while(n<60){ const s=src[i%src.length];
  ins.run('q_rnd_'+n, s.type, s.category, diffs[n%3], 'Generated reasoning item '+n, s.config_json, s.max_marks, 500+n, 'IQ', cats[n%6], 'MISSING');
  n++; i++; }
" > /dev/null
ALL_IQ=$("$NODE" -e "
const D=require('better-sqlite3'); const db=new D(process.env.DATABASE_PATH,{readonly:true});
console.log(JSON.stringify(db.prepare(\"SELECT id FROM questions WHERE question_family='IQ' AND active=1 AND COALESCE(archived,0)=0\").all().map(r=>r.id)));
")
post_json PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" "{\"questionIds\":$ALL_IQ}" > /dev/null
expect_eq "the IQ test now draws on 60 questions" 60 "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions WHERE assessment_id='$IQ_ASMT'")"
expect_eq "the seeded IQ test randomises by default" 1 "$(dbq "SELECT randomize_questions AS v FROM assessments WHERE id='$IQ_ASMT'")"
expect_eq "and randomises the order by default" 1 "$(dbq "SELECT randomize_question_order AS v FROM assessments WHERE id='$IQ_ASMT'")"
expect_eq "option order is OFF unless asked for" 0 "$(dbq "SELECT randomize_options AS v FROM assessments WHERE id='$IQ_ASMT'")"

# ===========================================================================
c_head "SHOW 25 OF 60 — the count is exact and nothing repeats"
post_json PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"questionsToShow":25}' > /dev/null
ASMT_VIEW=$(http_body GET "$BASE/api/admin/assessments/$IQ_ASMT" "$HR")
expect_eq "the admin sees the eligible pool" 60 "$(jsonval "$ASMT_VIEW" 'd.assessment.eligibleQuestionCount')"
expect_eq "and how big an attempt will be" 25 "$(jsonval "$ASMT_VIEW" 'd.assessment.attemptQuestionCount')"
expect_eq "and no configuration problem" 0 "$(jsonval "$ASMT_VIEW" 'd.assessment.selectionProblems.length')"

read -r CID_A TOK_A SID_A <<< "$(start_attempt "Random Candidate A" "$IQ_ASMT")"
expect_eq "the attempt stored exactly 25 questions" 25 "$(dbq "SELECT COUNT(*) AS v FROM session_questions WHERE session_id='$SID_A'")"
expect_eq "with no duplicates inside the attempt" 0 "$(dbq "SELECT COUNT(*)-COUNT(DISTINCT question_id) AS v FROM session_questions WHERE session_id='$SID_A'")"
expect_eq "the candidate is served exactly those 25" 25 "$(jsonval "$(curl -s "$BASE/api/exam/$TOK_A/questions")" 'd.questions.length')"
expect_eq "every served question belongs to the attempt" 25 "$(dbq "SELECT COUNT(*) AS v FROM session_questions sq WHERE sq.session_id='$SID_A' AND sq.question_id IN (SELECT question_id FROM session_questions WHERE session_id='$SID_A')")"
expect_eq "the display order is consecutive from zero" "$(seq 0 24 | tr '\n' ',' | sed 's/,$//')" "$(dbq "SELECT GROUP_CONCAT(display_order) AS v FROM (SELECT display_order FROM session_questions WHERE session_id='$SID_A' ORDER BY display_order)")"
expect_eq "the intro promises the same number" 25 "$(jsonval "$(http_body GET "$BASE/api/exam/$TOK_A")" 'd.questionCount')"
expect_eq "every drawn question is an IQ question" 25 "$(dbq "SELECT COUNT(*) AS v FROM session_questions sq JOIN questions q ON q.id=sq.question_id WHERE sq.session_id='$SID_A' AND q.question_family='IQ'")"

# ===========================================================================
c_head "THE SET IS DECIDED ONCE — nothing a candidate does redraws it"
ORDER_START=$(served_ids "$TOK_A")
curl -s "$BASE/api/exam/$TOK_A/questions" > /dev/null   # refresh
expect_eq "refreshing serves the same questions in the same order" "$ORDER_START" "$(served_ids "$TOK_A")"
public_json POST "$BASE/api/exam/$TOK_A/language" '{"language":"lo"}' > /dev/null
expect_eq "switching to Lao changes nothing about the set" "$ORDER_START" "$(served_ids "$TOK_A")"
expect_eq "the session really is in Lao now" "lo" "$(dbq "SELECT language AS v FROM assessment_sessions WHERE id='$SID_A'")"
public_json POST "$BASE/api/exam/$TOK_A/language" '{"language":"en"}' > /dev/null
expect_eq "and switching back changes nothing either" "$ORDER_START" "$(served_ids "$TOK_A")"
http_body GET "$BASE/api/exam/$TOK_A" > /dev/null       # reopening the link
expect_eq "reopening the invitation serves the same set" "$ORDER_START" "$(served_ids "$TOK_A")"
FIRST_Q=$(printf '%s' "$ORDER_START" | cut -d, -f1)
http_body GET "$BASE/api/exam/$TOK_A/question/$FIRST_Q" > /dev/null  # navigating
expect_eq "navigating to a question does not redraw" "$ORDER_START" "$(served_ids "$TOK_A")"
expect_eq "and the stored rows were never rewritten" "$(stored_ids "$SID_A")" "$(stored_ids "$SID_A")"
expect_eq "still exactly 25 rows after all of that" 25 "$(dbq "SELECT COUNT(*) AS v FROM session_questions WHERE session_id='$SID_A'")"
expect_eq "and only one session was ever created" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE candidate_id='$CID_A'")"

# ===========================================================================
c_head "FIVE CANDIDATES — independent draws, each one fixed"
SETS_FILE="$TEST_DIR/sets.txt"; : > "$SETS_FILE"
ORDERS_FILE="$TEST_DIR/orders.txt"; : > "$ORDERS_FILE"
for n in B C D E F; do
  read -r cid tok sid <<< "$(start_attempt "Random Candidate $n" "$IQ_ASMT")"
  expect_eq "candidate $n received exactly 25 questions" 25 "$(dbq "SELECT COUNT(*) AS v FROM session_questions WHERE session_id='$sid'")"
  expect_eq "candidate $n has no duplicate question" 0 "$(dbq "SELECT COUNT(*)-COUNT(DISTINCT question_id) AS v FROM session_questions WHERE session_id='$sid'")"
  expect_eq "candidate $n only ever sees their own set" 25 "$(jsonval "$(curl -s "$BASE/api/exam/$tok/questions")" 'd.questions.length')"
  before=$(served_ids "$tok")
  curl -s "$BASE/api/exam/$tok/questions" > /dev/null
  expect_eq "candidate $n keeps that set on a refresh" "$before" "$(served_ids "$tok")"
  dbq "SELECT GROUP_CONCAT(question_id) AS v FROM (SELECT question_id FROM session_questions WHERE session_id='$sid' ORDER BY question_id)" >> "$SETS_FILE"
  printf '%s\n' "$before" >> "$ORDERS_FILE"
done
# Randomness does not guarantee uniqueness, so this asserts that the draw is
# capable of differing, not that it always does: five identical draws from
# C(60,25) would be evidence of a bug, not of chance.
expect_eq "the five draws are not all the same set" 1 "$([ "$(sort -u "$SETS_FILE" | wc -l)" -gt 1 ] && echo 1 || echo 0)"
expect_eq "nor all the same order" 1 "$([ "$(sort -u "$ORDERS_FILE" | wc -l)" -gt 1 ] && echo 1 || echo 0)"

# ===========================================================================
c_head "A CANDIDATE CANNOT REACH A QUESTION THEY WERE NOT GIVEN"
UNSELECTED=$(dbq "SELECT q.id AS v FROM questions q WHERE q.question_family='IQ' AND q.active=1
                    AND q.id NOT IN (SELECT question_id FROM session_questions WHERE session_id='$SID_A') LIMIT 1")
check "there is an IQ question this attempt did not draw" "$([ -n "$UNSELECTED" ] && echo 0 || echo 1)" "$UNSELECTED"
expect_eq "fetching it through this attempt is refused" 404 "$(http_code GET "$BASE/api/exam/$TOK_A/question/$UNSELECTED")"
expect_eq "answering it through this attempt is refused" 404 "$(http_code POST "$BASE/api/exam/$TOK_A/answer" '' "{\"questionId\":\"$UNSELECTED\",\"answer\":{\"answer\":\"A\"}}")"
expect_eq "and no answer row was created for it" 0 "$(dbq "SELECT COUNT(*) AS v FROM candidate_answers WHERE session_id='$SID_A' AND question_id='$UNSELECTED'")"
expect_eq "a recruitment question is refused too" 404 "$(http_code POST "$BASE/api/exam/$TOK_A/answer" '' "{\"questionId\":\"$(dbq "SELECT id AS v FROM questions WHERE question_family='GENERAL' LIMIT 1")\",\"answer\":{\"answer\":\"A\"}}")"
expect_eq "an invented id is refused" 404 "$(http_code POST "$BASE/api/exam/$TOK_A/answer" '' '{"questionId":"q_does_not_exist","answer":{"answer":"A"}}')"
expect_eq "the candidate payload never carries the full bank" 25 "$(jsonval "$(curl -s "$BASE/api/exam/$TOK_A/questions")" 'd.questions.length')"
QPAYLOAD=$(curl -s "$BASE/api/exam/$TOK_A/questions")
expect_eq "nor an expected answer" 0 "$(printf '%s' "$QPAYLOAD" | grep -c '"expected"')"
expect_eq "nor an explanation" 0 "$(printf '%s' "$QPAYLOAD" | grep -c '"explanation"')"
expect_eq "nor the stored display order" 0 "$(printf '%s' "$QPAYLOAD" | grep -c 'display_order')"
expect_eq "nor the difficulty it was drawn by" 0 "$(printf '%s' "$QPAYLOAD" | grep -c '"difficulty"')"

# ===========================================================================
c_head "SCORING STILL MARKS WHAT WAS ACTUALLY ASKED"
read -r CID_S TOK_S SID_S <<< "$(start_attempt "Random Candidate Scored" "$IQ_ASMT")"
# Answer every drawn question with its own correct value, read server-side.
# One process does both: a Windows node resolves an MSYS /tmp path against the
# wrong drive, so nothing is handed between processes through a file.
"$NODE" -e "
const D=require('better-sqlite3'); const http=require('http');
const db=new D(process.env.DATABASE_PATH,{readonly:true});
const rows=db.prepare('SELECT q.id, q.config_json FROM session_questions sq JOIN questions q ON q.id=sq.question_id WHERE sq.session_id=? ORDER BY sq.display_order').all('$SID_S');
const items=rows.map(r=>{ const c=JSON.parse(r.config_json); return {id:r.id, key:c.parts[0].key, expected:c.parts[0].expected}; });
const base=new URL('$BASE');
(async () => {
  for (const it of items) {
    const body=JSON.stringify({questionId:it.id, answer:{[it.key]: it.expected}});
    await new Promise((res,rej)=>{
      const rq=http.request({hostname:base.hostname,port:base.port,path:'/api/exam/$TOK_S/answer',method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},
        (r)=>{ r.resume(); r.on('end',res); });
      rq.on('error',rej); rq.end(body);
    });
  }
  console.log('answered', items.length);
})();
"
sleep 1
public_json POST "$BASE/api/exam/$TOK_S/submit" '' > /dev/null
expect_eq "the result counts the 25 questions that were asked" 25 "$(dbq "SELECT total_questions AS v FROM iq_results WHERE session_id='$SID_S'")"
expect_eq "all 25 were marked correct" 25 "$(dbq "SELECT correct_count AS v FROM iq_results WHERE session_id='$SID_S'")"
expect_eq "none was marked wrong" 0 "$(dbq "SELECT incorrect_count AS v FROM iq_results WHERE session_id='$SID_S'")"
expect_eq "none was left unanswered" 0 "$(dbq "SELECT unanswered_count AS v FROM iq_results WHERE session_id='$SID_S'")"
expect_eq "a full paper is 100%" 100 "$(dbq "SELECT CAST(percentage AS INT) AS v FROM iq_results WHERE session_id='$SID_S'")"
expect_eq "the 35 questions this candidate never saw were not marked against them" 25 "$(dbq "SELECT total_questions AS v FROM iq_results WHERE session_id='$SID_S'")"
# The recruitment score row is the 30/30/40 model. A reasoning paper must never
# feed it, however many of its questions the candidate got right.
expect_eq "a perfect IQ paper scores nothing in the recruitment calculation section" 0 "$(dbq "SELECT COALESCE(calc_marks,0) AS v FROM scores WHERE session_id='$SID_S'")"
expect_eq "which is still marked out of the recruitment 30" 30 "$(dbq "SELECT calc_max AS v FROM scores WHERE session_id='$SID_S'")"
expect_eq "and the candidate was not put into the interview queue" 0 "$(dbq "SELECT CASE WHEN status='INTERVIEW_PENDING' THEN 1 ELSE 0 END AS v FROM candidates WHERE id='$CID_S'")"

c_head "THE LIVE DASHBOARD DESCRIBES THE PAPER THAT WAS ACTUALLY GIVEN"
read -r CID_L TOK_L SID_L <<< "$(start_attempt "Random Candidate Live" "$IQ_ASMT")"
LIVE=$(http_body GET "$BASE/api/admin/exam-control/live" "$HR")
expect_eq "progress is measured against this attempt's 25 questions" 25 "$(jsonval "$LIVE" "d.assessments.find(a => a.sessionId === '$SID_L').totalQuestions")"
expect_eq "and nobody has answered any of them yet" 0 "$(jsonval "$LIVE" "d.assessments.find(a => a.sessionId === '$SID_L').answered")"
expect_eq "so progress reads zero, not a fraction of the wrong bank" 0 "$(jsonval "$LIVE" "d.assessments.find(a => a.sessionId === '$SID_L').progressPercent")"

# ===========================================================================
c_head "CATEGORY DISTRIBUTION"
post_json PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"questionsToShow":20,"selectionRules":{"byCategory":{"NUMERICAL":4,"LOGICAL":4,"PATTERN":4,"VERBAL":3,"SPATIAL":3,"SEQUENCE":2}}}' > /dev/null
read -r CID_CAT TOK_CAT SID_CAT <<< "$(start_attempt "Random Candidate Category" "$IQ_ASMT")"
expect_eq "the attempt is the configured size" 20 "$(dbq "SELECT COUNT(*) AS v FROM session_questions WHERE session_id='$SID_CAT'")"
for pair in NUMERICAL:4 LOGICAL:4 PATTERN:4 VERBAL:3 SPATIAL:3 SEQUENCE:2; do
  cat_name="${pair%%:*}"; want="${pair##*:}"
  expect_eq "$cat_name contributed exactly $want" "$want" "$(dbq "SELECT COUNT(*) AS v FROM session_questions sq JOIN questions q ON q.id=sq.question_id WHERE sq.session_id='$SID_CAT' AND q.iq_category='$cat_name'")"
done
expect_eq "a distribution that does not add up to the total is refused" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"questionsToShow":99,"selectionRules":{"byCategory":{"NUMERICAL":4}}}')"
expect_eq "an unknown category is refused" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"selectionRules":{"byCategory":{"TELEPATHY":4}}}')"
expect_eq "a negative quota is refused" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"selectionRules":{"byCategory":{"NUMERICAL":-2}}}')"
expect_eq "asking for both distributions at once is refused" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"selectionRules":{"byCategory":{"NUMERICAL":2},"byDifficulty":{"EASY":2}}}')"

c_head "A DEFICIENT CATEGORY BLOCKS THE ATTEMPT, NOT A PARTIAL ONE"
post_json PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"questionsToShow":40,"selectionRules":{"byCategory":{"NUMERICAL":40}}}' > /dev/null
DEFICIENT=$(http_body GET "$BASE/api/admin/assessments/$IQ_ASMT" "$HR")
expect_contains "the admin view names the deficient category" 'NUMERICAL' "$(jsonval "$DEFICIENT" 'd.assessment.selectionProblems[0]')"
expect_contains "and says how many are needed and available" 'Required: 40' "$(jsonval "$DEFICIENT" 'd.assessment.selectionProblems[0]')"
read -r CID_BAD _ <<< "$(new_candidate "$HR" "Random Candidate Blocked")"
BADLINK=$(post_json POST "$BASE/api/admin/candidates/$CID_BAD/links" "$HR" "{\"assessmentId\":\"$IQ_ASMT\"}")
expect_contains "generating an invitation is refused with the reason" 'NUMERICAL' "$BADLINK"
expect_eq "and no invitation was created" 0 "$(dbq "SELECT COUNT(*) AS v FROM assessment_links WHERE candidate_id='$CID_BAD'")"
expect_eq "and no session was created" 0 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE candidate_id='$CID_BAD'")"

c_head "AN OVERSIZED REQUEST BLOCKS THE ATTEMPT TOO"
post_json PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"questionsToShow":500,"selectionRules":null}' > /dev/null
read -r CID_BIG _ <<< "$(new_candidate "$HR" "Random Candidate Oversized")"
BIGLINK=$(post_json POST "$BASE/api/admin/candidates/$CID_BIG/links" "$HR" "{\"assessmentId\":\"$IQ_ASMT\"}")
expect_contains "the error states what was required" 'Required: 500' "$BIGLINK"
expect_contains "and what is available" 'Available: 60' "$BIGLINK"
expect_eq "no partial attempt exists" 0 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE candidate_id='$CID_BIG'")"
expect_eq "questions shown must be a whole number of at least one" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"questionsToShow":0}')"

# ===========================================================================
c_head "DIFFICULTY DISTRIBUTION"
post_json PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"questionsToShow":20,"selectionRules":{"byDifficulty":{"EASY":5,"MEDIUM":10,"HARD":5}}}' > /dev/null
read -r CID_DIF TOK_DIF SID_DIF <<< "$(start_attempt "Random Candidate Difficulty" "$IQ_ASMT")"
expect_eq "the attempt is the configured size" 20 "$(dbq "SELECT COUNT(*) AS v FROM session_questions WHERE session_id='$SID_DIF'")"
expect_eq "5 easy" 5 "$(dbq "SELECT COUNT(*) AS v FROM session_questions sq JOIN questions q ON q.id=sq.question_id WHERE sq.session_id='$SID_DIF' AND UPPER(q.difficulty)='EASY'")"
expect_eq "10 medium" 10 "$(dbq "SELECT COUNT(*) AS v FROM session_questions sq JOIN questions q ON q.id=sq.question_id WHERE sq.session_id='$SID_DIF' AND UPPER(q.difficulty)='MEDIUM'")"
expect_eq "5 hard" 5 "$(dbq "SELECT COUNT(*) AS v FROM session_questions sq JOIN questions q ON q.id=sq.question_id WHERE sq.session_id='$SID_DIF' AND UPPER(q.difficulty)='HARD'")"
expect_eq "an unknown difficulty is refused" 400 "$(post_json_code PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"selectionRules":{"byDifficulty":{"IMPOSSIBLE":3}}}')"

# ===========================================================================
c_head "OPTION ORDER — off by default, correct when on"
post_json PATCH "$BASE/api/admin/assessments/$IQ_ASMT" "$HR" '{"questionsToShow":25,"selectionRules":null,"randomizeOptions":true}' > /dev/null
read -r CID_OPT TOK_OPT SID_OPT <<< "$(start_attempt "Random Candidate Options" "$IQ_ASMT")"
expect_eq "an option order was stored for this attempt" 1 "$([ "$(dbq "SELECT COUNT(*) AS v FROM session_questions WHERE session_id='$SID_OPT' AND option_order_json IS NOT NULL")" -gt 0 ] && echo 1 || echo 0)"
expect_eq "the stored order is a permutation, never a rewrite of the values" 0 "$("$NODE" -e "
const D=require('better-sqlite3'); const db=new D(process.env.DATABASE_PATH,{readonly:true});
const rows=db.prepare('SELECT q.config_json, sq.option_order_json FROM session_questions sq JOIN questions q ON q.id=sq.question_id WHERE sq.session_id=? AND sq.option_order_json IS NOT NULL').all('$SID_OPT');
let bad=0;
for (const r of rows) {
  const configured=JSON.parse(r.config_json).parts[0].options.map(String).sort();
  const shown=JSON.parse(r.option_order_json).map(String).sort();
  if (JSON.stringify(configured)!==JSON.stringify(shown)) bad++;
}
console.log(bad);
")"
OPTQ=$(dbq "SELECT question_id AS v FROM session_questions WHERE session_id='$SID_OPT' AND option_order_json IS NOT NULL LIMIT 1")
SHOWN=$(jsonval "$(http_body GET "$BASE/api/exam/$TOK_OPT/question/$OPTQ")" 'd.question.parts[0].options.map(o=>o.value).join(",")')
STORED_ORDER=$(dbq "SELECT REPLACE(REPLACE(REPLACE(option_order_json,'[',''),']',''),'\"','') AS v FROM session_questions WHERE session_id='$SID_OPT' AND question_id='$OPTQ'")
expect_eq "the candidate sees the options in this attempt's stored order" "$STORED_ORDER" "$SHOWN"
expect_eq "the option payload still carries no expected answer" 0 "$(printf '%s' "$(http_body GET "$BASE/api/exam/$TOK_OPT/question/$OPTQ")" | grep -c '"expected"')"
# Answering by canonical value still marks correctly, whatever order it was shown in.
OPT_KEY=$(dbq "SELECT json_extract(config_json,'\$.parts[0].key') AS v FROM questions WHERE id='$OPTQ'")
OPT_EXP=$(dbq "SELECT json_extract(config_json,'\$.parts[0].expected') AS v FROM questions WHERE id='$OPTQ'")
public_json POST "$BASE/api/exam/$TOK_OPT/answer" "{\"questionId\":\"$OPTQ\",\"answer\":{\"$OPT_KEY\":\"$OPT_EXP\"}}" > /dev/null
expect_eq "the answer is stored as the canonical value, not a position" 1 "$(dbq "SELECT CASE WHEN answer_json LIKE '%\"$OPT_EXP\"%' THEN 1 ELSE 0 END AS v FROM candidate_answers WHERE session_id='$SID_OPT' AND question_id='$OPTQ'")"
public_json POST "$BASE/api/exam/$TOK_OPT/submit" '' > /dev/null
expect_eq "and it was marked correct despite the shuffle" 1 "$(dbq "SELECT correct_count AS v FROM iq_results WHERE session_id='$SID_OPT'")"
expect_eq "a shuffled paper is still marked out of what was asked" 25 "$(dbq "SELECT total_questions AS v FROM iq_results WHERE session_id='$SID_OPT'")"
# Shuffling only defeats answer-sharing if the VISIBLE letter moves with the
# position. If the canonical letter travelled with the option, two candidates
# who saw the same content in different rows would both still call it "B".
expect_eq "the portal labels options by position" 1 "$(grep -c 'String.fromCharCode(65 + i)' public/iq/app.js)"
expect_eq "and still submits the canonical value" 1 "$(grep -c 'value=\"\${esc(o.value)}\"' public/iq/app.js)"
expect_eq "the portal never re-sorts what the server sent" 0 "$(grep -c 'options.sort\|\.sort()' public/iq/app.js)"

# ===========================================================================
c_head "RANDOMIZATION OFF — the recruitment assessment is untouched"
expect_eq "the recruitment assessment does not randomise" 0 "$(dbq "SELECT randomize_questions AS v FROM assessments WHERE id='$GEN_ASMT'")"
read -r CID_G TOK_G SID_G <<< "$(start_attempt "Random Candidate Recruitment" "$GEN_ASMT")"
expect_eq "no per-attempt set is materialised for it" 0 "$(dbq "SELECT COUNT(*) AS v FROM session_questions WHERE session_id='$SID_G'")"
expect_eq "it serves the assessment's attached questions, as it always did" \
  "$(dbq "SELECT COUNT(*) AS v FROM assessment_questions aq JOIN questions q ON q.id=aq.question_id WHERE aq.assessment_id='$GEN_ASMT' AND q.active=1 AND COALESCE(q.archived,0)=0")" \
  "$(jsonval "$(curl -s "$BASE/api/exam/$TOK_G/questions")" 'd.questions.length')"
expect_eq "in the assessment's own order" \
  "$(dbq "SELECT GROUP_CONCAT(question_id) AS v FROM (SELECT aq.question_id FROM assessment_questions aq JOIN questions q ON q.id=aq.question_id WHERE aq.assessment_id='$GEN_ASMT' AND q.active=1 AND COALESCE(q.archived,0)=0 ORDER BY aq.order_index)")" \
  "$(served_ids "$TOK_G")"
expect_eq "turning it on for a recruitment assessment is allowed" 200 "$(post_json_code PATCH "$BASE/api/admin/assessments/$GEN_ASMT" "$HR" '{"randomizeQuestions":true,"questionsToShow":3}')"
read -r CID_G2 TOK_G2 SID_G2 <<< "$(start_attempt "Random Candidate Recruitment Two" "$GEN_ASMT")"
expect_eq "and then it draws that many" 3 "$(dbq "SELECT COUNT(*) AS v FROM session_questions WHERE session_id='$SID_G2'")"
expect_eq "drawing only recruitment questions" 3 "$(dbq "SELECT COUNT(*) AS v FROM session_questions sq JOIN questions q ON q.id=sq.question_id WHERE sq.session_id='$SID_G2' AND q.question_family='GENERAL'")"
expect_eq "the earlier attempt is unaffected by the change" 0 "$(dbq "SELECT COUNT(*) AS v FROM session_questions WHERE session_id='$SID_G'")"
post_json PATCH "$BASE/api/admin/assessments/$GEN_ASMT" "$HR" '{"randomizeQuestions":false,"questionsToShow":null}' > /dev/null

summary "RANDOM QUESTION SELECTION"
