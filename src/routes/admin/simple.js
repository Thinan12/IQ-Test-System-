const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { Readable } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const db = require('../../db');
const { generateId, generateSecureToken } = require('../../lib/tokens');
const { nextCandidateCode } = require('../../lib/dataManagement');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { auditFromReq } = require('../../lib/audit');
const { validateSelection } = require('../../lib/questionSelection');
const ctl = require('../../lib/examControl');

const router = express.Router();
router.use(requireAuth);
const EDITORS = ['SUPER_ADMIN', 'HR_ADMIN'];
const VIEWERS = ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'EVALUATOR', 'RECRUITER'];

const clean = (v) => String(v == null ? '' : v).trim();
function headerKey(v) {
  return clean(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object' && v.text) return String(v.text);
  return String(v);
}
function pick(row, names) {
  const map = {};
  Object.keys(row).forEach((k) => { map[headerKey(k)] = row[k]; });
  for (const n of names) if (map[headerKey(n)] !== undefined) return cellText(map[headerKey(n)]);
  return '';
}

async function rowsFromFile(fileName, buffer) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.json') {
    const parsed = JSON.parse(buffer.toString('utf8'));
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.questions) ? parsed.questions : []);
  }
  if (ext === '.csv') {
    const wb = new ExcelJS.Workbook();
    const ws = await wb.csv.read(Readable.from(buffer));
    const headers = ws.getRow(1).values.slice(1).map((v) => cellText(v));
    const rows = [];
    for (let i = 2; i <= ws.rowCount; i += 1) {
      const values = ws.getRow(i).values.slice(1);
      const row = {};
      headers.forEach((h, n) => { row[h] = values[n] == null ? '' : cellText(values[n]); });
      rows.push(row);
    }
    return rows;
  }
  if (ext === '.xlsx' || ext === '.xls') {
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Question file is too large. Maximum is 4 MB.');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const headers = ws.getRow(1).values.slice(1).map((v) => cellText(v));
    const rows = [];
    for (let i = 2; i <= ws.rowCount; i += 1) {
      const values = ws.getRow(i).values.slice(1);
      const row = {};
      headers.forEach((h, n) => { row[h] = values[n] == null ? '' : cellText(values[n]); });
      rows.push(row);
    }
    return rows;
  }
  if (ext === '.txt' || ext === '.md') return textToRows(buffer.toString('utf8'));
  if (ext === '.pdf' || ext === '.docx') {
    const tmp = path.join(os.tmpdir(), 'lalco-' + crypto.randomBytes(8).toString('hex') + ext);
    try {
      fs.writeFileSync(tmp, buffer);
      let text = '';
      if (ext === '.pdf') {
        text = execFileSync('pdftotext', ['-layout', tmp, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      } else {
        text = execFileSync('unzip', ['-p', tmp, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        text = text.replace(/<w:tab[^>]*\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n')
          .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/\\s+/g, ' ').replace(/\n\s+/g, '\n');
      }
      return textToRows(text);
    } catch (e) {
      throw new Error(ext === '.pdf'
        ? 'PDF text could not be read on this server. Use XLSX/CSV/TXT for this upload.'
        : 'DOCX text could not be read on this server. Use XLSX/CSV/TXT for this upload.');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
  throw new Error('Unsupported file type. Use XLSX, CSV, JSON, TXT, MD, DOCX or PDF.');
}

function textToRows(text) {
  const chunks = text.split(/\n\s*(?=(?:Q(?:uestion)?\s*)?\d+\s*[.):\-])/i).map((x) => x.trim()).filter(Boolean);
  return chunks.map((chunk) => {
    const lines = chunk.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    let question = lines[0].replace(/^(?:Q(?:uestion)?\s*)?\d+\s*[.):\-]\s*/i, '').trim();
    if (!question && lines[1]) question = lines[1];
    const options = {};
    lines.forEach((line) => {
      const m = line.match(/^([A-D])\s*[.):\-]\s*(.+)$/i);
      if (m) options[m[1].toUpperCase()] = m[2].trim();
    });
    const answerLine = lines.find((l) => /^(?:answer|correct(?: answer)?|correct option|key)\s*[:\-]/i.test(l));
    const correct = answerLine ? (answerLine.split(/[:\-]/)[1] || '').trim() : '';
    const bodyWithout = lines.filter((l) => !/^([A-D])\s*[.):\-]\s*/i.test(l) && !/^(?:answer|correct(?: answer)?|correct option|key)\s*[:\-]/i.test(l));
    question = bodyWithout.join(' ').replace(/^\d+\s*[.):\-]\s*/, '').trim();
    return { Question: question, 'Option A': options.A || '', 'Option B': options.B || '', 'Option C': options.C || '', 'Option D': options.D || '', 'Correct Answer': correct };
  });
}

