const express = require('express');
const db = require('../../db');
const { requireAuth } = require('../../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function liveStatus(link) {
  if (link.status === 'REVOKED') return 'REVOKED';
  if (link.status === 'USED') return 'USED';
  if (new Date(link.expires_at) < new Date()) return 'EXPIRED';
  return link.status;
}

router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT l.*, c.full_name, c.code FROM assessment_links l JOIN candidates c ON c.id = l.candidate_id ORDER BY l.created_at DESC`
  ).all();
  const out = rows.map((l) => {
    const accessLog = db.prepare('SELECT * FROM link_access_log WHERE link_id = ? ORDER BY occurred_at').all(l.id);
    return {
      id: l.id, token: l.token, candidateId: l.candidate_id, candidateName: l.full_name, candidateCode: l.code,
      status: liveStatus(l), createdAt: l.created_at, expiresAt: l.expires_at, firstAccessAt: l.first_access_at,
      accessAttempts: accessLog.length, successfulAccess: accessLog.filter((a) => a.success).length,
    };
  });
  res.json({ links: out });
});

module.exports = router;
