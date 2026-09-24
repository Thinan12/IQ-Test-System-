// Administrative control over live assessments and invitation links.
//
// Every operation here is server-side, transactional and audited. None of it
// trusts anything the candidate's browser reports.
//
// Two states are represented by their own columns rather than by the `status`
// column, because SQLite cannot alter a CHECK constraint in place and
// rebuilding those tables on a live database would risk real candidate data:
//   * a session is PAUSED when status='IN_PROGRESS' AND paused_at IS NOT NULL
//   * a link is DISABLED when status='ACTIVE' AND disabled_at IS NOT NULL
// The status shown to users is computed from those (see the *LiveStatus
// helpers), so every existing query that keys off `status` keeps working.
const db = require('../db');
const { audit } = require('./audit');
const { parseDbDate } = require('./timeutil');

const PAUSE_POLICY = 'FREEZE_AND_CREDIT'; // deadline moves out by the paused duration

function nowIso() { return new Date().toISOString(); }
function isoPlusSeconds(iso, seconds) {
  return new Date(parseDbDate(iso).getTime() + seconds * 1000).toISOString();
}

// ---------------------------------------------------------------- statuses
function linkLiveStatus(link) {
  if (!link) return null;
  if (link.status === 'REVOKED') return 'REVOKED';
  if (link.status === 'USED') return 'USED';
  if (link.disabled_at) return 'DISABLED';
  if (link.expires_at && parseDbDate(link.expires_at) < new Date()) return 'EXPIRED';
  return link.status;
}

function sessionLiveStatus(session) {
  if (!session) return null;
  if (session.status === 'SUBMITTED') {
    if (session.submission_type === 'TERMINATED') return 'TERMINATED';
    if (session.submission_type === 'AUTO_SUBMITTED') return 'AUTO_SUBMITTED';
    return 'SUBMITTED';
  }
  if (session.status === 'IN_PROGRESS' && session.paused_at) return 'PAUSED';
  return session.status;
}

function isPaused(session) { return !!(session && session.status === 'IN_PROGRESS' && session.paused_at); }

/**
 * Seconds left on the candidate's clock. While paused the clock is frozen, so
 * the remaining time is measured to the moment the pause began.
 */
function remainingSeconds(session) {
  if (!session || !session.expires_at) return null;
  const reference = isPaused(session) ? parseDbDate(session.paused_at) : new Date();
  return Math.max(0, Math.round((parseDbDate(session.expires_at) - reference) / 1000));
}

// ------------------------------------------------------------ guard helper
function requireLiveSession(sessionId) {
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId);
  if (!session) return { error: 'Assessment session not found.', code: 404 };
  if (session.status === 'SUBMITTED') {
    return { error: 'This assessment is already finalized and cannot be changed.', code: 409 };
  }
  if (session.status !== 'IN_PROGRESS') {
    return { error: 'This assessment has not been started yet.', code: 409 };
  }
  return { session };
}

function candidateOf(session) {
  return db.prepare('SELECT * FROM candidates WHERE id = ?').get(session.candidate_id);
}

function auditSession(actor, action, session, detail) {
  const c = candidateOf(session);
  audit({
    userName: actor.name,
    role: actor.role,
    action,
    target: c ? c.code : session.candidate_id,
    newValue: { assessmentId: session.id, candidate: c ? c.code : null, ...detail },
    ip: actor.ip || null,
  });
}

// ------------------------------------------------------------------ PAUSE
function pauseSession(sessionId, actor) {
  const guard = requireLiveSession(sessionId);
  if (guard.error) return guard;
  if (isPaused(guard.session)) return { error: 'This assessment is already paused.', code: 409 };

  const at = nowIso();
  const run = db.transaction(() => {
    const changed = db.prepare(
      `UPDATE assessment_sessions SET paused_at = ?, paused_by = ?
        WHERE id = ? AND status = 'IN_PROGRESS' AND paused_at IS NULL`
    ).run(at, actor.name, sessionId);
    if (changed.changes === 0) return null;
    return db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId);
  });
  const session = run();
  if (!session) return { error: 'This assessment could not be paused; it may have just been submitted.', code: 409 };

  auditSession(actor, 'EXAM_PAUSED', session, {
    pausedAt: at,
    remainingSecondsAtPause: remainingSeconds(session),
    policy: PAUSE_POLICY,
  });
  return { session, remainingSeconds: remainingSeconds(session) };
}

