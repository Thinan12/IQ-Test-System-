const express = require('express');
const db = require('../../db');
const { generateId } = require('../../lib/tokens');
const { auditFromReq } = require('../../lib/audit');
const { requireAuth, requireRole, translateLimiter } = require('../../middleware/auth');
const { isTranslationConfigured, translateQuestion, TranslationError, LIMITS } = require('../../lib/translation');
const { validateLaoOverlay, resolveTranslationStatus, STATUSES, laoGaps, laoIsComplete } = require('../../lib/questionText');

const router = express.Router();
router.use(requireAuth);

// Who may see and manage the question bank. The bank contains the answer keys,
// tolerances and explanations, so it is NOT open to every authenticated user:
// a Recruiter or Interviewer who could read `expected` could hand a candidate
// the answers.
const QUESTION_READERS = ['SUPER_ADMIN', 'HR_ADMIN', 'EVALUATOR', 'MANAGER'];
const QUESTION_EDITORS = ['SUPER_ADMIN', 'HR_ADMIN'];
const TRANSLATION_SOURCES = ['HUMAN', 'MACHINE'];

// ---------------------------------------------------------------- validation
function validateQuestionPayload(body, { partial = false, existing = null } = {}) {
  const errors = [];
  const type = body.type || (existing && existing.type);

  if (!partial || body.type !== undefined) {
    if (!['CALC', 'ESSAY'].includes(type)) errors.push('type must be CALC or ESSAY.');
  }
  if (!partial || body.text !== undefined) {
    const text = body.text === undefined && existing ? existing.text : body.text;
    if (!String(text || '').trim()) errors.push('The English question text is required.');
  }
  // Lao is optional at every stage — a question is usable in English alone.
  if (body.textLo !== undefined && body.textLo !== null && typeof body.textLo !== 'string') {
    errors.push('The Lao question text must be text.');
  }
  if (body.translationStatus !== undefined && !STATUSES.includes(String(body.translationStatus).toUpperCase())) {
    errors.push('translationStatus must be one of: ' + STATUSES.join(', '));
  }
  // Provenance is recorded separately from approval, so machine output can
  // never be passed off as a reviewed translation.
  if (body.translationSource !== undefined && body.translationSource !== null
      && !TRANSLATION_SOURCES.includes(String(body.translationSource).toUpperCase())) {
    errors.push('translationSource must be one of: ' + TRANSLATION_SOURCES.join(', '));
  }

  const config = body.config !== undefined
    ? body.config
    : (existing ? JSON.parse(existing.config_json) : null);

  if (!partial || body.config !== undefined) {
    if (!config || typeof config !== 'object') {
      errors.push('config is required.');
    } else if (type === 'CALC') {
      if (!Array.isArray(config.parts) || config.parts.length === 0) {
        errors.push('A calculation question needs at least one part.');
      } else {
        const seen = new Set();
        config.parts.forEach((p, i) => {
          const where = `part ${i + 1}`;
          if (!String(p.key || '').trim()) errors.push(`${where}: key is required.`);
          else if (seen.has(p.key)) errors.push(`${where}: duplicate key "${p.key}".`);
          else seen.add(p.key);
          if (!String(p.label || '').trim()) errors.push(`${where}: label is required.`);
          if (!Number.isFinite(Number(p.marks)) || Number(p.marks) <= 0) {
            errors.push(`${where}: marks must be a positive number.`);
          }
          if (p.type === 'choice') {
            if (!Array.isArray(p.options) || p.options.length < 2) {
              errors.push(`${where}: a choice part needs at least two options.`);
            } else if (new Set(p.options).size !== p.options.length) {
              errors.push(`${where}: options must be unique.`);
            } else if (!p.options.includes(p.expected)) {
              // The correct answer must be one of the options that exist.
              errors.push(`${where}: the correct answer must be one of its options.`);
            }
            // Optional ENGLISH display labels, keyed by canonical value. The
            // value stays what grading compares against, so relabelling an
            // option can never change a mark or invalidate a saved answer.
            if (p.optionLabels !== undefined && p.optionLabels !== null) {
              if (typeof p.optionLabels !== 'object' || Array.isArray(p.optionLabels)) {
                errors.push(`${where}: optionLabels must be an object keyed by the canonical option value.`);
              } else {
                const allowed = Array.isArray(p.options) ? p.options : [];
                Object.keys(p.optionLabels).forEach((value) => {
                  if (!allowed.includes(value)) {
                    errors.push(`${where}: English label refers to option "${value}", which is not one of its options.`);
                  }
                  if (typeof p.optionLabels[value] !== 'string') {
                    errors.push(`${where}: English label for option "${value}" must be text.`);
                  }
                });
              }
            }
          } else {
            if (p.optionLabels !== undefined && p.optionLabels !== null) {
              errors.push(`${where}: optionLabels only apply to a choice part.`);
            }
            if (p.expected === undefined || p.expected === null || !Number.isFinite(Number(p.expected))) {
              errors.push(`${where}: a numeric part needs a numeric expected answer.`);
            }
            if (p.tol !== undefined && p.tol !== null && (!Number.isFinite(Number(p.tol)) || Number(p.tol) < 0)) {
              errors.push(`${where}: tolerance must be a number of zero or more.`);
            }
          }
        });
      }
    } else if (type === 'ESSAY') {
      if (!Array.isArray(config.rubric) || config.rubric.length === 0) {
        errors.push('An essay question needs at least one rubric criterion.');
      } else {
        config.rubric.forEach((r, i) => {
          const where = `criterion ${i + 1}`;
          if (!String(r.key || '').trim()) errors.push(`${where}: key is required.`);
          if (!String(r.label || '').trim()) errors.push(`${where}: label is required.`);
          if (!Number.isFinite(Number(r.max)) || Number(r.max) <= 0) {
            errors.push(`${where}: max marks must be a positive number.`);
          }
        });
      }
    }
  }

  // A Lao overlay may only reference parts and options that actually exist.
  if (body.configLo !== undefined && body.configLo !== null) {
    errors.push(...validateLaoOverlay(body.configLo, config, type));
  }

  return errors;
}

