// The recruitment report: everything about one candidate in one place.
//
// It is assembled, not stored. The parts a human enters live in
// recruitment_records; the parts the assessments produce are read live from the
// attempt that produced them — iq_results for the IQ mark, scores for the
// calculation and essay sections. Nothing copies a score into a second place,
// so a report can never disagree with the attempt it came from, and no
// administrator has to retype a result the system already knows.
//
// Everything here is behind requireAuth (mounted in server.js) and role-gated
// below. A candidate can never reach this router.
const express = require('express');
const db = require('../../db');
const { auditFromReq } = require('../../lib/audit');
const { requireAuth, requireRole } = require('../../middleware/auth');
const profile = require('../../lib/candidateProfile');
const { scoringConfigFor, ESTIMATED_IQ_DISCLAIMER } = require('../../lib/iqScoring');

const router = express.Router();
router.use(requireAuth);

// Reading a recruitment report is a recruitment activity; writing a decision to
// it is narrower still.
const READERS = ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'RECRUITER', 'INTERVIEWER', 'EVALUATOR'];
const EDITORS = ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'INTERVIEWER'];
// Only these may settle the outcome of an application.
const DECIDERS = ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER'];

// The interview scores the business uses. Anything else is refused rather than
// rounded, so a typo cannot quietly become a different mark.
const INTERVIEW_SCORES = [0, 5, 10, 15, 20, 25, 30];
const INTERVIEW_RESULTS = ['PASS', 'NOT_PASS'];
const FINAL_RESULTS = ['PENDING', 'PASS', 'NOT_PASS'];

// Who may be recorded as having interviewed somebody.
const INTERVIEWER_ROLES = ['INTERVIEWER', 'HR_ADMIN', 'MANAGER', 'SUPER_ADMIN'];

function emptyRecord(candidateId) {
  return {
    candidate_id: candidateId,
    reference_result: null, character_note: null, interviewer_id: null,
    hr_interview_score: null, chairman_interview_score: null,
    interview_result: null, remark: null, final_result: 'PENDING',
    date_come_to_work: null, updated_by: null, updated_at: null,
  };
}

function recordFor(candidateId) {
  return db.prepare('SELECT * FROM recruitment_records WHERE candidate_id = ?').get(candidateId)
    || emptyRecord(candidateId);
}

/** The most recent sitting for this candidate, whatever product it was. */
function latestSession(candidateId, assessmentType) {
  return db.prepare(
    `SELECT s.* FROM assessment_sessions s
       LEFT JOIN assessments a ON a.id = s.assessment_id
      WHERE s.candidate_id = ?
        AND COALESCE(a.assessment_type, 'GENERAL_ASSESSMENT') = ?
        AND s.submitted_at IS NOT NULL
      ORDER BY s.submitted_at DESC LIMIT 1`
  ).get(candidateId, assessmentType);
}

/**
 * The assessment results, read from the attempts that produced them. Each one
 * is null until the candidate has actually completed that assessment, so the
 * report never shows a mark nobody earned.
 */
function assessmentResults(candidateId) {
  const iqSession = latestSession(candidateId, 'IQ_TEST');
  const iqRow = iqSession
    ? db.prepare('SELECT * FROM iq_results WHERE session_id = ?').get(iqSession.id)
    : null;
  const iqAssessment = iqSession && iqSession.assessment_id
    ? db.prepare('SELECT * FROM assessments WHERE id = ?').get(iqSession.assessment_id)
    : null;
  const iqConfig = iqAssessment ? scoringConfigFor(iqAssessment) : null;

  const genSession = latestSession(candidateId, 'GENERAL_ASSESSMENT');
  const scores = genSession
    ? db.prepare('SELECT * FROM scores WHERE session_id = ?').get(genSession.id)
    : null;

  return {
    // The authoritative IQ result, marked server-side from the attempt. It is
    // an estimate from this test alone, never a clinical measurement.
    iq: iqRow ? {
      sessionId: iqRow.session_id,
      correct: iqRow.correct_count,
      totalQuestions: iqRow.total_questions,
      rawScore: iqRow.raw_score,
      rawMax: iqRow.raw_max,
      percentage: iqRow.percentage,
      // Null when the test is configured to publish no estimate at all.
      estimatedIq: iqRow.estimated_iq,
      estimatedIqEnabled: iqConfig ? !!iqConfig.estimatedIqEnabled : null,
      submittedAt: iqSession.submitted_at,
      disclaimer: ESTIMATED_IQ_DISCLAIMER,
    } : null,
    calculation: scores && scores.calc_max ? {
      sessionId: scores.session_id,
      marks: scores.calc_marks,
      max: scores.calc_max,
      submittedAt: genSession.submitted_at,
    } : null,
    essay: scores && scores.essay_marks !== null && scores.essay_marks !== undefined ? {
      sessionId: scores.session_id,
      marks: scores.essay_marks,
      max: scores.essay_max,
      markedBy: scores.essay_marker,
      markedAt: scores.essay_marked_at,
    } : null,
    // The criteria-based interview marking that already existed, kept distinct
    // from the HR/Chairman scores below: they answer different questions.
    interviewCriteria: scores && scores.interview_marks !== null && scores.interview_marks !== undefined ? {
      marks: scores.interview_marks,
      max: scores.interview_max,
      markedBy: scores.interview_marker,
      markedAt: scores.interview_marked_at,
    } : null,
    final: scores ? {
      marks: scores.final_marks,
      max: genSession ? genSession.total_max : null,
      percentage: scores.percentage,
      pass: scores.pass === null || scores.pass === undefined ? null : !!scores.pass,
    } : null,
  };
}

