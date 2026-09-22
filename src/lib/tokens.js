const crypto = require('crypto');

// Cryptographically secure random token for exam links. 32 bytes -> 64 hex chars.
// Never derived from candidate ID, email, phone, or database primary keys.
function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateId(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(12).toString('hex');
}

module.exports = { generateSecureToken, generateId };
