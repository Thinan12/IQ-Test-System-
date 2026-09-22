// The single place an assessment is ever finalized.
//
// Three different things can trigger it — the candidate pressing Submit, the
// client's countdown reaching zero, and the server noticing an expired session
// (on any request, or via the background sweep) — but they all come through
// finalizeSession(), which is atomic and idempotent. Whichever arrives first
// wins; every later attempt is told the assessment is already finalized and
// changes nothing. That is what prevents duplicate submissions.
//
// The server clock and assessment_sessions.expires_at are authoritative. A
// browser timer is only a prompt; nothing here trusts it.
const db = require('../db');
const { generateId } = require('./tokens');
const { gradeAllCalc } = require('./grading');
const { audit } = require('./audit');
const { parseDbDate } = require('./timeutil');

// Required lazily, not at module load: googleSheets -> sheetData -> finalize is
// a cycle, and resolving it at import time would leave one of the three holding
// a half-initialised module. At call time every module is fully loaded.
function googleSheets() { return require('./googleSheets'); }

const SUBMISSION_TYPES = { MANUAL: 'MANUAL', AUTO: 'AUTO_SUBMITTED', TERMINATED: 'TERMINATED' };
const REASONS = {
  CANDIDATE: 'CANDIDATE_SUBMITTED',
  TIME_EXPIRED: 'TIME_EXPIRED',
  TERMINATED_BY_ADMIN: 'TERMINATED_BY_ADMIN',
};

function nowIso() { return new Date().toISOString(); }

/**
 * Has the server-side deadline passed for this session?
 * A paused assessment can never be expired — its countdown is frozen and the
 * paused time is credited back on resume (see src/lib/examControl.js).
 */
function isExpired(session, at) {
  if (!session || !session.expires_at) return false;
  if (session.status === 'IN_PROGRESS' && session.paused_at) return false;
  return parseDbDate(session.expires_at).getTime() <= (at ? at.getTime() : Date.now());
}

/**
 * The status HR and the candidate are shown.
 * `status` itself stays 'SUBMITTED' so every existing query and guard that keys
 * off it keeps working untouched.
 */
function displayStatus(session) {
  if (!session) return null;
  if (session.status !== 'SUBMITTED') {
    return (session.status === 'IN_PROGRESS' && session.paused_at) ? 'PAUSED' : session.status;
  }
  if (session.submission_type === SUBMISSION_TYPES.TERMINATED) return 'TERMINATED';
  if (session.submission_type === SUBMISSION_TYPES.AUTO) return 'AUTO_SUBMITTED';
  return 'SUBMITTED';
}

// An answer counts as answered only if the candidate actually put something in
// it. A row created merely by visiting a question, or one holding only empty
// values, stays unanswered — we never invent an answer.
function meaningfulAnswerCount(sessionId) {
  const rows = db.prepare(
    `SELECT a.answer_json, q.type FROM candidate_answers a
       JOIN questions q ON q.id = a.question_id
      WHERE a.session_id = ? AND q.active = 1`
  ).all(sessionId);
  let answered = 0;
  rows.forEach((r) => {
    if (!r.answer_json) return;
    let parsed;
    try { parsed = JSON.parse(r.answer_json); } catch (e) { return; }
    if (parsed === null || parsed === undefined) return;
    if (r.type === 'ESSAY') {
      if (String(parsed.text || '').trim().length > 0) answered += 1;
      return;
    }
    const hasValue = Object.values(parsed).some(
      (v) => v !== null && v !== undefined && String(v).trim() !== ''
    );
    if (hasValue) answered += 1;
  });
  const total = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE active = 1').get().n;
  return { total, answered, unanswered: Math.max(0, total - answered) };
}

