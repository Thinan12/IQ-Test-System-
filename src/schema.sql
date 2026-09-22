-- LALCO Recruitment & Assessment Platform — relational schema (SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN','HR_ADMIN','RECRUITER','INTERVIEWER','EVALUATOR','MANAGER')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Singleton-style config tables (id = 1)
CREATE TABLE IF NOT EXISTS eligibility_rules (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  normal_iq_min INTEGER NOT NULL DEFAULT 80,
  normal_education_min TEXT NOT NULL DEFAULT 'High school graduate',
  scholarship_iq_min INTEGER NOT NULL DEFAULT 100,
  scholarship_education_min TEXT NOT NULL DEFAULT 'College/University graduate',
  scholarship_gpa_min REAL NOT NULL DEFAULT 3.0,
  character_note TEXT NOT NULL DEFAULT 'For reference only',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  org_name TEXT NOT NULL DEFAULT 'Lao Asean Leasing Public Company (LALCO)',
  pass_threshold INTEGER NOT NULL DEFAULT 70,
  link_expiry_minutes INTEGER NOT NULL DEFAULT 10,
  assessment_duration_minutes INTEGER NOT NULL DEFAULT 45,
  max_ltv INTEGER NOT NULL DEFAULT 80,
  require_candidate_id INTEGER NOT NULL DEFAULT 1,
  require_phone INTEGER NOT NULL DEFAULT 0,
  require_dob INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  gender TEXT,
  dob TEXT,
  nationality TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  province TEXT,
  current_location TEXT,
  education TEXT,
  university TEXT,
  major TEXT,
  gpa REAL,
  previous_employer TEXT,
  previous_position TEXT,
  years_experience INTEGER DEFAULT 0,
  expected_salary REAL,
  application_type TEXT NOT NULL CHECK(application_type IN ('NORMAL','SCHOLARSHIP')),
  applied_department_id TEXT REFERENCES departments(id),
  applied_position_id TEXT REFERENCES positions(id),
  branch_id TEXT REFERENCES branches(id),
  application_date TEXT,
  recruitment_batch TEXT,
  recruiter_id TEXT REFERENCES users(id),
  iq INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  is_demo INTEGER NOT NULL DEFAULT 0,
  -- Archived candidates are hidden from the working lists but keep every
  -- record intact; only a Super Admin can delete one permanently.
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  archived_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Question bank. config_json holds the answer key / marking rules and
-- is NEVER sent to the public exam API — only /api/admin routes read it in full.
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('CALC','ESSAY')),
  order_index INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  difficulty TEXT,
  max_marks INTEGER NOT NULL,
  text TEXT NOT NULL,
  config_json TEXT NOT NULL, -- {parts:[{key,label,marks,expected,tol,type,options}]} or {rubric:[...], themeHints:[...]}
  explanation TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interview_questions (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  disqualifying INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS interview_criteria (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  max_marks INTEGER NOT NULL DEFAULT 10,
  hint TEXT,
  order_index INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assessment_links (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','USED','EXPIRED','REVOKED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  created_by TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  -- A link is DISABLED when disabled_at IS NOT NULL while status is still
  -- 'ACTIVE' — disabling is reversible, revoking is not.
  disabled_at TEXT,
  disabled_by TEXT,
  expiry_extended_by TEXT,
  expiry_extended_at TEXT,
  first_access_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_candidate ON assessment_links(candidate_id);

CREATE TABLE IF NOT EXISTS link_access_log (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES assessment_links(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  success INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS assessment_sessions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  link_id TEXT REFERENCES assessment_links(id),
  started_at TEXT,
  duration_minutes INTEGER NOT NULL,
  expires_at TEXT,
  submitted_at TEXT,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK(status IN ('NOT_STARTED','IN_PROGRESS','SUBMITTED')),
  -- Pause policy: the countdown freezes and the time is credited back on
  -- resume, so expires_at is pushed out by exactly the paused duration.
  -- A session is paused when status='IN_PROGRESS' AND paused_at IS NOT NULL;
  -- `status` itself is left alone so every existing query keeps working and no
  -- CHECK constraint has to be rebuilt on a live database.
  paused_at TEXT,
  paused_by TEXT,
  total_paused_seconds INTEGER NOT NULL DEFAULT 0,
  -- Admin adjustments to the deadline, kept for the audit trail.
  time_adjusted_by TEXT,
  time_adjusted_at TEXT,
  original_expires_at TEXT,
  -- `status` stays the lifecycle lock ('SUBMITTED' = finalized, no further writes).
  -- HOW it was finalized is recorded separately so nothing that already keys off
  -- status='SUBMITTED' changes behaviour. The status HR and the candidate are
  -- shown is derived from these two columns (see src/lib/finalize.js).
  submission_type TEXT CHECK(submission_type IN ('MANUAL','AUTO_SUBMITTED','TERMINATED')),
  submission_reason TEXT CHECK(submission_reason IN ('CANDIDATE_SUBMITTED','TIME_EXPIRED','TERMINATED_BY_ADMIN')),
  answered_count INTEGER,
  unanswered_count INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,
  google_sync_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED' CHECK(google_sync_status IN ('NOT_REQUESTED','PENDING','SYNCED'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_candidate ON assessment_sessions(candidate_id);

CREATE TABLE IF NOT EXISTS candidate_answers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id),
  answer_json TEXT,
  started_at TEXT,
  first_answered_at TEXT,
  last_modified_at TEXT,
  submitted_at TEXT,
  time_spent_seconds INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, question_id)
);

CREATE TABLE IF NOT EXISTS answer_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  question_id TEXT,
  type TEXT NOT NULL, -- PASTE / FOCUS_CHANGE / VISIBILITY_CHANGE
  meta_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  calc_marks INTEGER NOT NULL DEFAULT 0,
  calc_max INTEGER NOT NULL DEFAULT 30,
  calc_breakdown_json TEXT,
  essay_marks INTEGER,
  essay_max INTEGER NOT NULL DEFAULT 30,
  essay_breakdown_json TEXT,
  essay_marker TEXT,
  essay_comments TEXT,
  essay_marked_at TEXT,
  interview_marks INTEGER,
  interview_max INTEGER NOT NULL DEFAULT 40,
  interview_breakdown_json TEXT,
  interview_marker TEXT,
  interview_comments TEXT,
  interview_marked_at TEXT,
  final_marks INTEGER,
  percentage REAL,
  pass INTEGER,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS integrity_assessments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  paste_events INTEGER NOT NULL DEFAULT 0,
  focus_changes INTEGER NOT NULL DEFAULT 0,
  largest_paste INTEGER NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'Low',
  evidence_json TEXT,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scholarship_policies (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('CURRENT','PROPOSED')),
  year INTEGER NOT NULL,
  funding TEXT,
  payment_timing TEXT,
  year_to_start INTEGER,
  commitment TEXT,
  UNIQUE(kind, year)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_name TEXT,
  role TEXT,
  action TEXT NOT NULL,
  target TEXT,
  old_value TEXT,
  new_value TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- Human reviewer conclusions about assessment integrity.
-- Machine signals (paste size, focus changes) are only ever *indicators*; a
-- conclusion such as "assistance was used" exists only if a named human
-- reviewer recorded it here.
CREATE TABLE IF NOT EXISTS integrity_reviews (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  conclusion TEXT NOT NULL CHECK(conclusion IN ('NO_CONCERN','INCONCLUSIVE','POTENTIAL_AI_ASSISTANCE_INDICATOR','CONFIRMED_MISCONDUCT')),
  comment TEXT,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
