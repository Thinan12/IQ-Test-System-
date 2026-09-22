// Validation for the candidate-facing LALCO ID (candidates.code).
//
// This is a human-readable business identifier printed on reports and used by
// the candidate to verify their identity before an assessment. It is NOT a
// secret and is NOT what secures the exam: the invitation URL always uses the
// 32-byte random token from lib/tokens.js.
const db = require('../db');

const MIN = 3;
const MAX = 32;
// Letters, digits, hyphen and underscore only. Everything else is rejected
// rather than stripped, so a typo is reported instead of silently changing the
// identifier. Values are parameterised at every call site, so this is defence
// in depth rather than the SQL-injection defence itself.
const ALLOWED = /^[A-Z0-9][A-Z0-9_-]*[A-Z0-9]$/;

/**
 * Trim the ends and uppercase. Internal whitespace is deliberately NOT stripped:
 * silently turning "HAS SPACE" into "HASSPACE" would hand back an identifier
 * the administrator never typed. It fails validation instead.
 */
function normalizeCode(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase();
}

/**
 * @returns {{ok: boolean, code?: string, error?: string}}
 */
function validateCode(raw, options = {}) {
  const code = normalizeCode(raw);
  if (!code) return { ok: false, error: 'Candidate ID cannot be empty.' };
  if (code.length < MIN) return { ok: false, error: `Candidate ID must be at least ${MIN} characters.` };
  if (code.length > MAX) return { ok: false, error: `Candidate ID must be at most ${MAX} characters.` };
  if (!ALLOWED.test(code)) {
    return { ok: false, error: 'Candidate ID may contain only letters, digits, hyphen and underscore, and must start and end with a letter or digit.' };
  }
  // Uniqueness is checked case-insensitively because codes are normalised to
  // uppercase; the UNIQUE index on candidates.code is the final guarantee.
  const clash = options.excludeId
    ? db.prepare('SELECT id FROM candidates WHERE code = ? AND id != ?').get(code, options.excludeId)
    : db.prepare('SELECT id FROM candidates WHERE code = ?').get(code);
  if (clash) return { ok: false, error: `Candidate ID "${code}" is already in use.` };
  return { ok: true, code };
}

module.exports = { MIN, MAX, normalizeCode, validateCode };