function buildIntegrity(sessionId) {
  const events = db.prepare('SELECT * FROM answer_events WHERE session_id = ?').all(sessionId);
  const pasteEvents = events.filter((e) => e.type === 'PASTE');
  const focusChanges = events.filter((e) => e.type === 'FOCUS_CHANGE' || e.type === 'VISIBILITY_CHANGE').length;
  const largestPaste = pasteEvents.reduce((m, e) => {
    let meta = {};
    try { meta = JSON.parse(e.meta_json || '{}'); } catch (err) { meta = {}; }
    return Math.max(m, meta.length || 0);
  }, 0);
  const evidence = [];
  if (largestPaste > 0) evidence.push(`Large text insertion detected. Candidate pasted ${largestPaste} characters into an answer field.`);
  if (focusChanges > 0) evidence.push(`Candidate changed browser focus ${focusChanges} times during the assessment.`);
  let risk = 'Low';
  if (largestPaste >= 500 || pasteEvents.length >= 3) risk = 'High';
  else if (largestPaste > 0 || pasteEvents.length >= 1 || focusChanges >= 5) risk = 'Medium';
  return { pasteCount: pasteEvents.length, focusChanges, largestPaste, risk, evidence };
}

/**
 * Finalize an assessment exactly once.
 *
 * @param {string} sessionId
 * @param {{auto?: boolean, reason?: string, ip?: string}} options
 * @returns {{finalized: boolean, alreadyFinalized: boolean, session, counts, submittedAt}}
 */
function finalizeSession(sessionId, options = {}) {
  const auto = !!options.auto;
  const submissionType = options.type
    || (auto ? SUBMISSION_TYPES.AUTO : SUBMISSION_TYPES.MANUAL);
  const submissionReason = options.reason
    || (auto ? REASONS.TIME_EXPIRED : REASONS.CANDIDATE);
  const terminated = submissionType === SUBMISSION_TYPES.TERMINATED;

  // Everything below happens in ONE transaction. The conditional UPDATE is the
  // first statement and acts as the lock: only the caller whose UPDATE actually
  // changed a row goes on to grade and record. better-sqlite3 runs synchronously
  // on a single connection, so no second caller can interleave.
  const run = db.transaction(() => {
    const submittedAt = nowIso();
    const locked = db.prepare(
      `UPDATE assessment_sessions
          SET status = 'SUBMITTED',
              submitted_at = ?,
              submission_type = ?,
              submission_reason = ?
        WHERE id = ? AND status = 'IN_PROGRESS'`
    ).run(submittedAt, submissionType, submissionReason, sessionId);

    if (locked.changes === 0) {
      // Someone (or something) already finalized this assessment.
      return { finalized: false, alreadyFinalized: true, submittedAt: null };
    }

    const session = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId);
    const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(session.candidate_id);

    // Grade from whatever the candidate had already saved to the server.
    // Nothing is invented; unanswered questions simply score zero.
    const questions = db.prepare('SELECT * FROM questions WHERE active = 1').all()
      .map((q) => ({ ...q, config: JSON.parse(q.config_json) }));
    const answers = db.prepare('SELECT * FROM candidate_answers WHERE session_id = ?').all(sessionId);
    const answersByQ = {};
    answers.forEach((a) => { answersByQ[a.question_id] = a; });
    const calcResult = gradeAllCalc(questions, answersByQ);

    const counts = meaningfulAnswerCount(sessionId);
    const integrity = buildIntegrity(sessionId);

    db.prepare(
      `UPDATE assessment_sessions SET answered_count = ?, unanswered_count = ?, google_sync_status = ? WHERE id = ?`
    ).run(counts.answered, counts.unanswered, googleSheets().isAutoSyncEnabled() ? 'PENDING' : 'NOT_REQUESTED', sessionId);

    // Question timing is finalized as-is: whatever deltas the client already
    // reported are kept, and no further writes are accepted after this point.
    db.prepare(
      `UPDATE candidate_answers SET submitted_at = ? WHERE session_id = ? AND submitted_at IS NULL`
    ).run(submittedAt, sessionId);

    db.prepare(`UPDATE candidates SET status = 'INTERVIEW_PENDING' WHERE id = ?`).run(candidate.id);

    db.prepare(
      `INSERT INTO scores (id, session_id, calc_marks, calc_max, calc_breakdown_json) VALUES (?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET calc_marks=excluded.calc_marks, calc_max=excluded.calc_max,
         calc_breakdown_json=excluded.calc_breakdown_json`
    ).run(generateId('score'), sessionId, calcResult.marks, calcResult.max, JSON.stringify(calcResult.breakdown));

    db.prepare(
      `INSERT INTO integrity_assessments (id, session_id, paste_events, focus_changes, largest_paste, risk_level, evidence_json)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET paste_events=excluded.paste_events, focus_changes=excluded.focus_changes,
         largest_paste=excluded.largest_paste, risk_level=excluded.risk_level, evidence_json=excluded.evidence_json`
    ).run(generateId('integ'), sessionId, integrity.pasteCount, integrity.focusChanges,
      integrity.largestPaste, integrity.risk, JSON.stringify(integrity.evidence));

    audit({
      userName: terminated
        ? (options.actorName || 'Administrator')
        : auto ? 'System (automatic submission)' : 'Candidate (public exam)',
      role: terminated ? 'ADMIN' : auto ? 'SYSTEM' : 'CANDIDATE',
      action: terminated
        ? 'ASSESSMENT_TERMINATED'
        : auto ? 'ASSESSMENT_AUTO_SUBMITTED' : 'Assessment submitted',
      target: candidate.code,
      newValue: {
        candidate: candidate.code,
        candidateName: candidate.full_name,
        assessmentId: sessionId,
        timestamp: submittedAt,
        reason: submissionReason,
        answered: counts.answered,
        unanswered: counts.unanswered,
        scheduledEndAt: session.expires_at,
        actualEndAt: submittedAt,
      },
      ip: options.ip || null,
    });

    return { finalized: true, alreadyFinalized: false, submittedAt, counts };
  });

  const result = run();
  // Google Sheets is reached only after the result is safely committed, and can
  // never delay or fail a submission (see src/lib/googleSheets.js).
  if (result.finalized) googleSheets().syncSessionInBackground(sessionId);
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId);
  return {
    ...result,
    session,
    submittedAt: result.submittedAt || (session && session.submitted_at) || null,
    counts: result.counts || (session
      ? { answered: session.answered_count, unanswered: session.unanswered_count }
      : null),
  };
}

