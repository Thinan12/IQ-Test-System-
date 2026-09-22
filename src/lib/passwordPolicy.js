// Password rules for admin accounts.
//
// Deliberately strict: these accounts can read every candidate's answers, alter
// marks, and (for Super Admin) delete all candidate data. A password is only
// ever handled here in memory — it is hashed with bcrypt before it reaches the
// database and is never logged, audited or returned by any route.
const MIN_LENGTH = 14;

const CLASSES = [
  { name: 'a lowercase letter', test: (s) => /[a-z]/.test(s) },
  { name: 'an uppercase letter', test: (s) => /[A-Z]/.test(s) },
  { name: 'a digit', test: (s) => /[0-9]/.test(s) },
  { name: 'a symbol', test: (s) => /[^A-Za-z0-9]/.test(s) },
];
const REQUIRED_CLASSES = 3;

// Passwords that have been published in this repository or its documentation.
const BANNED = ['changeme123!', 'password', 'password123', 'lalco', 'admin', 'letmein'];

/**
 * @returns {{ok: boolean, errors: string[]}}
 */
function validatePassword(password, context = {}) {
  const errors = [];
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, errors: ['A password is required.'] };
  }
  if (password.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters.`);
  }
  const met = CLASSES.filter((c) => c.test(password));
  if (met.length < REQUIRED_CLASSES) {
    const missing = CLASSES.filter((c) => !c.test(password)).map((c) => c.name);
    errors.push(`Password must include at least ${REQUIRED_CLASSES} of: lowercase, uppercase, digit, symbol. Missing: ${missing.join(', ')}.`);
  }
  const lower = password.toLowerCase();
  if (BANNED.some((b) => lower === b || lower.includes(b))) {
    errors.push('That password is publicly known or too predictable. Choose something else.');
  }
  if (context.email && lower.includes(String(context.email).split('@')[0].toLowerCase())) {
    errors.push('Password must not contain the account name.');
  }
  if (/^(.)\1+$/.test(password)) errors.push('Password must not be a single repeated character.');
  return { ok: errors.length === 0, errors };
}

/** A strong password for the "generate one" reset flow. Shown once, never stored. */
function generatePassword() {
  const crypto = require('crypto');
  const lower = 'abcdefghijkmnopqrstuvwxyz';       // no l
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';        // no I, O
  const digit = '23456789';                        // no 0, 1
  const symbol = '!@#$%^&*-_=+?';
  const all = lower + upper + digit + symbol;
  const pick = (set) => set[crypto.randomInt(0, set.length)];
  // Guarantee every class, then fill to 20 characters.
  const chars = [pick(lower), pick(upper), pick(digit), pick(symbol)];
  while (chars.length < 20) chars.push(pick(all));
  // Fisher-Yates with a CSPRNG so the guaranteed characters are not positional.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

module.exports = { MIN_LENGTH, REQUIRED_CLASSES, validatePassword, generatePassword };
