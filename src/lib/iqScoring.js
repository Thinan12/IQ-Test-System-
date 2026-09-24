// Scoring for the IQ reasoning test.
//
// Everything here runs on the SERVER from what is stored in the database. The
// browser never computes an authoritative score, never receives an answer key,
// and cannot influence the result by anything other than the answers it saved.
//
// IMPORTANT, and repeated wherever a number is shown: the estimated figure is
// an ESTIMATE produced by the configured model below from this test's own
// percentage. It is not a clinically validated IQ, it is not normed against a
// standardisation sample, and it must never be presented as a diagnosis.
const db = require('../db');
const { CATEGORIES } = require('./iqQuestions');

// The default model, kept as data so it can be changed per assessment without
// touching code. `scale` is points of estimated score per point of percentage
// away from the midpoint: at 50% the estimate is the mean, at 100% it is
// mean + 50*scale. With the defaults that is 100 at half marks and 130 at full
// marks, which is a deliberately conservative spread.
const DEFAULT_SCORING = {
  model: 'LINEAR_FROM_PERCENTAGE',
  mean: 100,
  scale: 0.6,
  min: 55,
  max: 145,
  // Whether to publish an estimated figure at all. Turning it off leaves the
  // raw score, the percentage and the category breakdown, which are the
  // defensible numbers.
  estimatedIqEnabled: true,
  // A percentage at or above this counts as a pass for reporting purposes.
  passThreshold: 50,
};

const MODELS = ['LINEAR_FROM_PERCENTAGE', 'RAW_ONLY'];

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : fallback;
  } catch (e) { return fallback; }
}

/** The scoring configuration for one assessment, with defaults filled in. */
function scoringConfigFor(assessment) {
  const stored = parseJson(assessment && assessment.iq_scoring_json, {});
  const cfg = { ...DEFAULT_SCORING, ...stored };
  if (!MODELS.includes(cfg.model)) cfg.model = DEFAULT_SCORING.model;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  cfg.mean = num(cfg.mean, DEFAULT_SCORING.mean);
  cfg.scale = num(cfg.scale, DEFAULT_SCORING.scale);
  cfg.min = num(cfg.min, DEFAULT_SCORING.min);
  cfg.max = num(cfg.max, DEFAULT_SCORING.max);
  cfg.passThreshold = num(cfg.passThreshold, DEFAULT_SCORING.passThreshold);
  cfg.estimatedIqEnabled = cfg.estimatedIqEnabled !== false && cfg.model !== 'RAW_ONLY';
  return cfg;
}

/** Validate an admin-supplied scoring configuration. Returns error strings. */
function validateScoringConfig(cfg) {
  const errors = [];
  if (cfg === undefined || cfg === null) return errors;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) return ['iqScoring must be an object.'];
  if (cfg.model !== undefined && !MODELS.includes(String(cfg.model))) {
    errors.push('iqScoring.model must be one of: ' + MODELS.join(', '));
  }
  const positive = (k) => {
    if (cfg[k] === undefined || cfg[k] === null) return;
    if (!Number.isFinite(Number(cfg[k]))) errors.push(`iqScoring.${k} must be a number.`);
  };
  ['mean', 'scale', 'min', 'max', 'passThreshold'].forEach(positive);
  if (Number.isFinite(Number(cfg.min)) && Number.isFinite(Number(cfg.max)) && Number(cfg.min) > Number(cfg.max)) {
    errors.push('iqScoring.min cannot be greater than iqScoring.max.');
  }
  if (cfg.passThreshold !== undefined && cfg.passThreshold !== null) {
    const p = Number(cfg.passThreshold);
    if (Number.isFinite(p) && (p < 0 || p > 100)) errors.push('iqScoring.passThreshold must be between 0 and 100.');
  }
  if (cfg.estimatedIqEnabled !== undefined && typeof cfg.estimatedIqEnabled !== 'boolean') {
    errors.push('iqScoring.estimatedIqEnabled must be true or false.');
  }
  return errors;
}