/**
 * Finalize a session if — and only if — its server-side deadline has passed.
 * Safe to call on any request path; a live session is left alone.
 */
function finalizeIfExpired(session, options = {}) {
  if (!session || session.status !== 'IN_PROGRESS' || !isExpired(session)) return null;
  return finalizeSession(session.id, { ...options, auto: true, reason: REASONS.TIME_EXPIRED });
}

/**
 * Sweep every abandoned session whose time has run out.
 *
 * This is what makes auto-submit hold when the candidate simply walks away:
 * no request ever arrives from that browser, so nothing else would notice.
 */
function finalizeExpiredSessions(options = {}) {
  const expired = db.prepare(
    `SELECT id FROM assessment_sessions
      WHERE status = 'IN_PROGRESS'
        AND paused_at IS NULL
        AND expires_at IS NOT NULL
        AND datetime(expires_at) <= datetime('now')`
  ).all();
  const finalized = [];
  expired.forEach((row) => {
    try {
      const result = finalizeSession(row.id, { auto: true, reason: REASONS.TIME_EXPIRED, ip: options.ip || null });
      if (result.finalized) finalized.push(row.id);
    } catch (error) {
      console.error('[auto-submit] could not finalize session %s: %s', row.id, error.message);
    }
  });
  return { scanned: expired.length, finalized: finalized.length, sessionIds: finalized };
}

/** Background sweep. Returns a stop() handle so tests and shutdown can clear it. */
function startExpirySweeper(intervalSeconds) {
  const seconds = Math.max(5, Number(intervalSeconds) || 60);
  const timer = setInterval(() => {
    try {
      const result = finalizeExpiredSessions();
      if (result.finalized > 0) {
        console.log('[auto-submit] finalized %d expired assessment(s)', result.finalized);
      }
    } catch (error) {
      console.error('[auto-submit] sweep failed: %s', error.message);
    }
  }, seconds * 1000);
  if (timer.unref) timer.unref(); // never hold the process open
  return { stop: () => clearInterval(timer), intervalSeconds: seconds };
}

module.exports = {
  SUBMISSION_TYPES,
  REASONS,
  isExpired,
  displayStatus,
  meaningfulAnswerCount,
  finalizeSession,
  finalizeIfExpired,
  finalizeExpiredSessions,
  startExpirySweeper,
};