function makeConfig(row, family) {
  const text = pick(row, ['question','question text','questiontext','prompt','problem','text']);
  const typeRaw = pick(row, ['type','question type']).toUpperCase();
  const essay = family === 'GENERAL' && (typeRaw === 'ESSAY' || (!pick(row, ['option a','a','option 1']) && !pick(row, ['option b','b','option 2'])));
  if (essay) {
    return {
      type: 'ESSAY',
      text,
      maxMarks: Number(pick(row, ['points','marks','max marks','maxmarks'])) || 10,
      config: { rubric: [{ key: 'content', label: 'Content and quality of response', max: Number(pick(row, ['points','marks','max marks','maxmarks'])) || 10 }] },
      options: [],
      correct: '',
    };
  }
  const options = [
    pick(row, ['option a','a','option 1']),
    pick(row, ['option b','b','option 2']),
    pick(row, ['option c','c','option 3']),
    pick(row, ['option d','d','option 4']),
  ].filter(Boolean);
  const labels = options.slice();
  const correctRaw = pick(row, ['correct answer','answer','correct','correct option','answer key']);
  let correct = correctRaw.trim();
  const letter = correctRaw.trim().toUpperCase().match(/^[A-D]$/);
  if (letter) correct = options[letter[0].charCodeAt(0) - 65] || '';
  if (!labels.some((v) => v.toLowerCase() === correct.toLowerCase())) correct = '';
  const marks = Number(pick(row, ['points','marks','max marks','maxmarks'])) || 1;
  return {
    type: 'MCQ',
    text,
    maxMarks: marks,
    config: { parts: [{ key: 'answer', label: 'Answer', marks, type: 'choice', options: labels, expected: correct }] },
    options: labels,
    correct,
  };
}

function importQuestions(rows, family, actor) {
  const imported = [];
  const failed = [];
  const tx = db.transaction(() => {
    rows.forEach((row, index) => {
      const parsed = makeConfig(row, family);
      if (!parsed.text) { failed.push({ row: index + 2, error: 'Missing question text' }); return; }
      if (parsed.type === 'MCQ' && (parsed.options.length < 2 || !parsed.options.includes(parsed.correct))) {
        failed.push({ row: index + 2, error: 'MCQ needs at least two options and a valid correct answer' }); return;
      }
      const id = generateId('q');
      const category = family === 'IQ'
        ? (pick(row, ['category','topic','subject']) || 'LOGICAL').toUpperCase()
        : (pick(row, ['category','topic','subject']) || 'GENERAL').toUpperCase();
      const difficulty = (pick(row, ['difficulty','level','difficulty level']) || 'MEDIUM').toUpperCase();
      const order = db.prepare('SELECT COALESCE(MAX(order_index),0)+1 AS n FROM questions WHERE question_family = ?').get(family).n;
      db.prepare(
        `INSERT INTO questions
          (id,type,order_index,category,difficulty,max_marks,text,config_json,
           translation_status,active,created_by,question_family,iq_category)
         VALUES (?,?,?,?,?,?,?,?,'MISSING',1,?,?,?)`
      ).run(
        id, parsed.type === 'ESSAY' ? 'ESSAY' : 'CALC', order, category, difficulty, parsed.maxMarks,
        parsed.text, JSON.stringify(parsed.config), actor, family, family === 'IQ' ? category : null
      );
      imported.push({ id, text: parsed.text, type: parsed.type, category, difficulty });
    });
  });
  tx();
  return { imported, failed };
}