function interviewerName(id) {
  if (!id) return null;
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(id);
  return u ? u.name : null;
}

/** The whole report for one candidate, in the sections the business reads it in. */
function buildReport(candidate) {
  const rec = recordFor(candidate.id);
  const results = assessmentResults(candidate.id);
  return {
    candidate: {
      id: candidate.id,
      code: candidate.code,
      name: candidate.full_name,
      phone: candidate.phone,
      // The stable internal value plus the labels, so the UI can show either
      // language without the caller having to know the mapping.
      graduateFrom: candidate.graduate_from,
      graduateFromLabels: profile.GRADUATE_FROM.find((g) => g.value === candidate.graduate_from) || null,
      school: candidate.university,
      subject: candidate.major,
      gpa: candidate.gpa,
      status: candidate.status,
      profileStatus: profile.profileStatus(candidate),
      profileCompletedAt: candidate.profile_completed_at,
    },
    assessment: results,
    interview: {
      interviewerId: rec.interviewer_id,
      interviewerName: interviewerName(rec.interviewer_id),
      hrScore: rec.hr_interview_score,
      chairmanScore: rec.chairman_interview_score,
      result: rec.interview_result,
      remark: rec.remark,
    },
    administrative: {
      referenceResult: rec.reference_result,
      character: rec.character_note,
    },
    outcome: {
      finalResult: rec.final_result || 'PENDING',
      dateComeToWork: rec.date_come_to_work,
    },
    updatedBy: rec.updated_by,
    updatedAt: rec.updated_at,
  };
}

// ------------------------------------------------------------------- meta
router.get('/meta', requireRole(...READERS), (req, res) => {
  const interviewers = db.prepare(
    `SELECT id, name, role FROM users
      WHERE active = 1 AND role IN (${INTERVIEWER_ROLES.map(() => '?').join(',')})
      ORDER BY name`
  ).all(...INTERVIEWER_ROLES);
  res.json({
    interviewers,
    interviewScores: INTERVIEW_SCORES,
    interviewResults: INTERVIEW_RESULTS,
    finalResults: FINAL_RESULTS,
    graduateFrom: profile.GRADUATE_FROM,
    estimatedIqDisclaimer: ESTIMATED_IQ_DISCLAIMER,
  });
});

// ------------------------------------------------------------------ report
router.get('/:candidateId', requireRole(...READERS), (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.candidateId);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  res.json({ report: buildReport(c) });
});

