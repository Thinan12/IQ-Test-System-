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

const sessionColumns = db.prepare('PRAGMA table_info(assessment_sessions)').all();
if (!sessionColumns.some((c) => c.name === 'google_sync_status')) {
  db.exec("ALTER TABLE assessment_sessions ADD COLUMN google_sync_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED'");
}

// Ensure singleton config rows exist
db.prepare(`INSERT OR IGNORE INTO eligibility_rules (id) VALUES (1)`).run();
db.prepare(`INSERT OR IGNORE INTO settings (id) VALUES (1)`).run();

module.exports = db;
