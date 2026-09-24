const express = require('express');
const db = require('../db');
const { generateId } = require('../lib/tokens');
const { finalizeSession, finalizeIfExpired, isExpired, displayStatus } = require('../lib/finalize');
const { isPaused, linkLiveStatus, remainingSeconds } = require('../lib/examControl');
const { resolveQuestionText, normaliseLanguage, DEFAULT_LANGUAGE } = require('../lib/questionText');
const { examLimiter, flagLimiter } = require('../middleware/auth');
const selection = require('../lib/questionSelection');
const profile = require('../lib/candidateProfile');
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(examLimiter);

function lookupName(table, id) {
  if (!id) return null;
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id);
  return row ? row.name : null;
}
function settings() { return db.prepare('SELECT * FROM settings WHERE id = 1').get(); }

// Put a choice part's options into THIS attempt's order. `optionOrder` is a
// list of canonical values; anything the attempt does not mention keeps its
// configured position at the end. The canonical value travels with each option
// and is what the answer is stored and marked by, so reordering what the
// candidate sees can never change a mark, and two candidates who both answer
// correctly both score, whatever order they saw.
function orderOptions(options, optionOrder) {
  if (!Array.isArray(options) || !Array.isArray(optionOrder) || !optionOrder.length) return options;
  const byValue = new Map(options.map((o) => [String(o.value), o]));
  const out = [];
  optionOrder.forEach((v) => {
    const o = byValue.get(String(v));
    if (o) { out.push(o); byValue.delete(String(v)); }
  });
  options.forEach((o) => { if (byValue.has(String(o.value))) out.push(o); });
  return out;
}

