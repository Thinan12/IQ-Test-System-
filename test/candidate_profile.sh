#!/bin/bash
# The candidate's own profile, the bilingual invitation wording, and the
# recruitment report that assembles everything about one candidate.
#
# Runs against a throwaway database on its own port, like every other suite.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

start_server 4139

SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
RECRUITER=$(login_token recruiter@lalco.demo "$DEMO_PASSWORD")
INTERVIEWER=$(login_token interviewer@lalco.demo "$DEMO_PASSWORD")
[ -n "$HR" ] || { c_red "could not log in"; server_log; exit 1; }

# Non-ASCII through curl -d is mangled on Windows, so bodies go via a UTF-8 file.
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
pub_json() {
  printf '%s' "$3" > "$TEST_DIR/pbody.json"
  curl -s -X "$1" "$2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/pbody.json"
}
pub_code() {
  printf '%s' "$3" > "$TEST_DIR/pbody.json"
  curl -s -o /dev/null -w '%{http_code}' -X "$1" "$2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/pbody.json"
}

GOOD_PROFILE='{"fullName":"Souphap Vilaysane","phone":"+856 20 5555 1234","graduateFrom":"UNIVERSITY","school":"National University of Laos","subject":"Finance","gpa":3.6}'
IQ_ASMT=$(dbq "SELECT id AS v FROM assessments WHERE assessment_type='IQ_TEST' LIMIT 1")

new_invite() { # new_invite <candidate-id> [language] [assessmentId]
  local body='{}'
  [ -n "$2" ] && body="{\"language\":\"$2\"}"
  [ -n "$3" ] && body="{\"language\":\"$2\",\"assessmentId\":\"$3\"}"
  jsonval "$(post_json POST "$BASE/api/admin/candidates/$1/links" "$HR" "$body")" 'd.token'
}

# ===========================================================================
c_head "THE PROFILE COMES FIRST"
read -r CID CCODE <<< "$(new_candidate "$HR" "Profile Candidate")"
TOK=$(new_invite "$CID" "lo")
INTRO=$(http_body GET "$BASE/api/exam/$TOK")
expect_eq "a new candidate has not filled in a profile" "PROFILE_PENDING" "$(jsonval "$INTRO" 'd.profileStatus')"
expect_eq "the invitation opens in the language the admin chose" "lo" "$(jsonval "$INTRO" 'd.linkLanguage')"
expect_eq "the assessment cannot be started yet" 428 "$(pub_code POST "$BASE/api/exam/$TOK/start" "{\"candidateCode\":\"$CCODE\"}")"
expect_eq "and no session was created by the attempt" 0 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE candidate_id='$CID'")"
expect_eq "the form is told which options exist" 3 "$(jsonval "$INTRO" 'd.graduateFromOptions.length')"
expect_eq "as stable internal values" "HIGH_SCHOOL,COLLEGE,UNIVERSITY" "$(jsonval "$INTRO" 'd.graduateFromOptions.map(o=>o.value).join(",")')"
expect_eq "each with an English label" 3 "$(jsonval "$INTRO" 'd.graduateFromOptions.filter(o=>o.en).length')"
expect_eq "and a Lao label" 3 "$(jsonval "$INTRO" 'd.graduateFromOptions.filter(o=>o.lo).length')"
expect_eq "the Lao labels are Lao script, not English" 3 "$(jsonval "$INTRO" 'd.graduateFromOptions.filter(o=>/[຀-໿]/.test(o.lo)).length')"