// ------------------------------------------------------------------ update
function validatePatch(b, isDecider) {
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

  if (has('interviewerId') && b.interviewerId !== null && b.interviewerId !== '') {
    const u = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(b.interviewerId);
    if (!u) errors.push('That interviewer does not exist.');
    else if (!u.active) errors.push('That interviewer account is disabled.');
    else if (!INTERVIEWER_ROLES.includes(u.role)) errors.push('That user cannot be recorded as an interviewer.');
  }
  ['hrScore', 'chairmanScore'].forEach((k) => {
    if (has(k) && b[k] !== null && b[k] !== '') {
      const n = Number(b[k]);
      if (!INTERVIEW_SCORES.includes(n)) {
        errors.push(`${k === 'hrScore' ? 'HR/Branch' : 'Chairman'} interview score must be one of: ${INTERVIEW_SCORES.join(', ')}.`);
      }
    }
  });
  if (has('interviewResult') && b.interviewResult !== null && b.interviewResult !== ''
      && !INTERVIEW_RESULTS.includes(String(b.interviewResult).toUpperCase())) {
    errors.push('Interview result must be PASS or NOT_PASS.');
  }
  if (has('finalResult') && b.finalResult !== null && b.finalResult !== '') {
    if (!FINAL_RESULTS.includes(String(b.finalResult).toUpperCase())) {
      errors.push('Final result must be PENDING, PASS or NOT_PASS.');
    } else if (!isDecider) {
      errors.push('Only HR or a manager may set the final result.');
    }
  }
  if (has('dateComeToWork') && b.dateComeToWork !== null && b.dateComeToWork !== '') {
    // Stored normalised as YYYY-MM-DD so it sorts and compares.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.dateComeToWork))) {
      errors.push('Date come to work must be a date (YYYY-MM-DD).');
    } else if (Number.isNaN(Date.parse(b.dateComeToWork))) {
      errors.push('That is not a real date.');
    }
  }
  return errors;
}

router.patch('/:candidateId', requireRole(...EDITORS), (req, res) => {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.candidateId);
  if (!c) return res.status(404).json({ error: 'Candidate not found.' });
  const b = req.body || {};
  const isDecider = DECIDERS.includes(req.user.role);

  const errors = validatePatch(b, isDecider);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const before = recordFor(c.id);
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const blankToNull = (v) => (v === '' || v === undefined ? null : v);
  const next = {
    candidate_id: c.id,
    reference_result: has('referenceResult') ? blankToNull(b.referenceResult) : before.reference_result,
    character_note: has('character') ? blankToNull(b.character) : before.character_note,
    interviewer_id: has('interviewerId') ? blankToNull(b.interviewerId) : before.interviewer_id,
    hr_interview_score: has('hrScore') ? (blankToNull(b.hrScore) === null ? null : Number(b.hrScore)) : before.hr_interview_score,
    chairman_interview_score: has('chairmanScore') ? (blankToNull(b.chairmanScore) === null ? null : Number(b.chairmanScore)) : before.chairman_interview_score,
    interview_result: has('interviewResult')
      ? (blankToNull(b.interviewResult) === null ? null : String(b.interviewResult).toUpperCase())
      : before.interview_result,
    remark: has('remark') ? blankToNull(b.remark) : before.remark,
    final_result: has('finalResult')
      ? (blankToNull(b.finalResult) === null ? 'PENDING' : String(b.finalResult).toUpperCase())
      : (before.final_result || 'PENDING'),
    date_come_to_work: has('dateComeToWork') ? blankToNull(b.dateComeToWork) : before.date_come_to_work,
    updated_by: req.user.name,
  };

  db.prepare(
    `INSERT INTO recruitment_records (candidate_id, reference_result, character_note, interviewer_id,
       hr_interview_score, chairman_interview_score, interview_result, remark, final_result,
       date_come_to_work, updated_by)
     VALUES (@candidate_id,@reference_result,@character_note,@interviewer_id,@hr_interview_score,
       @chairman_interview_score,@interview_result,@remark,@final_result,@date_come_to_work,@updated_by)
     ON CONFLICT(candidate_id) DO UPDATE SET
       reference_result=excluded.reference_result, character_note=excluded.character_note,
       interviewer_id=excluded.interviewer_id, hr_interview_score=excluded.hr_interview_score,
       chairman_interview_score=excluded.chairman_interview_score,
       interview_result=excluded.interview_result, remark=excluded.remark,
       final_result=excluded.final_result, date_come_to_work=excluded.date_come_to_work,
       updated_by=excluded.updated_by, updated_at=datetime('now')`
  ).run(next);

  // Only the fields this request actually changed are audited, so the trail
  // says what somebody did rather than restating the whole record every time.
  const changed = {};
  Object.keys(next).forEach((k) => {
    if (k === 'candidate_id' || k === 'updated_by') return;
    if (before[k] !== next[k]) changed[k] = { from: before[k], to: next[k] };
  });
  if (Object.keys(changed).length) {
    auditFromReq(req, 'RECRUITMENT_RECORD_UPDATED', c.code, null, changed);
  }

  res.json({ ok: true, changed: Object.keys(changed), report: buildReport(db.prepare('SELECT * FROM candidates WHERE id = ?').get(c.id)) });
});

module.exports = router;
module.exports.INTERVIEW_SCORES = INTERVIEW_SCORES;
module.exports.buildReport = buildReport;
