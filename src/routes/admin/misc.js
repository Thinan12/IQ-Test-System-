const express = require('express');
const db = require('../../db');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { auditFromReq } = require('../../lib/audit');
const { evaluateEligibility } = require('../../lib/eligibility');
const { generateId } = require('../../lib/tokens');

const router = express.Router();
router.use(requireAuth);

// ---------- Interview queue ----------
router.get('/interviews/queue', (req, res) => {
  const candidates = db.prepare('SELECT * FROM candidates').all();
  const rules = db.prepare('SELECT * FROM eligibility_rules WHERE id = 1').get();
  const out = [];
  candidates.forEach((c) => {
    const elig = evaluateEligibility(c, rules);
    if (elig.status !== 'ELIGIBLE') return;
    const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ? ORDER BY started_at DESC LIMIT 1').get(c.id);
    if (!session) return;
    const scores = db.prepare('SELECT * FROM scores WHERE session_id = ?').get(session.id);
    if (!scores || scores.essay_marks == null) return;
    out.push({
      id: c.id, code: c.code, fullName: c.full_name, status: c.status,
      calc: scores.calc_marks, essay: scores.essay_marks, interview: scores.interview_marks,
    });
  });
  res.json({ queue: out });
});

// ---------- Integrity review (human conclusion) ----------
// Machine signals (paste size, focus/visibility changes) are only ever
// *indicators*. A conclusion about assistance exists only when a named human
// reviewer records it here; nothing in the system writes one automatically.
const INTEGRITY_CONCLUSIONS = ['NO_CONCERN', 'INCONCLUSIVE', 'POTENTIAL_AI_ASSISTANCE_INDICATOR', 'CONFIRMED_MISCONDUCT'];

router.get('/integrity/:sessionId/review', (req, res) => {
  const review = db.prepare('SELECT * FROM integrity_reviews WHERE session_id = ?').get(req.params.sessionId);
  res.json({ review: review || null, conclusions: INTEGRITY_CONCLUSIONS });
});

router.put('/integrity/:sessionId/review', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'EVALUATOR'), (req, res) => {
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Assessment session not found.' });
  const conclusion = String((req.body || {}).conclusion || '');
  if (!INTEGRITY_CONCLUSIONS.includes(conclusion)) {
    return res.status(400).json({ error: 'conclusion must be one of: ' + INTEGRITY_CONCLUSIONS.join(', ') });
  }
  const comment = String((req.body || {}).comment || '').slice(0, 2000);
  db.prepare(
    `INSERT INTO integrity_reviews (id, session_id, reviewer, conclusion, comment, reviewed_at)
     VALUES (?,?,?,?,?,datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET reviewer=excluded.reviewer, conclusion=excluded.conclusion,
       comment=excluded.comment, reviewed_at=excluded.reviewed_at`
  ).run(generateId('irev'), session.id, req.user.name, conclusion, comment);
  auditFromReq(req, 'INTEGRITY_REVIEW_RECORDED', session.id, null, { conclusion, reviewer: req.user.name });
  res.json({ ok: true });
});

// ---------- Scholarship policy ----------
router.get('/scholarship', (req, res) => {
  const rows = db.prepare('SELECT * FROM scholarship_policies').all();
  const policy = { current: {}, proposed: {} };
  rows.forEach((r) => {
    const key = r.kind.toLowerCase();
    policy[key]['y' + r.year] = { funding: r.funding, paymentTiming: r.payment_timing, yearToStart: r.year_to_start, commitment: r.commitment };
  });
  res.json({ policy });
});
router.put('/scholarship', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'MANAGER'), (req, res) => {
  const { proposed } = req.body || {};
  if (!proposed) return res.status(400).json({ error: 'proposed policy is required.' });
  ['y3', 'y4'].forEach((yKey) => {
    const year = Number(yKey.slice(1));
    const p = proposed[yKey];
    if (!p) return;
    db.prepare(
      `UPDATE scholarship_policies SET funding=?, payment_timing=?, year_to_start=?, commitment=? WHERE kind='PROPOSED' AND year=?`
    ).run(p.funding, p.paymentTiming, p.yearToStart, p.commitment, year);
  });
  auditFromReq(req, 'Scholarship policy changed', 'proposed policy');
  res.json({ ok: true });
});

