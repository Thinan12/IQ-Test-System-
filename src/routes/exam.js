const express = require('express');
const db = require('../db');
const { generateId } = require('../lib/tokens');
const { gradeAllCalc } = require('../lib/grading');
const { syncSessionInBackground, isAutoSyncEnabled } = require('../lib/googleSheets');
const { examLimiter } = require('../middleware/auth');
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(examLimiter);

function lookupName(table, id) {
  if (!id) return null;
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id);
  return row ? row.name : null;
}
function settings() { return db.prepare('SELECT * FROM settings WHERE id = 1').get(); }

// Strips everything an evaluator needs but a candidate must never receive:
// correct answers, tolerances, marking weights per step's expected value, explanations.
function sanitizeQuestionForCandidate(q) {
  const config = JSON.parse(q.config_json);
  if (q.type === 'CALC') {
    return {
      id: q.id, type: 'CALC', text: q.text, maxMarks: q.max_marks,
      parts: config.parts.map((p) => ({
        key: p.key, label: p.label,
        type: p.type === 'choice' ? 'choice' : 'number',
        options: p.type === 'choice' ? p.options : undefined,
        // marks-per-part shown so the candidate understands question weight, NOT the expected value or tolerance
        marks: p.marks,
      })),
    };
  }
  // ESSAY
  return { id: q.id, type: 'ESSAY', text: q.text, maxMarks: q.max_marks };
}

function getLinkByToken(token) {
  return db.prepare('SELECT * FROM assessment_links WHERE token = ?').get(token);
}
function liveLinkStatus(link) {
  if (link.status === 'REVOKED') return 'REVOKED';
  if (new Date(link.expires_at) < new Date() && link.status === 'ACTIVE') return 'EXPIRED';
  return link.status;
}
function logAccess(linkId, success, req) {
  db.prepare('INSERT INTO link_access_log (id, link_id, success, ip, user_agent) VALUES (?,?,?,?,?)')
    .run(generateId('acc'), linkId, success ? 1 : 0, req.ip, req.get('user-agent') || '');
  if (success) db.prepare(`UPDATE assessment_links SET first_access_at = COALESCE(first_access_at, datetime('now')) WHERE id = ?`).run(linkId);
}
function existingSessionForLink(link) {
  return db.prepare('SELECT * FROM assessment_sessions WHERE link_id = ? ORDER BY started_at DESC LIMIT 1').get(link.id);
}

// ---- GET exam intro info ----
router.get('/:token', (req, res) => {
  const link = getLinkByToken(req.params.token);
  if (!link) { return res.status(404).json({ error: 'This link is not valid.' }); }
  const session = existingSessionForLink(link);
  // Once a session exists, the LINK's own expiry no longer governs access — only the session's own duration does.
  if (session) {
    logAccess(link.id, true, req);
    return respondWithCandidateContext(req, res, link, session);
  }
  const status = liveLinkStatus(link);
  if (status !== 'ACTIVE') {
    if (status === 'EXPIRED' && link.status === 'ACTIVE') db.prepare(`UPDATE assessment_links SET status='EXPIRED' WHERE id=?`).run(link.id);
    logAccess(link.id, false, req);
    const messages = { EXPIRED: 'This assessment invitation has expired.', REVOKED: 'This assessment invitation is no longer valid.', USED: 'This assessment invitation has already been used.' };
    return res.status(410).json({ error: messages[status] || 'This assessment invitation is not currently active.' });
  }
  logAccess(link.id, true, req);
  respondWithCandidateContext(req, res, link, null);
});

function respondWithCandidateContext(req, res, link, session) {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(link.candidate_id);
  const s = settings();
  const calcCount = db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE type='CALC' AND active=1`).get().n;
  const essayCount = db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE type='ESSAY' AND active=1`).get().n;
  res.json({
    candidateName: c.full_name,
    position: lookupName('positions', c.applied_position_id) || c.applied_position_id,
    assessmentName: 'LALCO Recruitment Assessment',
    questionCount: calcCount + essayCount,
    durationMinutes: s.assessment_duration_minutes,
    verification: { requireCandidateId: !!s.require_candidate_id, requirePhone: !!s.require_phone, requireDob: !!s.require_dob },
    session: session ? { status: session.status, startedAt: session.started_at, expiresAt: session.expires_at, submittedAt: session.submitted_at } : null,
  });
}