/**
 * The estimated, clearly-labelled figure. Returns null when the configured
 * model does not publish one, so a caller cannot accidentally invent it.
 */
function estimatedScore(percentage, cfg) {
  if (!cfg.estimatedIqEnabled) return null;
  const raw = cfg.mean + (percentage - 50) * cfg.scale;
  return Math.max(cfg.min, Math.min(cfg.max, Math.round(raw)));
}

/**
 * Mark one IQ session from the database and return the result WITHOUT writing
 * it, so it can be tested and inspected independently of persistence.
 *
 * An IQ question is a single-choice question: its stored answer is the
 * canonical option VALUE, compared by exact match against the configured
 * expected value, exactly as lib/grading.js does for a choice part. Translating
 * a label therefore cannot change a mark.
 */
function computeIqResult(session) {
  const assessment = session.assessment_id
    ? db.prepare('SELECT * FROM assessments WHERE id = ?').get(session.assessment_id)
    : null;
  const cfg = scoringConfigFor(assessment);

  // Mark the questions THIS attempt was given. With random selection every
  // candidate sits a different paper, so marking the assessment's whole bank
  // would count questions this candidate was never shown as wrong.
  const assigned = require('./questionSelection').sessionQuestions(session.id);
  const questions = assigned.length
    ? assigned
    : (session.assessment_id
      ? db.prepare(
          `SELECT q.* FROM assessment_questions aq JOIN questions q ON q.id = aq.question_id
            WHERE aq.assessment_id = ? ORDER BY aq.order_index`
        ).all(session.assessment_id)
      : []);

  const answers = {};
  db.prepare('SELECT * FROM candidate_answers WHERE session_id = ?').all(session.id)
    .forEach((a) => { answers[a.question_id] = a; });

  const byCategory = {};
  let correct = 0, incorrect = 0, unanswered = 0, marks = 0, max = 0;

  const breakdown = questions.map((q) => {
    let config;
    try { config = JSON.parse(q.config_json || '{}'); } catch (e) { config = {}; }
    const part = Array.isArray(config.parts) ? config.parts[0] : null;
    const questionMax = Number(q.max_marks) || 0;
    max += questionMax;

    const stored = answers[q.id];
    let submitted = null;
    if (stored && stored.answer_json) {
      try {
        const parsed = JSON.parse(stored.answer_json);
        submitted = parsed && part && parsed[part.key] !== undefined ? parsed[part.key] : null;
      } catch (e) { submitted = null; }
    }
    if (submitted === '' ) submitted = null;

    const expected = part ? part.expected : undefined;
    const isCorrect = submitted !== null && submitted !== undefined && submitted === expected;
    const awarded = isCorrect ? questionMax : 0;
    marks += awarded;

    if (submitted === null || submitted === undefined) unanswered++;
    else if (isCorrect) correct++;
    else incorrect++;

    const cat = String(q.iq_category || 'UNCATEGORISED').toUpperCase();
    if (!byCategory[cat]) byCategory[cat] = { correct: 0, incorrect: 0, unanswered: 0, total: 0, marks: 0, max: 0 };
    byCategory[cat].total++;
    byCategory[cat].max += questionMax;
    byCategory[cat].marks += awarded;
    if (submitted === null || submitted === undefined) byCategory[cat].unanswered++;
    else if (isCorrect) byCategory[cat].correct++;
    else byCategory[cat].incorrect++;

    return {
      questionId: q.id,
      category: cat,
      difficulty: q.difficulty || null,
      max: questionMax,
      awarded,
      submitted: submitted === undefined ? null : submitted,
      // The expected answer is part of the ADMIN breakdown only. Callers that
      // serve a candidate must not pass this on — see routes/exam.js, which
      // never returns it.
      expected: expected === undefined ? null : expected,
      correct: isCorrect,
    };
  });

  Object.keys(byCategory).forEach((k) => {
    const c = byCategory[k];
    c.percentage = c.max > 0 ? Math.round((c.marks / c.max) * 1000) / 10 : 0;
  });

  const percentage = max > 0 ? Math.round((marks / max) * 1000) / 10 : 0;
  const started = session.started_at ? Date.parse(String(session.started_at).replace(' ', 'T') + (String(session.started_at).endsWith('Z') ? '' : 'Z')) : null;
  const finished = session.submitted_at ? Date.parse(String(session.submitted_at).replace(' ', 'T') + (String(session.submitted_at).endsWith('Z') ? '' : 'Z')) : null;
  const durationSeconds = started && finished && finished >= started ? Math.round((finished - started) / 1000) : null;

  return {
    sessionId: session.id,
    candidateId: session.candidate_id,
    assessmentId: session.assessment_id || null,
    totalQuestions: questions.length,
    correctCount: correct,
    incorrectCount: incorrect,
    unansweredCount: unanswered,
    rawScore: marks,
    rawMax: max,
    percentage,
    categoryScores: byCategory,
    durationSeconds,
    estimatedIq: estimatedScore(percentage, cfg),
    passed: percentage >= cfg.passThreshold,
    scoringModel: cfg,
    breakdown,
  };
}

