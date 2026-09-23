// Resolves the language a candidate sees a question in.
//
// English is the source language and the single source of truth. A Lao
// translation belongs to the SAME question row — there is never a second
// question record — so the question ID, marks, answer key, tolerance and
// marking rules are shared and cannot drift between languages.
//
// The one rule that matters for correctness: a choice answer is stored as its
// option VALUE and graded by exact match against `expected` (see
// lib/grading.js). Translating a value would silently score every choice
// question zero and invalidate answers already saved. So only labels are ever
// translated; values stay canonical English.
const LANGUAGES = ['en', 'lo'];
const DEFAULT_LANGUAGE = 'en';
const STATUSES = ['MISSING', 'DRAFT', 'APPROVED'];

function normaliseLanguage(value) {
  const lang = String(value || '').trim().toLowerCase();
  return LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

/**
 * Only an APPROVED translation is ever shown to a candidate. A DRAFT is
 * visible to admins in the Question Bank but never to the person being
 * assessed — an unreviewed translation of an exam question is a wrong question.
 */
function hasApprovedLao(question) {
  return !!(question
    && question.translation_status === 'APPROVED'
    && String(question.text_lo || '').trim());
}

/**
 * The Lao overlay for a question's candidate-facing config strings.
 * Shape: { parts: { <partKey>: { label, options: { <englishValue>: '<lao>' } } } }
 */
function laoOverlay(question) {
  return parseJson(question && question.config_lo_json, { parts: {} }) || { parts: {} };
}

/**
 * Resolve the text a candidate sees, for one question in one language.
 *
 * Returns the English source plus, when Lao is requested, whatever approved Lao
 * exists and an explicit flag for what is missing. Nothing is invented: a
 * missing translation is reported, never silently replaced with English
 * pretending to be Lao, and never machine-generated.
 */
function resolveQuestionText(question, language) {
  const lang = normaliseLanguage(language);
  const overlay = lang === 'lo' ? laoOverlay(question) : { parts: {} };
  const approved = lang === 'lo' && hasApprovedLao(question);

  return {
    language: lang,
    // The question stem actually shown.
    text: approved ? question.text_lo : question.text,
    // True when Lao was asked for but no approved translation exists, so the
    // UI can say so plainly instead of pretending.
    laoMissing: lang === 'lo' && !approved,
    translationStatus: question ? question.translation_status || 'MISSING' : 'MISSING',

    /** Label for one config part, falling back to English when untranslated. */
    partLabel(part) {
      if (!approved) return part.label;
      const entry = overlay.parts && overlay.parts[part.key];
      const label = entry && typeof entry.label === 'string' ? entry.label.trim() : '';
      return label || part.label;
    },

    /**
     * Options as {value, label} pairs. `value` is ALWAYS the canonical English
     * string that grading compares against; only `label` is translated.
     */
    partOptions(part) {
      const values = Array.isArray(part.options) ? part.options : [];
      const entry = approved && overlay.parts ? overlay.parts[part.key] : null;
      const map = entry && entry.options && typeof entry.options === 'object' ? entry.options : {};
      return values.map((value) => {
        const translated = typeof map[value] === 'string' ? map[value].trim() : '';
        return { value, label: translated || value };
      });
    },
  };
}

/**
 * Validate a Lao overlay against the English config it belongs to, so a
 * translation can never introduce an option that does not exist or drop one
 * that does.
 */
function validateLaoOverlay(overlay, englishConfig, type) {
  const errors = [];
  if (overlay === null || overlay === undefined) return errors;
  if (typeof overlay !== 'object' || Array.isArray(overlay)) {
    return ['Lao configuration must be an object.'];
  }
  if (type !== 'CALC') return errors; // ESSAY has no candidate-facing config strings

  const parts = (englishConfig && Array.isArray(englishConfig.parts)) ? englishConfig.parts : [];
  const byKey = {};
  parts.forEach((p) => { byKey[p.key] = p; });
  const overlayParts = overlay.parts && typeof overlay.parts === 'object' ? overlay.parts : {};

  Object.keys(overlayParts).forEach((key) => {
    const part = byKey[key];
    if (!part) {
      errors.push(`Lao translation refers to part "${key}", which does not exist in the question.`);
      return;
    }
    const entry = overlayParts[key] || {};
    if (entry.label !== undefined && typeof entry.label !== 'string') {
      errors.push(`Lao label for part "${key}" must be text.`);
    }
    if (entry.options !== undefined) {
      if (typeof entry.options !== 'object' || Array.isArray(entry.options)) {
        errors.push(`Lao options for part "${key}" must be an object keyed by the English option.`);
        return;
      }
      const allowed = Array.isArray(part.options) ? part.options : [];
      Object.keys(entry.options).forEach((value) => {
        if (!allowed.includes(value)) {
          errors.push(`Lao translation refers to option "${value}" for part "${key}", which is not one of its options.`);
        }
        if (typeof entry.options[value] !== 'string') {
          errors.push(`Lao text for option "${value}" of part "${key}" must be text.`);
        }
      });
    }
  });
  return errors;
}

/** Derived status used when saving: empty Lao can never be APPROVED. */
function resolveTranslationStatus(requested, textLo) {
  const hasText = !!String(textLo || '').trim();
  if (!hasText) return 'MISSING';
  const wanted = String(requested || '').toUpperCase();
  return STATUSES.includes(wanted) && wanted !== 'MISSING' ? wanted : 'DRAFT';
}

module.exports = {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  STATUSES,
  normaliseLanguage,
  hasApprovedLao,
  laoOverlay,
  resolveQuestionText,
  validateLaoOverlay,
  resolveTranslationStatus,
};
