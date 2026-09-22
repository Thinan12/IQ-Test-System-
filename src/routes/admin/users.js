// Admin -> Users. Super Admin only.
//
// Passwords are bcrypt-hashed and a hash is never returned by any route here.
// Password resets and role changes are audited individually because they are
// the two actions that can silently escalate access.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../../db');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { auditFromReq } = require('../../lib/audit');
const { generateId } = require('../../lib/tokens');

const router = express.Router();
router.use(requireAuth, requireRole('SUPER_ADMIN'));

const ROLES = ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER', 'INTERVIEWER', 'EVALUATOR', 'MANAGER'];
const MIN_PASSWORD = 10;

// Shape sent to the browser. password_hash is deliberately absent.
function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    active: !!u.active,
    createdAt: u.created_at,
  };
}

function findUser(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }

function countActiveSuperAdmins(excludingId) {
  const rows = db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN' AND active = 1").all();
  return rows.filter((r) => r.id !== excludingId).length;
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= MIN_PASSWORD;
}

router.get('/', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY role, name').all();
  res.json({ users: users.map(publicUser), roles: ROLES, minPasswordLength: MIN_PASSWORD });
});

// ------------------------------------------------------------ Create user
router.post('/', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const role = String(b.role || '').trim();

  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email address is required.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Role must be one of: ' + ROLES.join(', ') });
  if (!validPassword(b.password)) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const id = generateId('user');
  db.prepare('INSERT INTO users (id, name, email, password_hash, role, active) VALUES (?,?,?,?,?,1)')
    .run(id, name, email, bcrypt.hashSync(b.password, 12), role);
  auditFromReq(req, 'USER_CREATED', email, null, { name, role });
  res.status(201).json({ ok: true, user: publicUser(findUser(id)) });
});

// -------------------------------------------------------------- Edit user
router.patch('/:id', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const b = req.body || {};
  const updates = {};

  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
    updates.name = name;
  }
  if (b.email !== undefined) {
    const email = String(b.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email address is required.' });
    const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, user.id);
    if (clash) return res.status(409).json({ error: 'Another account already uses that email.' });
    updates.email = email;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });

  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE users SET ${setClause} WHERE id = @id`).run({ ...updates, id: user.id });
  auditFromReq(req, 'USER_UPDATED', user.email, { name: user.name, email: user.email }, updates);
  res.json({ ok: true, user: publicUser(findUser(user.id)) });
});

// ------------------------------------------------------------ Change role
// Audited separately from an ordinary edit: this is a privilege change.
router.post('/:id/role', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const role = String((req.body || {}).role || '');
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Role must be one of: ' + ROLES.join(', ') });
  if (role === user.role) return res.status(400).json({ error: 'That is already this user\'s role.' });
  // Never leave the system without a way in.
  if (user.role === 'SUPER_ADMIN' && countActiveSuperAdmins(user.id) === 0) {
    return res.status(409).json({ error: 'This is the last active Super Admin. Promote another account first.' });
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
  auditFromReq(req, 'USER_ROLE_CHANGED', user.email, { role: user.role }, { role });
  res.json({ ok: true, user: publicUser(findUser(user.id)) });
});

// --------------------------------------------------- Enable / disable user
router.post('/:id/active', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const active = !!(req.body || {}).active;
  if (!active) {
    if (user.id === req.user.id) return res.status(409).json({ error: 'You cannot disable your own account.' });
    if (user.role === 'SUPER_ADMIN' && countActiveSuperAdmins(user.id) === 0) {
      return res.status(409).json({ error: 'This is the last active Super Admin and cannot be disabled.' });
    }
  }
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, user.id);
  auditFromReq(req, active ? 'USER_ENABLED' : 'USER_DISABLED', user.email, { active: !!user.active }, { active });
  res.json({ ok: true, user: publicUser(findUser(user.id)) });
});

// ---------------------------------------------------------- Reset password
router.post('/:id/reset-password', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const b = req.body || {};

  // Either set a chosen password, or have one generated to hand over once.
  let password = b.password;
  let generated = false;
  if (b.generate) {
    password = crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe
    generated = true;
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), user.id);
  // The audit record names who reset whose password — never the password.
  auditFromReq(req, 'USER_PASSWORD_RESET', user.email, null, { by: req.user.name, generated });
  res.json({
    ok: true,
    // A generated password is returned exactly once so the admin can pass it on;
    // a chosen one is never echoed back.
    generatedPassword: generated ? password : undefined,
    message: generated
      ? 'Password reset. Copy the generated password now — it will not be shown again.'
      : 'Password reset.',
  });
});

module.exports = router;