// ---- Verify identity + Start assessment ----
router.post('/:token/start', (req, res) => {
  const link = getLinkByToken(req.params.token);
  if (!link) return res.status(404).json({ error: 'This link is not valid.' });
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(link.candidate_id);
  let session = existingSessionForLink(link);
  if (session) {
    if (session.status === 'SUBMITTED') return res.status(409).json({ error: 'This assessment has already been submitted and cannot be restarted.' });
    return res.json({ started: true, expiresAt: session.expires_at });
  }
  const status = liveLinkStatus(link);
  if (status !== 'ACTIVE') return res.status(410).json({ error: 'This assessment invitation has expired.' });

  const s = settings();
  const b = req.body || {};
  if (s.require_candidate_id && String(b.candidateCode || '').trim().toUpperCase() !== c.code.toUpperCase()) {
    return res.status(401).json({ error: 'Candidate ID does not match our records.' });
  }
  if (s.require_phone && String(b.phone || '').replace(/\D/g, '') !== String(c.phone || '').replace(/\D/g, '')) {
    return res.status(401).json({ error: 'Phone number does not match our records.' });
  }
  if (s.require_dob && String(b.dob || '') !== String(c.dob || '')) {
    return res.status(401).json({ error: 'Date of birth does not match our records.' });
  }

  const id = generateId('sess');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + s.assessment_duration_minutes * 60000).toISOString();
  db.prepare(
    `INSERT INTO assessment_sessions (id, candidate_id, link_id, started_at, duration_minutes, expires_at, status, verified)
     VALUES (?,?,?,?,?,?,'IN_PROGRESS',1)`
  ).run(id, c.id, link.id, now.toISOString(), s.assessment_duration_minutes, expiresAt);
  db.prepare(`UPDATE assessment_links SET status='USED' WHERE id=?`).run(link.id);
  db.prepare(`UPDATE candidates SET status='ASSESSMENT_STARTED' WHERE id=?`).run(c.id);
  audit({ userName: 'Candidate (public exam)', role: 'CANDIDATE', action: 'Assessment started', target: c.code, ip: req.ip });
  res.json({ started: true, expiresAt });
}
);

function requireActiveSession(req, res, next) {
  const link = getLinkByToken(req.params.token);
  if (!link) return res.status(404).json({ error: 'This link is not valid.' });
  const session = existingSessionForLink(link);
  if (!session) return res.status(400).json({ error: 'Assessment has not been started yet.' });
  if (session.status === 'SUBMITTED') return res.status(409).json({ error: 'This assessment has already been submitted.' });
  if (new Date(session.expires_at) < new Date()) return res.status(410).json({ error: 'Your assessment time has expired. Please submit now; unanswered questions will be recorded as skipped.', timeExpired: true });
  req.link = link; req.session_ = session; req.candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(link.candidate_id);
  next();
}

// ---- Get question list (sanitized) + current answers for review/navigation ----
router.get('/:token/questions', requireActiveSession, (req, res) => {
  const questions = db.prepare(`SELECT * FROM questions WHERE active = 1 ORDER BY CASE type WHEN 'CALC' THEN 0 ELSE 1 END, order_index`).all();
  const answers = db.prepare('SELECT * FROM candidate_answers WHERE session_id = ?').all(req.session_.id);
  res.json({
    questions: questions.map(sanitizeQuestionForCandidate),
    answered: answers.filter((a) => a.answer_json && a.answer_json !== '{}').map((a) => a.question_id),
    expiresAt: req.session_.expires_at,
  });
});

// ---- Get one question (sanitized) with any previously saved raw answer for prefill ----
router.get('/:token/question/:qid', requireActiveSession, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND active = 1').get(req.params.qid);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  let ans = db.prepare('SELECT * FROM candidate_answers WHERE session_id = ? AND question_id = ?').get(req.session_.id, q.id);
  if (!ans) {
    const id = generateId('ans');
    db.prepare(`INSERT INTO candidate_answers (id, session_id, question_id, started_at, visits) VALUES (?,?,?,datetime('now'),1)`).run(id, req.session_.id, q.id);
    ans = db.prepare('SELECT * FROM candidate_answers WHERE id = ?').get(id);
  } else {
    db.prepare('UPDATE candidate_answers SET visits = visits + 1 WHERE id = ?').run(ans.id);
  }
  res.json({ question: sanitizeQuestionForCandidate(q), savedAnswer: ans.answer_json ? JSON.parse(ans.answer_json) : null });
});