/**
 * Compute and store. Idempotent: the row is keyed by session, so finalizing
 * twice (a manual submit racing the expiry sweep) cannot create two results or
 * change the first one's numbers.
 */
function recordIqResult(session) {
  const r = computeIqResult(session);
  const existing = db.prepare('SELECT id FROM iq_results WHERE session_id = ?').get(session.id);
  if (existing) return r;
  db.prepare(
    `INSERT INTO iq_results (id, session_id, candidate_id, assessment_id, total_questions,
       correct_count, incorrect_count, unanswered_count, raw_score, raw_max, percentage,
       category_scores_json, duration_seconds, estimated_iq, scoring_model_json)
     VALUES (@id,@sessionId,@candidateId,@assessmentId,@totalQuestions,
       @correctCount,@incorrectCount,@unansweredCount,@rawScore,@rawMax,@percentage,
       @categoryScores,@durationSeconds,@estimatedIq,@scoringModel)`
  ).run({
    id: 'iqr_' + session.id,
    sessionId: r.sessionId,
    candidateId: r.candidateId,
    assessmentId: r.assessmentId,
    totalQuestions: r.totalQuestions,
    correctCount: r.correctCount,
    incorrectCount: r.incorrectCount,
    unansweredCount: r.unansweredCount,
    rawScore: r.rawScore,
    rawMax: r.rawMax,
    percentage: r.percentage,
    categoryScores: JSON.stringify(r.categoryScores),
    durationSeconds: r.durationSeconds,
    estimatedIq: r.estimatedIq,
    scoringModel: JSON.stringify(r.scoringModel),
  });
  return r;
}

/** The stored result for a session, or null. */
function storedIqResult(sessionId) {
  const row = db.prepare('SELECT * FROM iq_results WHERE session_id = ?').get(sessionId);
  if (!row) return null;
  return {
    ...row,
    categoryScores: parseJson(row.category_scores_json, {}),
    scoringModel: parseJson(row.scoring_model_json, {}),
  };
}

// The one wording used wherever an estimated figure is shown, so the caveat
// cannot drift apart between the admin list, the detail view and the report.
const ESTIMATED_IQ_DISCLAIMER =
  'Estimated IQ-style score derived from this test only. It is not a clinically validated IQ and must not be presented as one.';

module.exports = {
  ESTIMATED_IQ_DISCLAIMER,
  DEFAULT_SCORING,
  MODELS,
  CATEGORIES,
  scoringConfigFor,
  validateScoringConfig,
  estimatedScore,
  computeIqResult,
  recordIqResult,
  storedIqResult,
};
