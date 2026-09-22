// Admin -> Settings -> Data Management.
//
// EVERY route in this file is Super Admin only. HR Admin, Recruiter,
// Interviewer, Evaluator and Manager are rejected with 403 by requireRole
// below — there is no client-side-only gate.
const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const db = require('../../db');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { auditFromReq } = require('../../lib/audit');
const {
  getDataStats, deleteCandidateData, previewDeletion, createDemoCandidates,
} = require('../../lib/dataManagement');
const {
  isGoogleSyncConfigured, isAutoSyncEnabled, syncAllGoogleSheets,
  syncPendingGoogleSheets, pendingSyncSessions,
} = require('../../lib/googleSheets');

const router = express.Router();
router.use(requireAuth, requireRole('SUPER_ADMIN'));

const DELETE_PHRASE = 'DELETE ALL CANDIDATES';
// Backups live beside the live database, wherever DATABASE_PATH points.
const BACKUP_DIR = path.join(path.dirname(db.name), 'backups');
const BACKUP_NAME = /^LALCO_backup_\d{8}T\d{6}\.sqlite$/;

// The destructive endpoint re-checks the Super Admin password, so it gets its
// own tight limiter to stop that becoming a password oracle.
const destructiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait before trying again.' },
});

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => BACKUP_NAME.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { fileName: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function csv(rows) {
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(escape).join(',')).join('\r\n');
}

function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv(rows)); // BOM so Excel opens UTF-8 names correctly
}

function today() { return new Date().toISOString().slice(0, 10); }

// ---------------------------------------------------------------- Overview
router.get('/', (req, res) => {
  res.json({
    stats: getDataStats(),
    // Only a boolean ever reaches the browser. Sheet ID, service-account email
    // and private key stay server-side.
    googleSyncConfigured: isGoogleSyncConfigured(),
    googleAutoSyncOnSubmit: isAutoSyncEnabled(),
    googleSyncPending: pendingSyncSessions().length,
    backups: listBackups().slice(0, 20),
  });
});

// ------------------------------------------------------------------ Export
router.get('/export-candidates.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT c.*, p.name AS position_name, d.name AS department_name, b.name AS branch_name
       FROM candidates c
       LEFT JOIN positions p ON p.id = c.applied_position_id
       LEFT JOIN departments d ON d.id = c.applied_department_id
       LEFT JOIN branches b ON b.id = c.branch_id
      ORDER BY c.created_at DESC`
  ).all();
  const out = [[
    'Candidate ID', 'Full Name', 'Gender', 'Date of Birth', 'Phone', 'Email', 'Province',
    'Education', 'University', 'Major', 'GPA', 'IQ', 'Application Type', 'Position', 'Department',
    'Branch', 'Application Date', 'Status', 'Demo Record', 'Created At',
  ]];
  rows.forEach((c) => out.push([
    c.code, c.full_name, c.gender, c.dob, c.phone, c.email, c.province, c.education, c.university,
    c.major, c.gpa, c.iq, c.application_type, c.position_name, c.department_name, c.branch_name,
    c.application_date, c.status, c.is_demo ? 'YES' : 'NO', c.created_at,
  ]));
  auditFromReq(req, 'EXPORT_ALL_CANDIDATE_DATA', 'ALL_CANDIDATES', null, { rows: rows.length });
  sendCsv(res, `LALCO_Candidate_Data_${today()}.csv`, out);
});

router.get('/export-results.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT c.code, c.full_name, c.is_demo, s.id AS assessment_id, s.started_at, s.submitted_at, s.status,
            s.submission_type, s.submission_reason, s.answered_count, s.unanswered_count,
            s.google_sync_status, sc.calc_marks, sc.calc_max, sc.essay_marks, sc.essay_max,
            sc.interview_marks, sc.interview_max, sc.final_marks, sc.percentage, sc.pass,
            ia.risk_level
       FROM assessment_sessions s
       JOIN candidates c ON c.id = s.candidate_id
       LEFT JOIN scores sc ON sc.session_id = s.id
       LEFT JOIN integrity_assessments ia ON ia.session_id = s.id
      ORDER BY COALESCE(s.submitted_at, s.started_at, '') DESC`
  ).all();
  const passThreshold = db.prepare('SELECT pass_threshold AS t FROM settings WHERE id = 1').get().t;
  const out = [[
    'Candidate ID', 'Candidate Name', 'Assessment ID', 'Started At', 'Submitted At', 'Session Status',
    'Submission Reason', 'Answered', 'Unanswered',
    'Calculation', 'Written', 'Interview', 'Final Score', 'Percentage', 'Pass Threshold', 'Pass/Fail',
    'Integrity Risk Level', 'Google Sync', 'Demo Record',
  ]];
  rows.forEach((r) => out.push([
    r.code, r.full_name, r.assessment_id, r.started_at, r.submitted_at,
    r.status === 'SUBMITTED' && r.submission_type === 'AUTO_SUBMITTED' ? 'AUTO_SUBMITTED' : r.status,
    r.submission_reason || '', r.answered_count == null ? '' : r.answered_count,
    r.unanswered_count == null ? '' : r.unanswered_count,
    r.calc_marks == null ? '' : `${r.calc_marks}/${r.calc_max}`,
    r.essay_marks == null ? '' : `${r.essay_marks}/${r.essay_max}`,
    r.interview_marks == null ? '' : `${r.interview_marks}/${r.interview_max}`,
    r.final_marks == null ? '' : r.final_marks, r.percentage == null ? '' : r.percentage,
    passThreshold, r.pass == null ? 'NOT SCORED' : r.pass ? 'PASS' : 'FAIL',
    r.risk_level || '', r.google_sync_status, r.is_demo ? 'YES' : 'NO',
  ]));
  auditFromReq(req, 'EXPORT_ALL_ASSESSMENT_RESULTS', 'ALL_ASSESSMENTS', null, { rows: rows.length });
  sendCsv(res, `LALCO_Assessment_Results_${today()}.csv`, out);
});

