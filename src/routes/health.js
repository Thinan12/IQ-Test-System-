const express = require('express');
const router = express.Router();
const db = require('../db');

// Simple, fast health check for Railway deployment verification.
// Verifies the SQLite connection is open without running any queries
// or migrations, then responds immediately.
router.get('/', (req, res) => {
  try {
    if (!db || !db.open) {
      return res.status(503).json({ status: 'error', database: 'disconnected' });
    }
    return res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (err) {
    return res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

module.exports = router;
