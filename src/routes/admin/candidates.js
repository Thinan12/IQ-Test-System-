const express = require('express');
const db = require('../../db');
const { generateId, generateSecureToken } = require('../../lib/tokens');
const { evaluateEligibility } = require('../../lib/eligibility');
const { gradeAllCalc } = require('../../lib/grading');
const { auditFromReq } = require('../../lib/audit');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { displayStatus } = require('../../lib/finalize');
const { parseDbDate } = require('../../lib/timeutil');
const bcrypt = require('bcryptjs');
const { linkLiveStatus, sessionLiveStatus } = require('../../lib/examControl');
const { deleteCandidateData } = require('../../lib/dataManagement');
const { normaliseLanguage, isSupportedLanguage, DEFAULT_LANGUAGE } = require('../../lib/questionText');
const { nextCandidateCode } = require('../../lib/dataManagement');
const { validateCode } = require('../../lib/candidateCode');

const router = express.Router();
router.use(requireAuth);

function lookupName(table, id) {
  if (!id) return null;
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id);
  return row ? row.name : null;
}
function lookupOrCreate(table, name) {
  if (!name) return null;
  const existing = db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name);
  if (existing) return existing.id;
  const id = generateId(table.slice(0, 3));
  db.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`).run(id, name);
  return id;
}

function eligibilityRules() {
  return db.prepare('SELECT * FROM eligibility_rules WHERE id = 1').get();
}
function settings() {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get();
}

function candidateSummary(c) {
  const elig = evaluateEligibility(c, eligibilityRules());
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ? ORDER BY started_at DESC LIMIT 1').get(c.id);
  const scores = session ? db.prepare('SELECT * FROM scores WHERE session_id = ?').get(session.id) : null;
  const integrity = session ? db.prepare('SELECT * FROM integrity_assessments WHERE session_id = ?').get(session.id) : null;
  return {
    id: c.id,
    code: c.code,
    fullName: c.full_name,
    applicationType: c.application_type,
    appliedPosition: lookupName('positions', c.applied_position_id),
    branch: lookupName('branches', c.branch_id),
    department: lookupName('departments', c.applied_department_id),
    status: c.status,
    eligibilityStatus: elig.status,
    calc: scores ? scores.calc_marks : null,
    essay: scores ? scores.essay_marks : null,
    interview: scores ? scores.interview_marks : null,
    final: scores ? scores.final_marks : null,
    pass: scores ? !!scores.pass : null,
    aiRisk: integrity ? integrity.risk_level : 'Low',
    isDemo: !!c.is_demo,
    archived: !!c.archived,
    archivedAt: c.archived_at || null,
  };
}

// ---- LIST ----
router.get('/', (req, res) => {
  // Archived candidates are hidden from the working list unless asked for.
  const showArchived = String(req.query.archived || '') === '1';
  const rows = showArchived
    ? db.prepare('SELECT * FROM candidates WHERE archived = 1 ORDER BY archived_at DESC').all()
    : db.prepare('SELECT * FROM candidates WHERE archived = 0 ORDER BY created_at DESC').all();
  let list = rows.map(candidateSummary);
  const { q, position, branch, type, status, eligibility } = req.query;
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((c) => (c.fullName + c.code).toLowerCase().includes(needle));
  }
  if (position) list = list.filter((c) => c.appliedPosition === position);
  if (branch) list = list.filter((c) => c.branch === branch);
  if (type) list = list.filter((c) => c.applicationType === type);
  if (status) list = list.filter((c) => c.status === status);
  if (eligibility) list = list.filter((c) => c.eligibilityStatus === eligibility);
  res.json({ candidates: list, total: list.length });
});

// ---- CREATE ----
router.post('/', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'), (req, res) => {
  const b = req.body || {};
  if (!b.fullName || !b.applicationType) return res.status(400).json({ error: 'fullName and applicationType are required.' });
  const id = generateId('cand');
  // An administrator may supply their own LALCO ID; otherwise one is derived
  // from the highest code already issued (never from a row count, so a code is
  // not reused after data has been deleted).
  let code;
  if (b.code !== undefined && String(b.code).trim() !== '') {
    const v = validateCode(b.code);
    if (!v.ok) return res.status(400).json({ error: v.error });
    code = v.code;
  } else {
    code = nextCandidateCode('LALCO');
  }
  db.prepare(
    `INSERT INTO candidates (id, code, full_name, gender, dob, nationality, phone, email, address, province,
      current_location, education, university, major, gpa, previous_employer, previous_position, years_experience,
      expected_salary, application_type, applied_department_id, applied_position_id, branch_id, application_date,
      recruitment_batch, recruiter_id, iq, status)
     VALUES (@id,@code,@fullName,@gender,@dob,@nationality,@phone,@email,@address,@province,
      @currentLocation,@education,@university,@major,@gpa,@previousEmployer,@previousPosition,@yearsExperience,
      @expectedSalary,@applicationType,@department,@position,@branch,@applicationDate,
      @recruitmentBatch,@recruiterId,@iq,'DRAFT')`
  ).run({
    id, code,
    fullName: b.fullName, gender: b.gender || null, dob: b.dob || null, nationality: b.nationality || null,
    phone: b.phone || null, email: b.email || null, address: b.address || null, province: b.province || null,
    currentLocation: b.currentLocation || null, education: b.education || null, university: b.university || null,
    major: b.major || null, gpa: b.gpa != null ? Number(b.gpa) : null, previousEmployer: b.previousEmployer || null,
    previousPosition: b.previousPosition || null, yearsExperience: b.yearsExperience || 0,
    expectedSalary: b.expectedSalary != null ? Number(b.expectedSalary) : null, applicationType: b.applicationType,
    department: lookupOrCreate('departments', b.department), position: lookupOrCreate('positions', b.position),
    branch: lookupOrCreate('branches', b.branch), applicationDate: b.applicationDate || new Date().toISOString().slice(0, 10),
    recruitmentBatch: b.recruitmentBatch || null, recruiterId: req.user.id, iq: b.iq != null ? Number(b.iq) : null,
  });
  auditFromReq(req, 'Candidate created', code, null, { customCode: b.code !== undefined && String(b.code).trim() !== '' });
  res.status(201).json({ id, code });
});

// ---- DETAIL ----
router.get('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const elig = evaluateEligibility(c, eligibilityRules());
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ? ORDER BY started_at DESC LIMIT 1').get(c.id);
  const links = db.prepare('SELECT * FROM assessment_links WHERE candidate_id = ? ORDER BY created_at DESC').all(c.id);
  let scores = null, integrity = null, answers = [];
  if (session) {
    scores = db.prepare('SELECT * FROM scores WHERE session_id = ?').get(session.id);
    integrity = db.prepare('SELECT * FROM integrity_assessments WHERE session_id = ?').get(session.id);
    const rawAnswers = db.prepare('SELECT * FROM candidate_answers WHERE session_id = ?').all(session.id);
    const questions = db.prepare("SELECT * FROM questions WHERE active = 1 AND question_family = 'GENERAL' ORDER BY order_index").all();
    answers = questions.map((q) => {
      const a = rawAnswers.find((x) => x.question_id === q.id);
      const config = JSON.parse(q.config_json);
      let breakdown = null;
      if (scores && q.type === 'CALC' && scores.calc_breakdown_json) {
        const bds = JSON.parse(scores.calc_breakdown_json);
        breakdown = bds.find((b) => b.questionId === q.id) || null;
      }
      return {
        questionId: q.id, type: q.type, category: q.category, maxMarks: q.max_marks, text: q.text,
        explanation: q.explanation,
        answer: a ? JSON.parse(a.answer_json || 'null') : null,
        timeSpentSeconds: a ? a.time_spent_seconds : 0,
        visits: a ? a.visits : 0,
        // The candidate's own "flag for review" bookmark. Shown to evaluators
        // as context for how the candidate worked — it carries no marks and
        // never affects scoring.
        flagged: a ? !!a.flagged : false,
        flaggedAt: a && a.flagged ? a.flagged_at : null,
        breakdown,
      };
    });
  }
  res.json({
    candidate: {
      ...c,
      appliedPosition: lookupName('positions', c.applied_position_id),
      appliedDepartment: lookupName('departments', c.applied_department_id),
      branch: lookupName('branches', c.branch_id),
    },
    eligibility: elig,
    session: decorateSession(session),
    liveSessionStatus: sessionLiveStatus(session),
    links: links.map((l) => ({ ...l, liveStatus: linkLiveStatus(l) })),
    scores,
    integrity,
    answers,
    settings: settings(),
  });
});

// ---- UPDATE ----
router.patch('/:id', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'), (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const allowed = ['full_name', 'gender', 'dob', 'nationality', 'phone', 'email', 'address', 'province',
    'current_location', 'education', 'university', 'major', 'gpa', 'previous_employer', 'previous_position',
    'years_experience', 'expected_salary', 'iq', 'status'];
  const updates = {};
  Object.keys(req.body || {}).forEach((k) => { if (allowed.includes(k)) updates[k] = req.body[k]; });

  // The LALCO ID may be corrected, but not once an assessment exists: the
  // candidate verifies their identity with this value, and reports and exports
  // already carry it.
  let codeChange = null;
  if (req.body && req.body.code !== undefined && String(req.body.code).trim() !== '') {
    const v = validateCode(req.body.code, { excludeId: c.id });
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (v.code !== c.code) {
      const session = db.prepare('SELECT id, status FROM assessment_sessions WHERE candidate_id = ? LIMIT 1').get(c.id);
      if (session) {
        return res.status(409).json({
          error: 'The Candidate ID cannot be changed once an assessment has been started for this candidate.',
        });
      }
      codeChange = v.code;
      updates.code = v.code;
    }
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });
  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE candidates SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: c.id });
  if (codeChange) {
    auditFromReq(req, 'CANDIDATE_CODE_CHANGED', c.code, { code: c.code }, { code: codeChange, by: req.user.name });
  }
  auditFromReq(req, 'Candidate updated', codeChange || c.code, c, updates);
  res.json({ ok: true });
});

// ---- ARCHIVE / RESTORE / PERMANENT DELETE ----
// Archiving is reversible and keeps every record. Permanent deletion is Super
// Admin only, refuses to run while an assessment is still live, and is audited
// with the counts of everything it removed.
router.post('/:id/archive', requireRole('SUPER_ADMIN', 'HR_ADMIN'), (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  if (c.archived) return res.status(409).json({ error: 'This candidate is already archived.' });
  db.prepare(`UPDATE candidates SET archived = 1, archived_at = datetime('now'), archived_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(req.user.name, c.id);
  auditFromReq(req, 'CANDIDATE_ARCHIVED', c.code, { archived: 0 }, { archived: 1, by: req.user.name });
  res.json({ ok: true, archived: true });
});

