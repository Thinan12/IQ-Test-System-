const express = require('express');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const db = require('../../db');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { auditFromReq } = require('../../lib/audit');
const { evaluateEligibility } = require('../../lib/eligibility');
const { syncAllGoogleSheets, isGoogleSyncConfigured } = require('../../lib/googleSheets');

const router = express.Router();
router.use(requireAuth);

function fullCandidateData(id) {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  if (!c) return null;
  const rules = db.prepare('SELECT * FROM eligibility_rules WHERE id = 1').get();
  const elig = evaluateEligibility(c, rules);
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ? ORDER BY started_at DESC LIMIT 1').get(c.id);
  const scores = session ? db.prepare('SELECT * FROM scores WHERE session_id = ?').get(session.id) : null;
  const integrity = session ? db.prepare('SELECT * FROM integrity_assessments WHERE session_id = ?').get(session.id) : null;
  const questions = db.prepare(`SELECT * FROM questions WHERE type='CALC' AND active=1 ORDER BY order_index`).all();
  const breakdown = scores && scores.calc_breakdown_json ? JSON.parse(scores.calc_breakdown_json) : [];
  return { candidate: c, eligibility: elig, session, scores, integrity, questions, breakdown };
}

router.get('/candidate/:id.csv', (req, res) => {
  const data = fullCandidateData(req.params.id);
  if (!data) return res.status(404).json({ error: 'Candidate not found.' });
  const { candidate: c, scores } = data;
  const rows = [
    ['Field', 'Value'],
    ['Candidate ID', c.code], ['Name', c.full_name], ['Eligibility', data.eligibility.status],
    ['Calculation', scores ? `${scores.calc_marks}/${scores.calc_max}` : '—'],
    ['Written', scores && scores.essay_marks != null ? `${scores.essay_marks}/${scores.essay_max}` : '—'],
    ['Interview', scores && scores.interview_marks != null ? `${scores.interview_marks}/${scores.interview_max}` : '—'],
    ['Final', scores && scores.final_marks != null ? `${scores.final_marks}/100` : '—'],
    ['Status', c.status],
  ];
  data.breakdown.forEach((b, i) => rows.push([`Q${i + 1}`, `${b.marks}/${b.max}`]));
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  auditFromReq(req, 'Report exported (CSV)', c.code);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="LALCO_Candidate_Report_${c.code}_${todayStr()}.csv"`);
  res.send(csv);
});

router.get('/candidate/:id.pdf', (req, res) => {
  const data = fullCandidateData(req.params.id);
  if (!data) return res.status(404).json({ error: 'Candidate not found.' });
  const { candidate: c, eligibility, scores, breakdown, questions, integrity } = data;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="LALCO_Candidate_Report_${c.code}_${todayStr()}.pdf"`);
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);
  doc.fontSize(18).fillColor('#0F2438').text('LALCO', { continued: true }).fillColor('black').fontSize(10).text('  Lao Asean Leasing Public Company');
  doc.moveDown();
  doc.fontSize(14).text(`Candidate Report — ${c.full_name} (${c.code})`);
  doc.fontSize(9).fillColor('gray').text(`Generated ${new Date().toLocaleString()}`);
  doc.fillColor('black').moveDown();

  doc.fontSize(12).text('Scores', { underline: true });
  doc.fontSize(10).text(`Calculation: ${scores ? scores.calc_marks + '/' + scores.calc_max : '—'}`);
  doc.text(`Written: ${scores && scores.essay_marks != null ? scores.essay_marks + '/' + scores.essay_max : '—'}`);
  doc.text(`Interview: ${scores && scores.interview_marks != null ? scores.interview_marks + '/' + scores.interview_max : '—'}`);
  doc.text(`Final: ${scores && scores.final_marks != null ? scores.final_marks + '/100 — ' + (scores.pass ? 'PASS' : 'FAIL') : '—'}`);
  doc.moveDown();

  doc.fontSize(12).text('Eligibility', { underline: true });
  eligibility.checks.forEach((ch) => doc.fontSize(9).text(`${ch.condition}: candidate ${ch.candidateValue}, required ${ch.requiredValue} — ${ch.status} (${ch.reason})`));
  doc.moveDown();

  doc.fontSize(12).text('Question performance', { underline: true });
  questions.forEach((q, i) => {
    const b = breakdown.find((x) => x.questionId === q.id);
    doc.fontSize(9).text(`Q${i + 1} (${q.category}) — ${b ? b.marks : 0}/${q.max_marks} — ${b ? b.reason : 'Not attempted'}`);
  });
  doc.moveDown();

  doc.fontSize(12).text('Assessment integrity', { underline: true });
  doc.fontSize(9).text(`Risk level: ${integrity ? integrity.risk_level : 'Low'}`);
  if (integrity && integrity.evidence_json) JSON.parse(integrity.evidence_json).forEach((e) => doc.text('• ' + e));

  auditFromReq(req, 'Report exported (PDF)', c.code);
  doc.end();
});