function computeMaxMarks(type, config) {
  return type === 'CALC'
    ? config.parts.reduce((sum, p) => sum + Number(p.marks), 0)
    : config.rubric.reduce((sum, r) => sum + Number(r.max), 0);
}

// Shape returned to admins: includes the answer key, which is exactly why this
// route is role-guarded.
function adminQuestion(q) {
  return {
    ...q,
    config: JSON.parse(q.config_json),
    configLo: q.config_lo_json ? JSON.parse(q.config_lo_json) : null,
    archived: !!q.archived,
    translationStatus: q.translation_status || 'MISSING',
    // What a Lao candidate would still read in English. Reported, never
    // enforced: the English fallback is deliberate and beats a guess. It is
    // here so an admin can see the gaps before approving, not afterwards.
    laoGaps: laoGaps(q),
    laoComplete: laoIsComplete(q),
    // 'MACHINE' until a person rewrites it. Shown in the bank so nobody
    // mistakes automatic output for a reviewed translation.
    translationSource: q.translation_source || null,
    // Which assessments actually ask this question. A question nobody has
    // added to an assessment is never served to a candidate, so this is the
    // difference between written and in use.
    usedByAssessments: db.prepare(
      `SELECT a.name FROM assessment_questions aq JOIN assessments a ON a.id = aq.assessment_id
        WHERE aq.question_id = ? AND COALESCE(a.archived,0) = 0 ORDER BY a.name`
    ).all(q.id).map((r) => r.name),
  };
}