router.post('/:id/restore', requireRole('SUPER_ADMIN', 'HR_ADMIN'), (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  if (!c.archived) return res.status(409).json({ error: 'This candidate is not archived.' });
  db.prepare(`UPDATE candidates SET archived = 0, archived_at = NULL, archived_by = NULL, updated_at = datetime('now') WHERE id = ?`).run(c.id);
  auditFromReq(req, 'CANDIDATE_RESTORED', c.code, { archived: 1 }, { archived: 0, by: req.user.name });
  res.json({ ok: true, archived: false });
});

router.delete('/:id', requireRole('SUPER_ADMIN'), (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });

  // A candidate mid-assessment (including one paused by an admin) must not
  // vanish underneath them.
  const live = db.prepare(
    `SELECT id, paused_at FROM assessment_sessions WHERE candidate_id = ? AND status = 'IN_PROGRESS'`
  ).get(c.id);
  if (live) {
    return res.status(409).json({
      error: live.paused_at
        ? 'This candidate has a PAUSED assessment. Resume and finish, or terminate it, before deleting.'
        : 'This candidate has an IN_PROGRESS assessment. Terminate it before deleting.',
    });
  }

  const confirmation = String((req.body || {}).confirmation || '').trim();
  if (confirmation !== c.code) {
    return res.status(400).json({ error: `Type the candidate code (${c.code}) to confirm permanent deletion.` });
  }
  const password = String((req.body || {}).password || '');
  const actor = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.user.id);
  if (!actor || actor.role !== 'SUPER_ADMIN' || !password || !bcrypt.compareSync(password, actor.password_hash)) {
    auditFromReq(req, 'CANDIDATE_DELETE_DENIED', c.code, null, { reason: 'password re-check failed' });
    return res.status(401).json({ error: 'Super Admin password is required to permanently delete a candidate.' });
  }

  const removed = deleteCandidateData({ candidateIds: [c.id] });
  auditFromReq(req, 'CANDIDATE_DELETED', c.code, { candidate: c.full_name }, {
    performedBy: req.user.name,
    candidate: c.code,
    name: c.full_name,
    assessmentsDeleted: removed.assessments,
    answersDeleted: removed.answers,
    linksDeleted: removed.links,
  });
  res.json({ ok: true, deleted: removed, message: `${c.code} and all of their assessment data were permanently deleted.` });
});

