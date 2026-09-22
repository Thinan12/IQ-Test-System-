// Google Sheets is an HR *reporting / export destination only*.
// SQLite remains the authoritative transactional database: nothing written here
// is ever read back into the application, and every failure path is non-fatal.
//
// Credentials live in server-side environment variables and are NEVER sent to a
// browser — the only thing the admin UI is told is the boolean from
// isGoogleSyncConfigured().
const db = require('../db');
const sheetData = require('./sheetData');

const LARGE_PASTE_CHARS = 500;

function isGoogleSyncConfigured() {
  return !!(
    process.env.GOOGLE_SHEET_ID &&
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  );
}

// Whether a submitted assessment should attempt an automatic sync (§14).
// Off by default: the exam must never depend on Google being reachable.
function isAutoSyncEnabled() {
  return isGoogleSyncConfigured() && String(process.env.GOOGLE_SYNC_ON_SUBMIT || '').toLowerCase() === 'true';
}

function includeDemoRows() {
  return String(process.env.GOOGLE_SYNC_INCLUDE_DEMO || '').toLowerCase() === 'true';
}

function getGoogleClient() {
  if (!isGoogleSyncConfigured()) return null;
  const { google } = require('googleapis');
  const privateKey = String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function buildAllSheets() {
  const includeDemo = includeDemoRows();
  return [
    sheetData.buildCandidatesSheet(includeDemo),
    sheetData.buildApplicationsSheet(includeDemo),
    sheetData.buildAssessmentResultsSheet(includeDemo),
    sheetData.buildQuestionResultsSheet(includeDemo),
    sheetData.buildInterviewResultsSheet(includeDemo),
    sheetData.buildIntegritySheet(includeDemo, LARGE_PASTE_CHARS),
    sheetData.buildAuditSummarySheet(),
  ];
}

async function ensureSheetExists(sheets, spreadsheetId, sheetName, knownTitles) {
  if (knownTitles.includes(sheetName)) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });
  knownTitles.push(sheetName);
}

async function writeSheet(sheets, spreadsheetId, sheet, knownTitles) {
  await ensureSheetExists(sheets, spreadsheetId, sheet.name, knownTitles);
  // Clear first, so a shrinking data set never leaves stale rows behind.
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${sheet.name}'` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheet.name}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [sheet.headers, ...sheet.rows] },
  });
}

function errText(error) {
  if (!error) return 'unknown error';
  if (error.response && error.response.data && error.response.data.error) {
    const e = error.response.data.error;
    return e.message || JSON.stringify(e);
  }
  return error.message || String(error);
}

// One sync at a time — a submit-triggered sync and an admin-triggered sync must
// not interleave writes into the same workbook.
let syncInFlight = null;

/**
 * Rebuild the whole HR reporting workbook from SQLite.
 * Never throws: callers get a summary object and decide what to do with it.
 */
async function syncAllGoogleSheets() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function runSync() {
  const empty = { candidates: 0, assessments: 0, questions: 0, interviews: 0, integrity: 0 };
  if (!isGoogleSyncConfigured()) {
    return {
      ok: false, configured: false, errors: 1, ...empty,
      message: 'Google Sheets sync is not configured on this server. Set GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.',
    };
  }

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  let built;
  try {
    built = buildAllSheets();
  } catch (error) {
    return { ok: false, configured: true, errors: 1, ...empty, message: 'Could not build report data: ' + errText(error) };
  }

  const byName = {};
  built.forEach((s) => { byName[s.name] = s; });
  const counts = {
    candidates: byName['Candidates'].rows.length,
    assessments: byName['Assessment Results'].rows.length,
    questions: byName['Question Results'].rows.length,
    interviews: byName['Interview Results'].rows.length,
    integrity: byName['Integrity Events'].rows.length,
  };

  try {
    const { google } = require('googleapis');
    const sheets = google.sheets({ version: 'v4', auth: getGoogleClient() });
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const knownTitles = (meta.data.sheets || []).map((s) => s.properties.title);

    const failures = [];
    for (const sheet of built) {
      try {
        await writeSheet(sheets, spreadsheetId, sheet, knownTitles);
      } catch (error) {
        failures.push(`${sheet.name}: ${errText(error)}`);
      }
    }

    if (failures.length) {
      return {
        ok: false, configured: true, errors: failures.length, ...counts, failures,
        message: `Google Sheets sync finished with ${failures.length} error(s): ${failures.join('; ')}`,
      };
    }

    return {
      ok: true, configured: true, errors: 0, ...counts,
      syncedAt: new Date().toISOString(),
      message: `Candidates synced: ${counts.candidates}. Assessments synced: ${counts.assessments}. `
        + `Questions synced: ${counts.questions}. Interviews synced: ${counts.interviews}. Errors: 0.`,
    };
  } catch (error) {
    return {
      ok: false, configured: true, errors: 1, ...counts,
      message: 'Google Sheets is unavailable: ' + errText(error),
    };
  }
}

/** Sessions whose result has not yet reached Google Sheets (§15). */
function pendingSyncSessions() {
  return db.prepare(
    `SELECT s.id, s.submitted_at, c.code, c.full_name
       FROM assessment_sessions s
       JOIN candidates c ON c.id = s.candidate_id
      WHERE s.google_sync_status = 'PENDING'
      ORDER BY COALESCE(s.submitted_at, '') DESC`
  ).all();
}

function markSessionSync(sessionId, status) {
  db.prepare('UPDATE assessment_sessions SET google_sync_status = ? WHERE id = ?').run(status, sessionId);
}

/**
 * Retry every assessment left in google_sync_status='PENDING'.
 * The workbook is rebuilt in full, so one successful sync clears all of them.
 */
async function syncPendingGoogleSheets() {
  const pending = pendingSyncSessions();
  const result = await syncAllGoogleSheets();
  if (result.ok) {
    const clear = db.transaction((ids) => ids.forEach((id) => markSessionSync(id, 'SYNCED')));
    clear(pending.map((p) => p.id));
  }
  return { ...result, pendingBefore: pending.length, pendingAfter: result.ok ? 0 : pending.length };
}

/**
 * Called right after a candidate submits. Fire-and-forget: it never blocks or
 * fails the candidate's submission. On any failure the session stays at
 * google_sync_status='PENDING' so an administrator can retry later.
 */
function syncSessionInBackground(sessionId) {
  if (!isAutoSyncEnabled()) return;
  setImmediate(async () => {
    try {
      const result = await syncAllGoogleSheets();
      markSessionSync(sessionId, result.ok ? 'SYNCED' : 'PENDING');
      if (!result.ok) console.warn('[google-sheets] auto-sync deferred for session %s: %s', sessionId, result.message);
    } catch (error) {
      markSessionSync(sessionId, 'PENDING');
      console.warn('[google-sheets] auto-sync failed for session %s: %s', sessionId, errText(error));
    }
  });
}

module.exports = {
  isGoogleSyncConfigured,
  isAutoSyncEnabled,
  syncAllGoogleSheets,
  syncPendingGoogleSheets,
  syncSessionInBackground,
  pendingSyncSessions,
  markSessionSync,
  buildAllSheets,
};