c_head "VALIDATION — every field is checked on the server"
BAD=$(pub_json POST "$BASE/api/exam/$TOK/profile" '{"fullName":"","phone":"","graduateFrom":"","school":"","subject":"","gpa":""}')
expect_eq "an empty form is refused" 6 "$(jsonval "$BAD" 'd.errors.length')"
expect_eq "and says which field is wrong" "fullName,phone,graduateFrom,school,subject,gpa" "$(jsonval "$BAD" 'd.errors.map(e=>e.field).join(",")')"
expect_eq "a made-up education level is refused" 400 "$(pub_code POST "$BASE/api/exam/$TOK/profile" '{"fullName":"A","phone":"+8562055551234","graduateFrom":"WIZARDRY","school":"S","subject":"X","gpa":3}')"
printf '%s' '{"fullName":"A","phone":"+8562055551234","graduateFrom":"ມະຫາວິທະຍາໄລ","school":"S","subject":"X","gpa":3}' > "$TEST_DIR/lao_label.json"
expect_eq "a Lao display label is not accepted in place of the value" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/exam/$TOK/profile" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/lao_label.json")"
expect_eq "a GPA above the scale is refused" 400 "$(pub_code POST "$BASE/api/exam/$TOK/profile" '{"fullName":"A","phone":"+8562055551234","graduateFrom":"UNIVERSITY","school":"S","subject":"X","gpa":250}')"
expect_eq "a negative GPA is refused" 400 "$(pub_code POST "$BASE/api/exam/$TOK/profile" '{"fullName":"A","phone":"+8562055551234","graduateFrom":"UNIVERSITY","school":"S","subject":"X","gpa":-1}')"
expect_eq "a non-numeric GPA is refused" 400 "$(pub_code POST "$BASE/api/exam/$TOK/profile" '{"fullName":"A","phone":"+8562055551234","graduateFrom":"UNIVERSITY","school":"S","subject":"X","gpa":"very good"}')"
expect_eq "letters are not a phone number" 400 "$(pub_code POST "$BASE/api/exam/$TOK/profile" '{"fullName":"A","phone":"call me","graduateFrom":"UNIVERSITY","school":"S","subject":"X","gpa":3}')"
expect_eq "nor are three digits" 400 "$(pub_code POST "$BASE/api/exam/$TOK/profile" '{"fullName":"A","phone":"123","graduateFrom":"UNIVERSITY","school":"S","subject":"X","gpa":3}')"
expect_eq "nothing was written by any refused attempt" "" "$(dbq "SELECT COALESCE(graduate_from,'') AS v FROM candidates WHERE id='$CID'")"
# Case is forgiven, because it still resolves to the one stable value; the
# stored column must always hold that value and never what was typed.
expect_eq "English wording resolves to the stable value" 200 "$(pub_code POST "$BASE/api/exam/$TOK/profile" '{"fullName":"A","phone":"+8562055551234","graduateFrom":"university","school":"S","subject":"X","gpa":3}')"
expect_eq "and the stable value is what is stored" "UNIVERSITY" "$(dbq "SELECT graduate_from AS v FROM candidates WHERE id='$CID'")"

c_head "REAL PHONE NUMBERS ARE ACCEPTED, NOT JUST ONE SHAPE"
for phone in "+856 20 5555 1234" "02055551234" "+66-81-234-5678" "(856) 20 5555 1234" "+44 20 7946 0958"; do
  expect_eq "accepts $phone" 200 "$(pub_code POST "$BASE/api/exam/$TOK/profile" "{\"fullName\":\"Phone Shape\",\"phone\":\"$phone\",\"graduateFrom\":\"COLLEGE\",\"school\":\"S\",\"subject\":\"X\",\"gpa\":3}")"
done

c_head "SAVING WRITES TO THE CANDIDATE THAT ALREADY EXISTS"
BEFORE_ROWS=$(dbq "SELECT COUNT(*) AS v FROM candidates")
SAVED=$(pub_json POST "$BASE/api/exam/$TOK/profile" "$GOOD_PROFILE")
expect_eq "the profile is accepted" "PROFILE_COMPLETED" "$(jsonval "$SAVED" 'd.profileStatus')"
expect_eq "no second candidate record was created" "$BEFORE_ROWS" "$(dbq "SELECT COUNT(*) AS v FROM candidates")"
expect_eq "the name is stored" "Souphap Vilaysane" "$(dbq "SELECT full_name AS v FROM candidates WHERE id='$CID'")"
expect_eq "the phone is stored" "+856 20 5555 1234" "$(dbq "SELECT phone AS v FROM candidates WHERE id='$CID'")"
expect_eq "the stable value is stored, never the label" "UNIVERSITY" "$(dbq "SELECT graduate_from AS v FROM candidates WHERE id='$CID'")"
expect_eq "the school goes to the existing column" "National University of Laos" "$(dbq "SELECT university AS v FROM candidates WHERE id='$CID'")"
expect_eq "the subject goes to the existing column" "Finance" "$(dbq "SELECT major AS v FROM candidates WHERE id='$CID'")"
expect_eq "the GPA goes to the existing column" "3.6" "$(dbq "SELECT gpa AS v FROM candidates WHERE id='$CID'")"
expect_eq "readable education is kept for the eligibility rules" "University" "$(dbq "SELECT education AS v FROM candidates WHERE id='$CID'")"
expect_eq "the completion is stamped" 1 "$(dbq "SELECT CASE WHEN profile_completed_at IS NOT NULL THEN 1 ELSE 0 END AS v FROM candidates WHERE id='$CID'")"
expect_eq "saving it is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*)>0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action='Candidate profile saved'")"