router.get('/batch.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM candidates').all();
  const header = ['Candidate ID', 'Name', 'Type', 'Eligibility', 'Calculation', 'Written', 'Interview', 'Final', 'Status'];
  const rules = db.prepare('SELECT * FROM eligibility_rules WHERE id = 1').get();
  const lines = [header];
  rows.forEach((c) => {
    const elig = evaluateEligibility(c, rules);
    const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ? ORDER BY started_at DESC LIMIT 1').get(c.id);
    const scores = session ? db.prepare('SELECT * FROM scores WHERE session_id = ?').get(session.id) : null;
    lines.push([c.code, c.full_name, c.application_type, elig.status, scores ? scores.calc_marks : '', scores ? scores.essay_marks ?? '' : '', scores ? scores.interview_marks ?? '' : '', scores ? scores.final_marks ?? '' : '', c.status]);
  });
  const csv = lines.map((r) => r.map(csvEscape).join(',')).join('\n');
  auditFromReq(req, 'Report exported (CSV)', 'Batch roster');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="LALCO_Batch_Report_${todayStr()}.csv"`);
  res.send(csv);
});

router.get('/batch.xlsx', async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Batch Report');
  sheet.columns = [
    { header: 'Candidate ID', key: 'code', width: 18 }, { header: 'Name', key: 'name', width: 24 },
    { header: 'Type', key: 'type', width: 14 }, { header: 'Eligibility', key: 'elig', width: 14 },
    { header: 'Calculation', key: 'calc', width: 12 }, { header: 'Written', key: 'essay', width: 12 },
    { header: 'Interview', key: 'interview', width: 12 }, { header: 'Final', key: 'final', width: 10 },
    { header: 'Status', key: 'status', width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  const rows = db.prepare('SELECT * FROM candidates').all();
  const rules = db.prepare('SELECT * FROM eligibility_rules WHERE id = 1').get();
  rows.forEach((c) => {
    const elig = evaluateEligibility(c, rules);
    const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ? ORDER BY started_at DESC LIMIT 1').get(c.id);
    const scores = session ? db.prepare('SELECT * FROM scores WHERE session_id = ?').get(session.id) : null;
    sheet.addRow({ code: c.code, name: c.full_name, type: c.application_type, elig: elig.status, calc: scores ? scores.calc_marks : '', essay: scores ? scores.essay_marks : '', interview: scores ? scores.interview_marks : '', final: scores ? scores.final_marks : '', status: c.status });
  });
  auditFromReq(req, 'Report exported (Excel)', 'Batch roster');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="LALCO_Batch_Report_${todayStr()}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

// ---- Export to Google Sheets ----
// Alongside the PDF / CSV / Excel exports above. Pushes the current SQLite
// contents into the HR reporting workbook; SQLite stays the source of truth.
router.get('/google-sheets/status', (req, res) => {
  res.json({ configured: isGoogleSyncConfigured() });
});

router.post('/google-sheets', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'MANAGER'), async (req, res) => {
  const result = await syncAllGoogleSheets();
  auditFromReq(req, result.ok ? 'Report exported (Google Sheets)' : 'Google Sheets export failed', 'HR reporting workbook', null, {
    candidates: result.candidates, assessments: result.assessments, errors: result.errors,
  });
  if (!result.ok) return res.status(503).json(result);
  res.json(result);
});

function csvEscape(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function todayStr() { return new Date().toISOString().slice(0, 10); }

module.exports = router;