// ---- ASSESSMENT LINKS ----
router.post('/:id/links', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'), (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const s = settings();
  // Which assessment is this invitation for? An explicit choice wins; otherwise
  // the active, non-archived one. An archived or inactive assessment can never
  // receive a new invitation.
  const requested = (req.body || {}).assessmentId;
  // Which language the candidate should see. An unsupported value is rejected
  // rather than quietly turned into English: the admin chose it deliberately
  // and must be told it did not take.
  const requestedLanguage = (req.body || {}).language;
  if (requestedLanguage !== undefined && requestedLanguage !== null && requestedLanguage !== ''
      && !isSupportedLanguage(requestedLanguage)) {
    return res.status(400).json({ error: 'Candidate language must be either English (en) or Lao (lo).' });
  }
  const language = requestedLanguage ? normaliseLanguage(requestedLanguage) : DEFAULT_LANGUAGE;
  const assessment = requested
    ? db.prepare('SELECT * FROM assessments WHERE id = ?').get(requested)
    : db.prepare(`SELECT * FROM assessments WHERE active = 1 AND COALESCE(archived,0) = 0 ORDER BY created_at LIMIT 1`).get();
  if (requested && !assessment) return res.status(404).json({ error: 'That assessment does not exist.' });
  if (assessment && assessment.archived) return res.status(409).json({ error: 'That assessment is archived and cannot receive new invitations.' });
  if (assessment && !assessment.active) return res.status(409).json({ error: 'That assessment is inactive and cannot receive new invitations.' });

  // Revoke any currently active links for this candidate; history is preserved, never deleted.
  db.prepare(`UPDATE assessment_links SET status = 'REVOKED', revoked_at = datetime('now') WHERE candidate_id = ? AND status = 'ACTIVE'`).run(c.id);
  const id = generateId('link');
  const token = generateSecureToken();
  // The assessment's own invitation window, falling back to the global setting
  // for a database that has no assessment yet.
  const expiryMinutes = assessment ? assessment.link_expiry_minutes : s.link_expiry_minutes;
  const expiresAt = new Date(Date.now() + expiryMinutes * 60000).toISOString();
  db.prepare(
    `INSERT INTO assessment_links (id, token, candidate_id, assessment_id, status, expires_at, created_by, language)
     VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`
  ).run(id, token, c.id, assessment ? assessment.id : null, expiresAt, req.user.name, language);
  if (c.status === 'DRAFT') db.prepare(`UPDATE candidates SET status = 'INVITED' WHERE id = ?`).run(c.id);
  auditFromReq(req, 'Assessment link generated', c.code, null, { token: token.slice(0, 8) + '…', expiresAt, language });
  const baseUrl = process.env.PUBLIC_EXAM_BASE_URL || (req.protocol + '://' + req.get('host'));
  // An IQ invitation opens the IQ portal. Same table, same opaque token, same
  // expiry and revoke behaviour — only the page the candidate lands on differs,
  // so the two products can never be confused for one another.
  const assessmentType = assessment ? (assessment.assessment_type || 'GENERAL_ASSESSMENT') : 'GENERAL_ASSESSMENT';
  const examPath = assessmentType === 'IQ_TEST' ? 'iq' : 'exam';
  res.status(201).json({
    id, token, expiresAt, status: 'ACTIVE', language, assessmentType,
    examUrl: `${baseUrl}/${examPath}/${token}`,
    whatsappMessage: `Dear ${c.full_name},\n\nYou are invited to complete the LALCO ${assessmentType === 'IQ_TEST' ? 'reasoning (IQ) test' : 'recruitment assessment'}.\n\nAssessment link:\n${baseUrl}/${examPath}/${token}\n\nThis invitation link expires in ${s.link_expiry_minutes} minutes. Please complete the assessment within the allocated assessment time once you begin.\n\nThank you.`,
  });
});