c_head "IT SURVIVES REOPENING, AND THE LANGUAGE NEVER CHANGES WHAT IS STORED"
REOPEN=$(http_body GET "$BASE/api/exam/$TOK")
expect_eq "reopening the link reports it complete" "PROFILE_COMPLETED" "$(jsonval "$REOPEN" 'd.profileStatus')"
expect_eq "and hands back what was entered" "National University of Laos" "$(jsonval "$REOPEN" 'd.profile.school')"
expect_eq "including the stable value" "UNIVERSITY" "$(jsonval "$REOPEN" 'd.profile.graduateFrom')"
# Re-saving the identical profile from a Lao form must store the same value.
pub_json POST "$BASE/api/exam/$TOK/profile" "$GOOD_PROFILE" > /dev/null
expect_eq "re-saving from the other language stores the same value" "UNIVERSITY" "$(dbq "SELECT graduate_from AS v FROM candidates WHERE id='$CID'")"
expect_eq "the first completion time is not overwritten" 1 "$(dbq "SELECT CASE WHEN profile_completed_at <= profile_updated_at THEN 1 ELSE 0 END AS v FROM candidates WHERE id='$CID'")"
expect_eq "the assessment can now be started" 200 "$(pub_code POST "$BASE/api/exam/$TOK/start" "{\"candidateCode\":\"$CCODE\"}")"
expect_eq "and exactly one session exists" 1 "$(dbq "SELECT COUNT(*) AS v FROM assessment_sessions WHERE candidate_id='$CID'")"
expect_eq "a submitted assessment will not take profile edits" 1 "$(pub_code POST "$BASE/api/exam/$TOK/submit" '' > /dev/null; printf '%s' "$(pub_code POST "$BASE/api/exam/$TOK/profile" "$GOOD_PROFILE")" | grep -c '409')"

c_head "THE PROFILE FORM IS SHARED, AND CARRIES NOTHING IT SHOULD NOT"
expect_eq "the shared form is served to the candidate portals" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/profileForm.js")"
expect_eq "the recruitment portal loads it" 1 "$(grep -c 'profileForm.js' public/exam/index.html)"
expect_eq "the IQ portal loads it too" 1 "$(grep -c 'profileForm.js' public/iq/index.html)"
expect_eq "the form never names a database id" 0 "$(grep -c 'candidateId\|candidate_id' public/profileForm.js)"
expect_eq "nor invents Lao — untranslated strings fall back to English" 1 "$(grep -c 'falls back to English' public/profileForm.js)"
PROFILE_PAYLOAD=$(http_body GET "$BASE/api/exam/$TOK")
expect_eq "the candidate payload carries no database id" 0 "$(printf '%s' "$PROFILE_PAYLOAD" | grep -c "$CID")"

# ===========================================================================
c_head "INVITATION WORDING — English and Lao, editable"
SETTINGS=$(http_body GET "$BASE/api/admin/settings" "$HR")
expect_contains "an English template exists by default" '[LINK]' "$(jsonval "$SETTINGS" 'd.invitationTemplates.en.text')"
expect_contains "and a Lao one" '[LINK]' "$(jsonval "$SETTINGS" 'd.invitationTemplates.lo.text')"
expect_eq "both start as the built-in wording" "true,true" "$(jsonval "$SETTINGS" 'String(d.invitationTemplates.en.isDefault)+","+String(d.invitationTemplates.lo.isDefault)')"
expect_eq "the Lao template is Lao script, not English" 1 "$(jsonval "$SETTINGS" '/[຀-໿]/.test(d.invitationTemplates.lo.text) ? 1 : 0')"

