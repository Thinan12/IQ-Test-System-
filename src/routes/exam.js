const express = require('express');
const db = require('../db');
const { generateId } = require('../lib/tokens');
const { finalizeSession, finalizeIfExpired, isExpired, displayStatus } = require('../lib/finalize');
const { isPaused, linkLiveStatus, remainingSeconds } = require('../lib/examControl');
const { resolveQuestionText, normaliseLanguage, DEFAULT_LANGUAGE } = require('../lib/questionText');
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
function sanitizeQuestionForCandidate(q, language) {
  const config = JSON.parse(q.config_json);
  // English is the source; Lao is shown only when a human has APPROVED it.
  const t = resolveQuestionText(q, language);

  const common = {
    id: q.id,                    // same question ID in either language
    text: t.text,
    maxMarks: q.max_marks,
    language: t.language,
    // Lets the portal say "Lao translation not available" rather than showing
    // English while implying it is Lao.
    laoUnavailable: t.laoMissing,
  };

  if (q.type === 'CALC') {
    return {
      ...common,
      type: 'CALC',
      parts: config.parts.map((p) => ({
        key: p.key,
        label: t.partLabel(p),
        type: p.type === 'choice' ? 'choice' : 'number',
        // {value,label}: VALUE is the canonical English string grading compares
        // against, so translating a label can never change a mark.
        options: p.type === 'choice' ? t.partOptions(p) : undefined,
        // marks-per-part shown so the candidate understands question weight, NOT the expected value or tolerance
        marks: p.marks,
      })),
    };
  }
  // ESSAY — marking is unchanged; only the stem is translated.
  return { ...common, type: 'ESSAY' };
}

function getLinkByToken(token) {
  return db.prepare('SELECT * FROM assessment_links WHERE token = ?').get(token);
}
function liveLinkStatus(link) {
  return linkLiveStatus(link);
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
  let session = existingSessionForLink(link);
  // Once a session exists, the LINK's own expiry no longer governs access — only the session's own duration does.
  if (session) {
    logAccess(link.id, true, req);
    // Reopening the link after the deadline finalizes it, so the candidate sees
    // the TIME EXPIRED screen rather than a live exam.
    if (session.status === 'IN_PROGRESS' && isExpired(session)) {
      finalizeIfExpired(session, { ip: req.ip });
      session = existingSessionForLink(link);
    }
    return respondWithCandidateContext(req, res, link, session);
  }
  const status = liveLinkStatus(link);
  if (status !== 'ACTIVE') {
    if (status === 'EXPIRED' && link.status === 'ACTIVE' && !link.disabled_at) db.prepare(`UPDATE assessment_links SET status='EXPIRED' WHERE id=?`).run(link.id);
    logAccess(link.id, false, req);
    const messages = {
      EXPIRED: 'This assessment invitation has expired.',
      REVOKED: 'This assessment invitation is no longer valid.',
      DISABLED: 'This assessment invitation has been temporarily disabled. Please contact the recruitment team.',
      USED: 'This assessment invitation has already been used.',
    };
    return res.status(410).json({ error: messages[status] || 'This assessment invitation is not currently active.', linkStatus: status });
  }
  logAccess(link.id, true, req);
  respondWithCandidateContext(req, res, link, null);
});

