// Candidate data lifecycle: statistics, demo fixtures, and the Super Admin
// "delete all candidate data" operation.
//
// What is deleted here is ONLY candidate-generated data. Configuration and
// institutional records are never touched:
//   users, roles/permissions, questions + answer keys, marking rules,
//   eligibility_rules, settings, departments, branches, positions,
//   interview_questions, interview_criteria, scholarship_policies, audit_logs.
const db = require('../db');
const { generateId } = require('./tokens');

// Tables holding candidate-generated data, in FK-safe deletion order.
// assessment_sessions must go before assessment_links (sessions reference links).
const CANDIDATE_DATA_TABLES = [
  { table: 'answer_events', via: 'session' },
  { table: 'candidate_answers', via: 'session' },
  { table: 'scores', via: 'session' },
  { table: 'integrity_assessments', via: 'session' },
  { table: 'integrity_reviews', via: 'session' },
  { table: 'link_access_log', via: 'link' },
  { table: 'assessment_sessions', via: 'candidate' },
  { table: 'assessment_links', via: 'candidate' },
  { table: 'candidates', via: 'self' },
];

// Tables that must survive every deletion. Used by the verification tooling.
const PROTECTED_TABLES = [
  'users', 'questions', 'interview_questions', 'interview_criteria', 'eligibility_rules',
  'settings', 'departments', 'branches', 'positions', 'scholarship_policies', 'audit_logs',
];

function getDataStats() {
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;
  return {
    totalCandidates: one('SELECT COUNT(*) AS n FROM candidates'),
    activeAssessments: one("SELECT COUNT(*) AS n FROM assessment_sessions WHERE status = 'IN_PROGRESS'"),
    completedAssessments: one("SELECT COUNT(*) AS n FROM assessment_sessions WHERE status = 'SUBMITTED'"),
    passed: one('SELECT COUNT(*) AS n FROM scores WHERE pass = 1'),
    failed: one('SELECT COUNT(*) AS n FROM scores WHERE pass = 0'),
    pending: one("SELECT COUNT(*) AS n FROM candidates WHERE status NOT IN ('PASSED','FAILED','SCHOLARSHIP_SELECTED','REJECTED','HIRED','WITHDRAWN')"),
    demoCandidates: one('SELECT COUNT(*) AS n FROM candidates WHERE is_demo = 1'),
    realCandidates: one('SELECT COUNT(*) AS n FROM candidates WHERE is_demo = 0'),
    answersStored: one('SELECT COUNT(*) AS n FROM candidate_answers'),
    googleSyncPending: one("SELECT COUNT(*) AS n FROM assessment_sessions WHERE google_sync_status = 'PENDING'"),
    auditRecords: one('SELECT COUNT(*) AS n FROM audit_logs'),
    questionsInBank: one('SELECT COUNT(*) AS n FROM questions'),
    adminUsers: one('SELECT COUNT(*) AS n FROM users'),
  };
}

// Stage the candidates to remove in a temp table. This avoids SQLite's bound
// parameter limit entirely, and keeps every subsequent DELETE inside the same
// transaction working off one consistent target list.
function stageTargets(options) {
  const demoOnly = !!(options && options.demoOnly);
  const candidateIds = options && Array.isArray(options.candidateIds) ? options.candidateIds : null;
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _delete_targets (candidate_id TEXT PRIMARY KEY)');
  db.exec('DELETE FROM _delete_targets');
  if (candidateIds) {
    // An explicit set (e.g. deleting one candidate). Inserted row by row so the
    // number of ids can never hit SQLite's bound-parameter limit.
    const insert = db.prepare('INSERT OR IGNORE INTO _delete_targets (candidate_id) VALUES (?)');
    candidateIds.forEach((id) => insert.run(id));
    return;
  }
  db.exec(
    'INSERT INTO _delete_targets (candidate_id) SELECT id FROM candidates' + (demoOnly ? ' WHERE is_demo = 1' : '')
  );
}

function scopeClause(via) {
  if (via === 'self') return 'id IN (SELECT candidate_id FROM _delete_targets)';
  if (via === 'candidate') return 'candidate_id IN (SELECT candidate_id FROM _delete_targets)';
  if (via === 'session') {
    return 'session_id IN (SELECT id FROM assessment_sessions WHERE candidate_id IN (SELECT candidate_id FROM _delete_targets))';
  }
  // link_access_log
  return 'link_id IN (SELECT id FROM assessment_links WHERE candidate_id IN (SELECT candidate_id FROM _delete_targets))';
}

