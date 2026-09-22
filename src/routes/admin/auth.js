const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const { signToken, requireAuth, loginLimiter } = require('../../middleware/auth');
const { auditFromReq } = require('../../lib/audit');

const router = express.Router();

router.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const token = signToken(user);
  auditFromReq({ user: { name: user.name, role: user.role } }, 'User signed in', user.email);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