read -r MID MCODE <<< "$(new_candidate "$HR" "Message Candidate")"
EN_LINK=$(post_json POST "$BASE/api/admin/candidates/$MID/links" "$HR" '{"language":"en"}')
expect_contains "an English invitation is rendered in English" 'You are invited' "$(jsonval "$EN_LINK" 'd.invitationMessage')"
expect_contains "with the candidate's name substituted" 'Message Candidate' "$(jsonval "$EN_LINK" 'd.invitationMessage')"
expect_contains "and the link substituted" '/exam/' "$(jsonval "$EN_LINK" 'd.invitationMessage')"
expect_eq "no placeholder is left behind" 0 "$(printf '%s' "$(jsonval "$EN_LINK" 'd.invitationMessage')" | grep -c '\[LINK\]\|\[Candidate Name\]')"
LO_LINK=$(post_json POST "$BASE/api/admin/candidates/$MID/links" "$HR" '{"language":"lo"}')
expect_eq "a Lao invitation is rendered in Lao script" 1 "$(jsonval "$LO_LINK" '/[຀-໿]/.test(d.invitationMessage) ? 1 : 0')"
expect_contains "and still carries the link" '/exam/' "$(jsonval "$LO_LINK" 'd.invitationMessage')"
EN_MSG=$(jsonval "$EN_LINK" 'd.invitationMessage')
LO_MSG=$(jsonval "$LO_LINK" 'd.invitationMessage')
expect_eq "the two languages really are different messages" 1 "$([ "$EN_MSG" != "$LO_MSG" ] && echo 1 || echo 0)"
expect_eq "the old field name still works for anything reading it" 1 "$(jsonval "$EN_LINK" 'd.whatsappMessage === d.invitationMessage ? 1 : 0')"

expect_eq "a template with no link is refused" 400 "$(post_json_code PUT "$BASE/api/admin/settings" "$SUPER" '{"inviteTemplateEn":"Hello, please come in."}')"
expect_eq "an edited template is used" 200 "$(post_json_code PUT "$BASE/api/admin/settings" "$SUPER" '{"inviteTemplateEn":"Edited wording for [Candidate Name]: [LINK]"}')"
EDITED=$(post_json POST "$BASE/api/admin/candidates/$MID/links" "$HR" '{"language":"en"}')
expect_contains "the new wording reaches the invitation" 'Edited wording for' "$(jsonval "$EDITED" 'd.invitationMessage')"
expect_contains "with the substitutions still applied" 'Message Candidate' "$(jsonval "$EDITED" 'd.invitationMessage')"
post_json PUT "$BASE/api/admin/settings" "$SUPER" '{"inviteTemplateEn":""}' > /dev/null
expect_eq "blanking it restores the built-in wording" "true" "$(jsonval "$(http_body GET "$BASE/api/admin/settings" "$HR")" 'String(d.invitationTemplates.en.isDefault)')"
expect_eq "only a Super Admin may change it" 403 "$(post_json_code PUT "$BASE/api/admin/settings" "$RECRUITER" '{"inviteTemplateEn":"x [LINK]"}')"

# ===========================================================================
c_head "RECRUITMENT REPORT — assembled from the attempts, never retyped"
read -r RID RCODE <<< "$(new_candidate "$HR" "Recruitment Report Candidate")"
RTOK=$(new_invite "$RID" "en")
take_assessment "$RTOK" "$RCODE" correct > /dev/null
REPORT=$(http_body GET "$BASE/api/admin/recruitment/$RID" "$HR")
expect_eq "the report names the candidate" "Recruitment Report Candidate" "$(jsonval "$REPORT" 'd.report.candidate.name')"
expect_eq "and carries their phone" 1 "$(jsonval "$REPORT" 'd.report.candidate.phone ? 1 : 0')"
expect_eq "and their education" 1 "$(jsonval "$REPORT" 'd.report.candidate.school ? 1 : 0')"
expect_eq "the profile is marked complete" "PROFILE_COMPLETED" "$(jsonval "$REPORT" 'd.report.candidate.profileStatus')"
expect_eq "the calculation mark comes from the attempt" "$(dbq "SELECT calc_marks AS v FROM scores WHERE session_id=(SELECT id FROM assessment_sessions WHERE candidate_id='$RID' ORDER BY started_at DESC LIMIT 1)")" "$(jsonval "$REPORT" 'd.report.assessment.calculation.marks')"
expect_eq "out of the attempt's own maximum" "$(dbq "SELECT calc_max AS v FROM scores WHERE session_id=(SELECT id FROM assessment_sessions WHERE candidate_id='$RID' ORDER BY started_at DESC LIMIT 1)")" "$(jsonval "$REPORT" 'd.report.assessment.calculation.max')"
expect_eq "an IQ mark is absent until an IQ test is sat" "null" "$(jsonval "$REPORT" 'String(d.report.assessment.iq)')"
expect_eq "the final result starts PENDING" "PENDING" "$(jsonval "$REPORT" 'd.report.outcome.finalResult')"

