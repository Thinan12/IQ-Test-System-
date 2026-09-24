// Admin -> Assessments.
//
// An assessment is a named configuration: which questions are asked, for how
// long, how they are scored and what counts as a pass. Questions are
// REFERENCED by id — the bilingual question bank stays authoritative and no
// question record is ever copied.
//
// Nothing here exposes an answer key: assessments only ever carry question ids
// and ordering, never `expected`, `tol` or `explanation`.
const express = require('express');
const db = require('../../db');
const { generateId } = require('../../lib/tokens');
const { auditFromReq } = require('../../lib/audit');
const { requireAuth, requireRole } = require('../../middleware/auth');

const { scoringConfigFor, validateScoringConfig } = require('../../lib/iqScoring');

const router = express.Router();
router.use(requireAuth);

// Viewing a configuration is broad — recruiters need to know which assessment
// to invite someone to, interviewers need the interview weighting. Changing one
// is not: it decides who passes.
const VIEWERS = ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'EVALUATOR', 'RECRUITER', 'INTERVIEWER'];
const EDITORS = ['SUPER_ADMIN', 'HR_ADMIN'];

// ------------------------------------------------------------------ helpers
function findAssessment(id) {
  return db.prepare('SELECT * FROM assessments WHERE id = ?').get(id);
}

function questionsFor(assessmentId) {
  return db.prepare(
    `SELECT aq.question_id AS id, aq.order_index, q.type, q.text, q.max_marks,
            q.active, COALESCE(q.archived,0) AS archived, q.translation_status
       FROM assessment_questions aq
       JOIN questions q ON q.id = aq.question_id
      WHERE aq.assessment_id = ?
      ORDER BY aq.order_index`
  ).all(assessmentId);
}

const ASSESSMENT_TYPES = ['GENERAL_ASSESSMENT', 'IQ_TEST'];

function shape(a, { withQuestions = true } = {}) {
  const questions = withQuestions ? questionsFor(a.id) : [];
  const usage = db.prepare('SELECT COUNT(*) AS n FROM assessment_sessions WHERE assessment_id = ?').get(a.id).n;
  return {
    ...a,
    active: !!a.active,
    archived: !!a.archived,
    questions,
    questionCount: questions.length,
    // Marks actually available from the attached questions, which is not
    // necessarily the configured maximum — surfaced so a mismatch is visible
    // rather than silently mis-scoring.
    questionMarks: questions.reduce((sum, q) => sum + (q.max_marks || 0), 0),
    sessionCount: usage,
    assessmentType: a.assessment_type || 'GENERAL_ASSESSMENT',
    // Resolved scoring configuration for an IQ test, defaults filled in, so an
    // admin sees what a candidate would actually be judged by. NULL for a
    // general assessment, which is scored by the 30/30/40 recruitment model.
    iqScoring: (a.assessment_type === 'IQ_TEST') ? scoringConfigFor(a) : null,
  };
}

