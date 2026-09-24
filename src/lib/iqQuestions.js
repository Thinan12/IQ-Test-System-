// The IQ question model.
//
// An IQ question reuses the EXISTING question row and the existing marking
// engine rather than introducing a parallel one. Concretely it is a `questions`
// row with:
//
//   type            = 'CALC'   -> objectively marked (see lib/grading.js)
//   question_family = 'IQ'     -> which bank it belongs to
//   iq_category     = e.g. 'NUMERICAL'
//   config_json     = { parts: [{ key:'answer', type:'choice',
//                                 options:['A','B','C','D'],
//                                 optionLabels:{A:'24',...},
//                                 expected:'B', marks:1 }] }
//
// That means bilingual text, approved-translation gating, the candidate
// sanitizer, autosave, flagging, the timer and server-side marking all work
// already and are already tested. The canonical option VALUE (A/B/C/D) is what
// is stored and compared; only the LABEL is ever translated, so a Lao candidate
// and an English candidate are marked by exactly the same rule.
const CATEGORIES = [
  { key: 'NUMERICAL', label: 'Numerical reasoning' },
  { key: 'LOGICAL', label: 'Logical reasoning' },
  { key: 'PATTERN', label: 'Pattern recognition' },
  { key: 'VERBAL', label: 'Verbal reasoning' },
  { key: 'SPATIAL', label: 'Spatial reasoning' },
  { key: 'SEQUENCE', label: 'Sequence reasoning' },
];
const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];

// Canonical option values. They are letters on purpose: a value must never be
// the answer text, or translating the text would change the answer.
const OPTION_VALUES = ['A', 'B', 'C', 'D', 'E', 'F'];
const ANSWER_PART_KEY = 'answer';

const LIMITS = {
  textChars: 2000,
  labelChars: 300,
  minOptions: 2,
  maxOptions: OPTION_VALUES.length,
  maxMarks: 20,
};

/**
 * Turn the admin's simple form into the config the marking engine expects.
 * @param {object} input {options:[{value,label}], correct, marks}
 */
function buildConfig(input) {
  const options = (input.options || []).map((o) => String(o.value));
  const optionLabels = {};
  (input.options || []).forEach((o) => {
    const label = String(o.label === undefined || o.label === null ? '' : o.label).trim();
    if (label) optionLabels[String(o.value)] = label;
  });
  const part = {
    key: ANSWER_PART_KEY,
    label: 'Answer',
    marks: Number(input.marks) > 0 ? Number(input.marks) : 1,
    type: 'choice',
    options,
    expected: String(input.correct),
  };
  if (Object.keys(optionLabels).length) part.optionLabels = optionLabels;
  return { parts: [part] };
}

/** The Lao overlay for an IQ question, in the shape resolveQuestionText reads. */
function buildConfigLo(input) {
  const map = {};
  (input.options || []).forEach((o) => {
    const label = String(o.labelLo === undefined || o.labelLo === null ? '' : o.labelLo).trim();
    if (label) map[String(o.value)] = label;
  });
  if (!Object.keys(map).length) return null;
  return { parts: { [ANSWER_PART_KEY]: { options: map } } };
}

/** Read an IQ question row back into the shape the admin form uses. */
function toAdminShape(q) {
  let config = {};
  let configLo = {};
  try { config = JSON.parse(q.config_json || '{}'); } catch (e) { config = {}; }
  try { configLo = JSON.parse(q.config_lo_json || '{}'); } catch (e) { configLo = {}; }
  const part = Array.isArray(config.parts) ? config.parts[0] : null;
  const loPart = configLo.parts && configLo.parts[ANSWER_PART_KEY] ? configLo.parts[ANSWER_PART_KEY] : {};
  const loOptions = loPart.options && typeof loPart.options === 'object' ? loPart.options : {};
  const enLabels = part && part.optionLabels && typeof part.optionLabels === 'object' ? part.optionLabels : {};
  return {
    id: q.id,
    category: q.iq_category || null,
    difficulty: q.difficulty || null,
    text: q.text,
    textLo: q.text_lo || null,
    marks: part ? Number(part.marks) || 1 : 1,
    correct: part ? part.expected : null,
    options: part && Array.isArray(part.options)
      ? part.options.map((v) => ({ value: v, label: enLabels[v] || v, labelLo: loOptions[v] || '' }))
      : [],
    explanation: q.explanation || null,
    active: !!q.active,
    archived: !!q.archived,
    translationStatus: q.translation_status || 'MISSING',
    translationSource: q.translation_source || null,
  };
}