// Full question bank INCLUDING answer keys — never served publicly, and not to
// every authenticated role either.
router.get('/', requireRole(...QUESTION_READERS), (req, res) => {
  const showArchived = String(req.query.archived || '') === '1';
  const rows = showArchived
    ? db.prepare('SELECT * FROM questions WHERE COALESCE(archived,0) = 1 ORDER BY type, order_index').all()
    : db.prepare('SELECT * FROM questions WHERE COALESCE(archived,0) = 0 ORDER BY type, order_index').all();
  // The admin UI needs to know whether the Auto-translate action can work.
  // It is told a BOOLEAN and nothing else — never the key, the provider or
  // any part of the configuration.
  res.json({ questions: rows.map(adminQuestion), translationStatuses: STATUSES, translationConfigured: isTranslationConfigured() });
});


// -------------------------------------------------------------- translation
// Machine translation of candidate-visible wording. ADMIN ONLY: a candidate can
// never reach this router at all (it is mounted behind requireAuth), and within
// it only the roles that may already edit questions can translate.
//
// Nothing is saved here. The translation is handed back to the editor, the
// admin reviews and edits it, and the ordinary save path stores it. That is
// what keeps machine output out of the candidate portal until a human approves.

// One in-flight translation per user. A double-click, an impatient second click
// or a stuck button cannot fan out into several paid provider calls.
const translationsInFlight = new Set();

router.post('/translate', requireRole(...QUESTION_EDITORS), translateLimiter, async (req, res) => {
  const userKey = (req.user && req.user.id) || req.ip;
  if (translationsInFlight.has(userKey)) {
    return res.status(409).json({ error: 'A translation is already running. Please wait for it to finish.' });
  }
  // NOTE the order: the request is validated inside translateQuestion BEFORE
  // the provider configuration is consulted. A malformed request is the
  // admin's mistake and must be reported as 400 whether or not a provider
  // happens to be configured — otherwise a misconfigured server hides real
  // request bugs behind a 503.
  translationsInFlight.add(userKey);
  try {
    const result = await translateQuestion(req.body || {});
    auditFromReq(req, 'Question translated', (req.body || {}).questionId || null, null, {
      sourceLanguage: (req.body || {}).sourceLanguage,
      targetLanguage: (req.body || {}).targetLanguage,
      options: result.options.length,
      machine: true,
    });
    // MACHINE output. The caller is told so explicitly, so nothing downstream
    // can mistake it for a reviewed translation.
    res.json({ ...result, machineTranslated: true, translationStatus: 'DRAFT' });
  } catch (e) {
    if (e instanceof TranslationError) {
      const status = {
        BAD_REQUEST: 400,
        NOT_CONFIGURED: 503,
        PROVIDER_TIMEOUT: 504,
        PROVIDER_UNAVAILABLE: 502,
        BAD_PROVIDER_RESPONSE: 502,
      }[e.code] || 500;
      if (status >= 500) console.warn('[translation] ' + e.code);
      const body = { error: e.message, code: e.code };
      // A configuration problem is reported as such, so the admin UI can say
      // "not configured" rather than "try again".
      if (e.code === 'NOT_CONFIGURED') body.configured = false;
      return res.status(status).json(body);
    }
    // Never surface a raw provider or runtime error to the browser.
    console.error('[translation] unexpected failure:', e && e.message);
    res.status(500).json({ error: 'Translation failed. Please try again.' });
  } finally {
    translationsInFlight.delete(userKey);
  }
});

router.get('/translate/limits', requireRole(...QUESTION_READERS), (req, res) => {
  res.json({ configured: isTranslationConfigured(), limits: LIMITS });
});

router.get('/:id', requireRole(...QUESTION_READERS), (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  res.json({ question: adminQuestion(q) });
});