function validate(body, { partial = false, existing = null, id = null } = {}) {
  // Product type. An existing assessment cannot change type: sessions already
  // sat under it were scored by that product's rules, and flipping the type
  // would re-interpret finished attempts.
  if (body.assessmentType !== undefined) {
    const t = String(body.assessmentType).toUpperCase();
    if (!ASSESSMENT_TYPES.includes(t)) {
      return ['assessmentType must be one of: ' + ASSESSMENT_TYPES.join(', ')];
    }
    if (existing && t !== (existing.assessment_type || 'GENERAL_ASSESSMENT')) {
      return ['An assessment cannot change type once it exists. Create a new one instead.'];
    }
  }
  if (body.iqScoring !== undefined && body.iqScoring !== null) {
    const errs = validateScoringConfig(body.iqScoring);
    if (errs.length) return errs;
  }
  const errors = [];
  const val = (key) => (body[key] !== undefined ? body[key] : (existing ? existing[key] : undefined));

  if (!partial || body.name !== undefined) {
    const name = String((body.name !== undefined ? body.name : existing && existing.name) || '').trim();
    if (!name) errors.push('An assessment name is required.');
    else if (name.length > 120) errors.push('The assessment name must be 120 characters or fewer.');
    else {
      const clash = id
        ? db.prepare('SELECT id FROM assessments WHERE name = ? AND id != ?').get(name, id)
        : db.prepare('SELECT id FROM assessments WHERE name = ?').get(name);
      if (clash) errors.push('Another assessment already uses that name.');
    }
  }

  const positive = (key, label, min, max) => {
    if (partial && body[key] === undefined) return;
    const v = Number(val(key));
    if (!Number.isFinite(v) || v < min || v > max) {
      errors.push(`${label} must be between ${min} and ${max}.`);
    }
  };
  positive('duration_minutes', 'Exam duration', 1, 600);
  positive('link_expiry_minutes', 'Invitation expiry', 1, 1440);
  positive('calc_max', 'Calculation marks', 0, 1000);
  positive('written_max', 'Written marks', 0, 1000);
  positive('interview_max', 'Interview marks', 0, 1000);
  positive('total_max', 'Total marks', 1, 1000);

  // The threshold has to be reachable, or every candidate fails by definition.
  if (!partial || body.pass_threshold !== undefined || body.total_max !== undefined) {
    const total = Number(val('total_max'));
    const threshold = Number(val('pass_threshold'));
    if (!Number.isFinite(threshold) || threshold < 0) errors.push('The pass threshold must be zero or more.');
    else if (Number.isFinite(total) && threshold > total) {
      errors.push(`The pass threshold (${threshold}) cannot exceed the total marks (${total}).`);
    }
  }

  // The components should add up to the total, otherwise the reported score and
  // the pass threshold are measuring different things.
  if (!partial || ['calc_max', 'written_max', 'interview_max', 'total_max'].some((k) => body[k] !== undefined)) {
    const sum = Number(val('calc_max')) + Number(val('written_max')) + Number(val('interview_max'));
    const total = Number(val('total_max'));
    if (Number.isFinite(sum) && Number.isFinite(total) && sum !== total) {
      errors.push(`Calculation + written + interview (${sum}) must equal the total marks (${total}).`);
    }
  }

  if (body.questionIds !== undefined) {
    if (!Array.isArray(body.questionIds)) {
      errors.push('questionIds must be a list.');
    } else {
      if (new Set(body.questionIds).size !== body.questionIds.length) {
        errors.push('The same question cannot be added twice.');
      }
      // A question set must belong to the same product as the assessment. An
      // IQ item lives in the same table as a recruitment question (it is a CALC
      // question with one choice part), so without this check an IQ item could
      // be attached to a recruitment assessment and be marked as part of the
      // /30 calculation section — or a recruitment question could be attached
      // to an IQ test and be counted towards a reasoning score.
      const type = body.assessmentType !== undefined
        ? String(body.assessmentType).toUpperCase()
        : ((existing && existing.assessment_type) || 'GENERAL_ASSESSMENT');
      const wantedFamily = type === 'IQ_TEST' ? 'IQ' : 'GENERAL';
      body.questionIds.forEach((qid) => {
        const q = db.prepare('SELECT id, archived, question_family FROM questions WHERE id = ?').get(qid);
        if (!q) errors.push(`Question "${qid}" does not exist.`);
        else if (q.archived) errors.push(`Question "${qid}" is archived and cannot be added.`);
        else if ((q.question_family || 'GENERAL') !== wantedFamily) {
          errors.push(`Question "${qid}" is not a ${wantedFamily === 'IQ' ? 'IQ' : 'recruitment'} question and cannot be added to this assessment.`);
        }
      });
    }
  }

  if (body.eligibility_rules_id !== undefined) {
    const rules = db.prepare('SELECT id FROM eligibility_rules WHERE id = ?').get(body.eligibility_rules_id);
    if (!rules) errors.push('That eligibility policy does not exist.');
  }

  return errors;
}

function setQuestions(assessmentId, questionIds) {
  db.prepare('DELETE FROM assessment_questions WHERE assessment_id = ?').run(assessmentId);
  const insert = db.prepare('INSERT INTO assessment_questions (assessment_id, question_id, order_index) VALUES (?,?,?)');
  questionIds.forEach((qid, i) => insert.run(assessmentId, qid, i));
}

// -------------------------------------------------------------------- READ
router.get('/', requireRole(...VIEWERS), (req, res) => {
  const showArchived = String(req.query.archived || '') === '1';
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows = db.prepare(
    `SELECT * FROM assessments WHERE COALESCE(archived,0) = ? ORDER BY created_at DESC`
  ).all(showArchived ? 1 : 0);
  if (q) rows = rows.filter((a) => (a.name + ' ' + (a.description || '')).toLowerCase().includes(q));
  res.json({
    assessments: rows.map((a) => shape(a)),
    canEdit: EDITORS.includes(req.user.role),
  });
});

