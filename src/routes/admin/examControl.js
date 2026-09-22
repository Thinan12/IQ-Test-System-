// Admin -> Live Assessments, plus link and exam-time control.
//
// Every route is authenticated and role-guarded, every mutation is audited,
// and every decision is made from the database — never from anything the
// candidate's browser reports.
const express = require('express');
const db = require('../../db');
const { requireAuth, requireRole } = require('../../middleware/auth');
const ctl = require('../../lib/examControl');

const router = express.Router();
router.use(requireAuth);

// Who may control a live exam. Recruiters and Interviewers deliberately cannot.
const CONTROLLERS = ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER'];

function actorFrom(req) {
  return { id: req.user.id, name: req.user.name, role: req.user.role, ip: req.ip };
}

// Turns the { error, code } shape the control library returns into a response.
function send(res, result, extra) {
  if (result && result.error) return res.status(result.code || 400).json({ error: result.error });
  return res.json(Object.assign({ ok: true }, extra || {}, result ? {
    status: result.session ? ctl.sessionLiveStatus(result.session) : result.status,
    remainingSeconds: result.remainingSeconds,
    scheduledEndAt: result.session ? result.session.expires_at : undefined,
  } : {}));
}

// ------------------------------------------------------- Live assessments
router.get('/live', (req, res) => {
  res.json({ assessments: ctl.liveAssessments(), pausePolicy: ctl.PAUSE_POLICY });
});

// --------------------------------------------------------- Exam time / state
router.post('/sessions/:id/pause', requireRole(...CONTROLLERS), (req, res) => {
  send(res, ctl.pauseSession(req.params.id, actorFrom(req)));
});

router.post('/sessions/:id/resume', requireRole(...CONTROLLERS), (req, res) => {
  const result = ctl.resumeSession(req.params.id, actorFrom(req));
  send(res, result, result && result.pausedSeconds != null ? { pausedSeconds: result.pausedSeconds } : {});
});

// Set a NEW total duration, measured from when the candidate started.
router.post('/sessions/:id/change-time', requireRole(...CONTROLLERS), (req, res) => {
  send(res, ctl.changeExamTime(req.params.id, (req.body || {}).durationMinutes, actorFrom(req)));
});

// ADD minutes to the existing deadline.
router.post('/sessions/:id/extend-time', requireRole(...CONTROLLERS), (req, res) => {
  send(res, ctl.extendExamTime(req.params.id, (req.body || {}).addMinutes, actorFrom(req)));
});

router.post('/sessions/:id/terminate', requireRole(...CONTROLLERS), (req, res) => {
  const result = ctl.terminateSession(req.params.id, actorFrom(req), (req.body || {}).note);
  send(res, result, result && result.counts ? { answered: result.counts.answered, unanswered: result.counts.unanswered } : {});
});

router.get('/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM assessment_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Assessment session not found.' });
  const link = session.link_id ? db.prepare('SELECT * FROM assessment_links WHERE id = ?').get(session.link_id) : null;
  res.json({
    session: {
      ...session,
      liveStatus: ctl.sessionLiveStatus(session),
      remainingSeconds: ctl.remainingSeconds(session),
      linkStatus: link ? ctl.linkLiveStatus(link) : null,
    },
  });
});

// ------------------------------------------------------------------ Links
const LINK_CONTROLLERS = ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'];

router.post('/links/:id/disable', requireRole(...LINK_CONTROLLERS), (req, res) => {
  send(res, ctl.disableLink(req.params.id, actorFrom(req)));
});

router.post('/links/:id/enable', requireRole(...LINK_CONTROLLERS), (req, res) => {
  send(res, ctl.enableLink(req.params.id, actorFrom(req)));
});

router.post('/links/:id/extend', requireRole(...LINK_CONTROLLERS), (req, res) => {
  send(res, ctl.extendLinkExpiry(req.params.id, (req.body || {}).addMinutes, actorFrom(req)));
});

module.exports = router;