router.post('/', requireRole(...QUESTION_EDITORS), (req, res) => {
  const b = req.body || {};
  const errors = validateQuestionPayload(b);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const id = generateId('q');
  const maxMarks = computeMaxMarks(b.type, b.config);
  const status = resolveTranslationStatus(b.translationStatus, b.textLo);
  db.prepare(
    `INSERT INTO questions (id, type, order_index, category, difficulty, max_marks, text, config_json,
       text_lo, config_lo_json, translation_status, translation_source,
       translation_updated_by, translation_updated_at,
       explanation, active, created_by)
     VALUES (@id,@type,@order,@category,@difficulty,@maxMarks,@text,@config,
       @textLo,@configLo,@status,@source,@translatedBy,@translatedAt,@explanation,@active,@createdBy)`
  ).run({
    id, type: b.type, order: b.order || 0, category: b.category || null, difficulty: b.difficulty || null,
    maxMarks, text: String(b.text).trim(), config: JSON.stringify(b.config),
    textLo: b.textLo ? String(b.textLo).trim() : null,
    configLo: b.configLo ? JSON.stringify(b.configLo) : null,
    status,
    // No Lao -> no provenance. Lao with no declared source was typed by the
    // person saving it, so it is HUMAN unless they say it came from the machine.
    source: status === 'MISSING'
      ? null
      : (b.translationSource ? String(b.translationSource).toUpperCase() : 'HUMAN'),
    translatedBy: status === 'MISSING' ? null : req.user.name,
    translatedAt: status === 'MISSING' ? null : new Date().toISOString(),
    explanation: b.explanation || null,
    active: b.active === false ? 0 : 1,
    createdBy: req.user.name,
  });
  auditFromReq(req, 'Question created', id, null, {
    type: b.type, maxMarks, translationStatus: status,
    translationSource: status === 'MISSING' ? null : (b.translationSource ? String(b.translationSource).toUpperCase() : 'HUMAN'),
  });
  res.status(201).json({ id, maxMarks, translationStatus: status });
});

router.patch('/:id', requireRole(...QUESTION_EDITORS), (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  const b = req.body || {};

  const errors = validateQuestionPayload(b, { partial: true, existing: q });
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const config = b.config ? JSON.stringify(b.config) : q.config_json;
  const maxMarks = b.config ? computeMaxMarks(q.type, b.config) : q.max_marks;

  // Editing the English text or the options invalidates an approved Lao
  // translation: it now describes a different question. It drops back to DRAFT
  // so a human re-approves it rather than a stale translation staying live.
  const englishChanged = (b.text !== undefined && String(b.text).trim() !== q.text)
    || (b.config !== undefined && JSON.stringify(b.config) !== q.config_json);
  const textLo = b.textLo !== undefined ? (b.textLo ? String(b.textLo).trim() : null) : q.text_lo;
  const configLo = b.configLo !== undefined
    ? (b.configLo ? JSON.stringify(b.configLo) : null)
    : q.config_lo_json;

  let status;
  if (b.translationStatus !== undefined || b.textLo !== undefined) {
    status = resolveTranslationStatus(b.translationStatus ?? q.translation_status, textLo);
  } else {
    status = resolveTranslationStatus(q.translation_status, textLo);
  }
  if (englishChanged && status === 'APPROVED' && b.translationStatus === undefined) {
    status = 'DRAFT';
  }

  // Provenance. An explicit declaration wins. Otherwise: rewriting the Lao text
  // by hand makes it HUMAN, because that is what just happened — machine output
  // a person has edited is no longer machine output. Clearing the Lao clears it.
  const laoTextChanged = b.textLo !== undefined && String(b.textLo || '').trim() !== String(q.text_lo || '').trim();
  let source;
  if (b.translationSource !== undefined) {
    source = b.translationSource ? String(b.translationSource).toUpperCase() : null;
  } else if (laoTextChanged) {
    source = 'HUMAN';
  } else {
    source = q.translation_source || null;
  }
  if (!textLo) source = null;

  const touchedTranslation = b.textLo !== undefined || b.configLo !== undefined
    || b.translationStatus !== undefined || b.translationSource !== undefined;
  db.prepare(
    `UPDATE questions SET text=@text, category=@category, difficulty=@difficulty, explanation=@explanation,
     config_json=@config, max_marks=@maxMarks, active=@active,
     text_lo=@textLo, config_lo_json=@configLo, translation_status=@status,
     translation_source=@source,
     translation_updated_by=@translatedBy, translation_updated_at=@translatedAt,
     updated_at=datetime('now') WHERE id=@id`
  ).run({
    id: q.id,
    text: b.text !== undefined ? String(b.text).trim() : q.text,
    category: b.category ?? q.category,
    difficulty: b.difficulty ?? q.difficulty,
    explanation: b.explanation ?? q.explanation,
    config, maxMarks,
    active: b.active != null ? (b.active ? 1 : 0) : q.active,
    textLo, configLo, status, source,
    translatedBy: touchedTranslation ? req.user.name : q.translation_updated_by,
    translatedAt: touchedTranslation ? new Date().toISOString() : q.translation_updated_at,
  });
  auditFromReq(req, 'Question updated', q.id,
    { translationStatus: q.translation_status, translationSource: q.translation_source, maxMarks: q.max_marks },
    { translationStatus: status, translationSource: source, maxMarks, englishChanged });
  res.json({ ok: true, maxMarks, translationStatus: status, translationSource: source });
});

