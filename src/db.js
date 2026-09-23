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

module.exports = db;
