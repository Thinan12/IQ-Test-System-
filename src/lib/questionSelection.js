// Per-attempt question selection.
//
// The rule this module exists to enforce: an attempt's question set is decided
// ONCE, on the server, when the attempt is initialised, and is then immutable.
// Reloading the browser, switching English <-> Lao, reopening the invitation
// and navigating between questions all read the same stored rows. The browser
// is never the authority on which questions a sitting contains.
//
// What is selected from:
//   * the questions ATTACHED to the assessment (assessment_questions), which is
//     the relationship the platform already used to decide what an attempt
//     asks. Random selection narrows that pool; it never reaches outside it.
//   * filtered to the assessment's own product family (an IQ item is a CALC
//     question with one choice part, so family is the only thing separating the
//     two banks), and to questions that are active and not archived.
//
// What is never selected: a question from another product, an archived one, an
// inactive one, or one that is not attached to the assessment at all.
//
// Nothing here reads or returns an answer key. Selection works on ids,
// categories and difficulties only.

const crypto = require('crypto');
const db = require('../db');

const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];

/** Raised when an attempt cannot be created as configured. Never partial. */
class SelectionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'SelectionError';
    this.code = 'SELECTION_IMPOSSIBLE';
    this.details = details || {};
  }
}

// ---------------------------------------------------------------- randomness
// crypto.randomInt is uniform over the range, unlike Math.random() scaled by a
// length. Selection decides what a candidate is examined on, so it uses the
// same quality of randomness as the invitation tokens.
function randomInt(n) {
  return n <= 1 ? 0 : crypto.randomInt(n);
}

/** Fisher-Yates, on a copy. */
function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}

/** Take n at random, without replacement — no duplicates within an attempt. */
function sample(list, n) {
  return shuffled(list).slice(0, n);
}

// ------------------------------------------------------------ configuration
function familyFor(assessment) {
  return assessment && assessment.assessment_type === 'IQ_TEST' ? 'IQ' : 'GENERAL';
}

function parseRules(assessment) {
  if (!assessment || !assessment.selection_rules_json) return null;
  try {
    const r = JSON.parse(assessment.selection_rules_json);
    return r && typeof r === 'object' ? r : null;
  } catch (e) {
    return null;
  }
}

/**
 * The resolved selection configuration for an assessment, defaults filled in.
 * `enabled:false` reproduces exactly what the platform did before this module.
 */
function selectionConfigFor(assessment) {
  const rules = parseRules(assessment);
  const byCategory = rules && rules.byCategory && typeof rules.byCategory === 'object' ? rules.byCategory : null;
  const byDifficulty = rules && rules.byDifficulty && typeof rules.byDifficulty === 'object' ? rules.byDifficulty : null;
  return {
    enabled: !!(assessment && assessment.randomize_questions),
    questionsToShow: assessment && assessment.questions_to_show != null
      ? Number(assessment.questions_to_show) : null,
    randomizeOrder: !!(assessment && assessment.randomize_question_order),
    randomizeOptions: !!(assessment && assessment.randomize_options),
    byCategory,
    byDifficulty,
    family: familyFor(assessment),
  };
}

// ------------------------------------------------------------------- the pool
/**
 * Every question this assessment may draw on: attached to it, of its own
 * product family, active and not archived.
 */
function eligiblePool(assessment) {
  if (!assessment) return [];
  return db.prepare(
    `SELECT q.id, q.iq_category, q.difficulty, q.config_json, q.question_family
       FROM assessment_questions aq
       JOIN questions q ON q.id = aq.question_id
      WHERE aq.assessment_id = ?
        AND q.active = 1
        AND COALESCE(q.archived, 0) = 0
        AND q.question_family = ?
      ORDER BY aq.order_index`
  ).all(assessment.id, familyFor(assessment));
}

function bucketOf(q, dimension) {
  if (dimension === 'byCategory') return q.iq_category || null;
  return q.difficulty ? String(q.difficulty).toUpperCase() : null;
}

