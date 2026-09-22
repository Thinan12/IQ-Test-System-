const db = require('../db');
const { generateId } = require('./tokens');

function audit({ userName, role, action, target, oldValue, newValue, ip }) {
  db.prepare(
    `INSERT INTO audit_logs (id, user_name, role, action, target, old_value, new_value, ip)
     VALUES (@id, @userName, @role, @action, @target, @oldValue, @newValue, @ip)`
  ).run({
    id: generateId('log'),
    userName: userName || 'System',
    role: role || 'System',
    action,
    target: target || '',
    oldValue: oldValue == null ? null : JSON.stringify(oldValue).slice(0, 500),
    newValue: newValue == null ? null : JSON.stringify(newValue).slice(0, 500),
    ip: ip || null,
  });
}

// Express middleware helper: pulls the actor off req.user (set by auth middleware) and the client IP.
function auditFromReq(req, action, target, oldValue, newValue) {
  audit({
    userName: req.user ? req.user.name : 'Candidate (public exam)',
    role: req.user ? req.user.role : 'CANDIDATE',
    action,
    target,
    oldValue,
    newValue,
    ip: req.ip,
  });
}

module.exports = { audit, auditFromReq };