// ----------------------------------------------------------- Google Sheets
router.post('/google-sync', async (req, res) => {
  const result = await syncAllGoogleSheets();
  auditFromReq(req, result.ok ? 'GOOGLE_SHEETS_SYNC' : 'GOOGLE_SHEETS_SYNC_FAILED', 'HR reporting workbook', null, {
    candidates: result.candidates, assessments: result.assessments, errors: result.errors,
  });
  if (!result.ok) return res.status(503).json(result);
  res.json(result);
});

router.get('/google-sync/pending', (req, res) => {
  res.json({ pending: pendingSyncSessions(), configured: isGoogleSyncConfigured() });
});

router.post('/google-sync/retry', async (req, res) => {
  const result = await syncPendingGoogleSheets();
  auditFromReq(req, result.ok ? 'GOOGLE_SHEETS_SYNC_RETRY' : 'GOOGLE_SHEETS_SYNC_RETRY_FAILED', 'pending assessments', null, {
    pendingBefore: result.pendingBefore, pendingAfter: result.pendingAfter, errors: result.errors,
  });
  if (!result.ok) return res.status(503).json(result);
  res.json(result);
});

// ----------------------------------------------------------------- Backup
// db.backup() writes one consistent .sqlite file containing every table
// (candidates, applications, sessions, answers, scores, interviews, integrity
// events and audit records). WAL/SHM scratch files are checkpointed into it
// rather than copied, so no temporary files end up in the backup.
router.post('/backup', async (req, res, next) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    const fileName = `LALCO_backup_${stamp}.sqlite`;
    const filePath = path.join(BACKUP_DIR, fileName);
    await db.backup(filePath);

    // The live database runs in WAL mode, so the copy inherits it and would
    // spawn -wal/-shm sidecars every time anyone opened it. Switch the copy to
    // a rollback journal and vacuum it, so what an administrator downloads is
    // one self-contained file with no temporary files attached.
    const copy = new Database(filePath);
    copy.pragma('journal_mode = DELETE');
    copy.exec('VACUUM');
    copy.close();
    ['-wal', '-shm'].forEach((suffix) => {
      if (fs.existsSync(filePath + suffix)) fs.unlinkSync(filePath + suffix);
    });

    const stat = fs.statSync(filePath);
    const createdAt = new Date().toISOString();
    auditFromReq(req, 'DATABASE_BACKUP_CREATED', fileName, null, { sizeBytes: stat.size });
    res.json({
      ok: true,
      fileName,
      createdAt,
      createdAtDisplay: createdAt.slice(0, 16).replace('T', ' '),
      sizeBytes: stat.size,
      includes: ['Candidates', 'Applications', 'Assessment sessions', 'Answers', 'Scores',
        'Interviews', 'Integrity events', 'Audit records'],
    });
  } catch (error) { next(error); }
});

