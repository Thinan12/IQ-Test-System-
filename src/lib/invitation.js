// The invitation message an administrator copies and sends.
//
// One message, rendered in the language the administrator chose when they
// generated the invitation. The wording is editable in Admin Settings; the
// defaults below are used until somebody edits them, so an existing
// installation keeps sending invitations without any data migration.
//
// Only two placeholders are substituted, and they are substituted literally:
//   [Candidate Name]
//   [LINK]
// Nothing else in the template is interpreted, so an administrator cannot
// accidentally expose a score, an id or anything else by editing the wording.

const db = require('../db');

const LANGUAGES = ['en', 'lo'];

// The Lao wording here was supplied by the business. It is not machine
// translated and must not be replaced with a machine translation.
const DEFAULT_TEMPLATES = {
  en: [
    'Hello [Candidate Name],',
    '',
    'You are invited to complete the assessment.',
    '',
    'Please open the following secure link:',
    '',
    '[LINK]',
    '',
    'Thank you.',
  ].join('\n'),
  lo: [
    'ສະບາຍດີ [Candidate Name],',
    '',
    'ທ່ານໄດ້ຮັບເຊີນໃຫ້ເຂົ້າຮ່ວມການທົດສອບ.',
    '',
    'ກະລຸນາເປີດລິ້ງດ້ານລຸ່ມ:',
    '',
    '[LINK]',
    '',
    'ຂອບໃຈ.',
  ].join('\n'),
};

function normaliseLanguage(lang) {
  const l = String(lang || '').trim().toLowerCase();
  return LANGUAGES.includes(l) ? l : 'en';
}

/** The template in force for a language: the edited one, or the default. */
function templateFor(language) {
  const lang = normaliseLanguage(language);
  const s = db.prepare('SELECT invite_template_en, invite_template_lo FROM settings WHERE id = 1').get() || {};
  const stored = lang === 'lo' ? s.invite_template_lo : s.invite_template_en;
  const text = String(stored || '').trim();
  return text || DEFAULT_TEMPLATES[lang];
}

/**
 * Render an invitation. Placeholder substitution only — the template is never
 * evaluated, and the values are inserted as-is.
 */
function renderInvitation({ language, candidateName, link }) {
  return templateFor(language)
    .split('[Candidate Name]').join(String(candidateName || ''))
    .split('[LINK]').join(String(link || ''));
}

/** What the settings screen edits, with the defaults shown when unset. */
function currentTemplates() {
  const s = db.prepare('SELECT invite_template_en, invite_template_lo FROM settings WHERE id = 1').get() || {};
  return {
    en: { text: String(s.invite_template_en || '').trim() || DEFAULT_TEMPLATES.en, isDefault: !String(s.invite_template_en || '').trim() },
    lo: { text: String(s.invite_template_lo || '').trim() || DEFAULT_TEMPLATES.lo, isDefault: !String(s.invite_template_lo || '').trim() },
  };
}

/**
 * Validate an edited template. The link placeholder is required: a message
 * without it cannot be acted on, and an administrator would only discover that
 * after sending it to somebody.
 */
function validateTemplate(text) {
  const t = String(text === null || text === undefined ? '' : text);
  if (!t.trim()) return []; // blank means "go back to the default"
  const errors = [];
  if (!t.includes('[LINK]')) errors.push('The invitation must contain [LINK], or the candidate has nothing to open.');
  if (t.length > 4000) errors.push('That invitation message is too long.');
  return errors;
}

module.exports = {
  LANGUAGES,
  DEFAULT_TEMPLATES,
  normaliseLanguage,
  templateFor,
  renderInvitation,
  currentTemplates,
  validateTemplate,
};