// ---- Save / autosave an answer ----
router.post('/:token/answer', requireActiveSession, (req, res) => {
  const { questionId, answer, timeSpentDeltaSeconds } = req.body || {};
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND active = 1').get(questionId);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  const existing = db.prepare('SELECT * FROM candidate_answers WHERE session_id = ? AND question_id = ?').get(req.session_.id, questionId);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      `UPDATE candidate_answers SET answer_json=?, last_modified_at=?, first_answered_at=COALESCE(first_answered_at, ?),
       time_spent_seconds = time_spent_seconds + ? WHERE id = ?`
    ).run(JSON.stringify(answer), now, now, Math.max(0, Number(timeSpentDeltaSeconds) || 0), existing.id);
  } else {
    const id = generateId('ans');
    db.prepare(
      `INSERT INTO candidate_answers (id, session_id, question_id, answer_json, started_at, first_answered_at, last_modified_at, time_spent_seconds, visits)
       VALUES (?,?,?,?,?,?,?,?,1)`
    ).run(id, req.session_.id, questionId, JSON.stringify(answer), now, now, now, Math.max(0, Number(timeSpentDeltaSeconds) || 0));
  }
  res.json({ ok: true });
});

// ---- Integrity signal reporting (paste / focus events) ----
router.post('/:token/event', requireActiveSession, (req, res) => {
  const { questionId, type, meta } = req.body || {};
  if (!['PASTE', 'FOCUS_CHANGE', 'VISIBILITY_CHANGE'].includes(type)) return res.status(400).json({ error: 'Unknown event type.' });
  db.prepare('INSERT INTO answer_events (id, session_id, question_id, type, meta_json) VALUES (?,?,?,?,?)')
    .run(generateId('evt'), req.session_.id, questionId || null, type, JSON.stringify(meta || {}));
  res.json({ ok: true });
});

// ---- Submit ----
router.post('/:token/submit', requireActiveSession, (req, res) => {
  const session = req.session_, candidate = req.candidate;
  const questions = db.prepare('SELECT * FROM questions WHERE active = 1').all().map((q) => ({ ...q, config: JSON.parse(q.config_json) }));
  const answers = db.prepare('SELECT * FROM candidate_answers WHERE session_id = ?').all(session.id);
  const answersByQ = {}; answers.forEach((a) => { answersByQ[a.question_id] = a; });

  const calcResult = gradeAllCalc(questions, answersByQ);

  // Integrity risk from raw events collected during the session.
  const events = db.prepare('SELECT * FROM answer_events WHERE session_id = ?').all(session.id);
  const pasteEvents = events.filter((e) => e.type === 'PASTE');
  const focusChanges = events.filter((e) => e.type === 'FOCUS_CHANGE' || e.type === 'VISIBILITY_CHANGE').length;
  const largestPaste = pasteEvents.reduce((m, e) => Math.max(m, (JSON.parse(e.meta_json || '{}').length || 0)), 0);
  const evidence = [];
  if (largestPaste > 0) evidence.push(`Large text insertion detected. Candidate pasted ${largestPaste} characters into an answer field.`);
  if (focusChanges > 0) evidence.push(`Candidate changed browser focus ${focusChanges} times during the assessment.`);
  let risk = 'Low';
  if (largestPaste >= 500 || pasteEvents.length >= 3) risk = 'High';
  else if (largestPaste > 0 || pasteEvents.length >= 1 || focusChanges >= 5) risk = 'Medium';

  const now = new Date().toISOString();

  // Everything that makes the submission real happens in ONE transaction:
  // the session lock, the marks and the integrity record either all land in
  // SQLite or none of them do. Google Sheets is deliberately outside it.
  const commitSubmission = db.transaction(() => {
    db.prepare(
      `UPDATE assessment_sessions SET submitted_at = ?, status = 'SUBMITTED', google_sync_status = ? WHERE id = ?`
    ).run(now, isAutoSyncEnabled() ? 'PENDING' : 'NOT_REQUESTED', session.id);
    db.prepare(`UPDATE candidates SET status = 'INTERVIEW_PENDING' WHERE id = ?`).run(candidate.id);

    db.prepare(
      `INSERT INTO scores (id, session_id, calc_marks, calc_max, calc_breakdown_json) VALUES (?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET calc_marks=excluded.calc_marks, calc_max=excluded.calc_max, calc_breakdown_json=excluded.calc_breakdown_json`
    ).run(generateId('score'), session.id, calcResult.marks, calcResult.max, JSON.stringify(calcResult.breakdown));

    db.prepare(
      `INSERT INTO integrity_assessments (id, session_id, paste_events, focus_changes, largest_paste, risk_level, evidence_json)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET paste_events=excluded.paste_events, focus_changes=excluded.focus_changes, largest_paste=excluded.largest_paste, risk_level=excluded.risk_level, evidence_json=excluded.evidence_json`
    ).run(generateId('integ'), session.id, pasteEvents.length, focusChanges, largestPaste, risk, JSON.stringify(evidence));
  });
  commitSubmission();

  audit({ userName: 'Candidate (public exam)', role: 'CANDIDATE', action: 'Assessment submitted', target: candidate.code, ip: req.ip });

  // The result is already safe in SQLite. Reporting to Google Sheets happens
  // after the response, never blocks the candidate, and leaves the session at
  // google_sync_status='PENDING' if Google is unreachable so an administrator
  // can retry. The candidate is never shown a storage or sync error.
  res.json({ ok: true, submittedAt: now });
  syncSessionInBackground(session.id);
});

module.exports = router;