// Strips everything an evaluator needs but a candidate must never receive:
// correct answers, tolerances, marking weights per step's expected value, explanations.
function sanitizeQuestionForCandidate(q, language, optionOrder) {
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
    // The reasoning category of an IQ question. Shown to the candidate on
    // purpose ("Numerical reasoning"), so it is not sensitive: it says what
    // KIND of question this is, never what the answer is. NULL for a
    // recruitment question, which has no reasoning category.
    category: q.iq_category || undefined,
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
        options: p.type === 'choice' ? orderOptions(t.partOptions(p), optionOrder) : undefined,
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

// Name of the assessment a session was sat under, for the candidate receipt.
function startedAssessmentName(session) {
  if (!session || !session.assessment_id) return 'LALCO Recruitment Assessment';
  const a = db.prepare('SELECT name FROM assessments WHERE id = ?').get(session.assessment_id);
  return a ? a.name : 'LALCO Recruitment Assessment';
}

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
  const calcCount = db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE type='CALC' AND active=1 AND question_family='GENERAL'`).get().n;
  const essayCount = db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE type='ESSAY' AND active=1 AND question_family='GENERAL'`).get().n;
  res.json({
    candidateName: c.full_name,
    // The LALCO ID is released only once a session exists — that is, only after
    // the candidate proved they already knew it at /start. Someone who merely
    // holds the link never learns it from here.
    candidateCode: session ? c.code : undefined,
    position: lookupName('positions', c.applied_position_id) || c.applied_position_id,
    assessmentName: assessment ? assessment.name : 'LALCO Recruitment Assessment',
    questionCount: (session && selection.sessionIsSelected(session.id))
      ? selection.sessionSelection(session.id).length
      : (selection.plannedQuestionCount(assessment) || attachedCount || calcCount + essayCount),
    durationMinutes: assessment ? assessment.duration_minutes : s.assessment_duration_minutes,
    verification: { requireCandidateId: !!s.require_candidate_id, requirePhone: !!s.require_phone, requireDob: !!s.require_dob },
    // The language this invitation was generated for. The portal opens in it
    // before any session exists, so the very first screen a candidate sees is
    // already in the right language. They can still switch.
    linkLanguage: normaliseLanguage(link.language),
    // Which product this invitation is for, so the portal knows whether to
    // present a recruitment assessment or an IQ test. It carries no answer
    // key, no marking rule and no internal id.
    assessmentType: assessment ? (assessment.assessment_type || 'GENERAL_ASSESSMENT') : 'GENERAL_ASSESSMENT',
    // The candidate's own profile, so the portal shows the welcome/profile step
    // first and can prefill it on a reopen. It is this candidate's own data and
    // nothing else: no database id, no score, no other candidate.
    profile: profile.profileForCandidate(c),
    profileStatus: profile.profileStatus(c),
    graduateFromOptions: profile.GRADUATE_FROM,
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

// ---- Candidate profile ----
// Saved BEFORE the assessment starts, and saved against the candidate the
// invitation already belongs to: reopening a link updates that record rather
// than creating a second one. Nothing here can name a different candidate —
// the token decides who this is, not the request body.
router.post('/:token/profile', (req, res) => {
  const link = getLinkByToken(req.params.token);
  if (!link) return res.status(404).json({ error: 'This link is not valid.' });
  // An invitation that can no longer be used cannot be used to edit a record.
  const status = liveLinkStatus(link);
  const session = existingSessionForLink(link);
  if (!session && status !== 'ACTIVE') {
    return res.status(410).json({ error: 'This assessment invitation has expired.' });
  }
  // Once the assessment is finished the record is the assessment's history.
  if (session && session.status === 'SUBMITTED') {
    return res.status(409).json({ error: 'This assessment has already been submitted.' });
  }

  const { errors, values } = profile.validateProfile(req.body);
  if (errors.length) {
    return res.status(400).json({ error: errors[0].message, errors });
  }
  const saved = profile.saveProfile(link.candidate_id, values);
  if (!saved) return res.status(404).json({ error: 'This link is not valid.' });
  audit({
    userName: 'Candidate (public exam)', role: 'CANDIDATE',
    action: 'Candidate profile saved', target: saved.code, ip: req.ip,
  });
  res.json({
    ok: true,
    profile: profile.profileForCandidate(saved),
    profileStatus: profile.profileStatus(saved),
  });
});

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
    return res.json({ started: true, expiresAt: session.expires_at, scheduledEndAt: session.expires_at, candidateCode: c.code, assessmentName: startedAssessmentName(session) });
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

  // The question set has to be satisfiable BEFORE anything is written. A pool
  // too small for the configuration is a misconfiguration, not a candidate
  // problem, so the attempt is refused whole rather than started short.
  // The profile comes first: the assessment cannot start until the candidate
  // has given the information the recruitment record needs.
  if (profile.profileStatus(c) !== 'PROFILE_COMPLETED') {
    return res.status(428).json({
      error: 'Please complete your profile before starting.',
      profileRequired: true,
    });
  }

  const selectionProblems = selection.validateSelection(assessment);
  if (selectionProblems.length) {
    return res.status(409).json({
      error: 'This assessment is not ready to be sat. Please contact the recruitment team.',
      // The administrator's detail, not the candidate's: it names no question,
      // no answer and no id, only how many were needed and how many exist.
      configurationError: selectionProblems[0],
      configurationErrors: selectionProblems,
    });
  }

  const id = generateId('sess');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMinutes * 60000).toISOString();
  // The language chosen on the instructions screen carries into the session.
  // When the candidate expressed no preference, the language the ADMIN chose
  // when generating the invitation applies, so a Lao invitation opens and is
  // sat in Lao without the candidate doing anything. Either way this is
  // presentation only: the deadline, answers and marking are untouched.
  const startLanguage = normaliseLanguage(b.language || link.language);
  // The attempt and the questions it consists of are written together. If the
  // draw cannot be satisfied the whole thing rolls back, so there is never a
  // session with a partial question set for somebody to sit.
  try {
    db.transaction(() => {
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
      // Decided ONCE, here. Everything the candidate does afterwards reads
      // these rows; nothing re-runs the draw.
      if (assessment && selection.selectionConfigFor(assessment).enabled) {
        selection.materializeSelection(id, assessment);
      }
      db.prepare(`UPDATE assessment_links SET status='USED' WHERE id=?`).run(link.id);
      db.prepare(`UPDATE candidates SET status='ASSESSMENT_STARTED' WHERE id=?`).run(c.id);
    })();
  } catch (err) {
    if (err instanceof selection.SelectionError) {
      return res.status(409).json({
        error: 'This assessment is not ready to be sat. Please contact the recruitment team.',
        configurationError: err.message,
      });
    }
    throw err;
  }
  audit({ userName: 'Candidate (public exam)', role: 'CANDIDATE', action: 'Assessment started', target: c.code, ip: req.ip });
  res.json({
    started: true, expiresAt, scheduledEndAt: expiresAt, language: startLanguage,
    assessmentType: assessment ? (assessment.assessment_type || 'GENERAL_ASSESSMENT') : 'GENERAL_ASSESSMENT',
    // Echoed back so the submission receipt can identify the candidate without
    // needing a page reload to repopulate it.
    candidateCode: c.code,
    assessmentName: assessment ? assessment.name : 'LALCO Recruitment Assessment',
  });
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

// Which bank this sitting draws on. An IQ item is a CALC question with one
// choice part, so family is the only thing separating the two products inside
// the questions table.
function familyForSession(session) {
  const asmt = session.assessment_id
    ? db.prepare('SELECT assessment_type FROM assessments WHERE id = ?').get(session.assessment_id)
    : null;
  return asmt && asmt.assessment_type === 'IQ_TEST' ? 'IQ' : 'GENERAL';
}

// The questions this assessment actually asks, in the order it asks them.
// Falls back to "every active question" for a session with no assessment
// (a database predating assessment management). This is also the authority on
// which questions a session is allowed to touch at all.
// The option order stored for this attempt, if any. Comes from the joined
// session_questions row, so it is per attempt and never per browser.
function parseOptionOrder(q) {
  if (!q || !q.sq_option_order_json) return null;
  try {
    const parsed = JSON.parse(q.sq_option_order_json);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) { return null; }
}

// The one question this attempt may see under this id. When the attempt has a
// materialised set, belonging to that set is the only thing that qualifies: a
// candidate cannot reach a question they were not given by sending its id, and
// cannot answer one either.
function questionForSession(session, questionId) {
  const isSelected = selection.sessionIsSelected(session.id);
  if (isSelected && !selection.sessionHasQuestion(session.id, questionId)) return null;
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND active = 1 AND question_family = ?')
    .get(questionId, familyForSession(session));
  if (!q) return null;
  if (isSelected) {
    const row = db.prepare(
      'SELECT option_order_json FROM session_questions WHERE session_id = ? AND question_id = ?'
    ).get(session.id, questionId);
    if (row) q.sq_option_order_json = row.option_order_json;
  }
  return q;
}

function questionsForSession(session) {
  // An attempt with a materialised set is answered by that set and nothing
  // else. These rows are written once, when the attempt is initialised, so a
  // reload, a language switch, reopening the link or navigating cannot change
  // what this candidate is asked.
  const selected = selection.sessionQuestions(session.id);
  if (selected.length) return selected;

  const attached = session.assessment_id
    ? db.prepare(
        `SELECT q.* FROM assessment_questions aq
           JOIN questions q ON q.id = aq.question_id
          WHERE aq.assessment_id = ? AND q.active = 1 AND COALESCE(q.archived,0) = 0
          ORDER BY aq.order_index`
      ).all(session.assessment_id)
    : [];
  // An archived question is withdrawn from new assessments but never deleted,
  // so completed assessments keep referencing it.
  return attached.length
    ? attached
    : db.prepare(
        `SELECT * FROM questions
          WHERE active = 1 AND COALESCE(archived,0) = 0 AND question_family = ?
          ORDER BY CASE type WHEN 'CALC' THEN 0 ELSE 1 END, order_index`
      ).all(familyForSession(session));
}

// ---- Get question list (sanitized) + current answers for review/navigation ----
router.get('/:token/questions', requireActiveSession, (req, res) => {
  const questions = questionsForSession(req.session_);
  const answers = db.prepare('SELECT * FROM candidate_answers WHERE session_id = ?').all(req.session_.id);
  const lang = req.session_.language || DEFAULT_LANGUAGE;
  const asmt = req.session_.assessment_id
    ? db.prepare('SELECT assessment_type FROM assessments WHERE id = ?').get(req.session_.assessment_id)
    : null;
  res.json({
    language: lang,
    assessmentType: asmt ? (asmt.assessment_type || 'GENERAL_ASSESSMENT') : 'GENERAL_ASSESSMENT',
    questions: questions.map((q) => sanitizeQuestionForCandidate(q, lang, parseOptionOrder(q))),
    answered: answers.filter((a) => a.answer_json && a.answer_json !== '{}').map((a) => a.question_id),
    // Flags travel with the question list, so they survive a reload, a
    // reconnect, navigation and a language switch without a separate request.
    flagged: answers.filter((a) => a.flagged).map((a) => a.question_id),
    expiresAt: req.session_.expires_at,
  });
});

// ---- Get one question (sanitized) with any previously saved raw answer for prefill ----
router.get('/:token/question/:qid', requireActiveSession, (req, res) => {
  const q = questionForSession(req.session_, req.params.qid);
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
    question: sanitizeQuestionForCandidate(q, req.session_.language || DEFAULT_LANGUAGE, parseOptionOrder(q)),
    savedAnswer: ans.answer_json ? JSON.parse(ans.answer_json) : null,
    flagged: !!ans.flagged,
    flaggedAt: ans.flagged ? ans.flagged_at : null,
  });
});