router.post('/links/:linkId/revoke', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'), (req, res) => {
  const link = db.prepare('SELECT * FROM assessment_links WHERE id = ?').get(req.params.linkId);
  if (!link) return res.status(404).json({ error: 'Link not found.' });
  db.prepare(`UPDATE assessment_links SET status = 'REVOKED', revoked_at = datetime('now') WHERE id = ?`).run(link.id);
  auditFromReq(req, 'Assessment link revoked', link.candidate_id);
  res.json({ ok: true });
});

// ---- ESSAY MARKING ----
router.post('/:id/essay-score', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'EVALUATOR'), (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ? ORDER BY started_at DESC LIMIT 1').get(c.id);
  if (!session) return res.status(400).json({ error: 'Candidate has no assessment session yet.' });
  const essayQ = db.prepare(`SELECT * FROM questions WHERE type = 'ESSAY' AND active = 1 LIMIT 1`).get();
  if (!essayQ) return res.status(400).json({ error: 'No essay question configured.' });
  const config = JSON.parse(essayQ.config_json);
  const rubricScores = req.body.rubricScores || {};
  let total = 0;
  config.rubric.forEach((r) => { const v = Math.max(0, Math.min(r.max, Number(rubricScores[r.key]) || 0)); total += v; });
  upsertScoreField(session.id, {
    essay_marks: total, essay_max: essayQ.max_marks, essay_breakdown_json: JSON.stringify(rubricScores),
    essay_marker: req.user.name, essay_comments: req.body.comments || '', essay_marked_at: new Date().toISOString(),
  });
  recomputeFinal(session.id);
  auditFromReq(req, 'Essay score entered', c.code, null, total);
  res.json({ ok: true, marks: total });
});