/** Positive whole-number quotas only, ignoring zeroes. */
function activeQuotas(spec) {
  const out = {};
  if (!spec) return out;
  Object.keys(spec).forEach((k) => {
    const n = Number(spec[k]);
    if (Number.isInteger(n) && n > 0) out[String(k).toUpperCase()] = n;
  });
  return out;
}

// -------------------------------------------------------------- validation
/**
 * Can an attempt be created for this assessment as configured? Returns a list
 * of human-readable problems — empty means yes. This is what the admin UI and
 * the invitation endpoint use so a misconfiguration is caught BEFORE a
 * candidate is sent a link, not when they try to sit it.
 */
function validateSelection(assessment) {
  const cfg = selectionConfigFor(assessment);
  if (!cfg.enabled) return [];

  const pool = eligiblePool(assessment);
  const errors = [];

  const quotaDimension = cfg.byCategory ? 'byCategory' : (cfg.byDifficulty ? 'byDifficulty' : null);
  if (quotaDimension) {
    const quotas = activeQuotas(cfg[quotaDimension]);
    const label = quotaDimension === 'byCategory' ? 'category' : 'difficulty';
    let quotaTotal = 0;
    Object.keys(quotas).forEach((bucket) => {
      quotaTotal += quotas[bucket];
      const available = pool.filter((q) => bucketOf(q, quotaDimension) === bucket).length;
      if (available < quotas[bucket]) {
        errors.push(
          `Not enough eligible questions in ${label} ${bucket}. Required: ${quotas[bucket]}. Available: ${available}.`
        );
      }
    });
    // A quota set and a separate total must agree, or the attempt would be
    // neither the configured size nor the configured shape.
    if (cfg.questionsToShow != null && cfg.questionsToShow !== quotaTotal) {
      errors.push(
        `The ${label} distribution adds up to ${quotaTotal}, but the test is set to show ${cfg.questionsToShow} questions.`
      );
    }
    return errors;
  }

  const want = cfg.questionsToShow != null ? cfg.questionsToShow : pool.length;
  if (want <= 0) {
    errors.push('Questions shown must be at least 1.');
  } else if (pool.length < want) {
    errors.push(`Not enough eligible questions. Required: ${want}. Available: ${pool.length}.`);
  }
  return errors;
}

/** How many questions an attempt at this assessment will contain. */
function plannedQuestionCount(assessment) {
  const cfg = selectionConfigFor(assessment);
  if (!cfg.enabled) return null;
  const quotas = activeQuotas(cfg.byCategory || cfg.byDifficulty);
  const quotaTotal = Object.keys(quotas).reduce((s, k) => s + quotas[k], 0);
  if (quotaTotal > 0) return quotaTotal;
  return cfg.questionsToShow != null ? cfg.questionsToShow : eligiblePool(assessment).length;
}

// ------------------------------------------------------- option randomisation
/**
 * The canonical option values of a single-choice question, in the order they
 * are configured. Returns null for anything that is not one — a calculation
 * question, a multi-part question, an essay — because reordering those would
 * either mean nothing or destroy meaning.
 */
function canonicalOptionValues(question) {
  if (!question || question.question_family !== 'IQ') return null;
  let config;
  try { config = JSON.parse(question.config_json || '{}'); } catch (e) { return null; }
  const parts = Array.isArray(config.parts) ? config.parts : [];
  if (parts.length !== 1) return null;
  const part = parts[0];
  if (!part || part.type !== 'choice' || !Array.isArray(part.options) || part.options.length < 2) return null;
  return part.options.map(String);
}

// --------------------------------------------------------------- the selection
/**
 * Decide one attempt's question set. Pure: it reads the bank and returns rows,
 * writing nothing, so it can be tested on its own.
 */
