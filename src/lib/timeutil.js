// SQLite's datetime('now') writes 'YYYY-MM-DD HH:MM:SS' — UTC, but with no
// timezone marker. JavaScript's Date parses that shape as LOCAL time, so on a
// UTC+7 server every such timestamp silently shifts by seven hours: links look
// like they were created in the future, durations come out wrong, and a
// deadline can even land in the past.
//
// The app writes ISO strings with a 'Z' in most places, but 14 columns default
// to SQLite's datetime(). Anything converting a stored timestamp into a Date
// must go through parseDbDate so both shapes mean the same instant.
function parseDbDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  // Bare SQLite/ISO datetime with no timezone marker -> it is UTC.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    return new Date(s.replace(' ', 'T') + 'Z');
  }
  return new Date(s);
}

/** Milliseconds since the epoch for a stored timestamp, or NaN. */
function dbTime(value) {
  const d = parseDbDate(value);
  return d ? d.getTime() : NaN;
}

/** Normalise any stored timestamp to an unambiguous ISO-8601 UTC string. */
function toIso(value) {
  const d = parseDbDate(value);
  return d ? d.toISOString() : null;
}

module.exports = { parseDbDate, dbTime, toIso };