// ---- INTERVIEW MARKING ----
router.post('/:id/interview-score', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'INTERVIEWER', 'MANAGER'), (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ? ORDER BY started_at DESC LIMIT 1').get(c.id);
  if (!session) return res.status(400).json({ error: 'Candidate has no assessment session yet.' });
  const criteria = db.prepare('SELECT * FROM interview_criteria ORDER BY order_index').all();
  const scoresIn = req.body.scores || {};
  let total = 0;
  const breakdown = {};
  criteria.forEach((cr) => { const v = Math.max(0, Math.min(cr.max_marks, Number(scoresIn[cr.key]) || 0)); breakdown[cr.key] = v; total += v; });
  upsertScoreField(session.id, {
    interview_marks: total, interview_max: criteria.reduce((s, c2) => s + c2.max_marks, 0),
    interview_breakdown_json: JSON.stringify(breakdown), interview_marker: req.user.name,
    interview_comments: req.body.comments || '', interview_marked_at: new Date().toISOString(),
  });
  recomputeFinal(session.id);
  auditFromReq(req, 'Interview scored', c.code, null, total);
  res.json({ ok: true, marks: total });
});

// Adds the submission record HR needs: how the assessment ended, the scheduled
// versus actual end, how long it really took, and answered/unanswered counts.
function decorateSession(session) {
  if (!session) return null;
  let durationLabel = null;
  if (session.started_at && session.submitted_at) {
    const minutes = (parseDbDate(session.submitted_at) - parseDbDate(session.started_at)) / 60000;
    durationLabel = `${Math.round(minutes * 10) / 10} min of ${session.duration_minutes} min allowed`;
  }
  const assessment = session.assessment_id
    ? db.prepare('SELECT name FROM assessments WHERE id = ?').get(session.assessment_id)
    : null;
  return {
    ...session,
    // Which assessment was actually sat, for the record and for print.
    assessmentName: assessment ? assessment.name : null,
    displayStatus: displayStatus(session),
    submissionType: session.submission_type || null,
    submissionReason: session.submission_reason || null,
    scheduledEndAt: session.expires_at,
    actualEndAt: session.submitted_at,
    durationLabel,
    answeredCount: session.answered_count,
    unansweredCount: session.unanswered_count,
  };
}

