const express = require('express');
const db = require('../../db');
const { generateId } = require('../../lib/tokens');
const { auditFromReq } = require('../../lib/audit');
const { requireAuth, requireRole } = require('../../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Full question bank INCLUDING answer keys — admin-only, authenticated. Never served publicly.
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM questions ORDER BY type, order_index').all();
  res.json({ questions: rows.map((q) => ({ ...q, config: JSON.parse(q.config_json) })) });
});

router.post('/', requireRole('SUPER_ADMIN', 'HR_ADMIN'), (req, res) => {
  const b = req.body || {};
  if (!b.type || !b.text || !b.config) return res.status(400).json({ error: 'type, text and config are required.' });
  const id = generateId('q');
  const maxMarks = b.type === 'CALC' ? b.config.parts.reduce((s, p) => s + p.marks, 0) : b.config.rubric.reduce((s, r) => s + r.max, 0);
  db.prepare(
    `INSERT INTO questions (id, type, order_index, category, difficulty, max_marks, text, config_json, explanation, created_by)
     VALUES (@id,@type,@order,@category,@difficulty,@maxMarks,@text,@config,@explanation,@createdBy)`
  ).run({ id, type: b.type, order: b.order || 0, category: b.category || null, difficulty: b.difficulty || null, maxMarks, text: b.text, config: JSON.stringify(b.config), explanation: b.explanation || null, createdBy: req.user.name });
  auditFromReq(req, 'Question created', id);
  res.status(201).json({ id });
});

router.patch('/:id', requireRole('SUPER_ADMIN', 'HR_ADMIN'), (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  const b = req.body || {};
  const config = b.config ? JSON.stringify(b.config) : q.config_json;
  const maxMarks = b.config
    ? (q.type === 'CALC' ? b.config.parts.reduce((s, p) => s + p.marks, 0) : b.config.rubric.reduce((s, r) => s + r.max, 0))
    : q.max_marks;
  db.prepare(
    `UPDATE questions SET text=@text, category=@category, difficulty=@difficulty, explanation=@explanation,
     config_json=@config, max_marks=@maxMarks, active=@active, updated_at=datetime('now') WHERE id=@id`
  ).run({
    id: q.id, text: b.text ?? q.text, category: b.category ?? q.category, difficulty: b.difficulty ?? q.difficulty,
    explanation: b.explanation ?? q.explanation, config, maxMarks, active: b.active != null ? (b.active ? 1 : 0) : q.active,
  });
  auditFromReq(req, 'Question updated', q.id, JSON.parse(q.config_json), b.config);
  res.json({ ok: true });
});

// ---- Interview questions ----
router.get('/interview/questions', (req, res) => {
  res.json({ questions: db.prepare('SELECT * FROM interview_questions ORDER BY order_index').all() });
});
router.post('/interview/questions', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'INTERVIEWER', 'MANAGER'), (req, res) => {
  const b = req.body || {};
  if (!b.text) return res.status(400).json({ error: 'text is required.' });
  const id = generateId('ivq');
  const orderRow = db.prepare('SELECT MAX(order_index) AS m FROM interview_questions').get();
  db.prepare('INSERT INTO interview_questions (id, text, disqualifying, active, order_index) VALUES (?,?,?,1,?)')
    .run(id, b.text, b.disqualifying ? 1 : 0, (orderRow.m || 0) + 1);
  auditFromReq(req, 'Interview question added', b.text);
  res.status(201).json({ id });
});
router.patch('/interview/questions/:id', requireRole('SUPER_ADMIN', 'HR_ADMIN', 'INTERVIEWER', 'MANAGER'), (req, res) => {
  const q = db.prepare('SELECT * FROM interview_questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  db.prepare('UPDATE interview_questions SET text=@text, disqualifying=@disqualifying, active=@active WHERE id=@id').run({
    id: q.id, text: b.text ?? q.text, disqualifying: b.disqualifying != null ? (b.disqualifying ? 1 : 0) : q.disqualifying,
    active: b.active != null ? (b.active ? 1 : 0) : q.active,
  });
  res.json({ ok: true });
});

router.get('/interview/criteria', (req, res) => {
  res.json({ criteria: db.prepare('SELECT * FROM interview_criteria ORDER BY order_index').all() });
});

module.exports = router;