c_head "AN IQ ATTEMPT POPULATES THE IQ MARK AND NOTHING ELSE"
CALC_BEFORE=$(jsonval "$REPORT" 'd.report.assessment.calculation.marks')
ITOK=$(new_invite "$RID" "en" "$IQ_ASMT")
complete_profile "$ITOK"
pub_json POST "$BASE/api/exam/$ITOK/start" "{\"candidateCode\":\"$RCODE\"}" > /dev/null
pub_json POST "$BASE/api/exam/$ITOK/submit" '' > /dev/null
REPORT2=$(http_body GET "$BASE/api/admin/recruitment/$RID" "$HR")
expect_eq "the IQ mark is now present" 1 "$(jsonval "$REPORT2" 'd.report.assessment.iq ? 1 : 0')"
expect_eq "read from the IQ attempt itself" "$(dbq "SELECT correct_count AS v FROM iq_results WHERE session_id=(SELECT id FROM assessment_sessions WHERE candidate_id='$RID' ORDER BY started_at DESC LIMIT 1)")" "$(jsonval "$REPORT2" 'd.report.assessment.iq.correct')"
expect_eq "the calculation mark is untouched by the IQ attempt" "$CALC_BEFORE" "$(jsonval "$REPORT2" 'd.report.assessment.calculation.marks')"
expect_contains "the estimate carries its disclaimer" 'not a clinically validated IQ' "$(jsonval "$REPORT2" 'd.report.assessment.iq.disclaimer')"
expect_eq "a candidate cannot post their own IQ mark" 404 "$(pub_code POST "$BASE/api/exam/$ITOK/iq-result" '{"estimatedIq":145}')"
expect_eq "nor patch the recruitment record without a login" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/admin/recruitment/$RID" -H 'Content-Type: application/json' -d '{"finalResult":"PASS"}')"

c_head "INTERVIEW AND FINAL RESULT — validated on the server"
META=$(http_body GET "$BASE/api/admin/recruitment/meta" "$HR")
expect_eq "the interviewer list is configurable, not hardcoded" 1 "$(jsonval "$META" 'd.interviewers.length > 0 ? 1 : 0')"
expect_eq "it offers only the allowed interview scores" "0,5,10,15,20,25,30" "$(jsonval "$META" 'd.interviewScores.join(",")')"
IVID=$(jsonval "$META" 'd.interviewers[0].id')
expect_eq "a score off the scale is refused" 400 "$(post_json_code PATCH "$BASE/api/admin/recruitment/$RID" "$HR" '{"hrScore":7}')"
expect_eq "so is one above the maximum" 400 "$(post_json_code PATCH "$BASE/api/admin/recruitment/$RID" "$HR" '{"chairmanScore":35}')"
expect_eq "an unknown interview result is refused" 400 "$(post_json_code PATCH "$BASE/api/admin/recruitment/$RID" "$HR" '{"interviewResult":"MAYBE"}')"
expect_eq "an unknown final result is refused" 400 "$(post_json_code PATCH "$BASE/api/admin/recruitment/$RID" "$HR" '{"finalResult":"HIRED"}')"
expect_eq "a nonsense date is refused" 400 "$(post_json_code PATCH "$BASE/api/admin/recruitment/$RID" "$HR" '{"dateComeToWork":"next Tuesday"}')"
expect_eq "an interviewer who does not exist is refused" 400 "$(post_json_code PATCH "$BASE/api/admin/recruitment/$RID" "$HR" '{"interviewerId":"usr_nobody"}')"
expect_eq "nothing was stored by any refused edit" 0 "$(dbq "SELECT COUNT(*) AS v FROM recruitment_records WHERE candidate_id='$RID' AND hr_interview_score IS NOT NULL")"

