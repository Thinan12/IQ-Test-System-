// Admin API for the IQ test module.
//
// The IQ bank lives in the SAME `questions` table as the recruitment bank,
// separated by question_family. That is deliberate: marking, bilingual text,
// approved-translation gating, the candidate sanitizer, archiving and the audit
// trail already work there and are already tested. This router only adds the
// IQ-shaped form on top — categories, options and a correct answer — and turns
// it into the config the existing marking engine already understands.
//
// Everything here is behind requireAuth (mounted in server.js) and role-gated
// below. A candidate can never reach this router.
const express = require('express');
const db = require('../../db');
const { generateId } = require('../../lib/tokens');
const { auditFromReq } = require('../../lib/audit');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { resolveTranslationStatus } = require('../../lib/questionText');
const iq = require('../../lib/iqQuestions');
const { computeIqResult, storedIqResult, CATEGORIES, DEFAULT_SCORING, MODELS } = require('../../lib/iqScoring');

const router = express.Router();
// Authentication for the whole router, exactly as the recruitment question
// bank does it. A candidate can never reach any route below.
router.use(requireAuth);

// Same split as the recruitment bank: the bank holds answer keys, so a
// Recruiter or Interviewer must not read it.
const IQ_READERS = ['SUPER_ADMIN', 'HR_ADMIN', 'EVALUATOR', 'MANAGER'];
const IQ_EDITORS = ['SUPER_ADMIN', 'HR_ADMIN'];
const RESULT_READERS = ['SUPER_ADMIN', 'HR_ADMIN', 'EVALUATOR', 'MANAGER', 'RECRUITER'];

function findIqQuestion(id) {
  return db.prepare("SELECT * FROM questions WHERE id = ? AND question_family = 'IQ'").get(id);
}

// ------------------------------------------------------------------ metadata
router.get('/meta', requireRole(...IQ_READERS), (req, res) => {
  res.json({
    categories: CATEGORIES,
    difficulties: iq.DIFFICULTIES,
    optionValues: iq.OPTION_VALUES,
    limits: iq.LIMITS,
    scoringModels: MODELS,
    defaultScoring: DEFAULT_SCORING,
  });
});

// -------------------------------------------------------------- question bank
router.get('/questions', requireRole(...IQ_READERS), (req, res) => {
  const showArchived = String(req.query.archived || '') === '1';
  const category = String(req.query.category || '').toUpperCase();
  const params = [];
  let sql = "SELECT * FROM questions WHERE question_family = 'IQ' AND COALESCE(archived,0) = ?";
  params.push(showArchived ? 1 : 0);
  if (category && iq.CATEGORY_KEYS.includes(category)) {
    sql += ' AND iq_category = ?';
    params.push(category);
  }
  sql += ' ORDER BY iq_category, order_index, created_at';
  const rows = db.prepare(sql).all(...params);
  res.json({
    questions: rows.map((q) => ({
      ...iq.toAdminShape(q),
      usedByAssessments: db.prepare(
        `SELECT a.name FROM assessment_questions aq JOIN assessments a ON a.id = aq.assessment_id
          WHERE aq.question_id = ? AND COALESCE(a.archived,0) = 0 ORDER BY a.name`
      ).all(q.id).map((r) => r.name),
    })),
    categories: CATEGORIES,
  });
});

router.get('/questions/:id', requireRole(...IQ_READERS), (req, res) => {
  const q = findIqQuestion(req.params.id);
  if (!q) return res.status(404).json({ error: 'IQ question not found.' });
  res.json({ question: iq.toAdminShape(q) });
});

router.post('/questions', requireRole(...IQ_EDITORS), (req, res) => {
  const b = req.body || {};
  const errors = iq.validateIqQuestion(b);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const config = iq.buildConfig(b);
  const configLo = iq.buildConfigLo(b);
  const status = resolveTranslationStatus(b.translationStatus, b.textLo);
  const id = generateId('q');
  const order = db.prepare("SELECT COALESCE(MAX(order_index), 0) + 1 AS n FROM questions WHERE question_family = 'IQ'").get().n;

  db.prepare(
    `INSERT INTO questions (id, type, order_index, category, difficulty, max_marks, text, config_json,
       text_lo, config_lo_json, translation_status, translation_source,
       translation_updated_by, translation_updated_at,
       explanation, active, created_by, question_family, iq_category)
     VALUES (@id,'CALC',@order,@category,@difficulty,@maxMarks,@text,@config,
       @textLo,@configLo,@status,@source,@translatedBy,@translatedAt,
       @explanation,@active,@createdBy,'IQ',@iqCategory)`
  ).run({
    id,
    order,
    // `category` is the free-text grouping the shared bank already has; the IQ
    // reasoning category is stored in its own column so it can be relied on.
    category: String(b.category).toUpperCase(),
    iqCategory: String(b.category).toUpperCase(),
    difficulty: b.difficulty ? String(b.difficulty).toUpperCase() : 'MEDIUM',
    maxMarks: config.parts[0].marks,
    text: String(b.text).trim(),
    config: JSON.stringify(config),
    textLo: b.textLo ? String(b.textLo).trim() : null,
    configLo: configLo ? JSON.stringify(configLo) : null,
    status,
    source: status === 'MISSING' ? null : (b.translationSource ? String(b.translationSource).toUpperCase() : 'HUMAN'),
    translatedBy: status === 'MISSING' ? null : req.user.name,
    translatedAt: status === 'MISSING' ? null : new Date().toISOString(),
    explanation: b.explanation ? String(b.explanation).trim() : null,
    active: b.active === false ? 0 : 1,
    createdBy: req.user.name,
  });

  auditFromReq(req, 'IQ_QUESTION_CREATED', id, null, {
    category: String(b.category).toUpperCase(),
    difficulty: b.difficulty || 'MEDIUM',
    options: config.parts[0].options.length,
    translationStatus: status,
  });
  // The correct answer is NOT echoed here; the caller already knows it and a
  // narrower response is one less place for it to leak.
  res.status(201).json({ id, marks: config.parts[0].marks, translationStatus: status });
});

