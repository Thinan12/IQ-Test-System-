const express = require('express');
const db = require('../db');
const { generateId } = require('../lib/tokens');
const { finalizeSession, finalizeIfExpired, isExpired, displayStatus } = require('../lib/finalize');
const selection = require('../lib/questionSelection');
const { examLimiter } = require('../middleware/auth');

const router = express.Router();
router.use(examLimiter);

function linkFor(token) {
  return db.prepare('SELECT * FROM assessment_links WHERE token = ?').get(token);
}
function assessmentFor(link) {
  return link && link.assessment_id ? db.prepare('SELECT * FROM assessments WHERE id = ?').get(link.assessment_id) : null;
}
function status(link) {
  const ctl = require('../lib/examControl');
  return ctl.linkLiveStatus(link);
}
function sessionFor(link) {
  return db.prepare('SELECT * FROM assessment_sessions WHERE link_id = ? ORDER BY started_at DESC LIMIT 1').get(link.id);
}
function candidateFor(link) {
  return db.prepare('SELECT * FROM candidates WHERE id = ?').get(link.candidate_id);
}
function selected(session) {
  const rows = selection.sessionQuestions(session.id);
  if (rows.length) return rows;
  return db.prepare(
    'SELECT q.* FROM assessment_questions aq JOIN questions q ON q.id=aq.question_id WHERE aq.assessment_id=? ORDER BY aq.order_index'
  ).all(session.assessment_id);
}
function safeQuestion(q) {
  const config = JSON.parse(q.config_json || '{}');
  if (q.type === 'ESSAY') return { id:q.id, type:'ESSAY', text:q.text, maxMarks:q.max_marks };
  const part = config.parts && config.parts[0];
  return {
    id:q.id, type:'MCQ', text:q.text, maxMarks:q.max_marks,
    options:(part && Array.isArray(part.options) ? part.options : []).map((value) => ({ value:String(value), label:String(value) }))
  };
}
function requireSession(token) {
  const link=linkFor(token);
  if (!link) return { error:{code:404,message:'This link is not valid.'} };
  const session=sessionFor(link);
  if (!session) return { error:{code:400,message:'Please complete your information and start the test.'} };
  if (session.status==='IN_PROGRESS' && isExpired(session)) {
    finalizeIfExpired(session);
    return { link, session:sessionFor(link) };
  }
  if (session.status==='SUBMITTED') return { link, session };
  return { link, session };
}

router.get('/:token', (req,res)=>{
  const link=linkFor(req.params.token);
  if(!link) return res.status(404).json({error:'This link is not valid.'});
  const a=assessmentFor(link);
  const c=candidateFor(link);
  const s=sessionFor(link);
  const st=status(link);
  if(!s && st!=='ACTIVE') return res.status(410).json({error:'This assessment link is no longer available.',linkStatus:st});
  res.json({
    assessmentType:a && a.assessment_type==='IQ_TEST'?'IQ':'GENERAL',
    assessmentName:a ? a.name : 'LALCO Assessment',
    durationMinutes:a ? a.duration_minutes : 30,
    linkStatus:st,
    candidate:{fullName:c.full_name==='Pending candidate'?'':c.full_name,email:c.email||'',phone:c.phone||'',idNumber:c.id_number||''},
    started:!!s, submitted:!!(s&&s.status==='SUBMITTED'),
    expiresAt:s?s.expires_at:null, remainingSeconds:s?Math.max(0,Math.floor((new Date(s.expires_at)-Date.now())/1000)):null
  });
});

