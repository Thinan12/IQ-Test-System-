#!/bin/bash
# Section 20 — static checks on the candidate portal's mobile readiness.
#
# THIS IS NOT A DEVICE TEST. It only verifies the markup and API behaviour that
# real-device testing depends on. The actual Android Chrome / iPhone Safari /
# desktop Chrome walkthrough has to be done by a human: see
# MOBILE_TEST_CHECKLIST.md.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4117

HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
[ -n "$HR" ] || { c_red "could not log in"; server_log; exit 1; }

EXAM_HTML=$(cat public/exam/index.html)
EXAM_JS=$(cat public/exam/app.js)
CSS=$(cat public/shared.css)

c_head "Viewport and layout"
expect_contains "the exam portal declares a mobile viewport" 'width=device-width, initial-scale=1' "$EXAM_HTML"
expect_contains "it honours the notch / safe area on iPhone" 'viewport-fit=cover' "$EXAM_HTML"
expect_contains "it pads for the safe area inset" 'safe-area-inset' "$EXAM_HTML"
expect_not_contains "pinch zoom is not disabled" 'user-scalable=no' "$EXAM_HTML"
expect_not_contains "maximum-scale does not block zoom" 'maximum-scale=1' "$EXAM_HTML"
expect_contains "the content column is capped for readability" 'max-width:640px' "$EXAM_HTML"
expect_contains "the layout has a small-screen breakpoint" '@media (max-width:900px)' "$CSS"

c_head "Fields, radio buttons and touch targets"
expect_contains "numeric answers open a numeric keypad" 'inputmode="decimal"' "$EXAM_JS"
expect_contains "numeric answers use a number input" 'type="number"' "$EXAM_JS"
expect_contains "choice answers use real radio inputs" 'type="radio"' "$EXAM_JS"
expect_contains "radio inputs are finger-sized" '.qopt input{width:20px; height:20px;' "$EXAM_HTML"
expect_contains "the whole option row is tappable, not just the dot" '<label class="qopt' "$EXAM_JS"
expect_contains "option rows meet the 48px touch-target guidance" 'min-height:48px' "$EXAM_HTML"
expect_contains "fields are 16px so iOS Safari does not zoom on focus" 'input,select,textarea{font-size:16px;}' "$EXAM_HTML"

c_head "Flag control and print do not crowd the exam on a phone"
expect_contains "the flag button is finger-sized" '.flagbtn{min-height:44px;}' "$EXAM_HTML"
expect_contains "the flag control sits with the question, not in the sticky nav bar" '.flagrow{display:flex' "$EXAM_HTML"
expect_not_contains "the flag button is NOT inside the bottom navigation bar" 'flagBtn' "$(grep 'class="pnav"' public/exam/app.js)"
expect_contains "the flagged state is announced, not just coloured" 'aria-pressed' "$EXAM_JS"
expect_contains "flagging shows it is working" "t('flagging')" "$EXAM_JS"
# Printing belongs on the confirmation screen only. A print control during a
# timed exam invites a candidate to leave the page mid-assessment.
expect_contains "the candidate print button exists on the confirmation" 'printReceipt' "$EXAM_JS"
expect_contains "and only inside the submitted-confirmation screen" 'renderDone' "$EXAM_JS"
expect_not_contains "there is no print control on a question screen" 'printReceipt' "$(sed -n '/^async function showQuestion/,/^\/\/ "Flag for review"/p' public/exam/app.js)"
expect_not_contains "nor on the review screen" 'printReceipt' "$(sed -n '/^async function showReview/,/^let SUBMITTING/p' public/exam/app.js)"
expect_contains "the printed confirmation drops the exam chrome" '.ptop,.pnav,.no-print' "$EXAM_HTML"

c_head "Timer, navigation, autosave"
expect_contains "a countdown timer is rendered" 'class="timer"' "$EXAM_JS"
expect_contains "the timer warns when time is low" 'timer.low' "$EXAM_HTML"
expect_contains "the timer ticks every second" 'setInterval' "$EXAM_JS"
expect_contains "Next / Review navigation exists" 'Review Answers' "$EXAM_JS"
expect_contains "Previous navigation exists" 'Previous' "$EXAM_JS"
expect_contains "the nav bar sticks to the bottom of the screen" '.pnav{position:sticky; bottom:0' "$EXAM_HTML"
expect_contains "answers autosave while typing" 'debounce(saveAnswer' "$EXAM_JS"
expect_contains "navigating saves before moving on" 'await saveAnswer();' "$EXAM_JS"

c_head "Autosave and resume actually work over HTTP"
read -r M_ID M_CODE <<< "$(new_candidate "$HR" "Mobile Flow Candidate")"
M_TOKEN=$(new_link "$HR" "$M_ID")
http_body POST "$BASE/api/exam/$M_TOKEN/start" '' "{\"candidateCode\":\"$M_CODE\"}" > /dev/null
QLIST=$(http_body GET "$BASE/api/exam/$M_TOKEN/questions")
QID=$(jsonval "$QLIST" "d.questions.filter(q=>q.type==='CALC')[0].id")
http_body POST "$BASE/api/exam/$M_TOKEN/answer" '' "{\"questionId\":\"$QID\",\"answer\":{\"monthlyInterest\":3000},\"timeSpentDeltaSeconds\":12}" > /dev/null
RESUMED=$(http_body GET "$BASE/api/exam/$M_TOKEN/question/$QID")
expect_contains "a partially typed answer is stored on the server, not just the device" '3000' "$RESUMED"
expect_contains "reopening the link returns the saved answer" 'savedAnswer' "$RESUMED"
REOPEN=$(http_body GET "$BASE/api/exam/$M_TOKEN")
expect_contains "reopening mid-assessment resumes the session" 'IN_PROGRESS' "$REOPEN"
expect_contains "the remaining time comes from the server, not the device clock" 'expiresAt' "$REOPEN"

c_head "Submission and confirmation"
SUBMIT=$(take_assessment "$M_TOKEN" "$M_CODE" correct "Mobile essay answer.")
expect_contains "submission succeeds" '"ok":true' "$SUBMIT"
expect_contains "submission returns a confirmation timestamp" 'submittedAt' "$SUBMIT"
expect_contains "a confirmation screen exists in the portal" "Assessment submitted" "$EXAM_JS"
expect_eq "a resubmit from a flaky mobile connection is rejected" 409 "$(http_code POST "$BASE/api/exam/$M_TOKEN/submit")"

c_head "Reminder"
printf '  \033[33mNOTE\033[0m  Real-device testing is still required: run MOBILE_TEST_CHECKLIST.md\n'
printf '        on Android Chrome, iPhone Safari and desktop Chrome before go-live.\n'

summary "MOBILE MARKUP CHECKS (section 20 — static only)"