// ---------------------------------------------------------------- FLAGGING
// "Flag for review" is the candidate's own bookmark. It is deliberately inert:
// it never touches the answer, the marks, the clock, the deadline, the order
// the questions are asked in, or whether the assessment is submitted.
//
// Authorization is the exam token itself, which requireActiveSession resolves
// to exactly one link -> one session -> one candidate. A candidate therefore
// cannot address another candidate's session, and the question must belong to
// the assessment that session is sitting.
function questionForFlag(req, res) {
  const questionId = String((req.body || {}).questionId || '');
  if (!questionId) { res.status(400).json({ error: 'A question is required.' }); return null; }
  const allowed = questionsForSession(req.session_).some((q) => q.id === questionId);
  if (!allowed) {
    // Same answer whether the question is someone else's, archived, or
    // invented: nothing is confirmed about questions outside this assessment.
    res.status(404).json({ error: 'That question is not part of this assessment.' });
    return null;
  }
  return questionId;
}

function setFlag(req, res, flagged) {
  const questionId = questionForFlag(req, res);
  if (!questionId) return;

  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM candidate_answers WHERE session_id = ? AND question_id = ?')
    .get(req.session_.id, questionId);

  // Already in the requested state: acknowledge, write nothing, audit nothing.
  // A candidate tapping the button repeatedly cannot flood the table or the
  // audit trail.
  if (existing && !!existing.flagged === flagged) {
    return res.json({ ok: true, questionId, flagged, changed: false, flaggedAt: existing.flagged_at || null });
  }

  if (existing) {
    // Names ONLY flag columns. An answer being autosaved at the same moment
    // cannot be clobbered by flagging, and time_spent/visits are untouched.
    db.prepare('UPDATE candidate_answers SET flagged = ?, flagged_at = ?, flag_changed_at = ? WHERE id = ?')
      .run(flagged ? 1 : 0, flagged ? now : null, now, existing.id);
  } else {
    // Flagging a question before typing anything into it: the row is created
    // with no answer, exactly as visiting the question would.
    db.prepare(
      `INSERT INTO candidate_answers (id, session_id, question_id, started_at, visits, flagged, flagged_at, flag_changed_at)
       VALUES (?,?,?,?,0,?,?,?)`
    ).run(generateId('ans'), req.session_.id, questionId, now, flagged ? 1 : 0, flagged ? now : null, now);
  }

  // Audited as the candidate, identified by their LALCO code — never by a
  // token, and no secret of any kind is recorded.
  audit({
    userName: req.candidate ? req.candidate.full_name : 'Candidate',
    role: 'CANDIDATE',
    action: flagged ? 'QUESTION_FLAGGED' : 'QUESTION_UNFLAGGED',
    target: req.candidate ? req.candidate.code : req.session_.id,
    oldValue: { flagged: !flagged },
    newValue: { flagged, questionId, sessionId: req.session_.id, at: now },
    ip: req.ip,
  });

  res.json({ ok: true, questionId, flagged, changed: true, flaggedAt: flagged ? now : null });
}

router.post('/:token/flag', flagLimiter, requireActiveSession, (req, res) => setFlag(req, res, true));
router.post('/:token/unflag', flagLimiter, requireActiveSession, (req, res) => setFlag(req, res, false));

// ---- Current flag state for this session ----
router.get('/:token/flags', requireActiveSession, (req, res) => {
  const rows = db.prepare(
    'SELECT question_id, flagged_at FROM candidate_answers WHERE session_id = ? AND flagged = 1'
  ).all(req.session_.id);
  res.json({
    flagged: rows.map((r) => r.question_id),
    flaggedAt: rows.reduce((acc, r) => { acc[r.question_id] = r.flagged_at; return acc; }, {}),
  });
});

// ---- Save / autosave an answer ----
router.post('/:token/answer', requireActiveSession, (req, res) => {
  const { questionId, answer, timeSpentDeltaSeconds } = req.body || {};
  const q = questionForSession(req.session_, questionId);
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