// ----------------------------------------------------------------- RESUME
function resumeSession(sessionId, actor) {
  const guard = requireLiveSession(sessionId);
  if (guard.error) return guard;
  if (!isPaused(guard.session)) return { error: 'This assessment is not paused.', code: 409 };

  const run = db.transaction(() => {
    const current = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId);
    if (!current || !current.paused_at) return null;
    // Credit back exactly the time spent paused.
    const pausedSeconds = Math.max(0, Math.round((Date.now() - parseDbDate(current.paused_at)) / 1000));
    const newExpiry = isoPlusSeconds(current.expires_at, pausedSeconds);
    db.prepare(
      `UPDATE assessment_sessions
          SET paused_at = NULL, paused_by = NULL,
              total_paused_seconds = total_paused_seconds + ?,
              expires_at = ?
        WHERE id = ?`
    ).run(pausedSeconds, newExpiry, sessionId);
    return { session: db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId), pausedSeconds };
  });

  const result = run();
  if (!result) return { error: 'This assessment is not paused.', code: 409 };

  auditSession(actor, 'EXAM_RESUMED', result.session, {
    pausedForSeconds: result.pausedSeconds,
    newScheduledEndAt: result.session.expires_at,
    totalPausedSeconds: result.session.total_paused_seconds,
    policy: PAUSE_POLICY,
  });
  return { session: result.session, pausedSeconds: result.pausedSeconds, remainingSeconds: remainingSeconds(result.session) };
}

// ------------------------------------------------------- CHANGE EXAM TIME
/**
 * Set a new total duration measured from when the candidate started.
 * Distinct from extendExamTime, which adds to the existing deadline.
 */
function changeExamTime(sessionId, newDurationMinutes, actor) {
  const minutes = Number(newDurationMinutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) {
    return { error: 'Duration must be between 1 and 600 minutes.', code: 400 };
  }
  const guard = requireLiveSession(sessionId);
  if (guard.error) return guard;
  const session = guard.session;
  if (!session.started_at) return { error: 'This assessment has not started yet.', code: 409 };

  const previous = session.expires_at;
  // Measured from the start, plus any time already credited back by pauses, so
  // changing the duration never silently swallows a pause.
  const newExpiry = isoPlusSeconds(session.started_at, minutes * 60 + (session.total_paused_seconds || 0));

  db.prepare(
    `UPDATE assessment_sessions
        SET expires_at = ?, duration_minutes = ?,
            original_expires_at = COALESCE(original_expires_at, ?),
            time_adjusted_by = ?, time_adjusted_at = ?
      WHERE id = ?`
  ).run(newExpiry, minutes, previous, actor.name, nowIso(), sessionId);

  const updated = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId);
  auditSession(actor, 'EXAM_TIME_CHANGED', updated, {
    previousScheduledEndAt: previous,
    newScheduledEndAt: newExpiry,
    newDurationMinutes: minutes,
  });
  return { session: updated, remainingSeconds: remainingSeconds(updated) };
}

// ------------------------------------------------------- EXTEND EXAM TIME
/** Add minutes to the existing deadline. */
function extendExamTime(sessionId, addMinutes, actor) {
  const minutes = Number(addMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) {
    return { error: 'Extension must be between 1 and 240 minutes.', code: 400 };
  }
  const guard = requireLiveSession(sessionId);
  if (guard.error) return guard;
  const session = guard.session;

  const previous = session.expires_at;
  const newExpiry = isoPlusSeconds(previous, minutes * 60);
  db.prepare(
    `UPDATE assessment_sessions
        SET expires_at = ?,
            duration_minutes = duration_minutes + ?,
            original_expires_at = COALESCE(original_expires_at, ?),
            time_adjusted_by = ?, time_adjusted_at = ?
      WHERE id = ?`
  ).run(newExpiry, minutes, previous, actor.name, nowIso(), sessionId);

  const updated = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId);
  auditSession(actor, 'EXAM_TIME_EXTENDED', updated, {
    addedMinutes: minutes,
    previousScheduledEndAt: previous,
    newScheduledEndAt: newExpiry,
  });
  return { session: updated, remainingSeconds: remainingSeconds(updated) };
}