SAVED=$(post_json PATCH "$BASE/api/admin/recruitment/$RID" "$HR" "{\"interviewerId\":\"$IVID\",\"hrScore\":25,\"chairmanScore\":30,\"interviewResult\":\"PASS\",\"remark\":\"Clear communicator\",\"character\":\"Calm\",\"referenceResult\":\"Positive\",\"finalResult\":\"PASS\",\"dateComeToWork\":\"2026-10-01\"}")
expect_eq "a valid record is stored" 1 "$(dbq "SELECT COUNT(*) AS v FROM recruitment_records WHERE candidate_id='$RID'")"
expect_eq "the interviewer is stored by id, not by name" "$IVID" "$(dbq "SELECT interviewer_id AS v FROM recruitment_records WHERE candidate_id='$RID'")"
expect_eq "and the report resolves the name" 1 "$(jsonval "$SAVED" 'd.report.interview.interviewerName ? 1 : 0')"
expect_eq "the HR score is stored" 25 "$(jsonval "$SAVED" 'd.report.interview.hrScore')"
expect_eq "the chairman score is stored" 30 "$(jsonval "$SAVED" 'd.report.interview.chairmanScore')"
expect_eq "the interview result is stored" "PASS" "$(jsonval "$SAVED" 'd.report.interview.result')"
expect_eq "the remark is stored" "Clear communicator" "$(jsonval "$SAVED" 'd.report.interview.remark')"
expect_eq "the reference result is stored" "Positive" "$(jsonval "$SAVED" 'd.report.administrative.referenceResult')"
expect_eq "character is stored" "Calm" "$(jsonval "$SAVED" 'd.report.administrative.character')"
expect_eq "the final result is stored" "PASS" "$(jsonval "$SAVED" 'd.report.outcome.finalResult')"
expect_eq "the start date is stored normalised" "2026-10-01" "$(jsonval "$SAVED" 'd.report.outcome.dateComeToWork')"
expect_eq "the change is audited" 1 "$(dbq "SELECT CASE WHEN COUNT(*)>0 THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action='RECRUITMENT_RECORD_UPDATED'")"
expect_eq "the audit records who did it" 1 "$(dbq "SELECT CASE WHEN user_name IS NOT NULL THEN 1 ELSE 0 END AS v FROM audit_logs WHERE action='RECRUITMENT_RECORD_UPDATED' LIMIT 1")"
expect_eq "editing again reports only what changed" "remark" "$(jsonval "$(post_json PATCH "$BASE/api/admin/recruitment/$RID" "$HR" '{"remark":"Revised remark"}')" 'd.changed.join(",")')"
expect_eq "the assessment marks are still read from the attempt" "$CALC_BEFORE" "$(jsonval "$(http_body GET "$BASE/api/admin/recruitment/$RID" "$HR")" 'd.report.assessment.calculation.marks')"

c_head "WHO MAY DO WHAT"
expect_eq "a recruiter may read a report" 200 "$(http_code GET "$BASE/api/admin/recruitment/$RID" "$RECRUITER")"
expect_eq "but may not edit it" 403 "$(post_json_code PATCH "$BASE/api/admin/recruitment/$RID" "$RECRUITER" '{"remark":"nope"}')"
expect_eq "an interviewer may record an interview" 200 "$(post_json_code PATCH "$BASE/api/admin/recruitment/$RID" "$INTERVIEWER" '{"hrScore":20}')"
expect_eq "but may not settle the final result" 400 "$(post_json_code PATCH "$BASE/api/admin/recruitment/$RID" "$INTERVIEWER" '{"finalResult":"NOT_PASS"}')"
expect_eq "and the final result was not changed by that attempt" "PASS" "$(dbq "SELECT final_result AS v FROM recruitment_records WHERE candidate_id='$RID'")"
expect_eq "an unknown candidate is a 404" 404 "$(http_code GET "$BASE/api/admin/recruitment/cand_nobody" "$HR")"
expect_eq "no anonymous access at all" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/recruitment/$RID")"

summary "CANDIDATE PROFILE + RECRUITMENT REPORT"
