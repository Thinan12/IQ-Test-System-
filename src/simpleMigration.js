const db = require('./db');

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Fields used by the simplified self-registration flow.
ensureColumn('candidates', 'id_number', 'TEXT');
ensureColumn('assessment_links', 'self_registration', 'INTEGER NOT NULL DEFAULT 0');

module.exports = db;