router.post('/:token/profile',(req,res)=>{
  const link=linkFor(req.params.token);
  if(!link) return res.status(404).json({error:'This link is not valid.'});
  const st=status(link); const existing=sessionFor(link);
  if(!existing && st!=='ACTIVE') return res.status(410).json({error:'This assessment link is no longer available.'});
  if(existing) return res.status(409).json({error:'The assessment has already started.'});
  const b=req.body||{}; const fullName=String(b.fullName||'').trim(), email=String(b.email||'').trim();
  const phone=String(b.phone||'').trim(), idNumber=String(b.idNumber||'').trim();
  const errors=[];
  if(!fullName) errors.push({field:'fullName',message:'Full name is required.'});
  if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push({field:'email',message:'A valid email is required.'});
  if(!phone) errors.push({field:'phone',message:'Phone number is required.'});
  if(!idNumber) errors.push({field:'idNumber',message:'ID/NIC/Passport is required.'});
  if(errors.length) return res.status(400).json({error:errors[0].message,errors});
  db.prepare(`UPDATE candidates SET full_name=?,email=?,phone=?,id_number=?,profile_completed_at=COALESCE(profile_completed_at,datetime('now')),profile_updated_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
    .run(fullName,email,phone,idNumber,link.candidate_id);
  res.json({ok:true});
});

router.post('/:token/start',(req,res)=>{
  const link=linkFor(req.params.token);
  if(!link) return res.status(404).json({error:'This link is not valid.'});
  let s=sessionFor(link);
  if(s){
    if(s.status==='IN_PROGRESS' && isExpired(s)) finalizeIfExpired(s);
    s=sessionFor(link);
    if(s.status==='SUBMITTED') return res.status(409).json({error:'This assessment has already been submitted.',status:displayStatus(s)});
    return res.json({started:true,expiresAt:s.expires_at,assessmentType:assessmentFor(link)?.assessment_type==='IQ_TEST'?'IQ':'GENERAL'});
  }
  if(status(link)!=='ACTIVE') return res.status(410).json({error:'This assessment link is no longer available.'});
  const c=candidateFor(link); if(!c.profile_completed_at) return res.status(428).json({error:'Please complete your information first.'});
  const a=assessmentFor(link); if(!a || !a.active || a.archived) return res.status(410).json({error:'This assessment is no longer available.'});
  const problems=selection.validateSelection(a); if(problems.length) return res.status(409).json({error:problems[0]});
  const id=generateId('sess'), now=new Date(), expires=new Date(now.getTime()+Number(a.duration_minutes)*60000).toISOString();
  db.transaction(()=>{
    db.prepare(`INSERT INTO assessment_sessions
      (id,candidate_id,link_id,assessment_id,started_at,duration_minutes,expires_at,status,verified,pass_threshold,total_max,language)
      VALUES (?,?,?,?,?,?,?,'IN_PROGRESS',1,?,?,'en')`).run(id,c.id,link.id,a.id,now.toISOString(),a.duration_minutes,expires,a.pass_threshold,a.total_max);
    if(selection.selectionConfigFor(a).enabled) selection.materializeSelection(id,a);
    db.prepare(`UPDATE assessment_links SET status='USED',first_access_at=COALESCE(first_access_at,datetime('now')) WHERE id=?`).run(link.id);
  })();
  res.json({started:true,expiresAt:expires,assessmentType:a.assessment_type==='IQ_TEST'?'IQ':'GENERAL'});
});

router.get('/:token/questions',(req,res)=>{
  const x=requireSession(req.params.token);
  if(x.error) return res.status(x.error.code).json({error:x.error.message});
  const {session}=x;
  if(session.status==='SUBMITTED') return res.json({submitted:true,questions:[]});
  if(session.paused_at) return res.status(423).json({error:'The assessment is paused.'});
  const questions=selected(session).map(safeQuestion);
  const answered=db.prepare('SELECT question_id,answer_json FROM candidate_answers WHERE session_id=?').all(session.id)
    .reduce((m,r)=>{m[r.question_id]=r.answer_json?JSON.parse(r.answer_json):null;return m;},{});
  res.json({questions,answered,expiresAt:session.expires_at});
});

router.post('/:token/answer',(req,res)=>{
  const x=requireSession(req.params.token);
  if(x.error) return res.status(x.error.code).json({error:x.error.message});
  const {link,session}=x;
  if(session.status==='SUBMITTED') return res.status(409).json({error:'The assessment has already ended.'});
  if(session.paused_at) return res.status(423).json({error:'The assessment is paused.'});
  const q=selected(session).find(v=>v.id===req.body.questionId);
  if(!q) return res.status(400).json({error:'Question is not part of this assessment.'});
  const answer=req.body.answer||{};
  const cleanAnswer=q.type==='ESSAY'?{text:String(answer.text||'')}:{answer:String(answer.answer||'')};
  db.prepare(`INSERT INTO candidate_answers (id,session_id,question_id,answer_json,last_modified_at,visits,time_spent_seconds)
    VALUES (?,?,?,?,datetime('now'),1,?) ON CONFLICT(session_id,question_id) DO UPDATE SET answer_json=excluded.answer_json,last_modified_at=excluded.last_modified_at,visits=visits+1,time_spent_seconds=time_spent_seconds+excluded.time_spent_seconds`)
    .run(generateId('ans'),session.id,q.id,JSON.stringify(cleanAnswer),Number(req.body.timeSpentSeconds)||0);
  res.json({ok:true});
});

router.post('/:token/submit',(req,res)=>{
  const x=requireSession(req.params.token);
  if(x.error) return res.status(x.error.code).json({error:x.error.message});
  const result=finalizeSession(x.session.id,{ip:req.ip});
  res.json({ok:true,status:displayStatus(result.session),submittedAt:result.submittedAt,marks:result.session.assessment_id});
});

module.exports=router;