function countStagedRows() {
  const counts = {};
  CANDIDATE_DATA_TABLES.forEach(({ table, via }) => {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${scopeClause(via)}`).get().n;
  });
  return counts;
}

/**
 * Delete candidate data in ONE transaction. If anything throws, better-sqlite3
 * rolls the whole thing back — there is no partially deleted candidate.
 *
 * @param {{demoOnly?: boolean, candidateIds?: string[]}} options
 * @returns {{candidates, assessments, answers, links, scores, integrityEvents, byTable}}
 */
function deleteCandidateData(options = {}) {
  const run = db.transaction(() => {
    stageTargets(options);
    const before = countStagedRows();
    // Reverse order is not needed: CANDIDATE_DATA_TABLES is already FK-safe,
    // but the target list itself is a snapshot so ordering stays stable.
    CANDIDATE_DATA_TABLES.forEach(({ table, via }) => {
      db.prepare(`DELETE FROM ${table} WHERE ${scopeClause(via)}`).run();
    });
    db.exec('DELETE FROM _delete_targets');
    return before;
  });

  const before = run();
  return {
    candidates: before.candidates,
    assessments: before.assessment_sessions,
    answers: before.candidate_answers,
    links: before.assessment_links,
    scores: before.scores,
    integrityEvents: before.answer_events,
    byTable: before,
  };
}

/** What a deletion *would* remove, without removing it. */
function previewDeletion(options = {}) {
  const run = db.transaction(() => {
    stageTargets(options);
    const counts = countStagedRows();
    db.exec('DELETE FROM _delete_targets');
    return counts;
  });
  const counts = run();
  return {
    candidates: counts.candidates,
    assessments: counts.assessment_sessions,
    answers: counts.candidate_answers,
    links: counts.assessment_links,
    byTable: counts,
  };
}

/**
 * Candidate codes must stay unique for the lifetime of the database, including
 * after demo candidates are deleted and re-created. Counting rows is not enough
 * (a delete would make the next code collide), so derive the next sequence
 * number from the highest code already issued for this prefix.
 */
function nextCandidateCode(prefix) {
  const year = new Date().getFullYear();
  const stem = `${prefix}-${year}-`;
  const rows = db.prepare('SELECT code FROM candidates WHERE code LIKE ?').all(stem + '%');
  let highest = 0;
  rows.forEach((r) => {
    const n = parseInt(String(r.code).slice(stem.length), 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  });
  // Defensive: if a code was issued and later removed mid-loop, keep probing.
  let next = highest + 1;
  const exists = db.prepare('SELECT 1 FROM candidates WHERE code = ?');
  while (exists.get(stem + String(next).padStart(5, '0'))) next += 1;
  return stem + String(next).padStart(5, '0');
}

const DEMO_NAMES = [
  'Akeo Demo Candidate', 'Bounmy Demo Candidate', 'Chanh Demo Candidate', 'Dala Demo Candidate',
  'Seng Demo Candidate', 'Vanh Demo Candidate', 'Khamla Demo Candidate', 'Phout Demo Candidate',
  'Souk Demo Candidate', 'Thida Demo Candidate',
];

/**
 * Demo candidates are ordinary, fully functional candidate records flagged
 * is_demo = 1. They are never mixed into production reporting (the Google
 * Sheets sync excludes them unless GOOGLE_SYNC_INCLUDE_DEMO=true) and can be
 * wiped independently of real candidates.
 */
function createDemoCandidates(count, recruiterId) {
  const n = Math.max(1, Math.min(10, Number(count) || 5));
  const created = [];
  const insert = db.prepare(
    `INSERT INTO candidates (id, code, full_name, gender, phone, email, education, university, major, gpa, iq,
       application_type, application_date, recruiter_id, status, is_demo)
     VALUES (@id,@code,@fullName,@gender,@phone,@email,@education,@university,@major,@gpa,@iq,
       @applicationType,@applicationDate,@recruiterId,'DRAFT',1)`
  );
  const run = db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      const name = DEMO_NAMES[i % DEMO_NAMES.length];
      const id = generateId('cand');
      const code = nextCandidateCode('DEMO');
      const applicationType = i % 2 === 0 ? 'NORMAL' : 'SCHOLARSHIP';
      // Deliberately eligible under the default rules (IQ > 100, and for
      // scholarship: university education with GPA > 3.0) so a demo candidate
      // can be driven end-to-end without editing eligibility settings.
      insert.run({
        id,
        code,
        fullName: `${name} ${code.slice(-3)}`,
        gender: i % 2 === 0 ? 'Male' : 'Female',
        phone: '020' + String(55000000 + i),
        email: `${code.toLowerCase()}@demo.invalid`,
        education: 'Bachelor Degree',
        university: 'Demo University',
        major: 'Business',
        gpa: Math.round((3.2 + (i % 4) * 0.2) * 100) / 100,
        iq: 105 + (i % 6),
        applicationType,
        applicationDate: new Date().toISOString().slice(0, 10),
        recruiterId: recruiterId || null,
      });
      created.push({ id, code });
    }
  });
  run();
  return created;
}

module.exports = {
  CANDIDATE_DATA_TABLES,
  PROTECTED_TABLES,
  getDataStats,
  deleteCandidateData,
  previewDeletion,
  createDemoCandidates,
  nextCandidateCode,
};
