const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'lalco.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Additive migrations for databases created before a column existed.
// CREATE TABLE IF NOT EXISTS cannot add columns, so each one is applied here.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Question flags (Phase 3). Additive: an existing answer row is simply not
// flagged. No answer, score, timing or ordering column is touched.
ensureColumn('candidate_answers', 'flagged', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('candidate_answers', 'flagged_at', 'TEXT');
ensureColumn('candidate_answers', 'flag_changed_at', 'TEXT');

ensureColumn('assessment_sessions', 'google_sync_status', "TEXT NOT NULL DEFAULT 'NOT_REQUESTED'");
// How the assessment was finalized. NULL on rows finalized before this existed.
ensureColumn('assessment_sessions', 'submission_type', 'TEXT');
ensureColumn('assessment_sessions', 'submission_reason', 'TEXT');
ensureColumn('assessment_sessions', 'answered_count', 'INTEGER');
ensureColumn('assessment_sessions', 'unanswered_count', 'INTEGER');

// Bilingual question bank. Every column is additive and nullable, so existing
// questions keep their IDs, English text, answer keys, marking rules and
// history untouched. Lao stays empty until a human enters and approves it —
// nothing is auto-translated.
ensureColumn('questions', 'text_lo', 'TEXT');
ensureColumn('questions', 'config_lo_json', 'TEXT');
ensureColumn('questions', 'translation_status', "TEXT NOT NULL DEFAULT 'MISSING'");
ensureColumn('questions', 'translation_updated_by', 'TEXT');
ensureColumn('questions', 'translation_updated_at', 'TEXT');
ensureColumn('questions', 'archived', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('questions', 'archived_at', 'TEXT');
ensureColumn('questions', 'archived_by', 'TEXT');

// Candidate display language for a session. Presentation only.
ensureColumn('assessment_sessions', 'language', "TEXT NOT NULL DEFAULT 'en'");



// Priority 1 — candidate archiving.
ensureColumn('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');

ensureColumn('candidates', 'archived', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('candidates', 'archived_at', 'TEXT');
ensureColumn('candidates', 'archived_by', 'TEXT');

// Priority 2 — link disable / re-enable / expiry extension.
ensureColumn('assessment_links', 'revoked_by', 'TEXT');
ensureColumn('assessment_links', 'disabled_at', 'TEXT');
ensureColumn('assessment_links', 'disabled_by', 'TEXT');
ensureColumn('assessment_links', 'expiry_extended_by', 'TEXT');
ensureColumn('assessment_links', 'expiry_extended_at', 'TEXT');

// Priority 3 — pause / resume / time adjustment.
ensureColumn('assessment_sessions', 'paused_at', 'TEXT');
ensureColumn('assessment_sessions', 'paused_by', 'TEXT');
ensureColumn('assessment_sessions', 'total_paused_seconds', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('assessment_sessions', 'time_adjusted_by', 'TEXT');
ensureColumn('assessment_sessions', 'time_adjusted_at', 'TEXT');
ensureColumn('assessment_sessions', 'original_expires_at', 'TEXT');

// Note: `status` on both tables keeps its original CHECK constraint. Paused
// sessions and disabled links are represented by their own nullable columns
// above, and the status shown to users is computed (see src/lib/examControl.js).
// SQLite cannot alter a CHECK in place, and rebuilding these tables on a live
// database would put real candidate data at risk for no benefit.


// Ensure singleton config rows exist
db.prepare(`INSERT OR IGNORE INTO eligibility_rules (id) VALUES (1)`).run();
db.prepare(`INSERT OR IGNORE INTO settings (id) VALUES (1)`).run();

// ---------------------------------------------------------------------------
// Assessment entity (Phase 2). Runs AFTER the singleton config rows above,
// because an assessment references eligibility_rules(id).
// Additive: links and sessions gain a reference,
// and sessions gain a snapshot of the scoring rules they were judged under.
ensureColumn('assessment_links', 'assessment_id', 'TEXT');
ensureColumn('assessment_sessions', 'assessment_id', 'TEXT');
ensureColumn('assessment_sessions', 'pass_threshold', 'INTEGER');
ensureColumn('assessment_sessions', 'total_max', 'INTEGER');

// Backfill, once, inside a transaction. Before this migration an "assessment"
// was implicit: the active questions plus the `settings` singleton. That exact
// configuration becomes a real, named assessment, and every existing link and
// session is attached to it — so nothing that already happened changes meaning.
const migrateAssessments = db.transaction(() => {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM assessments').get().n;
  if (existing === 0) {
    const cfg = db.prepare('SELECT * FROM settings WHERE id = 1').get() || {};
    const id = 'asmt_default';
    db.prepare(
      `INSERT INTO assessments (id, name, description, active, archived, duration_minutes,
         link_expiry_minutes, calc_max, written_max, interview_max, total_max, pass_threshold,
         eligibility_rules_id, created_by)
       VALUES (?,?,?,1,0,?,?,?,?,?,?,?,1,'System (migration)')`
    ).run(
      id,
      'LALCO Recruitment Assessment',
      'The standard recruitment assessment. Created automatically from the existing configuration so nothing already issued or completed changes meaning.',
      cfg.assessment_duration_minutes != null ? cfg.assessment_duration_minutes : 45,
      cfg.link_expiry_minutes != null ? cfg.link_expiry_minutes : 10,
      30, 30, 40, 100,
      cfg.pass_threshold != null ? cfg.pass_threshold : 70
    );

    // Attach the question set exactly as the exam already serves it.
    const questions = db.prepare(
      `SELECT id FROM questions
        WHERE active = 1 AND COALESCE(archived,0) = 0
        ORDER BY CASE type WHEN 'CALC' THEN 0 ELSE 1 END, order_index`
    ).all();
    const attach = db.prepare('INSERT OR IGNORE INTO assessment_questions (assessment_id, question_id, order_index) VALUES (?,?,?)');
    questions.forEach((q, i) => attach.run(id, q.id, i));
  }

  const defaultId = db.prepare('SELECT id FROM assessments ORDER BY created_at LIMIT 1').get();
  if (defaultId) {
    db.prepare('UPDATE assessment_links SET assessment_id = ? WHERE assessment_id IS NULL').run(defaultId.id);
    db.prepare('UPDATE assessment_sessions SET assessment_id = ? WHERE assessment_id IS NULL').run(defaultId.id);
    // Historical sessions get the threshold they were actually judged under —
    // the only value available is the current one, which is what they were
    // being judged against a moment ago anyway. From now on it is pinned.
    const cfg = db.prepare('SELECT * FROM settings WHERE id = 1').get() || {};
    db.prepare('UPDATE assessment_sessions SET pass_threshold = ? WHERE pass_threshold IS NULL')
      .run(cfg.pass_threshold != null ? cfg.pass_threshold : 70);
    db.prepare('UPDATE assessment_sessions SET total_max = 100 WHERE total_max IS NULL').run();
  }
});
migrateAssessments();

module.exports = db;