/**
 * Validate the admin's IQ question. Returns error strings; an empty list means
 * the question can be saved.
 */
function validateIqQuestion(body, { partial = false, existing = null } = {}) {
  const errors = [];
  const b = body || {};

  if (!partial || b.text !== undefined) {
    const text = b.text === undefined && existing ? existing.text : b.text;
    if (!String(text || '').trim()) errors.push('The English question text is required.');
    else if (String(text).length > LIMITS.textChars) errors.push(`The question text may be at most ${LIMITS.textChars} characters.`);
  }
  if (b.textLo !== undefined && b.textLo !== null && typeof b.textLo !== 'string') {
    errors.push('The Lao question text must be text.');
  }

  const category = b.category !== undefined ? b.category : (existing ? existing.iq_category : undefined);
  if (!partial || b.category !== undefined) {
    if (!CATEGORY_KEYS.includes(String(category || '').toUpperCase())) {
      errors.push('category must be one of: ' + CATEGORY_KEYS.join(', '));
    }
  }
  if (b.difficulty !== undefined && b.difficulty !== null
      && !DIFFICULTIES.includes(String(b.difficulty).toUpperCase())) {
    errors.push('difficulty must be one of: ' + DIFFICULTIES.join(', '));
  }
  if (b.marks !== undefined && b.marks !== null) {
    const m = Number(b.marks);
    if (!Number.isFinite(m) || m <= 0 || m > LIMITS.maxMarks) {
      errors.push(`marks must be a number between 1 and ${LIMITS.maxMarks}.`);
    }
  }

  if (!partial || b.options !== undefined || b.correct !== undefined) {
    const options = b.options !== undefined ? b.options : [];
    if (!Array.isArray(options)) {
      errors.push('options must be a list.');
      return errors;
    }
    if (options.length < LIMITS.minOptions || options.length > LIMITS.maxOptions) {
      errors.push(`An IQ question needs between ${LIMITS.minOptions} and ${LIMITS.maxOptions} options.`);
      return errors;
    }
    const seen = new Set();
    options.forEach((o, i) => {
      const value = String((o && o.value) || '').trim();
      if (!value) { errors.push(`Option ${i + 1} needs a canonical value.`); return; }
      if (!OPTION_VALUES.includes(value)) {
        errors.push(`Option ${i + 1}: the canonical value must be one of ${OPTION_VALUES.join(', ')}.`);
      }
      if (seen.has(value)) errors.push(`Option value "${value}" appears twice.`);
      seen.add(value);
      const label = String((o && o.label) || '').trim();
      if (!label) errors.push(`Option "${value}" needs English text.`);
      else if (label.length > LIMITS.labelChars) errors.push(`Option "${value}" is longer than ${LIMITS.labelChars} characters.`);
      if (o && o.labelLo !== undefined && o.labelLo !== null && typeof o.labelLo !== 'string') {
        errors.push(`The Lao text for option "${value}" must be text.`);
      }
    });
    const correct = String(b.correct === undefined || b.correct === null ? '' : b.correct).trim();
    if (!correct) errors.push('A correct answer is required.');
    else if (!seen.has(correct)) errors.push('The correct answer must be one of the option values.');
  }

  return errors;
}

module.exports = {
  CATEGORIES,
  CATEGORY_KEYS,
  DIFFICULTIES,
  OPTION_VALUES,
  ANSWER_PART_KEY,
  LIMITS,
  buildConfig,
  buildConfigLo,
  toAdminShape,
  validateIqQuestion,
};