router.get('/backups', (req, res) => res.json({ backups: listBackups() }));

router.get('/backup/download', (req, res) => {
  // basename() plus a strict allow-list pattern: no traversal, no absolute
  // paths, and nothing outside the backup directory can be requested.
  const fileName = path.basename(String(req.query.file || '').trim());
  if (!BACKUP_NAME.test(fileName)) return res.status(400).json({ error: 'Invalid backup filename.' });
  const filePath = path.join(BACKUP_DIR, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup file not found.' });
  auditFromReq(req, 'DATABASE_BACKUP_DOWNLOADED', fileName);
  res.download(filePath, fileName);
});

// ------------------------------------------------------------- Demo data
router.post('/demo/create', (req, res) => {
  const created = createDemoCandidates(req.body && req.body.count, req.user.id);
  auditFromReq(req, 'CREATE_DEMO_CANDIDATES', 'demo candidates', null, {
    count: created.length, codes: created.map((c) => c.code),
  });
  res.json({
    ok: true,
    count: created.length,
    created,
    message: `${created.length} demo candidates created. They are flagged is_demo = true and are kept out of HR reporting.`,
  });
});

router.post('/demo/delete', (req, res) => {
  const removed = deleteCandidateData({ demoOnly: true });
  auditFromReq(req, 'DELETE_DEMO_CANDIDATES', 'demo candidates', null, {
    candidates: removed.candidates, assessments: removed.assessments, answers: removed.answers,
    performedBy: req.user.name,
  });
  res.json({
    ok: true,
    ...removed,
    message: `${removed.candidates} demo candidates removed (${removed.assessments} assessments, ${removed.answers} answers). Real candidates were not touched.`,
  });
});

// --------------------------------------------------------- DANGER ZONE
router.get('/delete-all-candidate-data/preview', (req, res) => {
  res.json({ preview: previewDeletion({}) });
});

router.post('/delete-all-candidate-data', destructiveLimiter, (req, res, next) => {
  const body = req.body || {};
  const confirmation = String(body.confirmation || '').trim();
  const password = String(body.password || '');

  if (confirmation !== DELETE_PHRASE) {
    return res.status(400).json({ error: `Please type the exact confirmation phrase: ${DELETE_PHRASE}` });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.user.id);
  if (!user || user.role !== 'SUPER_ADMIN' || !password || !bcrypt.compareSync(password, user.password_hash)) {
    auditFromReq(req, 'DELETE_ALL_CANDIDATE_DATA_DENIED', 'ALL_CANDIDATES', null, { reason: 'password re-check failed' });
    return res.status(401).json({ error: 'Super Admin password is required to proceed.' });
  }

  try {
    // One transaction. Anything that throws rolls the whole delete back, so
    // there is never a partially deleted candidate record.
    const removed = deleteCandidateData({});

    // The audit log itself is never deleted — instead the deletion is recorded.
    auditFromReq(req, 'DELETE_ALL_CANDIDATE_DATA', 'ALL_CANDIDATES', null, {
      performedBy: req.user.name,
      role: req.user.role,
      timestamp: new Date().toISOString(),
      candidatesDeleted: removed.candidates,
      assessmentsDeleted: removed.assessments,
      answersDeleted: removed.answers,
      linksDeleted: removed.links,
    });

    res.json({
      ok: true,
      candidates: removed.candidates,
      assessments: removed.assessments,
      answers: removed.answers,
      links: removed.links,
      byTable: removed.byTable,
      stats: getDataStats(),
      message: 'Candidate data successfully deleted.',
      summary: [
        `${removed.candidates} candidates removed`,
        `${removed.assessments} assessments removed`,
        `${removed.answers} answers removed`,
      ],
    });
  } catch (error) {
    auditFromReq(req, 'DELETE_ALL_CANDIDATE_DATA_FAILED', 'ALL_CANDIDATES', null, { error: String(error.message || error) });
    next(error);
  }
});

module.exports = router;