function buildSelection(assessment) {
  const cfg = selectionConfigFor(assessment);
  const problems = validateSelection(assessment);
  if (problems.length) throw new SelectionError(problems[0], { problems });

  const pool = eligiblePool(assessment);
  let chosen;

  const quotaDimension = cfg.byCategory ? 'byCategory' : (cfg.byDifficulty ? 'byDifficulty' : null);
  if (quotaDimension) {
    const quotas = activeQuotas(cfg[quotaDimension]);
    chosen = [];
    // Draw each bucket independently, so the shape of the paper is the
    // configured shape however the draw falls.
    Object.keys(quotas).forEach((bucket) => {
      const inBucket = pool.filter((q) => bucketOf(q, quotaDimension) === bucket);
      chosen = chosen.concat(sample(inBucket, quotas[bucket]));
    });
  } else {
    const want = cfg.questionsToShow != null ? cfg.questionsToShow : pool.length;
    chosen = sample(pool, want);
  }

  // Display order. When it is not randomised the attempt keeps the assessment's
  // own order, which is the order eligiblePool() returned.
  const ordered = cfg.randomizeOrder
    ? shuffled(chosen)
    : pool.filter((q) => chosen.some((c) => c.id === q.id));

  return ordered.map((q, i) => {
    let optionOrder = null;
    if (cfg.randomizeOptions) {
      const values = canonicalOptionValues(q);
      if (values) optionOrder = shuffled(values);
    }
    return { questionId: q.id, displayOrder: i, optionOrder };
  });
}

/**
 * Write one attempt's set. Called inside the transaction that creates the
 * session, so a pool that cannot satisfy the configuration aborts the whole
 * thing and no partial attempt is left behind.
 */
function materializeSelection(sessionId, assessment) {
  const rows = buildSelection(assessment);
  const insert = db.prepare(
    `INSERT INTO session_questions (session_id, question_id, display_order, option_order_json)
     VALUES (?,?,?,?)`
  );
  rows.forEach((r) => {
    insert.run(sessionId, r.questionId, r.displayOrder, r.optionOrder ? JSON.stringify(r.optionOrder) : null);
  });
  return rows;
}

/**
 * The rows an attempt was given, in its own display order. Empty for a session
 * that predates random selection or whose assessment has it switched off —
 * every caller treats empty as "fall back to the assessment's own set", which
 * is the behaviour that existed before this module.
 */
function sessionSelection(sessionId) {
  return db.prepare(
    `SELECT question_id, display_order, option_order_json
       FROM session_questions WHERE session_id = ? ORDER BY display_order`
  ).all(sessionId);
}

/** The questions an attempt was given, fully loaded, in display order. */
function sessionQuestions(sessionId) {
  return db.prepare(
    `SELECT q.*, sq.display_order AS sq_display_order, sq.option_order_json AS sq_option_order_json
       FROM session_questions sq
       JOIN questions q ON q.id = sq.question_id
      WHERE sq.session_id = ?
      ORDER BY sq.display_order`
  ).all(sessionId);
}

/** Is this question part of this attempt? The server's answer to any id a candidate sends. */
function sessionHasQuestion(sessionId, questionId) {
  const row = db.prepare(
    'SELECT 1 AS n FROM session_questions WHERE session_id = ? AND question_id = ?'
  ).get(sessionId, questionId);
  return !!row;
}

/** Does this attempt have a materialised set at all? */
function sessionIsSelected(sessionId) {
  return !!db.prepare('SELECT 1 AS n FROM session_questions WHERE session_id = ? LIMIT 1').get(sessionId);
}

module.exports = {
  DIFFICULTIES,
  SelectionError,
  selectionConfigFor,
  eligiblePool,
  validateSelection,
  plannedQuestionCount,
  canonicalOptionValues,
  buildSelection,
  materializeSelection,
  sessionSelection,
  sessionQuestions,
  sessionHasQuestion,
  sessionIsSelected,
  // exported for tests
  shuffled,
  sample,
};