// -------------------------------------------------------------- TERMINATE
/**
 * Immediately lock the assessment. Delegates to the one finalizer so the marks,
 * integrity record and answer counts are produced exactly as for any other
 * ending, and so it cannot collide with a concurrent submission.
 */
function terminateSession(sessionId, actor, note) {
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(sessionId);
  if (!session) return { error: 'Assessment session not found.', code: 404 };
  if (session.status === 'SUBMITTED') {
    return { error: 'This assessment is already finalized.', code: 409 };
  }
  if (session.status !== 'IN_PROGRESS') {
    return { error: 'This assessment has not been started yet.', code: 409 };
  }

  const { finalizeSession } = require('./finalize');
  const result = finalizeSession(sessionId, {
    type: 'TERMINATED',
    reason: 'TERMINATED_BY_ADMIN',
    ip: actor.ip,
    actorName: actor.name,
  });
  if (!result.finalized && result.alreadyFinalized) {
    return { error: 'This assessment was finalized a moment ago by another action.', code: 409 };
  }

  auditSession(actor, 'EXAM_TERMINATED', result.session, {
    note: note || null,
    answered: result.counts ? result.counts.answered : null,
    unanswered: result.counts ? result.counts.unanswered : null,
    terminatedAt: result.submittedAt,
  });
  return { session: result.session, counts: result.counts };
}

// ------------------------------------------------------------------ LINKS
function getLink(linkId) {
  return db.prepare('SELECT * FROM assessment_links WHERE id = ?').get(linkId);
}

function disableLink(linkId, actor) {
  const link = getLink(linkId);
  if (!link) return { error: 'Link not found.', code: 404 };
  if (link.status === 'REVOKED') return { error: 'This link has been revoked and cannot be disabled.', code: 409 };
  if (link.disabled_at) return { error: 'This link is already disabled.', code: 409 };
  db.prepare('UPDATE assessment_links SET disabled_at = ?, disabled_by = ? WHERE id = ?').run(nowIso(), actor.name, linkId);
  const updated = getLink(linkId);
  audit({ userName: actor.name, role: actor.role, action: 'LINK_DISABLED', target: linkId,
    newValue: { candidateId: link.candidate_id, status: linkLiveStatus(updated) }, ip: actor.ip });
  return { link: updated, status: linkLiveStatus(updated) };
}

function enableLink(linkId, actor) {
  const link = getLink(linkId);
  if (!link) return { error: 'Link not found.', code: 404 };
  if (link.status === 'REVOKED') return { error: 'A revoked link cannot be re-enabled. Generate a new link instead.', code: 409 };
  if (!link.disabled_at) return { error: 'This link is not disabled.', code: 409 };
  if (link.expires_at && parseDbDate(link.expires_at) < new Date()) {
    return { error: 'This link has already expired. Extend its expiry or generate a new link.', code: 409 };
  }
  db.prepare('UPDATE assessment_links SET disabled_at = NULL, disabled_by = NULL WHERE id = ?').run(linkId);
  const updated = getLink(linkId);
  audit({ userName: actor.name, role: actor.role, action: 'LINK_ENABLED', target: linkId,
    newValue: { candidateId: link.candidate_id, status: linkLiveStatus(updated) }, ip: actor.ip });
  return { link: updated, status: linkLiveStatus(updated) };
}

function extendLinkExpiry(linkId, addMinutes, actor) {
  const minutes = Number(addMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
    return { error: 'Extension must be between 1 and 1440 minutes.', code: 400 };
  }
  const link = getLink(linkId);
  if (!link) return { error: 'Link not found.', code: 404 };
  if (link.status === 'REVOKED') return { error: 'A revoked link cannot be extended.', code: 409 };
  if (link.status === 'USED') return { error: 'This link has already been used to start an assessment.', code: 409 };

  // Extend from now if it already lapsed, otherwise from its own deadline, so
  // an extension always yields a genuinely usable window.
  const base = parseDbDate(link.expires_at) > new Date() ? link.expires_at : nowIso();
  const newExpiry = isoPlusSeconds(base, minutes * 60);
  db.prepare('UPDATE assessment_links SET expires_at = ?, expiry_extended_by = ?, expiry_extended_at = ? WHERE id = ?')
    .run(newExpiry, actor.name, nowIso(), linkId);
  const updated = getLink(linkId);
  audit({ userName: actor.name, role: actor.role, action: 'LINK_EXPIRY_EXTENDED', target: linkId,
    newValue: { candidateId: link.candidate_id, addedMinutes: minutes, previousExpiresAt: link.expires_at, newExpiresAt: newExpiry }, ip: actor.ip });
  return { link: updated, status: linkLiveStatus(updated) };
}

