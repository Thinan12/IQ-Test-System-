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

// Ensure singleton config rows exist
db.prepare(`INSERT OR IGNORE INTO eligibility_rules (id) VALUES (1)`).run();
db.prepare(`INSERT OR IGNORE INTO settings (id) VALUES (1)`).run();

module.exports = db;