router.get('/summary', requireRole(...VIEWERS), (req, res) => {
  const candidates = db.prepare('SELECT COUNT(*) n FROM candidates WHERE COALESCE(archived,0)=0').get().n;
  const tests = db.prepare('SELECT COUNT(*) n FROM assessments WHERE COALESCE(archived,0)=0 AND active=1').get().n;
  const links = db.prepare("SELECT COUNT(*) n FROM assessment_links WHERE status='ACTIVE' AND COALESCE(disabled_at,'')=''").get().n;
  const iqQuestions = db.prepare("SELECT COUNT(*) n FROM questions WHERE question_family='IQ' AND active=1 AND COALESCE(archived,0)=0").get().n;
  const generalQuestions = db.prepare("SELECT COUNT(*) n FROM questions WHERE question_family='GENERAL' AND active=1 AND COALESCE(archived,0)=0").get().n;
  const rows = db.prepare(
    `SELECT r.*, c.full_name, c.email, c.phone, c.id_number, a.name assessment_name,
            a.pass_threshold, s.submitted_at, s.started_at
       FROM iq_results r
       JOIN candidates c ON c.id=r.candidate_id
       LEFT JOIN assessments a ON a.id=r.assessment_id
       LEFT JOIN assessment_sessions s ON s.id=r.session_id
      ORDER BY r.created_at DESC LIMIT 100`
  ).all();
  res.json({
    counts: { candidates, tests, links, iqQuestions, generalQuestions },
    results: rows.map((r) => ({
      sessionId:r.session_id, candidateName:r.full_name, email:r.email, phone:r.phone, idNumber:r.id_number || '',
      assessmentName:r.assessment_name, marks:r.raw_score, maxMarks:r.raw_max,
      percentage:r.percentage, pass:Number(r.raw_score || 0) >= Number(r.pass_threshold || 0),
      submittedAt:r.submitted_at, startedAt:r.started_at
    }))
  });
});

router.get('/questions', requireRole(...VIEWERS), (req, res) => {
  const family = String(req.query.family || 'IQ').toUpperCase() === 'GENERAL' ? 'GENERAL' : 'IQ';
  const rows = db.prepare(
    `SELECT id,text,category,difficulty,type,max_marks FROM questions
       WHERE question_family=? AND active=1 AND COALESCE(archived,0)=0 ORDER BY order_index DESC`
  ).all(family);
  res.json({ family, questions: rows });
});

router.post('/import', requireRole(...EDITORS), async (req, res) => {
  try {
    const b = req.body || {};
    const name = clean(b.fileName);
    const base64 = String(b.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    const family = String(b.family || 'IQ').toUpperCase() === 'GENERAL' ? 'GENERAL' : 'IQ';
    if (!name || !base64) return res.status(400).json({ error: 'A question file is required.' });
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'The uploaded file is empty.' });
    if (buffer.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'Maximum question file size is 4 MB.' });
    const rows = await rowsFromFile(name, buffer);
    const result = importQuestions(rows, family, req.user.name);
    auditFromReq(req, 'SIMPLE_QUESTION_IMPORT', family, null, { fileName:name, found:rows.length, imported:result.imported.length, failed:result.failed.length });
    res.json({ ok:true, found:rows.length, imported:result.imported.length, failed:result.failed.length, errors:result.failed });
  } catch (e) {
    console.error('[simple-import]', e);
    res.status(400).json({ error: e.message || 'Could not read this question file.' });
  }
});

