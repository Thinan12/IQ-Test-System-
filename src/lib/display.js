// Presentation rules shared by every export and by the admin UI.
//
// The central rule: a NULL score means "this has not happened yet" and a 0
// means "this was marked and scored zero". Those must never be conflated —
// showing 0/30 for an unmarked essay would tell HR the candidate failed it.
const NOT_GRADED = 'Not graded';
const NOT_COMPLETED = 'Not completed';
const NOT_CALCULATED = 'Not calculated';
const NOT_ANSWERED = 'Not answered';
const NOT_STARTED = 'Not started';

function isMissing(v) { return v === null || v === undefined || v === ''; }

/** Calculation section: marked automatically on submission, so it exists or the assessment does not. */
function calcScore(score) {
  if (!score || isMissing(score.calc_marks)) return NOT_COMPLETED;
  return `${score.calc_marks}/${score.calc_max}`;
}

/** Written/essay: marked by a human, so NULL means nobody has marked it yet. */
function writtenScore(score) {
  if (!score || isMissing(score.essay_marks)) return NOT_GRADED;
  return `${score.essay_marks}/${score.essay_max}`;
}

/** Interview: NULL means the interview has not taken place. */
function interviewScore(score) {
  if (!score || isMissing(score.interview_marks)) return NOT_COMPLETED;
  return `${score.interview_marks}/${score.interview_max}`;
}

/** Final: NULL means not every component is in yet. */
function finalScore(score) {
  if (!score || isMissing(score.final_marks)) return NOT_CALCULATED;
  return `${score.final_marks}/100`;
}

function percentage(score) {
  if (!score || isMissing(score.percentage)) return NOT_CALCULATED;
  return `${score.percentage}%`;
}

function passLabel(score) {
  if (!score || isMissing(score.pass)) return NOT_CALCULATED;
  return score.pass ? 'PASS' : 'FAIL';
}

/**
 * One question's awarded marks. `awarded` of 0 is a real zero and is shown as
 * 0/max; only a genuinely absent mark becomes "Not answered".
 */
function questionMarks(awarded, max, answered) {
  if (isMissing(awarded)) return answered ? NOT_GRADED : NOT_ANSWERED;
  return `${awarded}/${max}`;
}

/** A raw numeric cell for spreadsheets: keeps 0 as 0 and NULL as blank. */
function numberOrBlank(v) {
  if (isMissing(v)) return '';
  return v;
}

/** Human label for an assessment session that may not exist yet. */
function sessionLabel(session, liveStatus) {
  if (!session) return NOT_STARTED;
  return liveStatus || session.status;
}

module.exports = {
  NOT_GRADED, NOT_COMPLETED, NOT_CALCULATED, NOT_ANSWERED, NOT_STARTED,
  isMissing,
  calcScore, writtenScore, interviewScore, finalScore, percentage, passLabel,
  questionMarks, numberOrBlank, sessionLabel,
};