// -------------------------------------------------- Archive / restore
// Questions are never hard-deleted: candidate_answers.question_id references
// them, so a completed assessment would lose the question it was marked on.
// Archiving withdraws a question from new assessments and is reversible.
router.post('/:id/archive', requireRole(...QUESTION_EDITORS), (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  if (q.archived) return res.status(409).json({ error: 'This question is already archived.' });
  db.prepare(`UPDATE questions SET archived = 1, archived_at = datetime('now'), archived_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(req.user.name, q.id);
  const usedBy = db.prepare('SELECT COUNT(*) AS n FROM candidate_answers WHERE question_id = ?').get(q.id).n;
  auditFromReq(req, 'QUESTION_ARCHIVED', q.id, { archived: 0 }, { archived: 1, answersReferencing: usedBy });
  res.json({ ok: true, archived: true, answersReferencing: usedBy });
});

router.post('/:id/restore', requireRole(...QUESTION_EDITORS), (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  if (!q.archived) return res.status(409).json({ error: 'This question is not archived.' });
  db.prepare(`UPDATE questions SET archived = 0, archived_at = NULL, archived_by = NULL, updated_at = datetime('now') WHERE id = ?`).run(q.id);
  auditFromReq(req, 'QUESTION_RESTORED', q.id, { archived: 1 }, { archived: 0 });
  res.json({ ok: true, archived: false });
});

// ---- Interview questions ----
router.get('/interview/questions', (req, res) => {
  res.json({ questions: db.prepare('SELECT * FROM interview_questions ORDER BY order_index').all() });
});
router.post('/interview/questions', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'INTERVIEWER', 'MANAGER'), (req, res) => {
  const b = req.body || {};
  if (!b.text) return res.status(400).json({ error: 'text is required.' });
  const id = generateId('ivq');
  const orderRow = db.prepare('SELECT MAX(order_index) AS m FROM interview_questions').get();
  db.prepare('INSERT INTO interview_questions (id, text, disqualifying, active, order_index) VALUES (?,?,?,1,?)')
    .run(id, b.text, b.disqualifying ? 1 : 0, (orderRow.m || 0) + 1);
  auditFromReq(req, 'Interview question added', b.text);
  res.status(201).json({ id });
});
router.patch('/interview/questions/:id', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'INTERVIEWER', 'MANAGER'), (req, res) => {
  const q = db.prepare('SELECT * FROM interview_questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  db.prepare('UPDATE interview_questions SET text=@text, disqualifying=@disqualifying, active=@active WHERE id=@id').run({
    id: q.id, text: b.text ?? q.text, disqualifying: b.disqualifying != null ? (b.disqualifying ? 1 : 0) : q.disqualifying,
    active: b.active != null ? (b.active ? 1 : 0) : q.active,
  });
  res.json({ ok: true });
});

router.get('/interview/criteria', (req, res) => {
  res.json({ criteria: db.prepare('SELECT * FROM interview_criteria ORDER BY order_index').all() });
});

module.exports = router;