router.get('/:id', requireRole(...VIEWERS), (req, res) => {
  const a = findAssessment(req.params.id);
  if (!a) return res.status(404).json({ error: 'Assessment not found.' });
  res.json({ assessment: shape(a), canEdit: EDITORS.includes(req.user.role) });
});

// ------------------------------------------------------------------ CREATE
router.post('/', requireRole(...EDITORS), (req, res) => {
  const b = req.body || {};
  // Anything not supplied falls back to the organisation defaults in Settings,
  // which is what those Settings fields are for now that each assessment owns
  // its own timing and threshold.
  const cfg = db.prepare('SELECT * FROM settings WHERE id = 1').get() || {};
  const payload = {
    name: String(b.name || '').trim(),
    description: b.description ? String(b.description).trim() : null,
    duration_minutes: b.duration_minutes !== undefined ? Number(b.duration_minutes)
      : (cfg.assessment_duration_minutes != null ? cfg.assessment_duration_minutes : 45),
    link_expiry_minutes: b.link_expiry_minutes !== undefined ? Number(b.link_expiry_minutes)
      : (cfg.link_expiry_minutes != null ? cfg.link_expiry_minutes : 10),
    calc_max: b.calc_max !== undefined ? Number(b.calc_max) : 30,
    written_max: b.written_max !== undefined ? Number(b.written_max) : 30,
    interview_max: b.interview_max !== undefined ? Number(b.interview_max) : 40,
    total_max: b.total_max !== undefined ? Number(b.total_max) : 100,
    pass_threshold: b.pass_threshold !== undefined ? Number(b.pass_threshold)
      : (cfg.pass_threshold != null ? cfg.pass_threshold : 70),
    eligibility_rules_id: b.eligibility_rules_id !== undefined ? Number(b.eligibility_rules_id) : 1,
    assessment_type: b.assessmentType ? String(b.assessmentType).toUpperCase() : 'GENERAL_ASSESSMENT',
    iq_scoring_json: b.iqScoring ? JSON.stringify(b.iqScoring) : null,
  };
  const errors = validate({ ...b, ...payload }, {});
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const id = generateId('asmt');
  const questionIds = Array.isArray(b.questionIds) ? b.questionIds : [];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO assessments (id, name, description, active, archived, duration_minutes, link_expiry_minutes,
         calc_max, written_max, interview_max, total_max, pass_threshold, eligibility_rules_id,
         assessment_type, iq_scoring_json, created_by)
       VALUES (@id,@name,@description,@active,0,@duration_minutes,@link_expiry_minutes,
         @calc_max,@written_max,@interview_max,@total_max,@pass_threshold,@eligibility_rules_id,
         @assessment_type,@iq_scoring_json,@createdBy)`
    ).run({ id, ...payload, active: b.active === false ? 0 : 1, createdBy: req.user.name });
    setQuestions(id, questionIds);
  })();

  auditFromReq(req, 'ASSESSMENT_CREATED', id, null, {
    name: payload.name, questions: questionIds.length, assessmentType: payload.assessment_type,
    duration: payload.duration_minutes, passThreshold: payload.pass_threshold,
  });
  res.status(201).json({ id, assessment: shape(findAssessment(id)) });
});

// -------------------------------------------------------------------- EDIT
router.patch('/:id', requireRole(...EDITORS), (req, res) => {
  const a = findAssessment(req.params.id);
  if (!a) return res.status(404).json({ error: 'Assessment not found.' });
  if (a.archived) return res.status(409).json({ error: 'Restore this assessment before editing it.' });

  const b = req.body || {};
  const errors = validate(b, { partial: true, existing: a, id: a.id });
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const next = {
    name: b.name !== undefined ? String(b.name).trim() : a.name,
    description: b.description !== undefined ? (b.description ? String(b.description).trim() : null) : a.description,
    active: b.active !== undefined ? (b.active ? 1 : 0) : a.active,
    duration_minutes: b.duration_minutes !== undefined ? Number(b.duration_minutes) : a.duration_minutes,
    link_expiry_minutes: b.link_expiry_minutes !== undefined ? Number(b.link_expiry_minutes) : a.link_expiry_minutes,
    calc_max: b.calc_max !== undefined ? Number(b.calc_max) : a.calc_max,
    written_max: b.written_max !== undefined ? Number(b.written_max) : a.written_max,
    interview_max: b.interview_max !== undefined ? Number(b.interview_max) : a.interview_max,
    total_max: b.total_max !== undefined ? Number(b.total_max) : a.total_max,
    pass_threshold: b.pass_threshold !== undefined ? Number(b.pass_threshold) : a.pass_threshold,
    eligibility_rules_id: b.eligibility_rules_id !== undefined ? Number(b.eligibility_rules_id) : a.eligibility_rules_id,
    // The scoring model can be retuned; attempts already sat keep the snapshot
    // they were judged under (see iq_results.scoring_model_json), so nobody is
    // ever re-judged by a model that did not exist when they took the test.
    iq_scoring_json: b.iqScoring !== undefined
      ? (b.iqScoring ? JSON.stringify(b.iqScoring) : null)
      : a.iq_scoring_json,
  };

  const beforeQuestions = questionsFor(a.id).map((q) => q.id);
  db.transaction(() => {
    db.prepare(
      `UPDATE assessments SET name=@name, description=@description, active=@active,
         duration_minutes=@duration_minutes, link_expiry_minutes=@link_expiry_minutes,
         calc_max=@calc_max, written_max=@written_max, interview_max=@interview_max,
         total_max=@total_max, pass_threshold=@pass_threshold, eligibility_rules_id=@eligibility_rules_id,
         iq_scoring_json=@iq_scoring_json,
         updated_at=datetime('now') WHERE id=@id`
    ).run({ id: a.id, ...next });
    if (b.questionIds !== undefined) setQuestions(a.id, b.questionIds);
  })();

  // Separate audit lines for the things that change what a result means, so the
  // trail says WHY a later candidate was judged differently.
  auditFromReq(req, 'ASSESSMENT_EDITED', a.id, { name: a.name }, { name: next.name });
  if (next.duration_minutes !== a.duration_minutes || next.link_expiry_minutes !== a.link_expiry_minutes) {
    auditFromReq(req, 'ASSESSMENT_TIMING_CHANGED', a.id,
      { duration: a.duration_minutes, invitationExpiry: a.link_expiry_minutes },
      { duration: next.duration_minutes, invitationExpiry: next.link_expiry_minutes,
        note: 'Applies to assessments started from now on. Links already issued keep their own expiry and running exams keep their own deadline.' });
  }
  if (['calc_max', 'written_max', 'interview_max', 'total_max', 'pass_threshold'].some((k) => next[k] !== a[k])) {
    auditFromReq(req, 'ASSESSMENT_SCORING_CHANGED', a.id,
      { calc: a.calc_max, written: a.written_max, interview: a.interview_max, total: a.total_max, passThreshold: a.pass_threshold },
      { calc: next.calc_max, written: next.written_max, interview: next.interview_max, total: next.total_max, passThreshold: next.pass_threshold,
        note: 'Completed assessments keep the threshold they were judged under.' });
  }
  if (next.eligibility_rules_id !== a.eligibility_rules_id) {
    auditFromReq(req, 'ASSESSMENT_ELIGIBILITY_CHANGED', a.id,
      { eligibilityRulesId: a.eligibility_rules_id }, { eligibilityRulesId: next.eligibility_rules_id });
  }
  if (b.questionIds !== undefined) {
    const afterQuestions = b.questionIds;
    const added = afterQuestions.filter((q) => !beforeQuestions.includes(q));
    const removed = beforeQuestions.filter((q) => !afterQuestions.includes(q));
    const reordered = added.length === 0 && removed.length === 0
      && JSON.stringify(afterQuestions) !== JSON.stringify(beforeQuestions);
    auditFromReq(req, 'ASSESSMENT_QUESTIONS_CHANGED', a.id,
      { count: beforeQuestions.length }, { added, removed, reordered, count: afterQuestions.length });
  }

  res.json({ ok: true, assessment: shape(findAssessment(a.id)) });
});

// --------------------------------------------------------------- DUPLICATE
// Copies configuration only. Candidate sessions, answers, invitation links,
// results and audit history are deliberately NOT copied — a duplicate is a new
// assessment nobody has sat.
router.post('/:id/duplicate', requireRole(...EDITORS), (req, res) => {
  const a = findAssessment(req.params.id);
  if (!a) return res.status(404).json({ error: 'Assessment not found.' });

  let name = String((req.body || {}).name || '').trim() || `${a.name} (copy)`;
  if (name.length > 120) name = name.slice(0, 120);
  // Names are unique, so find one that is free rather than failing.
  let candidate = name;
  let n = 2;
  while (db.prepare('SELECT id FROM assessments WHERE name = ?').get(candidate)) {
    candidate = `${name} ${n}`;
    n += 1;
    if (n > 200) return res.status(409).json({ error: 'Could not find a free name for the copy.' });
  }

  const id = generateId('asmt');
  const sourceQuestions = questionsFor(a.id).map((q) => q.id);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO assessments (id, name, description, active, archived, duration_minutes, link_expiry_minutes,
         calc_max, written_max, interview_max, total_max, pass_threshold, eligibility_rules_id, created_by)
       VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, candidate, a.description,
      // A copy starts inactive so it cannot be invited to before it is reviewed.
      0,
      a.duration_minutes, a.link_expiry_minutes,
      a.calc_max, a.written_max, a.interview_max, a.total_max, a.pass_threshold,
      a.eligibility_rules_id, req.user.name
    );
    setQuestions(id, sourceQuestions);
  })();

  auditFromReq(req, 'ASSESSMENT_DUPLICATED', id, { from: a.id, fromName: a.name }, {
    newId: id, newName: candidate, questionsCopied: sourceQuestions.length,
    copied: 'configuration, question references and order',
    notCopied: 'candidate sessions, answers, invitation links, results and audit history',
  });
  res.status(201).json({ id, assessment: shape(findAssessment(id)) });
});

// --------------------------------------------------- ACTIVATE / DEACTIVATE
router.post('/:id/active', requireRole(...EDITORS), (req, res) => {
  const a = findAssessment(req.params.id);
  if (!a) return res.status(404).json({ error: 'Assessment not found.' });
  const active = !!(req.body || {}).active;
  if (active && a.archived) {
    return res.status(409).json({ error: 'Restore this assessment before activating it.' });
  }
  if (active && questionsFor(a.id).length === 0) {
    return res.status(409).json({ error: 'An assessment needs at least one question before it can be activated.' });
  }
  if (!!a.active === active) {
    return res.status(409).json({ error: `This assessment is already ${active ? 'active' : 'inactive'}.` });
  }
  db.prepare(`UPDATE assessments SET active = ?, updated_at = datetime('now') WHERE id = ?`).run(active ? 1 : 0, a.id);
  auditFromReq(req, active ? 'ASSESSMENT_ACTIVATED' : 'ASSESSMENT_DEACTIVATED', a.id,
    { active: !!a.active }, { active });
  res.json({ ok: true, active });
});

// ------------------------------------------------------- ARCHIVE / RESTORE
// Archiving withdraws an assessment from new invitations. It never touches
// completed results, which keep their own snapshot of how they were scored.
router.post('/:id/archive', requireRole(...EDITORS), (req, res) => {
  const a = findAssessment(req.params.id);
  if (!a) return res.status(404).json({ error: 'Assessment not found.' });
  if (a.archived) return res.status(409).json({ error: 'This assessment is already archived.' });

  const live = db.prepare(
    `SELECT COUNT(*) AS n FROM assessment_sessions WHERE assessment_id = ? AND status = 'IN_PROGRESS'`
  ).get(a.id).n;
  if (live > 0) {
    return res.status(409).json({ error: `${live} candidate(s) are sitting this assessment right now. Wait for them to finish, or terminate those assessments first.` });
  }

  const completed = db.prepare('SELECT COUNT(*) AS n FROM assessment_sessions WHERE assessment_id = ?').get(a.id).n;
  db.prepare(`UPDATE assessments SET archived = 1, active = 0, archived_at = datetime('now'), archived_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(req.user.name, a.id);
  auditFromReq(req, 'ASSESSMENT_ARCHIVED', a.id, { archived: 0, active: !!a.active },
    { archived: 1, active: false, historicalSessionsPreserved: completed });
  res.json({ ok: true, archived: true, historicalSessions: completed });
});

router.post('/:id/restore', requireRole(...EDITORS), (req, res) => {
  const a = findAssessment(req.params.id);
  if (!a) return res.status(404).json({ error: 'Assessment not found.' });
  if (!a.archived) return res.status(409).json({ error: 'This assessment is not archived.' });
  // Restored inactive on purpose: someone decides it is correct before it can
  // be invited to again.
  db.prepare(`UPDATE assessments SET archived = 0, archived_at = NULL, archived_by = NULL, updated_at = datetime('now') WHERE id = ?`).run(a.id);
  auditFromReq(req, 'ASSESSMENT_RESTORED', a.id, { archived: 1 }, { archived: 0, active: !!a.active });
  res.json({ ok: true, archived: false, active: !!a.active });
});

module.exports = router;