router.patch('/questions/:id', requireRole(...IQ_EDITORS), (req, res) => {
  const q = findIqQuestion(req.params.id);
  if (!q) return res.status(404).json({ error: 'IQ question not found.' });
  const b = req.body || {};
  const errors = iq.validateIqQuestion(b, { partial: true, existing: q });
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const current = iq.toAdminShape(q);
  const merged = {
    options: b.options !== undefined ? b.options : current.options,
    correct: b.correct !== undefined ? b.correct : current.correct,
    marks: b.marks !== undefined ? b.marks : current.marks,
  };
  const rebuildAnswers = b.options !== undefined || b.correct !== undefined || b.marks !== undefined;
  const config = rebuildAnswers ? iq.buildConfig(merged) : JSON.parse(q.config_json);

  // The Lao overlay is rebuilt only when Lao labels were supplied, so editing
  // the English side never silently discards a translation.
  const loSupplied = b.options !== undefined && b.options.some((o) => o && o.labelLo !== undefined);
  const configLo = loSupplied ? iq.buildConfigLo(merged) : (q.config_lo_json ? JSON.parse(q.config_lo_json) : null);

  const textLo = b.textLo !== undefined ? (b.textLo ? String(b.textLo).trim() : null) : q.text_lo;
  const englishChanged = (b.text !== undefined && String(b.text).trim() !== q.text)
    || (rebuildAnswers && JSON.stringify(config) !== q.config_json);

  let status = resolveTranslationStatus(
    b.translationStatus !== undefined ? b.translationStatus : q.translation_status,
    textLo
  );
  // Editing the question invalidates an approved translation: it now describes
  // a different question, so a human re-approves rather than a stale Lao
  // translation staying live in front of candidates.
  if (englishChanged && status === 'APPROVED' && b.translationStatus === undefined) status = 'DRAFT';

  const laoTextChanged = b.textLo !== undefined && String(b.textLo || '').trim() !== String(q.text_lo || '').trim();
  let source;
  if (b.translationSource !== undefined) source = b.translationSource ? String(b.translationSource).toUpperCase() : null;
  else if (laoTextChanged || loSupplied) source = 'HUMAN';
  else source = q.translation_source || null;
  if (!textLo) source = null;

  const touched = b.textLo !== undefined || b.options !== undefined
    || b.translationStatus !== undefined || b.translationSource !== undefined;

  db.prepare(
    `UPDATE questions SET text=@text, difficulty=@difficulty, explanation=@explanation,
       category=@category, iq_category=@iqCategory, max_marks=@maxMarks, config_json=@config,
       text_lo=@textLo, config_lo_json=@configLo, translation_status=@status, translation_source=@source,
       translation_updated_by=@translatedBy, translation_updated_at=@translatedAt,
       active=@active, updated_at=datetime('now')
     WHERE id=@id`
  ).run({
    id: q.id,
    text: b.text !== undefined ? String(b.text).trim() : q.text,
    difficulty: b.difficulty !== undefined ? String(b.difficulty).toUpperCase() : q.difficulty,
    explanation: b.explanation !== undefined ? (b.explanation ? String(b.explanation).trim() : null) : q.explanation,
    category: b.category !== undefined ? String(b.category).toUpperCase() : q.category,
    iqCategory: b.category !== undefined ? String(b.category).toUpperCase() : q.iq_category,
    maxMarks: config.parts[0].marks,
    config: JSON.stringify(config),
    textLo,
    configLo: configLo ? JSON.stringify(configLo) : null,
    status,
    source,
    translatedBy: touched ? req.user.name : q.translation_updated_by,
    translatedAt: touched ? new Date().toISOString() : q.translation_updated_at,
    active: b.active !== undefined ? (b.active ? 1 : 0) : q.active,
  });

  auditFromReq(req, 'IQ_QUESTION_UPDATED', q.id,
    { translationStatus: q.translation_status, translationSource: q.translation_source },
    { translationStatus: status, translationSource: source, englishChanged });
  res.json({ ok: true, marks: config.parts[0].marks, translationStatus: status, translationSource: source });
});