router.post('/link', requireRole(...EDITORS), (req, res) => {
  const b = req.body || {};
  const family = String(b.type || 'IQ').toUpperCase() === 'GENERAL' ? 'GENERAL' : 'IQ';
  const pool = db.prepare("SELECT id FROM questions WHERE question_family=? AND active=1 AND COALESCE(archived,0)=0 ORDER BY RANDOM()").all(family);
  if (!pool.length) return res.status(409).json({ error: 'No questions are available. Upload questions first.' });
  const count = Math.max(1, Math.min(Number(b.questions) || pool.length, pool.length));
  const duration = Math.max(1, Math.min(Number(b.durationMinutes) || 30, 600));
  const linkExpiry = Math.max(1, Math.min(Number(b.linkExpiryMinutes) || 1440, 10080));
  const passMark = Math.max(0, Math.min(Number(b.passMark) || Math.ceil(count * 0.6), count));
  const assessmentId = generateId('asmt');
  const assessmentName = family === 'IQ' ? `IQ Test ${new Date().toISOString().replace(/[:.]/g,'-')}` : `Assessment ${new Date().toISOString().replace(/[:.]/g,'-')}`;
  const candidateId = generateId('cand');
  const code = nextCandidateCode('LALCO');
  const linkId = generateId('link');
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + linkExpiry * 60000).toISOString();
  const questionIds = pool.slice(0, count).map((q) => q.id);
  const totalMax = family === 'IQ'
    ? questionIds.reduce((sum, id) => sum + Number(db.prepare('SELECT max_marks FROM questions WHERE id=?').get(id).max_marks || 1), 0)
    : questionIds.reduce((sum, id) => sum + Number(db.prepare('SELECT max_marks FROM questions WHERE id=?').get(id).max_marks || 1), 0);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO assessments
        (id,name,description,active,archived,duration_minutes,link_expiry_minutes,
         calc_max,written_max,interview_max,total_max,pass_threshold,eligibility_rules_id,
         assessment_type,randomize_questions,questions_to_show,randomize_question_order,
         randomize_options,created_by)
       VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      assessmentId, assessmentName, 'Simple assessment', 1, 0, duration, linkExpiry,
      totalMax, 0, 0, totalMax, passMark, 1, family === 'IQ' ? 'IQ_TEST' : 'GENERAL_ASSESSMENT',
      family === 'IQ' ? 1 : 0, count, family === 'IQ' ? 1 : 0, family === 'IQ' ? 1 : 0, req.user.name
    );
    const insertQ = db.prepare('INSERT INTO assessment_questions (assessment_id,question_id,order_index) VALUES (?,?,?)');
    questionIds.forEach((qid, i) => insertQ.run(assessmentId, qid, i));
    db.prepare(
      `INSERT INTO candidates
        (id,code,full_name,dob,phone,email,application_type,status,archived)
       VALUES (?,?,?,'',NULL,NULL,'NORMAL','DRAFT',0)`
    ).run(candidateId, code, 'Pending candidate');
    db.prepare(
      `INSERT INTO assessment_links
        (id,token,candidate_id,assessment_id,status,expires_at,created_by,language,self_registration)
       VALUES (?,?,?,?,'ACTIVE',?,?,'en',1)`
    ).run(linkId, token, candidateId, assessmentId, expiresAt, req.user.name);
  })();
  auditFromReq(req, 'SIMPLE_ASSESSMENT_LINK_CREATED', assessmentId, null, { family, count, duration, linkExpiry, passMark });
  const baseUrl = process.env.PUBLIC_EXAM_BASE_URL || (req.protocol + '://' + req.get('host'));
  const examPath = family === 'IQ' ? 'simple/iq' : 'simple/test';
  res.status(201).json({
    assessmentId, linkId, token, examUrl:`${baseUrl}/${examPath}/${token}`,
    durationMinutes:duration, linkExpiryMinutes:linkExpiry, passMark, questions:count
  });
});

router.get('/links', requireRole(...VIEWERS), (req, res) => {
  const rows = db.prepare(
    `SELECT l.id,l.token,l.status,l.created_at,l.expires_at,l.disabled_at,l.self_registration,
            a.name assessment_name,a.assessment_type,c.full_name,c.email
       FROM assessment_links l
       JOIN assessments a ON a.id=l.assessment_id
       JOIN candidates c ON c.id=l.candidate_id
       WHERE COALESCE(l.self_registration,0)=1
       ORDER BY l.created_at DESC LIMIT 100`
  ).all();
  res.json({ links: rows.map((r) => ({ ...r, liveStatus: ctl.linkLiveStatus(r) })) });
});

router.post('/links/:id/disable', requireRole(...EDITORS), (req, res) => {
  const r = ctl.disableLink(req.params.id, { id:req.user.id, name:req.user.name, role:req.user.role, ip:req.ip });
  if (r.error) return res.status(r.code || 400).json({ error:r.error });
  res.json({ ok:true, status:r.status });
});
router.post('/links/:id/enable', requireRole(...EDITORS), (req, res) => {
  const r = ctl.enableLink(req.params.id, { id:req.user.id, name:req.user.name, role:req.user.role, ip:req.ip });
  if (r.error) return res.status(r.code || 400).json({ error:r.error });
  res.json({ ok:true, status:r.status });
});

function resultRow(sessionId) {
  const r = db.prepare(
    `SELECT ir.*,c.full_name,c.email,c.phone,c.id_number,a.name assessment_name,a.assessment_type,
            a.pass_threshold,s.started_at,s.submitted_at
       FROM iq_results ir
       JOIN candidates c ON c.id=ir.candidate_id
       LEFT JOIN assessments a ON a.id=ir.assessment_id
       LEFT JOIN assessment_sessions s ON s.id=ir.session_id
      WHERE ir.session_id=?`
  ).get(sessionId);
  if (r) return r;
  return db.prepare(
    `SELECT s.id session_id,c.full_name,c.email,c.phone,c.id_number,a.name assessment_name,a.assessment_type,
            s.started_at,s.submitted_at,s.pass_threshold,s.total_max,
            sc.final_marks raw_score,sc.percentage,sc.pass
       FROM assessment_sessions s
       JOIN candidates c ON c.id=s.candidate_id
       LEFT JOIN assessments a ON a.id=s.assessment_id
       LEFT JOIN scores sc ON sc.session_id=s.id
      WHERE s.id=?`
  ).get(sessionId);
}

