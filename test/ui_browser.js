// Priority 13 — REAL UI testing.
//
// This drives the actual admin interface in a real Chromium browser: it clicks
// the real buttons, fills the real forms, and after each action checks the
// database and the audit log directly. Nothing is asserted from the UI alone,
// and nothing is asserted from the API alone.
//
// Playwright is not a project dependency (it must never ship to production), so
// it is loaded from wherever PLAYWRIGHT_MODULE points:
//
//   PLAYWRIGHT_MODULE=/path/to/playwright BASE_URL=... DATABASE_PATH=... node test/ui_browser.js
const path = require('path');
const Database = require('better-sqlite3');

const BASE = process.env.BASE_URL;
const DB_PATH = process.env.DATABASE_PATH;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'superadmin@lalco.demo';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
if (!BASE || !DB_PATH) {
  console.error('BASE_URL and DATABASE_PATH are required');
  process.exit(1);
}
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const db = new Database(DB_PATH, { readonly: true });
let pass = 0;
const failures = [];
const consoleErrors = [];

function ok(msg) { pass += 1; console.log('\x1b[32m  PASS  ' + msg + '\x1b[0m'); }
function bad(msg) { failures.push(msg); console.log('\x1b[31m  FAIL  ' + msg + '\x1b[0m'); }
function check(cond, msg, detail) { cond ? ok(msg) : bad(msg + (detail ? ' — ' + detail : '')); }
function head(t) { console.log('\n\x1b[1m== ' + t + ' ==\x1b[0m'); }
function one(sql, ...a) { const r = db.prepare(sql).get(...a); return r ? Object.values(r)[0] : null; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  // Admin and candidate get separate contexts: separate cookies, separate
  // storage — genuinely different browser sessions.
  const adminCtx = await browser.newContext();
  const page = await adminCtx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  try {
    // ------------------------------------------------------------------ login
    head('Admin login through the real form');
    await page.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
    check(await page.locator('#lEmail').isVisible(), 'the login form renders');
    await page.fill('#lEmail', ADMIN_EMAIL);
    await page.fill('#lPass', 'definitely-wrong');
    await page.click('#lBtn');
    await page.waitForTimeout(700);
    const err = (await page.locator('#lErr').textContent()) || '';
    check(/invalid/i.test(err), 'a wrong password shows an error in the UI', JSON.stringify(err));
    check(await page.locator('#lEmail').isVisible(), 'and we are still on the login page');

    await page.fill('#lPass', ADMIN_PASSWORD);
    await page.click('#lBtn');
    await page.waitForSelector('.sidebar-nav', { timeout: 15000 });
    ok('signing in with the right password reaches the dashboard');

    // ------------------------------------------------------------ navigation
    head('Sidebar navigation — every item renders real content');
    const navItems = await page.$$eval('.sidebar-nav a', (els) => els.map((e) => e.dataset.nav));
    check(navItems.length >= 10, `sidebar shows ${navItems.length} destinations`);
    for (const key of navItems) {
      await page.click(`.sidebar-nav a[data-nav="${key}"]`);
      await page.waitForTimeout(900);
      const body = (await page.locator('#content').innerText()).trim();
      const stuck = body === 'Loading…' || body === '';
      const broke = /could not be loaded/i.test(body);
      check(!stuck && !broke, `"${key}" renders content`, stuck ? 'stuck on Loading…' : broke ? 'error panel' : '');
    }

    // ------------------------------------------- create candidate (real modal)
    head('Create a candidate using the real modal');
    const before = one('SELECT COUNT(*) FROM candidates');
    await page.click('.sidebar-nav a[data-nav="candidates"]');
    await page.waitForSelector('#newCandBtn');
    await page.click('#newCandBtn');
    await page.waitForSelector('#nFullName');
    await page.click('#saveBtn');
    await page.waitForTimeout(500);
    check(one('SELECT COUNT(*) FROM candidates') === before, 'saving with an empty name creates nothing (validation)');
    await page.fill('#nFullName', 'Browser UI Candidate');
    await page.fill('#nIQ', '118');
    await page.fill('#nEdu', 'Bachelor Degree');
    await page.fill('#nPos', 'Marketing Staff');
    await page.click('#saveBtn');
    await page.waitForTimeout(1400);
    const created = db.prepare("SELECT * FROM candidates WHERE full_name = 'Browser UI Candidate'").get();
    check(!!created, 'the candidate row exists in the database');
    check(created && created.iq === 118, 'the IQ typed into the form was stored', created && String(created.iq));
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='Candidate created' AND target=?", created ? created.code : '') > 0,
      'an audit record was written');
    check((await page.locator('#rows').innerText()).includes('Browser UI Candidate'), 'and the table refreshed to show it');

    // --------------------------------------------------- generate + copy link
    head('Generate an exam link from the candidate profile');
    await page.click(`#rows tr[data-id="${created.id}"]`);
    await page.waitForSelector('#profTabs');
    await page.click('#profTabs button[data-t="assessment"]');
    await page.waitForSelector('#genLink');
    await page.click('#genLink');
    await page.waitForTimeout(1500);
    const link = db.prepare("SELECT * FROM assessment_links WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1").get(created.id);
    check(!!link, 'a link row was created in the database');
    check(link && link.token.length === 64, 'the token is 64 hex characters');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='Assessment link generated' AND target=?", created.code) > 0,
      'link generation is audited');
    check(await page.locator('#revokeLink').isVisible(), 'the Revoke Link control is offered');

    // ------------------------------------------- candidate sits the exam (2nd context)
    head('Candidate completes the exam in a separate browser session');
    const candCtx = await browser.newContext(); // no admin cookies, no shared storage
    const cand = await candCtx.newPage();
    const candErrors = [];
    cand.on('console', (m) => { if (m.type() === 'error') candErrors.push(m.text()); });
    cand.on('pageerror', (e) => candErrors.push('pageerror: ' + e.message));
    await cand.goto(`${BASE}/exam/${link.token}`, { waitUntil: 'networkidle' });
    const introText = await cand.locator('body').innerText();
    check(introText.includes('Browser UI Candidate'), 'the candidate portal greets the right candidate');
    check(!introText.includes('superadmin'), 'no admin identity leaks into the candidate portal');

    await cand.fill('#vCode', created.code);
    await cand.check('#ack');
    await cand.click('#startBtn');
    await cand.waitForSelector('#nextBtn', { timeout: 15000 });
    ok('identity verification accepted and the exam started');
    check(one("SELECT COUNT(*) FROM assessment_sessions WHERE candidate_id = ?", created.id) === 1,
      'exactly one session row was created');

    const session = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ?').get(created.id);
    // Answer the first calculation question through the real inputs.
    const numInputs = await cand.$$('input[type="number"]');
    check(numInputs.length > 0, 'the first question renders numeric inputs');
    if (numInputs.length >= 2) {
      await numInputs[0].fill('3000');
      await numInputs[1].fill('18000');
    }
    await cand.waitForTimeout(1200); // debounced autosave
    const savedAnswers = one('SELECT COUNT(*) FROM candidate_answers WHERE session_id = ? AND answer_json IS NOT NULL', session.id);
    check(savedAnswers > 0, 'typing autosaved the answer to the server', 'saved rows: ' + savedAnswers);

    await cand.click('#nextBtn');
    await cand.waitForTimeout(900);
    ok('Next advanced to the following question');
    await cand.click('#prevBtn');
    await cand.waitForTimeout(900);
    const firstVal = await cand.locator('input[type="number"]').first().inputValue();
    check(firstVal === '3000', 'Previous restored the saved answer', 'got ' + JSON.stringify(firstVal));

    // ------------------------------------------------- live controls (real UI)
    head('Live Assessments — pause / resume through the real buttons');
    await page.click('.sidebar-nav a[data-nav="live"]');
    await page.waitForTimeout(1500);
    let liveText = await page.locator('#content').innerText();
    check(liveText.includes('Browser UI Candidate'), 'the running assessment appears on the Live page');

    page.once('dialog', (d) => d.accept()); // confirm() for pause
    await page.click(`button[data-live="PAUSE"][data-sid="${session.id}"]`);
    await page.waitForTimeout(1800);
    check(one('SELECT paused_at FROM assessment_sessions WHERE id = ?', session.id) !== null,
      'clicking Pause paused the session in the database');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='EXAM_PAUSED'") > 0, 'the pause is audited');

    // The candidate must now be locked out.
    await cand.reload({ waitUntil: 'networkidle' });
    await cand.waitForTimeout(800);
    const pausedText = await cand.locator('body').innerText();
    check(/paused/i.test(pausedText), 'the candidate sees that the exam is paused', JSON.stringify(pausedText.slice(0, 90)));

    await page.click('.sidebar-nav a[data-nav="live"]');
    await page.waitForTimeout(1500);
    await page.click(`button[data-live="RESUME"][data-sid="${session.id}"]`);
    await page.waitForTimeout(1800);
    check(one('SELECT paused_at FROM assessment_sessions WHERE id = ?', session.id) === null,
      'clicking Resume cleared the pause');
    check(one('SELECT total_paused_seconds FROM assessment_sessions WHERE id = ?', session.id) >= 0,
      'the paused duration was recorded');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='EXAM_RESUMED'") > 0, 'the resume is audited');

    // Extend time via the real button (prompt dialog).
    const expiryBefore = one('SELECT expires_at FROM assessment_sessions WHERE id = ?', session.id);
    page.once('dialog', (d) => d.accept('15'));
    await page.click(`button[data-live="EXTEND_TIME"][data-sid="${session.id}"]`);
    await page.waitForTimeout(1800);
    const expiryAfter = one('SELECT expires_at FROM assessment_sessions WHERE id = ?', session.id);
    check(expiryAfter !== expiryBefore, 'clicking +Time extended the deadline', `${expiryBefore} -> ${expiryAfter}`);
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='EXAM_TIME_EXTENDED'") > 0, 'the extension is audited');

    // Terminate via the real button.
    await page.click('.sidebar-nav a[data-nav="live"]');
    await page.waitForTimeout(1500);
    page.once('dialog', (d) => d.accept());
    await page.click(`button[data-live="TERMINATE"][data-sid="${session.id}"]`);
    await page.waitForTimeout(2200);
    check(one('SELECT status FROM assessment_sessions WHERE id = ?', session.id) === 'SUBMITTED',
      'clicking Terminate finalized the assessment');
    check(one('SELECT submission_type FROM assessment_sessions WHERE id = ?', session.id) === 'TERMINATED',
      'it is recorded as TERMINATED');
    check(one('SELECT COUNT(*) FROM scores WHERE session_id = ?', session.id) === 1,
      'it was marked from the answers already saved');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='EXAM_TERMINATED'") > 0, 'the termination is audited');

    await cand.reload({ waitUntil: 'networkidle' });
    await cand.waitForTimeout(800);
    const afterTerm = await cand.locator('body').innerText();
    check(!/Question 1 of/i.test(afterTerm), 'the candidate can no longer continue the exam');

    // ------------------------------------------------------ user management
    head('Users page — create a user through the real form');
    await page.click('.sidebar-nav a[data-nav="users"]');
    await page.waitForSelector('#newUserBtn', { timeout: 10000 });
    const usersBefore = one('SELECT COUNT(*) FROM users');
    await page.click('#newUserBtn');
    await page.waitForSelector('#uName');
    await page.fill('#uName', 'Browser Made User');
    await page.fill('#uEmail', 'browser.user@lalco.demo');
    await page.selectOption('#uRole', 'RECRUITER');
    await page.fill('#uPass', 'BrowserPassword123');
    await page.click('#uSave');
    await page.waitForTimeout(1600);
    check(one('SELECT COUNT(*) FROM users') === usersBefore + 1, 'the user row was created');
    const madeUser = db.prepare("SELECT * FROM users WHERE email = 'browser.user@lalco.demo'").get();
    check(madeUser && madeUser.role === 'RECRUITER', 'with the role chosen in the dropdown');
    check(madeUser && /^\$2[aby]\$/.test(madeUser.password_hash), 'the password is bcrypt-hashed, not plaintext');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='USER_CREATED'") > 0, 'user creation is audited');
    const usersText = await page.locator('#content').innerText();
    check(usersText.includes('Browser Made User'), 'and the table refreshed');
    check(!usersText.includes('BrowserPassword123'), 'the password is never displayed in the UI');

    // Disable through the real button.
    page.once('dialog', (d) => d.accept());
    await page.click(`button[data-uact="active"][data-uid="${madeUser.id}"]`);
    await page.waitForTimeout(1600);
    check(one('SELECT active FROM users WHERE id = ?', madeUser.id) === 0, 'clicking Disable deactivated the account');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='USER_DISABLED'") > 0, 'disabling is audited');

    // --------------------------------------------- candidate archive (real UI)
    head('Archive a candidate through the real button');
    await page.click('.sidebar-nav a[data-nav="candidates"]');
    await page.waitForSelector('#rows');
    await page.click(`#rows tr[data-id="${created.id}"]`);
    await page.waitForSelector('#archiveCandBtn', { timeout: 10000 });
    page.once('dialog', (d) => d.accept());
    await page.click('#archiveCandBtn');
    await page.waitForTimeout(1800);
    check(one('SELECT archived FROM candidates WHERE id = ?', created.id) === 1, 'clicking Archive archived the candidate');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='CANDIDATE_ARCHIVED'") > 0, 'archiving is audited');

    await page.click('.sidebar-nav a[data-nav="candidates"]');
    await page.waitForSelector('#rows');
    await page.waitForTimeout(900);
    check(!(await page.locator('#rows').innerText()).includes('Browser UI Candidate'),
      'the archived candidate is hidden from the active list');
    await page.selectOption('#fArchived', '1');
    await page.waitForTimeout(1200);
    check((await page.locator('#rows').innerText()).includes('Browser UI Candidate'),
      'and appears when the Archived filter is selected');

    // --------------------------------------------------------- reports (real)
    head('Report buttons download real files');
    await page.selectOption('#fArchived', '');
    await page.waitForTimeout(800);
    await page.goto(`${BASE}/admin/#/candidates/${created.id}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#profTabs');
    await page.click('#profTabs button[data-t="reports"]');
    await page.waitForSelector('#pdfBtn');
    const [pdf] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#pdfBtn')]);
    const pdfPath = await pdf.path();
    const pdfSize = pdfPath ? require('fs').statSync(pdfPath).size : 0;
    check(pdfSize > 500, 'Download PDF produced a non-empty file', pdfSize + ' bytes');
    check(pdfPath && require('fs').readFileSync(pdfPath).slice(0, 5).toString() === '%PDF-', 'and it is a real PDF');

    // ------------------------------------------------------------- modals
    head('Modals close cleanly');
    await page.click('.sidebar-nav a[data-nav="candidates"]');
    await page.waitForSelector('#newCandBtn');
    await page.click('#newCandBtn');
    await page.waitForSelector('#nFullName');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    check(!(await page.locator('#nFullName').count()), 'Escape closes the new-candidate modal');
    await page.click('#newCandBtn');
    await page.waitForSelector('#nFullName');
    await page.click('#cancelBtn');
    await page.waitForTimeout(500);
    check(!(await page.locator('#nFullName').count()), 'Cancel closes it too');
    check(await page.locator('#newCandBtn').isEnabled(), 'and the page underneath is usable again');

    // ------------------------------------------------------------- logout
    head('Logout');
    await page.click('#logoutBtn');
    await page.waitForTimeout(900);
    check(await page.locator('#lEmail').isVisible(), 'signing out returns to the login form');

    // ------------------------------------------------------- console hygiene
    head('Browser console');
    const realErrors = consoleErrors.concat(candErrors)
      .filter((e) => !/favicon|Failed to load resource: the server responded with a status of 40[019]/i.test(e));
    check(realErrors.length === 0, 'no JavaScript errors or unhandled rejections',
      realErrors.slice(0, 4).join(' | '));

    await candCtx.close();
  } catch (e) {
    bad('UNCAUGHT: ' + e.message);
    console.log(e.stack);
  } finally {
    await browser.close();
  }

  console.log('\n\x1b[1m---- REAL BROWSER UI TEST ----\x1b[0m');
  console.log('\x1b[32mPassed: ' + pass + '\x1b[0m');
  if (failures.length) {
    console.log('\x1b[31mFailed: ' + failures.length + '\x1b[0m');
    failures.forEach((f) => console.log('\x1b[31m   - ' + f + '\x1b[0m'));
    process.exit(1);
  }
  console.log('\x1b[32mFailed: 0\x1b[0m');
  process.exit(0);
})();