function respondWithCandidateContext(req, res, link, session) {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(link.candidate_id);
  const s = settings();
  // What the candidate is told must describe the assessment this invitation is
  // for. Reporting the global default here told people the wrong duration and
  // the wrong number of questions as soon as assessments could differ.
  const assessment = link.assessment_id
    ? db.prepare('SELECT * FROM assessments WHERE id = ?').get(link.assessment_id)
    : db.prepare(`SELECT * FROM assessments WHERE active = 1 AND COALESCE(archived,0) = 0 ORDER BY created_at LIMIT 1`).get();
  const attachedCount = assessment
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM assessment_questions aq JOIN questions q ON q.id = aq.question_id
          WHERE aq.assessment_id = ? AND q.active = 1 AND COALESCE(q.archived,0) = 0`
      ).get(assessment.id).n
    : 0;
  const calcCount = db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE type='CALC' AND active=1`).get().n;
  const essayCount = db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE type='ESSAY' AND active=1`).get().n;
  res.json({
    candidateName: c.full_name,
    position: lookupName('positions', c.applied_position_id) || c.applied_position_id,
    assessmentName: assessment ? assessment.name : 'LALCO Recruitment Assessment',
    questionCount: attachedCount || calcCount + essayCount,
    durationMinutes: assessment ? assessment.duration_minutes : s.assessment_duration_minutes,
    verification: { requireCandidateId: !!s.require_candidate_id, requirePhone: !!s.require_phone, requireDob: !!s.require_dob },
    session: session ? {
      // `status` is what the candidate's portal keys off: SUBMITTED for a manual
      // submission, AUTO_SUBMITTED when the server finalized it on time expiry.
      status: displayStatus(session),
      lifecycleStatus: session.status,
      paused: isPaused(session),
      remainingSeconds: remainingSeconds(session),
      reason: session.submission_reason || null,
      autoSubmitted: session.submission_type === 'AUTO_SUBMITTED',
      startedAt: session.started_at,
      scheduledEndAt: session.expires_at,
      expiresAt: session.expires_at,
      submittedAt: session.submitted_at,
      answered: session.answered_count,
      unanswered: session.unanswered_count,
      language: session.language || DEFAULT_LANGUAGE,
    } : null,
  });
}

// ---- Verify identity + Start assessment ----
router.post('/:token/start', (req, res) => {
  const link = getLinkByToken(req.params.token);
  if (!link) return res.status(404).json({ error: 'This link is not valid.' });
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(link.candidate_id);
  let session = existingSessionForLink(link);
  if (session) {
    if (session.status === 'IN_PROGRESS' && isExpired(session)) {
      finalizeIfExpired(session, { ip: req.ip });
      session = existingSessionForLink(link);
    }
    if (session.status === 'SUBMITTED') {
      return res.status(409).json({
        error: session.submission_type === 'AUTO_SUBMITTED'
          ? 'Your assessment time has ended. Your saved answers have been submitted automatically.'
          : 'This assessment has already been submitted and cannot be restarted.',
        status: displayStatus(session),
        reason: session.submission_reason || null,
        submittedAt: session.submitted_at,
      });
    }
    return res.json({ started: true, expiresAt: session.expires_at, scheduledEndAt: session.expires_at });
  }
  const status = liveLinkStatus(link);
  if (status !== 'ACTIVE') return res.status(410).json({ error: 'This assessment invitation has expired.' });

  const s = settings();
  // The assessment this invitation was issued for governs the duration and the
  // scoring this attempt is judged under.
  const assessment = link.assessment_id
    ? db.prepare('SELECT * FROM assessments WHERE id = ?').get(link.assessment_id)
    : db.prepare(`SELECT * FROM assessments WHERE active = 1 AND COALESCE(archived,0) = 0 ORDER BY created_at LIMIT 1`).get();
  if (assessment && assessment.archived) {
    return res.status(410).json({ error: 'This assessment is no longer available. Please contact the recruitment team.' });
  }
  const durationMinutes = assessment ? assessment.duration_minutes : s.assessment_duration_minutes;
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
  const expiresAt = new Date(now.getTime() + durationMinutes * 60000).toISOString();
  // The language chosen on the instructions screen carries into the session.
  const startLanguage = normaliseLanguage(b.language);
  db.prepare(
    `INSERT INTO assessment_sessions (id, candidate_id, link_id, assessment_id, started_at, duration_minutes,
       expires_at, status, verified, language, pass_threshold, total_max)
     VALUES (?,?,?,?,?,?,?,'IN_PROGRESS',1,?,?,?)`
  ).run(
    id, c.id, link.id, assessment ? assessment.id : null, now.toISOString(), durationMinutes,
    expiresAt, startLanguage,
    // Snapshot: this attempt is judged by these numbers for ever.
    assessment ? assessment.pass_threshold : s.pass_threshold,
    assessment ? assessment.total_max : 100
  );
  db.prepare(`UPDATE assessment_links SET status='USED' WHERE id=?`).run(link.id);
  db.prepare(`UPDATE candidates SET status='ASSESSMENT_STARTED' WHERE id=?`).run(c.id);
  audit({ userName: 'Candidate (public exam)', role: 'CANDIDATE', action: 'Assessment started', target: c.code, ip: req.ip });
  res.json({ started: true, expiresAt, scheduledEndAt: expiresAt, language: startLanguage });
}
);

// Every candidate-facing request re-checks token validity, session ownership,
// session state and the SERVER clock against scheduled_end_at. If the deadline
// has passed, the assessment is finalized here and now — the candidate is never
// asked to press anything for that to happen.
function requireActiveSession(req, res, next) {
  const link = getLinkByToken(req.params.token);
  if (!link) return res.status(404).json({ error: 'This link is not valid.' });
  const session = existingSessionForLink(link);
  if (!session) return res.status(400).json({ error: 'Assessment has not been started yet.' });

  if (session.status === 'IN_PROGRESS' && isExpired(session)) {
    const result = finalizeIfExpired(session, { ip: req.ip });
    const counts = (result && result.counts) || {};
    return res.status(410).json({
      error: 'Your assessment time has ended. Your saved answers have been submitted automatically.',
      timeExpired: true,
      autoSubmitted: true,
      status: 'AUTO_SUBMITTED',
      reason: 'TIME_EXPIRED',
      submittedAt: result ? result.submittedAt : session.submitted_at,
      answered: counts.answered,
      unanswered: counts.unanswered,
    });
  }

  if (session.status === 'SUBMITTED') {
    return res.status(409).json({
      error: 'This assessment has already been submitted.',
      status: displayStatus(session),
      reason: session.submission_reason || null,
      submittedAt: session.submitted_at,
    });
  }

  // Paused by an administrator: progress stops and the countdown is frozen.
  if (isPaused(session)) {
    return res.status(423).json({
      error: 'Your assessment has been paused by the administrator. Please wait — your answers and remaining time are safe.',
      paused: true,
      status: 'PAUSED',
      remainingSeconds: remainingSeconds(session),
    });
  }

  req.link = link; req.session_ = session; req.candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(link.candidate_id);
  next();
}

// ---- Get question list (sanitized) + current answers for review/navigation ----
router.get('/:token/questions', requireActiveSession, (req, res) => {
  // The questions this assessment actually asks, in the order it asks them.
  // Falls back to "every active question" for a session with no assessment
  // (a database predating assessment management).
  const assessmentId = req.session_.assessment_id;
  const attached = assessmentId
    ? db.prepare(
        `SELECT q.* FROM assessment_questions aq
           JOIN questions q ON q.id = aq.question_id
          WHERE aq.assessment_id = ? AND q.active = 1 AND COALESCE(q.archived,0) = 0
          ORDER BY aq.order_index`
      ).all(assessmentId)
    : [];
  // An archived question is withdrawn from new assessments but never deleted,
  // so completed assessments keep referencing it.
  const questions = attached.length
    ? attached
    : db.prepare(`SELECT * FROM questions WHERE active = 1 AND COALESCE(archived,0) = 0 ORDER BY CASE type WHEN 'CALC' THEN 0 ELSE 1 END, order_index`).all();
  const answers = db.prepare('SELECT * FROM candidate_answers WHERE session_id = ?').all(req.session_.id);
  const lang = req.session_.language || DEFAULT_LANGUAGE;
  res.json({
    language: lang,
    questions: questions.map((q) => sanitizeQuestionForCandidate(q, lang)),
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
  res.json({
    question: sanitizeQuestionForCandidate(q, req.session_.language || DEFAULT_LANGUAGE),
    savedAnswer: ans.answer_json ? JSON.parse(ans.answer_json) : null,
  });
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

// ---- Language switch ----
// Presentation only. Same session, same question IDs, same saved answers, same
// deadline, same marking — and it never submits anything.
router.post('/:token/language', requireActiveSession, (req, res) => {
  const language = normaliseLanguage((req.body || {}).language);
  const before = req.session_;

  db.prepare('UPDATE assessment_sessions SET language = ? WHERE id = ?').run(language, before.id);

  const after = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(before.id);
  res.json({
    ok: true,
    language,
    // Echoed back so the client can verify nothing moved.
    expiresAt: after.expires_at,
    scheduledEndAt: after.expires_at,
    deadlineUnchanged: after.expires_at === before.expires_at,
    status: after.status,
  });
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
// Used both by the candidate pressing Submit and by the client's countdown
// reaching zero (which sends ?auto=1). Either way the server decides what the
// submission actually is: if the deadline has already passed it is recorded as
// AUTO_SUBMITTED / TIME_EXPIRED regardless of what the browser claims.
router.post('/:token/submit', (req, res) => {
  const link = getLinkByToken(req.params.token);
  if (!link) return res.status(404).json({ error: 'This link is not valid.' });
  const session = existingSessionForLink(link);
  if (!session) return res.status(400).json({ error: 'Assessment has not been started yet.' });

  if (session.status === 'SUBMITTED') {
    // Idempotent: a retry, a double tap, or a client auto-submit racing the
    // server sweep all land here and change nothing.
    return res.status(409).json({
      error: 'This assessment has already been submitted.',
      alreadySubmitted: true,
      status: displayStatus(session),
      reason: session.submission_reason || null,
      submittedAt: session.submitted_at,
      answered: session.answered_count,
      unanswered: session.unanswered_count,
    });
  }

  const expired = isExpired(session);
  const result = finalizeSession(session.id, { auto: expired, ip: req.ip });

  if (!result.finalized && result.alreadyFinalized) {
    return res.status(409).json({
      error: 'This assessment has already been submitted.',
      alreadySubmitted: true,
      status: displayStatus(result.session),
      reason: result.session.submission_reason || null,
      submittedAt: result.session.submitted_at,
    });
  }

  res.json({
    ok: true,
    submittedAt: result.submittedAt,
    status: displayStatus(result.session),
    reason: result.session.submission_reason,
    autoSubmitted: expired,
    answered: result.counts ? result.counts.answered : null,
    unanswered: result.counts ? result.counts.unanswered : null,
  });
});

module.exports = router;
