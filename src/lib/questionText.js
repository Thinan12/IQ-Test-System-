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

/**
 * Strict check for a language an ADMIN supplied. normaliseLanguage() quietly
 * falls back to English, which is right for a candidate request that may carry
 * a stale value, but wrong when someone configuring an invitation typed
 * something unsupported: they must be told rather than silently given English.
 * Accepts either case, so 'EN' and 'en' both pass.
 */
function isSupportedLanguage(value) {
  return LANGUAGES.includes(String(value == null ? '' : value).trim().toLowerCase());
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
     *
     * An option may carry a separate ENGLISH display label in
     * `part.optionLabels[value]`, so a question can read "A / Paris" without
     * the graded value ever becoming "Paris". It is optional: a part with no
     * optionLabels shows the value itself, which is how every question written
     * before this existed already behaved.
     *
     * Precedence: approved Lao -> English label -> canonical value.
     */
    partOptions(part) {
      const values = Array.isArray(part.options) ? part.options : [];
      const english = part.optionLabels && typeof part.optionLabels === 'object' ? part.optionLabels : {};
      const entry = approved && overlay.parts ? overlay.parts[part.key] : null;
      const map = entry && entry.options && typeof entry.options === 'object' ? entry.options : {};
      return values.map((value) => {
        const translated = typeof map[value] === 'string' ? map[value].trim() : '';
        const englishLabel = typeof english[value] === 'string' ? english[value].trim() : '';
        return { value, label: translated || englishLabel || value };
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

/**
 * What a Lao candidate would still read in English for this question, as a
 * plain list. It reports; it never blocks and never invents anything.
 *
 * A gap is not an error: the per-option English fallback is deliberate and is
 * better than a guessed translation. This exists so an admin marking a question
 * APPROVED can SEE what is still English rather than discovering it from a
 * candidate. Only candidate-visible strings are counted — an essay rubric is
 * internal marking text and is never shown, so it is not a gap.
 */
function laoGaps(question) {
  const gaps = { text: false, parts: [], options: [] };
  if (!question) return gaps;
  gaps.text = !String(question.text_lo || '').trim();
  if (question.type !== 'CALC') return gaps;

  let config;
  try { config = JSON.parse(question.config_json || '{}'); } catch (e) { return gaps; }
  const parts = Array.isArray(config.parts) ? config.parts : [];
  const overlay = laoOverlay(question);
  const overlayParts = overlay.parts && typeof overlay.parts === 'object' ? overlay.parts : {};

  parts.forEach((p) => {
    const entry = overlayParts[p.key] || {};
    if (!String(entry.label || '').trim()) gaps.parts.push(p.key);
    if (p.type !== 'choice') return;
    const map = entry.options && typeof entry.options === 'object' ? entry.options : {};
    (Array.isArray(p.options) ? p.options : []).forEach((value) => {
      if (!String(map[value] || '').trim()) gaps.options.push({ part: p.key, value });
    });
  });
  return gaps;
}

/** True when nothing a Lao candidate reads would fall back to English. */
function laoIsComplete(question) {
  const g = laoGaps(question);
  return !g.text && !g.parts.length && !g.options.length;
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
  isSupportedLanguage,
  hasApprovedLao,
  laoOverlay,
  resolveQuestionText,
  validateLaoOverlay,
  laoGaps,
  laoIsComplete,
  resolveTranslationStatus,
};