// How many questions ONE sitting contains: the set it was actually given when
// it has one, otherwise the assessment it was issued for, otherwise the
// recruitment bank — which is what this was before either existed.
function questionCountForSession(sessionId, assessmentId) {
  const drawn = db.prepare('SELECT COUNT(*) AS n FROM session_questions WHERE session_id = ?').get(sessionId).n;
  if (drawn) return drawn;
  if (assessmentId) {
    const attached = db.prepare(
      `SELECT COUNT(*) AS n FROM assessment_questions aq JOIN questions q ON q.id = aq.question_id
        WHERE aq.assessment_id = ? AND q.active = 1 AND COALESCE(q.archived,0) = 0`
    ).get(assessmentId).n;
    if (attached) return attached;
  }
  return db.prepare("SELECT COUNT(*) AS n FROM questions WHERE active = 1 AND question_family = 'GENERAL'").get().n;
}

// --------------------------------------------------------- LIVE DASHBOARD
/** Everything Admin -> Live Assessments needs, in one query per session. */
function liveAssessments() {
  const sessions = db.prepare(
    `SELECT s.*, c.code, c.full_name, c.archived
       FROM assessment_sessions s
       JOIN candidates c ON c.id = s.candidate_id
      WHERE s.status = 'IN_PROGRESS'
      ORDER BY s.started_at DESC`
  ).all();

  return sessions.map((s) => {
    const totalQuestions = questionCountForSession(s.id, s.assessment_id);
    const answered = db.prepare(
      `SELECT COUNT(*) AS n FROM candidate_answers
        WHERE session_id = ? AND answer_json IS NOT NULL AND answer_json NOT IN ('{}','null','')`
    ).get(s.id).n;
    const lastActivity = db.prepare(
      'SELECT MAX(COALESCE(last_modified_at, started_at)) AS t FROM candidate_answers WHERE session_id = ?'
    ).get(s.id).t;
    const link = s.link_id ? getLink(s.link_id) : null;
    const integrity = db.prepare('SELECT risk_level FROM integrity_assessments WHERE session_id = ?').get(s.id);
    const status = sessionLiveStatus(s);
    return {
      sessionId: s.id,
      candidateId: s.candidate_id,
      candidateCode: s.code,
      candidateName: s.full_name,
      startedAt: s.started_at,
      scheduledEndAt: s.expires_at,
      remainingSeconds: remainingSeconds(s),
      durationMinutes: s.duration_minutes,
      totalPausedSeconds: s.total_paused_seconds || 0,
      answered,
      totalQuestions,
      progressPercent: totalQuestions ? Math.round((answered / totalQuestions) * 100) : 0,
      status,
      linkId: link ? link.id : null,
      linkStatus: link ? linkLiveStatus(link) : null,
      integrityRisk: integrity ? integrity.risk_level : 'Low',
      lastActivityAt: lastActivity || s.started_at,
      pausedAt: s.paused_at || null,
      pausedBy: s.paused_by || null,
      timeAdjustedBy: s.time_adjusted_by || null,
      // Only the actions that make sense for the current state.
      availableActions: status === 'PAUSED'
        ? ['VIEW', 'RESUME', 'CHANGE_TIME', 'EXTEND_TIME', 'TERMINATE', 'DISABLE_LINK']
        : ['VIEW', 'PAUSE', 'CHANGE_TIME', 'EXTEND_TIME', 'TERMINATE', 'DISABLE_LINK'],
    };
  });
}

module.exports = {
  PAUSE_POLICY,
  linkLiveStatus,
  sessionLiveStatus,
  isPaused,
  remainingSeconds,
  pauseSession,
  resumeSession,
  changeExamTime,
  extendExamTime,
  terminateSession,
  disableLink,
  enableLink,
  extendLinkExpiry,
  liveAssessments,
};
