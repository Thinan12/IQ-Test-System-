// Builds every HR reporting sheet from the SQLite source of truth.
// Pure data transformation — no network, no credentials. Kept separate from
// googleSheets.js so the exact column layout can be unit-tested and reused by
// the CSV/Excel exports without touching the Google API.
const db = require('../db');
const { evaluateEligibility } = require('./eligibility');
const { displayStatus } = require('./finalize');

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
function row(values) { return values.map(cell); }
function round1(n) { return Math.round(n * 10) / 10; }

function lookupName(table, id) {
  if (!id) return '';
  const r = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id);
  return r ? r.name : '';
}
function settings() { return db.prepare('SELECT * FROM settings WHERE id = 1').get(); }
function eligibilityRules() { return db.prepare('SELECT * FROM eligibility_rules WHERE id = 1').get(); }

function candidateRows(includeDemo) {
  const where = includeDemo ? '' : 'WHERE is_demo = 0';
  return db.prepare(`SELECT * FROM candidates ${where} ORDER BY created_at DESC`).all();
}

// Latest session per candidate — the one HR reports on.
function latestSession(candidateId) {
  return db.prepare(
    `SELECT * FROM assessment_sessions WHERE candidate_id = ?
     ORDER BY COALESCE(submitted_at, started_at, '') DESC LIMIT 1`
  ).get(candidateId);
}