// ---------- Settings ----------
router.get('/settings', (req, res) => {
  res.json({
    settings: db.prepare('SELECT * FROM settings WHERE id = 1').get(),
    eligibilityRules: db.prepare('SELECT * FROM eligibility_rules WHERE id = 1').get(),
  });
});
router.put('/settings', requireRole('SUPER_ADMIN'), (req, res) => {
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  db.prepare(
    `UPDATE settings SET org_name=@orgName, pass_threshold=@passThreshold, link_expiry_minutes=@linkExpiryMinutes,
     assessment_duration_minutes=@assessmentDurationMinutes, max_ltv=@maxLtv, require_candidate_id=@requireCandidateId,
     require_phone=@requirePhone, require_dob=@requireDob, updated_at=datetime('now') WHERE id=1`
  ).run({
    orgName: b.orgName ?? cur.org_name, passThreshold: b.passThreshold ?? cur.pass_threshold,
    linkExpiryMinutes: b.linkExpiryMinutes ?? cur.link_expiry_minutes,
    assessmentDurationMinutes: b.assessmentDurationMinutes ?? cur.assessment_duration_minutes,
    maxLtv: b.maxLtv ?? cur.max_ltv,
    requireCandidateId: b.requireCandidateId != null ? (b.requireCandidateId ? 1 : 0) : cur.require_candidate_id,
    requirePhone: b.requirePhone != null ? (b.requirePhone ? 1 : 0) : cur.require_phone,
    requireDob: b.requireDob != null ? (b.requireDob ? 1 : 0) : cur.require_dob,
  });
  auditFromReq(req, 'Settings changed', 'settings', cur, b);
  res.json({ ok: true });
});
router.put('/eligibility-rules', requireRole('SUPER_ADMIN'), (req, res) => {
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM eligibility_rules WHERE id = 1').get();
  db.prepare(
    `UPDATE eligibility_rules SET normal_iq_min=@normalIqMin, normal_education_min=@normalEducationMin,
     scholarship_iq_min=@scholarshipIqMin, scholarship_education_min=@scholarshipEducationMin,
     scholarship_gpa_min=@scholarshipGpaMin, updated_at=datetime('now') WHERE id=1`
  ).run({
    normalIqMin: b.normalIqMin ?? cur.normal_iq_min, normalEducationMin: b.normalEducationMin ?? cur.normal_education_min,
    scholarshipIqMin: b.scholarshipIqMin ?? cur.scholarship_iq_min,
    scholarshipEducationMin: b.scholarshipEducationMin ?? cur.scholarship_education_min,
    scholarshipGpaMin: b.scholarshipGpaMin ?? cur.scholarship_gpa_min,
  });
  auditFromReq(req, 'Eligibility rules changed', 'eligibilityRules', cur, b);
  res.json({ ok: true });
});

// ---------- Audit log ----------
router.get('/audit', requireRole('SUPER_ADMIN', 'HR_ADMIN'), (req, res) => {
  const q = req.query.q ? String(req.query.q).toLowerCase() : '';
  let rows = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500').all();
  if (q) rows = rows.filter((r) => (r.user_name + r.action + (r.target || '')).toLowerCase().includes(q));
  res.json({ logs: rows });
});

// ---------- Analytics ----------
router.get('/analytics', (req, res) => {
  const candidates = db.prepare('SELECT * FROM candidates').all();
  const rules = db.prepare('SELECT * FROM eligibility_rules WHERE id = 1').get();
  const withScores = [];
  candidates.forEach((c) => {
    const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ? ORDER BY started_at DESC LIMIT 1').get(c.id);
    if (!session) return;
    const scores = db.prepare('SELECT * FROM scores WHERE session_id = ?').get(session.id);
    if (scores && scores.final_marks != null) withScores.push({ candidate: c, scores });
  });
  const eligibleCount = candidates.filter((c) => evaluateEligibility(c, rules).status === 'ELIGIBLE').length;
  const finals = withScores.map((w) => w.scores.final_marks);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const buckets = [0, 0, 0, 0, 0];
  finals.forEach((f) => { buckets[Math.max(0, Math.min(4, Math.floor(f / 20)))]++; });
  const questions = db.prepare(`SELECT * FROM questions WHERE type='CALC' AND active=1 AND question_family='GENERAL' ORDER BY order_index`).all();
  const questionStats = questions.map((q) => {
    let attempts = 0, full = 0, partial = 0, failed = 0, timeSum = 0, timeN = 0, scoreSum = 0;
    withScores.forEach((w) => {
      if (!w.scores.calc_breakdown_json) return;
      const bd = JSON.parse(w.scores.calc_breakdown_json).find((b) => b.questionId === q.id);
      if (!bd) return;
      attempts++; scoreSum += bd.marks;
      if (bd.marks === bd.max) full++; else if (bd.marks === 0) failed++; else partial++;
    });
    return { id: q.id, category: q.category, attempts, full, partial, failed, avgScore: attempts ? round2(scoreSum / attempts) : 0, max: q.max_marks, failRate: attempts ? round2((failed / attempts) * 100) : 0 };
  });
  res.json({
    totals: {
      total: candidates.length, eligible: eligibleCount,
      passed: withScores.filter((w) => w.scores.pass).length, failed: withScores.filter((w) => !w.scores.pass).length,
      avgScore: round2(avg(finals)), highest: finals.length ? Math.max(...finals) : null, lowest: finals.length ? Math.min(...finals) : null,
      avgCalc: round2(avg(withScores.map((w) => w.scores.calc_marks))),
      avgEssay: round2(avg(withScores.filter((w) => w.scores.essay_marks != null).map((w) => w.scores.essay_marks))),
      avgInterview: round2(avg(withScores.filter((w) => w.scores.interview_marks != null).map((w) => w.scores.interview_marks))),
    },
    scoreDistribution: buckets,
    questionStats,
  });
});
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = router;