// Archive / restore reuse the same never-delete rule as the recruitment bank:
// candidate_answers references a question, so a completed attempt must keep it.
router.post('/questions/:id/archive', requireRole(...IQ_EDITORS), (req, res) => {
  const q = findIqQuestion(req.params.id);
  if (!q) return res.status(404).json({ error: 'IQ question not found.' });
  if (q.archived) return res.status(409).json({ error: 'That question is already archived.' });
  db.prepare("UPDATE questions SET archived = 1, archived_at = datetime('now'), archived_by = ? WHERE id = ?")
    .run(req.user.name, q.id);
  auditFromReq(req, 'IQ_QUESTION_ARCHIVED', q.id);
  res.json({ ok: true });
});

router.post('/questions/:id/restore', requireRole(...IQ_EDITORS), (req, res) => {
  const q = findIqQuestion(req.params.id);
  if (!q) return res.status(404).json({ error: 'IQ question not found.' });
  if (!q.archived) return res.status(409).json({ error: 'That question is not archived.' });
  db.prepare('UPDATE questions SET archived = 0, archived_at = NULL, archived_by = NULL WHERE id = ?').run(q.id);
  auditFromReq(req, 'IQ_QUESTION_RESTORED', q.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------- results
router.get('/results', requireRole(...RESULT_READERS), (req, res) => {
  const rows = db.prepare(
    `SELECT r.*, c.full_name, c.code, a.name AS assessment_name, s.language, s.submitted_at
       FROM iq_results r
       JOIN candidates c ON c.id = r.candidate_id
       LEFT JOIN assessments a ON a.id = r.assessment_id
       LEFT JOIN assessment_sessions s ON s.id = r.session_id
      ORDER BY r.created_at DESC`
  ).all();
  res.json({
    results: rows.map((r) => ({
      sessionId: r.session_id,
      candidateId: r.candidate_id,
      candidateName: r.full_name,
      candidateCode: r.code,
      assessmentName: r.assessment_name,
      language: r.language,
      submittedAt: r.submitted_at,
      totalQuestions: r.total_questions,
      correct: r.correct_count,
      incorrect: r.incorrect_count,
      unanswered: r.unanswered_count,
      rawScore: r.raw_score,
      rawMax: r.raw_max,
      percentage: r.percentage,
      durationSeconds: r.duration_seconds,
      estimatedIq: r.estimated_iq,
    })),
    // Repeated with every payload so no consumer can present the figure without it.
    estimatedIqDisclaimer: 'Estimated IQ-style score derived from this test only. It is not a clinically validated IQ and must not be presented as one.',
  });
});

router.get('/results/:sessionId', requireRole(...RESULT_READERS), (req, res) => {
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  const stored = storedIqResult(session.id);
  if (!stored) return res.status(404).json({ error: 'No IQ result has been recorded for that session.' });

  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(stored.candidate_id);
  const assessment = stored.assessment_id
    ? db.prepare('SELECT * FROM assessments WHERE id = ?').get(stored.assessment_id)
    : null;

  // The per-question review carries the expected answer, which is why this
  // route is role-gated and why it is never part of any candidate response.
  const live = computeIqResult(session);
  const questionById = {};
  db.prepare(
    `SELECT q.id, q.text, q.text_lo, q.iq_category, q.difficulty, q.explanation, q.config_json
       FROM assessment_questions aq JOIN questions q ON q.id = aq.question_id
      WHERE aq.assessment_id = ?`
  ).all(stored.assessment_id || '').forEach((q) => { questionById[q.id] = q; });

  res.json({
    result: {
      sessionId: stored.session_id,
      candidate: candidate ? { id: candidate.id, name: candidate.full_name, code: candidate.code } : null,
      assessment: assessment ? { id: assessment.id, name: assessment.name } : null,
      language: session.language,
      startedAt: session.started_at,
      submittedAt: session.submitted_at,
      durationSeconds: stored.duration_seconds,
      totalQuestions: stored.total_questions,
      correct: stored.correct_count,
      incorrect: stored.incorrect_count,
      unanswered: stored.unanswered_count,
      rawScore: stored.raw_score,
      rawMax: stored.raw_max,
      percentage: stored.percentage,
      categoryScores: stored.categoryScores,
      estimatedIq: stored.estimated_iq,
      scoringModel: stored.scoringModel,
      review: live.breakdown.map((b) => {
        const q = questionById[b.questionId] || {};
        return {
          questionId: b.questionId,
          category: b.category,
          difficulty: b.difficulty,
          text: q.text || null,
          textLo: q.text_lo || null,
          explanation: q.explanation || null,
          submitted: b.submitted,
          expected: b.expected,
          correct: b.correct,
          marks: b.awarded,
          max: b.max,
        };
      }),
    },
    estimatedIqDisclaimer: 'Estimated IQ-style score derived from this test only. It is not a clinically validated IQ and must not be presented as one.',
  });
});

module.exports = router;