function resultData(sessionId) {
  const r = resultRow(sessionId);
  if (!r) return null;
  const max = Number(r.raw_max || r.total_max || 0);
  const marks = Number(r.raw_score || r.final_marks || 0);
  const pct = Number(r.percentage || (max ? marks / max * 100 : 0));
  const threshold = Number(r.pass_threshold || 0);
  return { r, max, marks, pct, pass: r.pass != null ? !!r.pass : pct >= (max ? threshold / max * 100 : 0) };
}

router.get('/results', requireRole(...VIEWERS), (req, res) => {
  const rows = db.prepare(
    `SELECT s.id session_id,c.full_name,c.email,c.phone,c.id_number,
            a.name assessment_name,a.assessment_type,
            COALESCE(ir.raw_score,sc.final_marks) marks,
            COALESCE(ir.raw_max,s.total_max) max_marks,
            COALESCE(ir.percentage,sc.percentage) percentage,
            s.pass_threshold,s.started_at,s.submitted_at
       FROM assessment_sessions s
       JOIN candidates c ON c.id=s.candidate_id
       LEFT JOIN assessments a ON a.id=s.assessment_id
       LEFT JOIN iq_results ir ON ir.session_id=s.id
       LEFT JOIN scores sc ON sc.session_id=s.id
      WHERE s.status='SUBMITTED'
      ORDER BY COALESCE(s.submitted_at,s.started_at) DESC LIMIT 500`
  ).all();
  res.json({ results: rows.map((r) => ({
    sessionId:r.session_id,name:r.full_name,email:r.email,phone:r.phone,idNumber:r.id_number || '',
    assessment:r.assessment_name,type:r.assessment_type,marks:r.marks || 0,maxMarks:r.max_marks || 0,
    percentage:Number(r.percentage || 0),passMark:Number(r.pass_threshold || 0),pass:Number(r.marks || 0) >= Number(r.pass_threshold || 0),
    submittedAt:r.submitted_at
  })) });
});

function writeReportHeader(doc, r, marks, max, pct, pass) {
  doc.fontSize(18).fillColor('#0F2438').text('LALCO ASSESSMENT RESULT');
  doc.moveDown(0.5).fontSize(11).fillColor('black');
  [
    ['Name', r.full_name], ['Email', r.email], ['Phone', r.phone], ['ID', r.id_number],
    ['Assessment', r.assessment_name], ['Type', r.assessment_type],
    ['Started', r.started_at], ['Submitted', r.submitted_at],
    ['Marks', `${marks} / ${max}`], ['Percentage', `${Math.round(pct * 100) / 100}%`],
    ['Pass mark', r.pass_threshold], ['Result', pass ? 'PASS' : 'FAIL']
  ].forEach(([k,v]) => doc.text(`${k}: ${v == null ? '' : v}`));
}

router.get('/results/:sessionId.pdf', requireRole(...VIEWERS), (req,res) => {
  const data=resultData(req.params.sessionId);
  if(!data) return res.status(404).json({error:'Result not found.'});
  const {r,marks,max,pct,pass}=data;
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="LALCO_Result_${r.full_name.replace(/[^a-z0-9_-]+/gi,'_')}.pdf"`);
  const doc=new PDFDocument({margin:45}); doc.pipe(res); writeReportHeader(doc,r,marks,max,pct,pass); doc.end();
});

router.get('/results/:sessionId.xlsx', requireRole(...VIEWERS), async (req,res) => {
  const data=resultData(req.params.sessionId);
  if(!data) return res.status(404).json({error:'Result not found.'});
  const {r,marks,max,pct,pass}=data;
  const wb=new ExcelJS.Workbook(); const ws=wb.addWorksheet('Result');
  ws.columns=[{header:'Field',key:'field',width:24},{header:'Value',key:'value',width:40}];
  [['Name',r.full_name],['Email',r.email],['Phone',r.phone],['ID',r.id_number],['Assessment',r.assessment_name],
   ['Type',r.assessment_type],['Started',r.started_at],['Submitted',r.submitted_at],['Marks',marks],['Max Marks',max],
   ['Percentage',pct],['Pass Mark',r.pass_threshold],['Result',pass?'PASS':'FAIL']].forEach(([field,value])=>ws.addRow({field,value:value==null?'':value}));
  ws.getRow(1).font={bold:true}; res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="LALCO_Result_${r.full_name.replace(/[^a-z0-9_-]+/gi,'_')}.xlsx"`);
  await wb.xlsx.write(res); res.end();
});