function upsertScoreField(sessionId, fields) {
  const existing = db.prepare('SELECT id FROM scores WHERE session_id = ?').get(sessionId);
  if (existing) {
    const setClause = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE scores SET ${setClause} WHERE session_id = @sessionId`).run({ ...fields, sessionId });
  } else {
    const cols = ['id', 'session_id', ...Object.keys(fields)];
    const vals = { id: generateId('score'), session_id: sessionId, ...fields };
    db.prepare(`INSERT INTO scores (${cols.join(',')}) VALUES (${cols.map((c) => '@' + (c === 'session_id' ? 'session_id' : c)).join(',')})`).run(vals);
  }
}

function recomputeFinal(sessionId) {
  const s = db.prepare('SELECT * FROM scores WHERE session_id = ?').get(sessionId);
  if (!s) return;
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId);
  // Judged against the threshold captured when this assessment was SAT, not
  // whatever the configuration says today. Re-marking an essay later must not
  // re-decide pass/fail under rules the candidate never sat under. Legacy rows
  // with no snapshot fall back to the global setting.
  const threshold = session && session.pass_threshold != null
    ? session.pass_threshold
    : settings().pass_threshold;
  const totalMax = session && session.total_max != null ? session.total_max : 100;
  const calc = s.calc_marks || 0;
  const essay = s.essay_marks == null ? 0 : s.essay_marks;
  const interview = s.interview_marks == null ? 0 : s.interview_marks;
  const final = calc + essay + interview;
  const percentage = totalMax ? Math.round((final / totalMax) * 100) : final;
  const pass = final >= threshold ? 1 : 0;
  db.prepare('UPDATE scores SET final_marks = ?, percentage = ?, pass = ? WHERE session_id = ?').run(final, percentage, pass, sessionId);
  if (s.essay_marks != null && s.interview_marks != null) {
    const session = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId);
    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(session.candidate_id);
    const newStatus = pass ? (candidate.application_type === 'SCHOLARSHIP' ? 'SCHOLARSHIP_SELECTED' : 'PASSED') : 'FAILED';
    db.prepare(`UPDATE candidates SET status = ? WHERE id = ?`).run(newStatus, session.candidate_id);
  }
}

// ---- FAILURE ANALYSIS ----
router.get('/:id/failure-analysis', (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const elig = evaluateEligibility(c, eligibilityRules());
  if (elig.status === 'NOT_ELIGIBLE') {
    return res.json({ headline: 'NOT ELIGIBLE', detail: elig.fails.map((f) => `${f.condition}: candidate ${f.candidateValue}, required ${f.requiredValue} — ${f.reason}`) });
  }
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ? ORDER BY started_at DESC LIMIT 1').get(c.id);
  if (!session) return res.json({ headline: 'INSUFFICIENT DATA', detail: ['Insufficient assessment evidence to determine the reason.'] });
  const scores = db.prepare('SELECT * FROM scores WHERE session_id = ?').get(session.id);
  if (!scores || scores.final_marks == null) return res.json({ headline: 'INSUFFICIENT DATA', detail: ['Insufficient assessment evidence to determine the reason.'] });
  const set = settings();
  const lines = [];
  lines.push(`Final score: ${scores.final_marks}/100. Required: ${set.pass_threshold}/100.` + (scores.final_marks < set.pass_threshold ? ` Marks required: ${set.pass_threshold - scores.final_marks} additional marks.` : ' Candidate met the passing threshold.'));
  const sections = [
    { name: 'Calculation Test', got: scores.calc_marks, max: scores.calc_max },
    { name: 'Written', got: scores.essay_marks, max: scores.essay_max },
    { name: 'Interview', got: scores.interview_marks, max: scores.interview_max },
  ].filter((s) => s.got != null);
  sections.sort((a, b) => a.got / a.max - b.got / b.max);
  sections.forEach((s) => lines.push(`${s.name}: ${s.got}/${s.max} — candidate lost ${s.max - s.got} marks.`));
  const gaps = [];
  if (scores.calc_breakdown_json) {
    JSON.parse(scores.calc_breakdown_json).filter((b) => b.marks < b.max).forEach((b) => {
      const q = db.prepare('SELECT category FROM questions WHERE id = ?').get(b.questionId);
      gaps.push(`${q ? q.category : b.questionId}: ${b.reason}`);
    });
  }
  const integrity = db.prepare('SELECT * FROM integrity_assessments WHERE session_id = ?').get(session.id);
  if (integrity && integrity.risk_level !== 'Low') gaps.push(`Assessment integrity indicator: ${integrity.risk_level} risk — see Integrity tab (requires human review, not used to auto-reject).`);
  res.json({ headline: scores.final_marks >= set.pass_threshold ? 'PASSED' : 'FAILED', detail: lines, gaps });
});

module.exports = router;