function scoreFor(sessionId) {
  return db.prepare('SELECT * FROM scores WHERE session_id = ?').get(sessionId);
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

// ---------------------------------------------------------------- Candidates
function buildCandidatesSheet(includeDemo) {
  const rules = eligibilityRules();
  const rows = candidateRows(includeDemo).map((c) => {
    const session = latestSession(c.id);
    return row([
      c.code,
      c.full_name,
      lookupName('positions', c.applied_position_id),
      lookupName('departments', c.applied_department_id),
      lookupName('branches', c.branch_id),
      c.application_type,
      c.phone,
      c.email,
      c.education,
      c.major,
      c.gpa,
      c.iq,
      evaluateEligibility(c, rules).status,
      c.application_date,
      session ? displayStatus(session) : 'NOT_INVITED',
      c.status,
    ]);
  });
  return {
    name: 'Candidates',
    headers: ['Candidate ID', 'Full Name', 'Position', 'Department', 'Branch', 'Application Type', 'Phone',
      'Email', 'Education', 'Major', 'GPA', 'IQ', 'Eligibility Status', 'Application Date',
      'Assessment Status', 'Final Status'],
    rows,
  };
}

// -------------------------------------------------------------- Applications
function buildApplicationsSheet(includeDemo) {
  const rules = eligibilityRules();
  const rows = candidateRows(includeDemo).map((c) => row([
    c.code,
    c.full_name,
    c.application_type,
    lookupName('positions', c.applied_position_id),
    lookupName('departments', c.applied_department_id),
    lookupName('branches', c.branch_id),
    c.application_date,
    c.recruitment_batch,
    recruiterName(c.recruiter_id),
    c.previous_employer,
    c.previous_position,
    c.years_experience,
    c.expected_salary,
    evaluateEligibility(c, rules).status,
    c.status,
  ]));
  return {
    name: 'Applications',
    headers: ['Candidate ID', 'Full Name', 'Application Type', 'Position', 'Department', 'Branch',
      'Application Date', 'Recruitment Batch', 'Recruiter', 'Previous Employer', 'Previous Position',
      'Years Experience', 'Expected Salary', 'Eligibility Status', 'Application Status'],
    rows,
  };
}
function recruiterName(id) {
  if (!id) return '';
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(id);
  return u ? u.name : '';
}

// ------------------------------------------------------- Assessment Results
function buildAssessmentResultsSheet(includeDemo) {
  const passThreshold = settings().pass_threshold;
  const demoFilter = includeDemo ? '' : 'WHERE c.is_demo = 0';
  const sessions = db.prepare(
    `SELECT s.*, c.code, c.full_name
       FROM assessment_sessions s
       JOIN candidates c ON c.id = s.candidate_id
       ${demoFilter}
      ORDER BY COALESCE(s.submitted_at, s.started_at, '') DESC`
  ).all();

  const rows = sessions.map((s) => {
    const score = scoreFor(s.id);
    const timing = db.prepare(
      `SELECT COUNT(*) AS answered, COALESCE(SUM(time_spent_seconds),0) AS total
         FROM candidate_answers WHERE session_id = ? AND answer_json IS NOT NULL`
    ).get(s.id);
    const avgQuestionSeconds = timing.answered ? round1(timing.total / timing.answered) : '';
    const durationMinutes = s.started_at && s.submitted_at
      ? round1((new Date(s.submitted_at) - new Date(s.started_at)) / 60000)
      : '';
    return row([
      s.code,
      s.full_name,
      s.id,
      s.submitted_at || s.started_at || '',
      score ? score.calc_marks : '',
      score && score.essay_marks != null ? score.essay_marks : '',
      score && score.interview_marks != null ? score.interview_marks : '',
      score && score.final_marks != null ? score.final_marks : '',
      score && score.percentage != null ? score.percentage + '%' : '',
      passThreshold,
      score && score.pass != null ? (score.pass ? 'PASS' : 'FAIL') : 'NOT SCORED',
      durationMinutes === '' ? '' : durationMinutes + ' min',
      avgQuestionSeconds === '' ? '' : avgQuestionSeconds + ' s',
    ]);
  });

  return {
    name: 'Assessment Results',
    headers: ['Candidate ID', 'Candidate Name', 'Assessment ID', 'Assessment Date', 'Calculation Score',
      'Written Score', 'Interview Score', 'Final Score', 'Percentage', 'Pass Threshold', 'Pass/Fail',
      'Assessment Duration', 'Average Question Time'],
    rows,
  };
}

// --------------------------------------------------------- Question Results
function answerToText(question, answerJson) {
  const answer = parseJson(answerJson, null);
  if (answer == null) return '';
  if (question.type === 'ESSAY') return String(answer.text || '');
  return Object.keys(answer)
    .map((k) => `${k}=${answer[k] === null || answer[k] === undefined ? '' : answer[k]}`)
    .join('; ');
}

function buildQuestionResultsSheet(includeDemo) {
  const demoFilter = includeDemo ? '' : 'WHERE c.is_demo = 0';
  const records = db.prepare(
    `SELECT a.*, c.code, c.full_name, s.id AS session_id, s.status AS session_status,
            q.type AS q_type, q.text AS q_text, q.max_marks, q.order_index
       FROM candidate_answers a
       JOIN assessment_sessions s ON s.id = a.session_id
       JOIN candidates c ON c.id = s.candidate_id
       JOIN questions q ON q.id = a.question_id
       ${demoFilter}
      ORDER BY c.code, q.type, q.order_index`
  ).all();

  const rows = records.map((r) => {
    const score = scoreFor(r.session_id);
    let awarded = '';
    let marker = '';
    let markerComment = '';

    if (r.q_type === 'CALC') {
      const breakdown = parseJson(score && score.calc_breakdown_json, []) || [];
      const entry = breakdown.find((b) => b.questionId === r.question_id);
      if (entry) awarded = entry.marks;
      marker = score && score.calc_breakdown_json ? 'Automatic (server-side marking)' : '';
    } else {
      if (score && score.essay_marks != null) awarded = score.essay_marks;
      marker = (score && score.essay_marker) || '';
      markerComment = (score && score.essay_comments) || '';
    }

    const percentage = awarded === '' || !r.max_marks ? '' : Math.round((awarded / r.max_marks) * 100) + '%';
    let status = 'NOT ANSWERED';
    if (r.answer_json && r.answer_json !== '{}') status = 'ANSWERED';
    if (awarded !== '') status = awarded === r.max_marks ? 'CORRECT' : awarded === 0 ? 'INCORRECT' : 'PARTIAL';

    return row([
      r.code,
      r.full_name,
      r.question_id,
      r.q_text,
      r.q_type === 'CALC' ? 'Calculation' : 'Written (essay)',
      r.max_marks,
      awarded,
      percentage,
      answerToText({ type: r.q_type }, r.answer_json),
      r.time_spent_seconds ? r.time_spent_seconds + ' s' : '0 s',
      status,
      marker,
      markerComment,
    ]);
  });

  return {
    name: 'Question Results',
    headers: ['Candidate ID', 'Candidate Name', 'Question ID', 'Question', 'Question Type', 'Maximum Marks',
      'Awarded Marks', 'Percentage', 'Answer', 'Time Spent', 'Status', 'Marker', 'Marker Comment'],
    rows,
  };
}

// -------------------------------------------------------- Interview Results
function buildInterviewResultsSheet(includeDemo) {
  // Criterion keys come from the live interview_criteria table so the columns
  // never drift from however the rubric is configured.
  const criteria = db.prepare('SELECT * FROM interview_criteria ORDER BY order_index').all();
  const demoFilter = includeDemo ? '' : 'AND c.is_demo = 0';
  const records = db.prepare(
    `SELECT c.code, c.full_name, sc.*, s.submitted_at
       FROM scores sc
       JOIN assessment_sessions s ON s.id = sc.session_id
       JOIN candidates c ON c.id = s.candidate_id
      WHERE sc.interview_marks IS NOT NULL ${demoFilter}
      ORDER BY sc.interview_marked_at DESC`
  ).all();

  const rows = records.map((r) => {
    const breakdown = parseJson(r.interview_breakdown_json, {}) || {};
    const values = [r.code, r.full_name, r.interview_marked_at || r.submitted_at || '', r.interview_marker || ''];
    criteria.forEach((cr) => values.push(breakdown[cr.key] != null ? breakdown[cr.key] : 0));
    values.push(`${r.interview_marks}/${r.interview_max}`, r.interview_comments || '');
    return row(values);
  });

  return {
    name: 'Interview Results',
    headers: ['Candidate ID', 'Candidate Name', 'Interview Date', 'Interviewer',
      ...criteria.map((cr) => cr.label), 'Interview Total', 'Interview Comments'],
    rows,
  };
}

// --------------------------------------------------------- Integrity Events
// NOTE: these are *indicators*, never conclusions. The Risk Level column is a
// mechanical signal (paste size / focus changes). The Reviewer and Reviewer
// Comment columns stay blank until a human reviewer independently records a
// conclusion via the Integrity review endpoint.
function buildIntegritySheet(includeDemo, largePasteChars) {
  const demoFilter = includeDemo ? '' : 'WHERE c.is_demo = 0';
  const records = db.prepare(
    `SELECT ia.*, c.code, s.id AS session_id
       FROM integrity_assessments ia
       JOIN assessment_sessions s ON s.id = ia.session_id
       JOIN candidates c ON c.id = s.candidate_id
       ${demoFilter}
      ORDER BY ia.computed_at DESC`
  ).all();

  const rows = records.map((r) => {
    const events = db.prepare('SELECT type, meta_json FROM answer_events WHERE session_id = ?').all(r.session_id);
    const pastes = events.filter((e) => e.type === 'PASTE');
    const largePastes = pastes.filter((e) => (parseJson(e.meta_json, {}) || {}).length >= largePasteChars).length;
    const focusChanges = events.filter((e) => e.type === 'FOCUS_CHANGE').length;
    const visibilityChanges = events.filter((e) => e.type === 'VISIBILITY_CHANGE').length;
    const review = db.prepare('SELECT * FROM integrity_reviews WHERE session_id = ?').get(r.session_id);

    return row([
      r.code,
      r.session_id,
      pastes.length,
      largePastes,
      focusChanges,
      visibilityChanges,
      'Not measured',
      r.risk_level,
      review ? review.reviewer : '',
      review ? [review.conclusion, review.comment].filter(Boolean).join(' — ') : '',
    ]);
  });

  return {
    name: 'Integrity Events',
    headers: ['Candidate ID', 'Assessment ID', 'Paste Events', 'Large Paste Events', 'Focus Changes',
      'Visibility Changes', 'Answer Similarity', 'Risk Level', 'Reviewer', 'Reviewer Comment'],
    rows,
  };
}

// ------------------------------------------------------------ Audit Summary
function buildAuditSummarySheet() {
  const records = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 1000').all();
  return {
    name: 'Audit Summary',
    headers: ['Timestamp', 'User', 'Role', 'Action', 'Target', 'IP'],
    rows: records.map((r) => row([r.created_at, r.user_name, r.role, r.action, r.target, r.ip])),
  };
}

module.exports = {
  db,
  buildCandidatesSheet,
  buildApplicationsSheet,
  buildAssessmentResultsSheet,
  buildQuestionResultsSheet,
  buildInterviewResultsSheet,
  buildIntegritySheet,
  buildAuditSummarySheet,
};