router.get('/results/:sessionId.doc', requireRole(...VIEWERS), (req,res) => {
  const data=resultData(req.params.sessionId);
  if(!data) return res.status(404).json({error:'Result not found.'});
  const {r,marks,max,pct,pass}=data;
  const escHtml=(v)=>String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const html=`<html><body><h1>LALCO ASSESSMENT RESULT</h1><table border="1" cellpadding="6">${[
    ['Name',r.full_name],['Email',r.email],['Phone',r.phone],['ID',r.id_number],['Assessment',r.assessment_name],
    ['Type',r.assessment_type],['Started',r.started_at],['Submitted',r.submitted_at],['Marks',marks+' / '+max],
    ['Percentage',Math.round(pct*100)/100+'%'],['Pass Mark',r.pass_threshold],['Result',pass?'PASS':'FAIL']
  ].map(x=>'<tr><th>'+escHtml(x[0])+'</th><td>'+escHtml(x[1])+'</td></tr>').join('')}</table></body></html>`;
  res.setHeader('Content-Type','application/msword');
  res.setHeader('Content-Disposition',`attachment; filename="LALCO_Result_${r.full_name.replace(/[^a-z0-9_-]+/gi,'_')}.doc"`);
  res.send(html);
});

router.get('/results.xlsx', requireRole(...VIEWERS), async (req,res) => {
  const rows=db.prepare(
    `SELECT s.id session_id,c.full_name,c.email,c.phone,c.id_number,a.name assessment_name,a.assessment_type,
            COALESCE(ir.raw_score,sc.final_marks) marks,COALESCE(ir.raw_max,s.total_max) max_marks,
            COALESCE(ir.percentage,sc.percentage) percentage,s.pass_threshold,s.submitted_at
       FROM assessment_sessions s JOIN candidates c ON c.id=s.candidate_id
       LEFT JOIN assessments a ON a.id=s.assessment_id
       LEFT JOIN iq_results ir ON ir.session_id=s.id LEFT JOIN scores sc ON sc.session_id=s.id
      WHERE s.status='SUBMITTED' ORDER BY COALESCE(s.submitted_at,s.started_at) DESC`
  ).all();
  const wb=new ExcelJS.Workbook(); const ws=wb.addWorksheet('Results');
  ws.columns=['Name','Email','Phone','ID','Assessment','Type','Marks','Max Marks','Percentage','Pass Mark','Result','Submitted']
    .map((header)=>({header,key:header.toLowerCase().replace(/[^a-z]+/g,'_'),width:18})).forEach((c)=>{});
  // Rebuild columns with stable keys.
  ws.columns=[
    {header:'Name',key:'name',width:24},{header:'Email',key:'email',width:28},{header:'Phone',key:'phone',width:18},
    {header:'ID',key:'id',width:18},{header:'Assessment',key:'assessment',width:28},{header:'Type',key:'type',width:16},
    {header:'Marks',key:'marks',width:10},{header:'Max Marks',key:'max',width:12},{header:'Percentage',key:'percentage',width:12},
    {header:'Pass Mark',key:'passmark',width:12},{header:'Result',key:'result',width:12},{header:'Submitted',key:'submitted',width:22}
  ];
  rows.forEach(r=>ws.addRow({name:r.full_name,email:r.email,phone:r.phone,id:r.id_number,assessment:r.assessment_name,type:r.assessment_type,
    marks:r.marks||0,max:r.max_marks||0,percentage:Number(r.percentage||0),passmark:r.pass_threshold||0,
    result:Number(r.percentage||0)>=Number(r.pass_threshold||0)?'PASS':'FAIL',submitted:r.submitted_at||''}));
  ws.getRow(1).font={bold:true}; res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="LALCO_All_Results.xlsx"'); await wb.xlsx.write(res); res.end();
});

module.exports = router;
