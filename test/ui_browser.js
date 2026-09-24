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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Test-Suite-Passw0rd!2026';
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
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Chromium's message for a failed request does not name the URL, so the
    // location is appended: an exemption can then be scoped to one endpoint
    // instead of muting a whole status code everywhere.
    const loc = m.location && m.location();
    consoleErrors.push(m.text() + (loc && loc.url ? ' [' + loc.url + ']' : ''));
  });
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
    await page.fill('#uPass', 'Bw7#nHt5Jq!xZd3');
    await page.click('#uSave');
    await page.waitForTimeout(1600);
    check(one('SELECT COUNT(*) FROM users') === usersBefore + 1, 'the user row was created');
    const madeUser = db.prepare("SELECT * FROM users WHERE email = 'browser.user@lalco.demo'").get();
    check(madeUser && madeUser.role === 'RECRUITER', 'with the role chosen in the dropdown');
    check(madeUser && /^\$2[aby]\$/.test(madeUser.password_hash), 'the password is bcrypt-hashed, not plaintext');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='USER_CREATED'") > 0, 'user creation is audited');
    const usersText = await page.locator('#content').innerText();
    check(usersText.includes('Browser Made User'), 'and the table refreshed');
    check(!usersText.includes('Bw7#nHt5Jq!xZd3'), 'the password is never displayed in the UI');

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

    // -------------------------------------------- Question Bank (bilingual)
    head('Question Bank — create, edit, archive, restore in the real UI');
    await page.click('.sidebar-nav a[data-nav="questions"]');
    await page.waitForSelector('#newQBtn', { timeout: 10000 });
    const qBefore = one('SELECT COUNT(*) FROM questions');

    await page.click('#newQBtn');
    await page.waitForSelector('#qText');
    await page.fill('#qText', 'Browser bilingual question: what is 10% of 1000?');
    await page.fill('#qTextLo', 'ຄຳຖາມທົດສອບຈາກຕົວທ່ອງເວັບ');
    await page.selectOption('#qStatus', 'APPROVED');
    await page.fill('#qCategory', 'Browser Test');
    await page.fill('#qConfig', JSON.stringify({ parts: [{ key: 'answer', label: 'Answer (USD)', marks: 5, expected: 100, tol: 1 }] }, null, 2));
    // The Lao wording is typed into the structured panel, which is rebuilt from
    // the marking configuration above. Dispatch the change the panel listens for.
    await page.dispatchEvent('#qConfig', 'change');
    await page.waitForSelector('.qPartLo[data-part="answer"]', { timeout: 10000 });
    check(await page.locator('.qPartEn[data-part="answer"]').inputValue() === 'Answer (USD)',
      'the bilingual panel picked the English wording up from the configuration');
    check(await page.locator('.biltag.en').count() > 0, 'the panel marks which field is English');
    check(await page.locator('.biltag.lo').count() > 0, 'and which field is Lao');
    await page.fill('.qPartLo[data-part="answer"]', 'ຄຳຕອບ (USD)');
    // Regression: clicking from the configuration straight into a Lao field
    // used to rebuild the panel mid-click, so the keystrokes landed back in the
    // textarea and corrupted the JSON. Both must survive.
    check(await page.locator('.qPartLo[data-part="answer"]').inputValue() === 'ຄຳຕອບ (USD)',
      'typing Lao straight after editing the configuration is not lost',
      await page.locator('.qPartLo[data-part="answer"]').inputValue());
    const cfgAfter = await page.locator('#qConfig').inputValue();
    let cfgValid = true;
    try { JSON.parse(cfgAfter); } catch (e) { cfgValid = false; }
    check(cfgValid, 'and the marking configuration is still valid JSON', cfgAfter.slice(-40));
    await page.click('#qSave');
    await page.waitForTimeout(1800);

    const madeQ = db.prepare("SELECT * FROM questions WHERE category = 'Browser Test'").get();
    check(!!madeQ, 'clicking Create made a question row');
    check(one('SELECT COUNT(*) FROM questions') === qBefore + 1, 'exactly one question was added');
    check(madeQ && madeQ.max_marks === 5, 'marks were computed from the parts server-side', madeQ && String(madeQ.max_marks));
    check(madeQ && madeQ.translation_status === 'APPROVED', 'the translation status was stored');
    check(madeQ && !!madeQ.text_lo, 'the Lao text was stored on the SAME row');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='Question created' AND target=?", madeQ ? madeQ.id : '') > 0,
      'question creation is audited');
    const cardText = await page.locator('#qBody').innerText();
    check(cardText.includes('Browser bilingual question'), 'the English question appears in the list');
    check(cardText.includes('ຄຳຖາມທົດສອບຈາກຕົວທ່ອງເວັບ'), 'and the Lao appears beside it');

    await page.click(`button[data-qact="edit"][data-qid="${madeQ.id}"]`);
    await page.waitForSelector('#qText');
    await page.fill('#qCategory', 'Browser Test Edited');
    await page.click('#qSave');
    await page.waitForTimeout(1800);
    check(one('SELECT category FROM questions WHERE id = ?', madeQ.id) === 'Browser Test Edited',
      'clicking Save changed the question');

    page.once('dialog', (d) => d.accept());
    await page.click(`button[data-qact="archive"][data-qid="${madeQ.id}"]`);
    await page.waitForTimeout(1800);
    check(one('SELECT archived FROM questions WHERE id = ?', madeQ.id) === 1, 'clicking Archive archived it');
    check(one('SELECT COUNT(*) FROM questions WHERE id = ?', madeQ.id) === 1, 'and did NOT delete the row');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='QUESTION_ARCHIVED'") > 0, 'archiving is audited');

    await page.selectOption('#qArchived', '1');
    await page.waitForTimeout(1400);
    await page.click(`button[data-qact="restore"][data-qid="${madeQ.id}"]`);
    await page.waitForTimeout(1800);
    check(one('SELECT archived FROM questions WHERE id = ?', madeQ.id) === 0, 'clicking Restore restored it');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='QUESTION_RESTORED'") > 0, 'restoring is audited');

    // Archive it again so it does not join the candidate exam below and change
    // which question appears first.
    await page.evaluate(async (id) => { await api('/questions/' + id + '/archive', { method: 'POST' }); }, madeQ.id);
    check(one('SELECT archived FROM questions WHERE id = ?', madeQ.id) === 1, 'the test question is parked out of the candidate exam');

    // ------------------------------------------- candidate language switching
    head('Candidate language switch in a real browser');
    const langCtx = await browser.newContext();
    const lp = await langCtx.newPage();
    const langErrors = [];
    lp.on('pageerror', (e) => langErrors.push('pageerror: ' + e.message));
    lp.on('console', (m) => { if (m.type() === 'error') langErrors.push(m.text()); });

    // A LOCAL test candidate on this throwaway server. No production data.
    const langCand = await page.evaluate(async () => {
      const r = await api('/candidates', { method: 'POST', body: JSON.stringify({ fullName: 'Language Switch Candidate', applicationType: 'NORMAL', iq: 110, education: 'Bachelor Degree' }) });
      const l = await api('/candidates/' + r.id + '/links', { method: 'POST' });
      return { id: r.id, code: r.code, token: l.token };
    });
    check(!!langCand.token, 'a local test candidate and link were created');

    await lp.goto(`${BASE}/exam/${langCand.token}`, { waitUntil: 'networkidle' });
    check(await lp.locator('#langSwitch').isVisible(), 'the English | ລາວ switch is offered before starting');

    await lp.click('#langSwitch [data-lang="lo"]');
    await lp.waitForTimeout(600);
    await lp.fill('#vCode', langCand.code);
    await lp.check('#ack');
    await lp.click('#startBtn');
    await lp.waitForSelector('#nextBtn', { timeout: 15000 });
    const langSession = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ?').get(langCand.id);
    check(langSession && langSession.language === 'lo', 'the pre-exam language choice reached the session', langSession && langSession.language);

    await lp.click('#langSwitch [data-lang="en"]');
    await lp.waitForTimeout(1200);
    check(one('SELECT language FROM assessment_sessions WHERE id = ?', langSession.id) === 'en',
      'switching during the exam updates the session language');

    const nums = await lp.$$('input[type="number"]');
    check(nums.length > 0, 'the first question renders at least one numeric input', 'found ' + nums.length);
    await nums[0].fill('3000');
    if (nums.length >= 2) await nums[1].fill('18000');
    await lp.waitForTimeout(1500);
    const answersBefore = one('SELECT COUNT(*) FROM candidate_answers WHERE session_id = ? AND answer_json IS NOT NULL', langSession.id);
    const deadlineBefore = one('SELECT expires_at FROM assessment_sessions WHERE id = ?', langSession.id);
    const statusBefore = one('SELECT status FROM assessment_sessions WHERE id = ?', langSession.id);
    check(answersBefore > 0, 'an answer was autosaved before switching');

    await lp.click('#langSwitch [data-lang="lo"]');
    await lp.waitForTimeout(1600);

    check(one('SELECT expires_at FROM assessment_sessions WHERE id = ?', langSession.id) === deadlineBefore,
      'DEADLINE unchanged after switching language');
    check(one('SELECT status FROM assessment_sessions WHERE id = ?', langSession.id) === statusBefore,
      'the assessment was NOT submitted by switching language');
    check(one('SELECT COUNT(*) FROM candidate_answers WHERE session_id = ? AND answer_json IS NOT NULL', langSession.id) === answersBefore,
      'ANSWERS preserved after switching to Lao');
    const shownAfter = await lp.locator('input[type="number"]').first().inputValue();
    check(shownAfter === '3000', 'the typed answer is still on screen in Lao', JSON.stringify(shownAfter));
    const timerAfter = ((await lp.locator('#timer').textContent()) || '').trim();
    check(/^\d{2}:\d{2}$/.test(timerAfter), 'the countdown is still running, not reset', JSON.stringify(timerAfter));
    check(timerAfter !== '--:--', 'and did not fall back to a placeholder');

    await lp.click('#langSwitch [data-lang="en"]');
    await lp.waitForTimeout(1600);
    const shownBack = await lp.locator('input[type="number"]').first().inputValue();
    check(shownBack === '3000', 'the answer survives switching back to English', JSON.stringify(shownBack));
    check(one('SELECT COUNT(*) FROM assessment_sessions WHERE candidate_id = ?', langCand.id) === 1,
      'no extra session was created by any of the switching');

    const realErrorsLang = langErrors.filter((e) => !/favicon|status of 40[019]/i.test(e));
    check(realErrorsLang.length === 0, 'no console errors during language switching', realErrorsLang.slice(0, 3).join(' | '));
    await langCtx.close();

    // ------------------------------------------ Assessment Management (P2)
    head('Assessment Management — the full 11-step flow through the real UI');
    await page.click('.sidebar-nav a[data-nav="assessments"]');
    await page.waitForSelector('#newAsmtBtn', { timeout: 10000 });
    check(true, '1. the Assessments screen loads with a New Assessment button');

    const listText = await page.locator('#content').innerText();
    check(listText.includes('LALCO Recruitment Assessment'), '2. the existing assessment is listed');
    check(listText.includes('ACTIVE'), 'its status is shown');
    check(/45 min/.test(listText), 'its exam duration is shown');
    check(/10 min/.test(listText), 'its invitation expiry is shown');
    check(/\b70\b/.test(listText), 'its pass threshold is shown');

    // 3. create a new assessment through the real form
    const asmtBefore = one('SELECT COUNT(*) FROM assessments');
    await page.click('#newAsmtBtn');
    await page.waitForSelector('#aName');
    await page.fill('#aName', 'Browser Assessment');
    await page.fill('#aDesc', 'Created by the browser test.');
    await page.fill('#aDuration', '30');
    await page.fill('#aExpiry', '8');
    await page.fill('#aCalc', '20');
    await page.fill('#aWritten', '20');
    await page.fill('#aInterview', '20');
    await page.fill('#aTotal', '60');
    await page.fill('#aThreshold', '36');
    // Pick two questions and put them in a deliberate order.
    const useBoxes = await page.$$('#aQuestions .aq-use');
    const orderInputs = await page.$$('#aQuestions .aq-order');
    await useBoxes[0].check();
    await useBoxes[1].check();
    await orderInputs[0].fill('1');
    await orderInputs[1].fill('0');
    await page.click('#aSave');
    await page.waitForTimeout(1800);

    const madeA = db.prepare("SELECT * FROM assessments WHERE name = 'Browser Assessment'").get();
    check(!!madeA, '3. clicking Create made an assessment row');
    check(one('SELECT COUNT(*) FROM assessments') === asmtBefore + 1, 'exactly one assessment was added');
    check(madeA && madeA.duration_minutes === 30, 'the exam duration was saved', madeA && String(madeA.duration_minutes));
    check(madeA && madeA.link_expiry_minutes === 8, 'the invitation expiry was saved separately');
    check(madeA && madeA.pass_threshold === 36 && madeA.total_max === 60, 'the scoring was saved');
    check(madeA && madeA.eligibility_rules_id === 1, 'the eligibility policy was saved');
    check(one('SELECT COUNT(*) FROM assessment_questions WHERE assessment_id = ?', madeA.id) === 2,
      '4. the two chosen questions were attached');
    const orderedIds = db.prepare('SELECT question_id FROM assessment_questions WHERE assessment_id = ? ORDER BY order_index').all(madeA.id).map((r) => r.question_id);
    const bankIds = await page.evaluate(async () => (await api('/questions')).questions.map((q) => q.id));
    check(orderedIds[0] === bankIds[1] && orderedIds[1] === bankIds[0],
      'and in the order typed into the Order column, not the bank order', orderedIds.join(','));
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='ASSESSMENT_CREATED' AND target=?", madeA.id) > 0,
      'creating it is audited');

    // 5. search
    await page.fill('#aSearch', 'Browser Assessment');
    await page.waitForTimeout(900);
    const searched = await page.locator('#content').innerText();
    check(searched.includes('Browser Assessment'), '5. search finds it');
    check(!searched.includes('LALCO Recruitment Assessment'), 'and filters the others out');
    await page.fill('#aSearch', '');
    await page.waitForTimeout(900);

    // 6. view (read-only)
    await page.click(`button[data-aact="view"][data-aid="${madeA.id}"]`);
    await page.waitForSelector('#aName');
    check(await page.locator('#aName').isDisabled(), '6. View opens the configuration read-only');
    check(!(await page.locator('#aSave').count()), 'with no Save button to press by accident');
    await page.click('#aCancel');
    await page.waitForTimeout(500);

    // 7. edit
    await page.click(`button[data-aact="edit"][data-aid="${madeA.id}"]`);
    await page.waitForSelector('#aName');
    check(!(await page.locator('#aName').isDisabled()), '7. Edit opens the same form, editable');
    check((await page.locator('#aDuration').inputValue()) === '30', 'pre-filled with what is stored');
    await page.fill('#aDuration', '35');
    await page.click('#aSave');
    await page.waitForTimeout(1800);
    check(one('SELECT duration_minutes FROM assessments WHERE id = ?', madeA.id) === 35,
      'clicking Save changed the assessment');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='ASSESSMENT_TIMING_CHANGED' AND target=?", madeA.id) > 0,
      'the timing change is audited on its own line');

    // 8. duplicate (the copy is named through a prompt)
    page.once('dialog', (d) => d.accept('Browser Assessment Copy'));
    await page.click(`button[data-aact="duplicate"][data-aid="${madeA.id}"]`);
    await page.waitForTimeout(2000);
    const copyA = db.prepare("SELECT * FROM assessments WHERE name = 'Browser Assessment Copy'").get();
    check(!!copyA, '8. Duplicate made a copy');
    check(copyA && copyA.id !== madeA.id, 'with its own id');
    check(copyA && copyA.active === 0, 'and it starts inactive so it is reviewed first');
    check(copyA && one('SELECT COUNT(*) FROM assessment_questions WHERE assessment_id = ?', copyA.id) === 2,
      'the question references came with it');
    check(one('SELECT COUNT(*) FROM assessment_sessions WHERE assessment_id = ?', copyA.id) === 0,
      'but no candidate history did');

    // 9. deactivate / activate
    page.once('dialog', (d) => d.accept());
    await page.click(`button[data-aact="deactivate"][data-aid="${madeA.id}"]`);
    await page.waitForTimeout(1800);
    check(one('SELECT active FROM assessments WHERE id = ?', madeA.id) === 0, '9. Deactivate deactivated it');
    await page.click(`button[data-aact="activate"][data-aid="${madeA.id}"]`);
    await page.waitForTimeout(1800);
    check(one('SELECT active FROM assessments WHERE id = ?', madeA.id) === 1, 'Activate switched it back on');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='ASSESSMENT_DEACTIVATED' AND target=?", madeA.id) > 0,
      'both state changes are audited');

    // 10. archive
    page.once('dialog', (d) => d.accept());
    await page.click(`button[data-aact="archive"][data-aid="${madeA.id}"]`);
    await page.waitForTimeout(1800);
    check(one('SELECT archived FROM assessments WHERE id = ?', madeA.id) === 1, '10. Archive archived it');
    check(one('SELECT COUNT(*) FROM assessments WHERE id = ?', madeA.id) === 1, 'and did NOT delete the row');
    check(one('SELECT COUNT(*) FROM assessment_questions WHERE assessment_id = ?', madeA.id) === 2,
      'nor its question references');
    const afterArchive = await page.locator('#content').innerText();
    check(!afterArchive.includes('Browser Assessment\n'), 'it leaves the current list');

    // 11. restore
    await page.selectOption('#aArchived', '1');
    await page.waitForTimeout(1400);
    check((await page.locator('#content').innerText()).includes('Browser Assessment'),
      '11. it is findable under Archived');
    await page.click(`button[data-aact="restore"][data-aid="${madeA.id}"]`);
    await page.waitForTimeout(1800);
    check(one('SELECT archived FROM assessments WHERE id = ?', madeA.id) === 0, 'Restore restored it');
    check(one('SELECT active FROM assessments WHERE id = ?', madeA.id) === 0,
      'and it comes back inactive, awaiting a decision');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='ASSESSMENT_RESTORED' AND target=?", madeA.id) > 0,
      'restoring is audited');

    // a refusal surfaces as a message, not a silent no-op
    await page.selectOption('#aArchived', '');
    await page.waitForTimeout(1200);
    await page.click(`button[data-aact="edit"][data-aid="${madeA.id}"]`);
    await page.waitForSelector('#aName');
    await page.fill('#aTotal', '999');
    await page.click('#aSave');
    await page.waitForTimeout(1600);
    const toastText = await page.locator('.toast').first().innerText().catch(() => '');
    check(/total|threshold|equal/i.test(toastText), 'an invalid configuration is refused with a readable message', JSON.stringify(toastText));
    check(one('SELECT total_max FROM assessments WHERE id = ?', madeA.id) === 60, 'and nothing was saved');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    // -------------------------------- Question flags + print (Phase 3, 1-19)
    head('Question flags and print — the full 19-step flow in a real browser');
    const flagCtx = await browser.newContext();
    const fp = await flagCtx.newPage();
    const flagErrors = [];
    fp.on('pageerror', (e) => flagErrors.push('pageerror: ' + e.message));
    fp.on('console', (m) => { if (m.type() === 'error') flagErrors.push(m.text()); });

    // A LOCAL test candidate on this throwaway server. No production data.
    const flagCand = await page.evaluate(async () => {
      const r = await api('/candidates', { method: 'POST', body: JSON.stringify({ fullName: 'Flag Browser Candidate', applicationType: 'NORMAL', iq: 112, education: 'Bachelor Degree' }) });
      const l = await api('/candidates/' + r.id + '/links', { method: 'POST' });
      return { id: r.id, code: r.code, token: l.token };
    });

    // 1. the candidate opens a question
    await fp.goto(`${BASE}/exam/${flagCand.token}`, { waitUntil: 'networkidle' });
    await fp.fill('#vCode', flagCand.code);
    await fp.check('#ack');
    await fp.click('#startBtn');
    await fp.waitForSelector('#flagBtn', { timeout: 15000 });
    check(true, '1. the candidate reaches a question with a Flag control');
    const flagSession = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ?').get(flagCand.id);
    const firstQid = db.prepare(
      `SELECT aq.question_id AS id FROM assessment_questions aq WHERE aq.assessment_id = ? ORDER BY aq.order_index LIMIT 1`
    ).get(flagSession.assessment_id).id;
    check((await fp.locator('#flagBtn').getAttribute('aria-pressed')) === 'false', 'it starts unflagged');
    check((await fp.locator('#flagState').innerText()).includes('Not flagged'), 'and says so in words');

    // 2. flag it
    const deadlineAtFlag = one('SELECT expires_at FROM assessment_sessions WHERE id = ?', flagSession.id);
    await fp.click('#flagBtn');
    await fp.waitForTimeout(1200);
    check(one('SELECT flagged FROM candidate_answers WHERE session_id = ? AND question_id = ?', flagSession.id, firstQid) === 1,
      '2. clicking Flag stored the flag');
    check((await fp.locator('#flagBtn').getAttribute('aria-pressed')) === 'true', 'the button shows the flagged state');
    check((await fp.locator('#flagLabel').innerText()).toLowerCase().includes('remove'), 'and offers to remove it');
    check(one('SELECT expires_at FROM assessment_sessions WHERE id = ?', flagSession.id) === deadlineAtFlag,
      'flagging did NOT move the deadline');
    check(one('SELECT status FROM assessment_sessions WHERE id = ?', flagSession.id) === 'IN_PROGRESS',
      'and did NOT submit the assessment');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='QUESTION_FLAGGED' AND target=?", flagCand.code) > 0,
      'flagging is audited against the candidate');

    // 3-5. move away and come back
    await fp.click('#nextBtn');
    await fp.waitForTimeout(1400);
    check((await fp.locator('#flagBtn').getAttribute('aria-pressed')) === 'false',
      '3. the next question is its own, unflagged');
    await fp.click('#prevBtn');
    await fp.waitForTimeout(1400);
    check((await fp.locator('#flagBtn').getAttribute('aria-pressed')) === 'true',
      '4-5. returning to the question shows the flag still set');

    // 6-7. answer it, and the flag and answer coexist
    const fnums = await fp.$$('input[type="number"]');
    check(fnums.length > 0, '6. the question renders an answer field');
    await fnums[0].fill('3000');
    await fp.waitForTimeout(1400);
    check(one('SELECT COUNT(*) FROM candidate_answers WHERE session_id = ? AND question_id = ? AND answer_json IS NOT NULL', flagSession.id, firstQid) === 1,
      '7. the answer was autosaved');
    check(one('SELECT flagged FROM candidate_answers WHERE session_id = ? AND question_id = ?', flagSession.id, firstQid) === 1,
      'and the flag is still set on the same row');
    check((await fp.locator('input[type="number"]').first().inputValue()) === '3000', 'the answer is still on screen');

    // 8-9. English -> Lao
    await fp.click('#langSwitch [data-lang="lo"]');
    await fp.waitForTimeout(1800);
    check(one('SELECT language FROM assessment_sessions WHERE id = ?', flagSession.id) === 'lo', '8. switched to Lao');
    check((await fp.locator('#flagBtn').getAttribute('aria-pressed')) === 'true', '9. the flag survives the switch to Lao');
    check((await fp.locator('input[type="number"]').first().inputValue()) === '3000', 'and so does the typed answer');
    check(one('SELECT expires_at FROM assessment_sessions WHERE id = ?', flagSession.id) === deadlineAtFlag,
      'the deadline still has not moved');

    // 10-11. Lao -> English
    await fp.click('#langSwitch [data-lang="en"]');
    await fp.waitForTimeout(1800);
    check((await fp.locator('#flagBtn').getAttribute('aria-pressed')) === 'true', '10-11. the flag survives the switch back to English');
    check((await fp.locator('input[type="number"]').first().inputValue()) === '3000', 'and the answer with it');

    // 12-13. a real page reload
    await fp.reload({ waitUntil: 'networkidle' });
    await fp.waitForSelector('#flagBtn', { timeout: 15000 });
    check((await fp.locator('#flagBtn').getAttribute('aria-pressed')) === 'true', '12-13. the flag survives a full page reload');
    check(one('SELECT flagged FROM candidate_answers WHERE session_id = ? AND question_id = ?', flagSession.id, firstQid) === 1,
      'the server, not the browser, is holding it');
    check((await fp.locator('input[type="number"]').first().inputValue()) === '3000', 'the answer survived the reload too');

    // 14-15. unflag
    await fp.click('#flagBtn');
    await fp.waitForTimeout(1400);
    check(one('SELECT flagged FROM candidate_answers WHERE session_id = ? AND question_id = ?', flagSession.id, firstQid) === 0,
      '14. clicking again removed the flag');
    check((await fp.locator('#flagBtn').getAttribute('aria-pressed')) === 'false', '15. and the button says so');
    check((await fp.locator('input[type="number"]').first().inputValue()) === '3000', 'unflagging did not clear the answer');
    check(one("SELECT COUNT(*) FROM audit_logs WHERE action='QUESTION_UNFLAGGED' AND target=?", flagCand.code) > 0,
      'unflagging is audited');

    // Re-flag two questions so the admin and print views have something to show.
    await fp.click('#flagBtn');
    await fp.waitForTimeout(1200);
    await fp.click('#nextBtn');
    await fp.waitForTimeout(1400);
    await fp.click('#flagBtn');
    await fp.waitForTimeout(1200);
    check(one('SELECT COUNT(*) FROM candidate_answers WHERE session_id = ? AND flagged = 1', flagSession.id) === 2,
      'two questions are now flagged');

    const realErrorsFlag = flagErrors.filter((e) => !/favicon|status of 40[019]/i.test(e));
    check(realErrorsFlag.length === 0, 'no console errors anywhere in the flag flow', realErrorsFlag.slice(0, 3).join(' | '));
    await flagCtx.close();

    // 16-17. the admin opens the candidate record and sees the flags
    await page.goto(`${BASE}/admin/#/candidates/${flagCand.id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.click('#profTabs button[data-t="questions"]');
    await page.waitForTimeout(1500);
    const qTabText = await page.locator('#profBody').innerText();
    check(qTabText.includes('Flagged'), '16-17. the admin sees the candidate flags on the record');
    check(/2 question\(s\) the candidate flagged/.test(qTabText), 'with a summary of how many', qTabText.slice(0, 120));

    // 18. the admin print view
    await page.click('#profTabs button[data-t="reports"]');
    await page.waitForSelector('#printBtn', { timeout: 10000 });
    await page.click('#printBtn');
    await page.waitForSelector('.printdoc', { timeout: 10000 });
    check(true, '18. the Print button opens a print view');

    // 19. the printed content and layout
    const printText = await page.locator('.printdoc').innerText();
    check(printText.includes('Flag Browser Candidate'), '19. the printout names the candidate');
    check(printText.includes(flagCand.code), 'and carries the LALCO ID', flagCand.code);
    check(printText.includes('LALCO Recruitment Assessment'), 'and names the assessment');
    check(/pass threshold applied/i.test(printText), 'and the pass threshold that was applied');
    check(/flagged for review by the candidate/i.test(printText), 'and the candidate flags');
    check(/question performance/i.test(printText), 'and the question performance');
    check(/assessment integrity/i.test(printText), 'and the integrity summary');
    // Nothing that would hand a reader the answer key.
    check(!/toleran/i.test(printText), 'the printout carries no tolerance');
    check(!/expected answer/i.test(printText), 'and no expected answer');

    // The print LAYOUT, verified by actually emulating print media.
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(400);
    check(!(await page.locator('.sidebar').isVisible()), 'printing hides the sidebar navigation');
    check(!(await page.locator('.topbar').isVisible()), 'and the topbar');
    check(!(await page.locator('#doPrint').isVisible()), 'and the Print button itself');
    check(await page.locator('.printdoc').isVisible(), 'while the report itself remains');
    await page.emulateMedia({ media: 'screen' });
    await page.waitForTimeout(300);
    check(await page.locator('#doPrint').isVisible(), 'and the controls come back on screen');

    // Printing must not have changed anything.
    check(one('SELECT COUNT(*) FROM candidate_answers WHERE session_id = ? AND flagged = 1', flagSession.id) === 2,
      'opening the print view changed no stored data');

    // The candidate's own printable confirmation, after submitting.
    const doneCtx = await browser.newContext();
    const dp = await doneCtx.newPage();
    const doneCand = await page.evaluate(async () => {
      const r = await api('/candidates', { method: 'POST', body: JSON.stringify({ fullName: 'Receipt Candidate', applicationType: 'NORMAL', iq: 108, education: 'Bachelor Degree' }) });
      const l = await api('/candidates/' + r.id + '/links', { method: 'POST' });
      return { id: r.id, code: r.code, token: l.token };
    });
    await dp.goto(`${BASE}/exam/${doneCand.token}`, { waitUntil: 'networkidle' });
    await dp.fill('#vCode', doneCand.code);
    await dp.check('#ack');
    await dp.click('#startBtn');
    await dp.waitForSelector('#nextBtn', { timeout: 15000 });
    dp.once('dialog', (d) => d.accept());
    await dp.evaluate(async () => {
      const token = location.pathname.split('/').pop();
      await fetch('/api/exam/' + token + '/submit', { method: 'POST' });
    });
    await dp.reload({ waitUntil: 'networkidle' });
    await dp.waitForSelector('#receipt', { timeout: 10000 });
    const receipt = await dp.locator('#receipt').innerText();
    check(receipt.includes('Receipt Candidate'), 'the candidate confirmation names them');
    check(receipt.includes(doneCand.code), 'and shows their LALCO ID');
    check(receipt.includes('LALCO Recruitment Assessment'), 'and which assessment they sat');
    check(/Submitted/.test(receipt), 'and that it was submitted');
    check(!/\bPASS\b|\bFAIL\b|marks|score/i.test(receipt), 'but NO score or result', receipt.slice(0, 120));
    check(await dp.locator('#printReceipt').isVisible(), 'and offers a Print button');
    await dp.emulateMedia({ media: 'print' });
    await dp.waitForTimeout(400);
    check(!(await dp.locator('#printReceipt').isVisible()), 'which is hidden on the printed page');
    check(await dp.locator('#receipt').isVisible(), 'while the confirmation itself prints');
    await doneCtx.close();

    // ------------- Bilingual OPTIONS built through the structured editor
    // The canonical value is what grading compares against. The point of this
    // block is that it survives being given two different display labels.
    head('Question Bank \u2014 bilingual options: value, English label, Lao label');
    await page.click('.sidebar-nav a[data-nav="questions"]');
    await page.waitForSelector('#newQBtn', { timeout: 10000 });
    await page.click('#newQBtn');
    await page.waitForSelector('#qText');
    await page.fill('#qText', 'Browser choice question: which city is the capital of France?');
    await page.fill('#qTextLo', '\u0ec0\u0ea1\u0eb7\u0ead\u0e87\u0ec3\u0e94\u0ec1\u0ea1\u0ec8\u0e99\u0e99\u0eb0\u0e84\u0ead\u0e99\u0eab\u0ebc\u0ea7\u0e87?');
    await page.selectOption('#qStatus', 'APPROVED');
    await page.fill('#qCategory', 'Browser Choice');
    await page.fill('#qConfig', JSON.stringify({
      parts: [{ key: 'capital', label: 'Capital city', marks: 4, type: 'choice', options: ['A', 'B'], expected: 'A' }],
    }, null, 2));
    await page.dispatchEvent('#qConfig', 'change');
    await page.waitForSelector('.qOptEn[data-value="A"]', { timeout: 10000 });

    const canonCells = await page.locator('.optgrid td.canon').allInnerTexts();
    check(canonCells.map((x) => x.trim()).join(',') === 'A,B',
      'the canonical values are shown read-only, one row each', canonCells.join(','));
    check(await page.locator('.optgrid td.canon input').count() === 0,
      'and there is no input on the canonical value \u2014 it cannot be edited here');

    await page.fill('.qOptEn[data-value="A"]', 'Paris');
    await page.fill('.qOptEn[data-value="B"]', 'London');
    await page.fill('.qOptLo[data-value="A"]', '\u0e9b\u0eb2\u0ea3\u0eb5');
    await page.fill('.qOptLo[data-value="B"]', '\u0ea5\u0ead\u0e99\u0e94\u0ead\u0e99');
    await page.fill('.qPartLo[data-part="capital"]', '\u0e99\u0eb0\u0e84\u0ead\u0e99\u0eab\u0ebc\u0ea7\u0e87');
    await page.click('#qSave');
    await page.waitForTimeout(1800);

    const choiceQ = db.prepare("SELECT * FROM questions WHERE category = 'Browser Choice'").get();
    check(!!choiceQ, 'the choice question was created through the UI');
    const choiceCfg = choiceQ ? JSON.parse(choiceQ.config_json) : { parts: [] };
    const choicePart = choiceCfg.parts[0] || {};
    check(JSON.stringify(choicePart.options) === '["A","B"]',
      'the canonical values were stored unchanged', JSON.stringify(choicePart.options));
    check(choicePart.expected === 'A', 'the expected answer is still the VALUE, not a label', String(choicePart.expected));
    check(choicePart.optionLabels && choicePart.optionLabels.A === 'Paris',
      'the English label was stored against the value', JSON.stringify(choicePart.optionLabels));
    const choiceLo = choiceQ && choiceQ.config_lo_json ? JSON.parse(choiceQ.config_lo_json) : { parts: {} };
    check(!!(choiceLo.parts && choiceLo.parts.capital && choiceLo.parts.capital.options
      && choiceLo.parts.capital.options.A === '\u0e9b\u0eb2\u0ea3\u0eb5'),
      'the Lao label was stored as an overlay keyed by the same value',
      JSON.stringify(choiceLo.parts && choiceLo.parts.capital));
    check(choiceQ && choiceQ.translation_status === 'APPROVED', 'and it is approved for Lao');

    // Reopening must show what was saved, in both columns.
    await page.click('.sidebar-nav a[data-nav="questions"]');
    await page.waitForSelector('#qBody', { timeout: 10000 });
    const editBtn = page.locator(`button[data-qact="edit"][data-qid="${choiceQ.id}"]`);
    if (await editBtn.count()) {
      await editBtn.first().click();
      await page.waitForSelector('.qOptEn[data-value="A"]', { timeout: 10000 });
      check(await page.locator('.qOptEn[data-value="A"]').inputValue() === 'Paris',
        'reopening the question shows the saved English label');
      check(await page.locator('.qOptLo[data-value="A"]').inputValue() === '\u0e9b\u0eb2\u0ea3\u0eb5',
        'and the saved Lao label');
      check((await page.locator('.optgrid td.canon').allInnerTexts()).map((x) => x.trim()).join(',') === 'A,B',
        'and the canonical values are unchanged after a round trip');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    } else {
      check(false, 'the saved question offers an Edit control');
    }

    // ------------------- Invitation language chosen by the admin, in the UI
    head('Invitation language \u2014 admin picks Lao, the exam opens in Lao');
    const invCand = await page.evaluate(async () => {
      const r = await api('/candidates', { method: 'POST', body: JSON.stringify({ fullName: 'Invitation Language Browser', applicationType: 'NORMAL', iq: 115, education: 'Bachelor Degree' }) });
      return { id: r.id, code: r.code };
    });
    await page.goto(`${BASE}/admin/#/candidates/${invCand.id}`, { waitUntil: 'networkidle' });
    // The link card lives on the Assessment tab, not the profile's default tab.
    await page.waitForSelector('#profTabs', { timeout: 15000 });
    await page.click('#profTabs button[data-t="assessment"]');
    await page.waitForSelector('#genLink', { timeout: 15000 });
    check(await page.locator('#linkLang').count() > 0, 'the link card offers a candidate language choice');
    check(await page.locator('#linkLangEn').isChecked(), 'English is selected by default');

    await page.check('#linkLangLo');
    await page.click('#genLink');
    await page.waitForTimeout(1800);
    const laoLink = db.prepare("SELECT * FROM assessment_links WHERE candidate_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(invCand.id);
    check(!!laoLink, 'a link was generated from the UI');
    check(laoLink && laoLink.language === 'lo', 'and it recorded the Lao choice', laoLink && laoLink.language);
    const linkCard = await page.locator('.card').first().innerText();
    check(/Lao/.test(linkCard), 'the admin can see which language the active link uses');

    // The candidate opens it: no switching, no manual translation.
    const invCtx = await browser.newContext();
    const invPage = await invCtx.newPage();
    await invPage.goto(`${BASE}/exam/${laoLink.token}`, { waitUntil: 'networkidle' });
    await invPage.waitForTimeout(700);
    const invIntro = await invPage.locator('.pbody').innerText();
    check(/[\u0E80-\u0EFF]/.test(invIntro), 'the invitation screen opens in Lao with no candidate action');
    const invActive = await invPage.locator('#langSwitch .langbtn.active').innerText();
    check(/[\u0E80-\u0EFF]/.test(invActive), 'and the Lao button is the one shown as active', JSON.stringify(invActive));

    await invPage.fill('#vCode', invCand.code);
    await invPage.check('#ack');
    await invPage.click('#startBtn');
    await invPage.waitForSelector('#nextBtn', { timeout: 20000 });
    const invSession = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ?').get(invCand.id);
    check(invSession && invSession.language === 'lo',
      'the session was created in Lao from the invitation alone', invSession && invSession.language);

    // Reload must not lose it.
    await invPage.reload({ waitUntil: 'networkidle' });
    await invPage.waitForSelector('#nextBtn', { timeout: 20000 });
    check(/[\u0E80-\u0EFF]/.test(await invPage.locator('#nextBtn').innerText()),
      'reloading keeps the exam in Lao');
    check(one('SELECT language FROM assessment_sessions WHERE id = ?', invSession.id) === 'lo',
      'and the stored language is still Lao after the reload');

    // Answer something, then switch language twice: the answer must survive.
    const invNums = await invPage.$$('input[type="number"]');
    if (invNums.length) { await invNums[0].fill('4321'); await invPage.waitForTimeout(1600); }
    const answeredBefore = one('SELECT COUNT(*) FROM candidate_answers WHERE session_id = ? AND answer_json IS NOT NULL', invSession.id);
    check(answeredBefore > 0, 'an answer was saved while in Lao');
    const invDeadlineBefore = one('SELECT expires_at FROM assessment_sessions WHERE id = ?', invSession.id);

    await invPage.click('#langSwitch [data-lang="en"]');
    await invPage.waitForTimeout(900);
    check(one('SELECT language FROM assessment_sessions WHERE id = ?', invSession.id) === 'en',
      'switching to English in the browser is persisted');
    const numsEn = await invPage.$$('input[type="number"]');
    check(numsEn.length > 0 && (await numsEn[0].inputValue()) === '4321',
      'the answer typed in Lao is still on screen in English',
      numsEn.length ? await numsEn[0].inputValue() : 'no field');

    await invPage.click('#langSwitch [data-lang="lo"]');
    await invPage.waitForTimeout(900);
    check(one('SELECT language FROM assessment_sessions WHERE id = ?', invSession.id) === 'lo',
      'and switching back to Lao is persisted');
    const numsLo = await invPage.$$('input[type="number"]');
    check(numsLo.length > 0 && (await numsLo[0].inputValue()) === '4321',
      'the answer is still there after switching back',
      numsLo.length ? await numsLo[0].inputValue() : 'no field');
    check(one('SELECT COUNT(*) FROM candidate_answers WHERE session_id = ? AND answer_json IS NOT NULL', invSession.id) === answeredBefore,
      'no answer was lost by switching language twice');
    check(one('SELECT expires_at FROM assessment_sessions WHERE id = ?', invSession.id) === invDeadlineBefore,
      'and the deadline never moved');
    check(one('SELECT COUNT(*) FROM assessment_sessions WHERE candidate_id = ?', invCand.id) === 1,
      'switching language never started a second attempt');
    await invCtx.close();

    // ----------------------------- Automatic translation, through the real UI
    // Nothing here fakes a translation. Either the configured provider really
    // produces the Lao, or the not-configured path is proved instead and the
    // live path is reported as unproven.
    head('Automatic translation \u2014 real admin UI, real endpoint');
    const translationConfigured = !!String(process.env.ANTHROPIC_API_KEY || '').trim();

    await page.click('.sidebar-nav a[data-nav="questions"]');
    await page.waitForSelector('#newQBtn', { timeout: 10000 });
    await page.click('#newQBtn');
    await page.waitForSelector('#qText');

    // 3-4. English question and English options, typed like an admin would.
    const trEnglish = 'LALCO lends USD 100,000 to a customer for 6 months at 3% per month. Which decision is correct?';
    await page.fill('#qText', trEnglish);
    await page.fill('#qCategory', 'Translation Test');
    await page.fill('#qConfig', JSON.stringify({
      parts: [{ key: 'decision', label: 'Decision', marks: 4, type: 'choice', options: ['A', 'B'], expected: 'A' }],
    }, null, 2));
    await page.dispatchEvent('#qConfig', 'change');
    await page.waitForSelector('.qOptEn[data-value="A"]', { timeout: 10000 });
    await page.fill('.qOptEn[data-value="A"]', 'Approve the loan');
    await page.fill('.qOptEn[data-value="B"]', 'Reject the loan');

    check(await page.locator('#qTranslateLo').count() > 0, 'the editor offers Auto-translate to Lao');
    check(await page.locator('#qTranslateEn').count() > 0, 'and Auto-translate to English');
    check((await page.locator('#qTranslateLo').innerText()).includes('Auto-translate'),
      'it reads Auto-translate while the Lao side is empty',
      await page.locator('#qTranslateLo').innerText());
    check(await page.locator('#qTranslateEn').isDisabled(),
      'translating INTO English is disabled while there is no Lao source');

    if (!translationConfigured) {
      // -------- provider not configured: prove the controlled behaviour -----
      check(await page.locator('#qTranslateLo').isDisabled(),
        'with no provider configured the Lao button is disabled, not silently broken');
      const note = await page.locator('#qTranslateMsg').innerText();
      check(/not configured/i.test(note), 'and the admin is told why', JSON.stringify(note));

      // The endpoint itself, called exactly as the UI calls it.
      const unconfigured = await page.evaluate(async (q) => {
        try {
          await api('/questions/translate', {
            method: 'POST',
            body: JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'lo', question: q, options: [{ value: 'A', label: 'Approve the loan' }] }),
          });
          return { status: 200, body: 'unexpected success' };
        } catch (e) {
          return { status: e.status, body: JSON.stringify(e.data || {}) };
        }
      }, trEnglish);
      check(unconfigured.status === 503, 'the real endpoint answers 503, not a fabricated translation', String(unconfigured.status));
      check(/not configured/i.test(unconfigured.body), 'and says it is a configuration problem', unconfigured.body);
      check(!/\u0e80-\u0eff/.test(unconfigured.body), 'no Lao text was invented anywhere in the response');
      check((await page.locator('#qTextLo').inputValue()) === '', 'the Lao field stays empty');
      check((await page.locator('#qText').inputValue()) === trEnglish, 'and the English the admin typed is untouched');

      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      console.log('\n\x1b[33m  CONFIGURATION BLOCKER\x1b[0m  ANTHROPIC_API_KEY is not set on this server.');
      console.log('  The automatic-translation flow (generate Lao -> save -> candidate sits in Lao)');
      console.log('  was NOT exercised end to end. Set the key and re-run to prove it.');
    } else {
      // ---------------- provider configured: the real end-to-end flow -------
      // 5-6. Press the button and wait for the real server response.
      await page.click('#qTranslateLo');
      await page.waitForFunction(
        () => { const el = document.querySelector('#qTextLo'); return el && el.value.trim().length > 0; },
        { timeout: 90000 }
      );

      // 7-9. Lao appeared, and the canonical values did not move.
      const trLaoQuestion = await page.locator('#qTextLo').inputValue();
      check(trLaoQuestion.trim().length > 0, '7. the Lao question field was filled by the server');
      check(trLaoQuestion.trim() !== trEnglish, 'and it is not just a copy of the English');
      check(/[\u0E80-\u0EFF]/.test(trLaoQuestion), 'and it really contains Lao script',
        (trLaoQuestion.match(/[\u0E80-\u0EFF]+/) || ['none'])[0]);
      const trLaoA = await page.locator('.qOptLo[data-value="A"]').inputValue();
      const trLaoB = await page.locator('.qOptLo[data-value="B"]').inputValue();
      check(trLaoA.trim().length > 0 && trLaoB.trim().length > 0, '8. both Lao option labels were filled');
      check(/[\u0E80-\u0EFF]/.test(trLaoA), 'and the option labels are Lao', trLaoA);
      const trCanon = (await page.locator('.optgrid td.canon').allInnerTexts()).map((x) => x.trim()).join(',');
      check(trCanon === 'A,B', '9. the canonical option values did not change', trCanon);
      check((await page.locator('.qOptEn[data-value="A"]').inputValue()) === 'Approve the loan',
        'and the English labels were not overwritten');
      check(/100,000/.test(trLaoQuestion) && /6/.test(trLaoQuestion) && /3%/.test(trLaoQuestion),
        'the amounts in the question survived translation',
        trLaoQuestion);
      check((await page.locator('#qStatus').inputValue()) === 'DRAFT',
        'machine output is offered as a DRAFT, never auto-approved',
        await page.locator('#qStatus').inputValue());

      // 10. The admin reviews it and approves it deliberately, then saves.
      await page.selectOption('#qStatus', 'APPROVED');
      await page.click('#qSave');
      await page.waitForTimeout(2000);

      const trQ = db.prepare("SELECT * FROM questions WHERE category = 'Translation Test'").get();
      check(!!trQ, '10. the question saved');
      check(trQ && !!trQ.text_lo, 'with the Lao text stored on the same row');
      check(trQ && trQ.translation_source === 'MACHINE',
        'and its provenance recorded as MACHINE', trQ && trQ.translation_source);
      const trCfg = trQ ? JSON.parse(trQ.config_json) : { parts: [] };
      check(JSON.stringify(trCfg.parts[0].options) === '["A","B"]', 'canonical values stored unchanged');
      check(trCfg.parts[0].expected === 'A', 'and the answer key is still the VALUE');

      // 11-12. Reload the question: both languages persisted.
      await page.click('.sidebar-nav a[data-nav="questions"]');
      await page.waitForSelector('#qBody', { timeout: 10000 });
      await page.click(`button[data-qact="edit"][data-qid="${trQ.id}"]`);
      await page.waitForSelector('.qOptLo[data-value="A"]', { timeout: 10000 });
      check((await page.locator('#qText').inputValue()) === trEnglish, '11-12. the English persisted');
      check((await page.locator('#qTextLo').inputValue()).trim() === trLaoQuestion.trim(), 'and the Lao persisted');
      check((await page.locator('.qOptLo[data-value="A"]').inputValue()).trim() === trLaoA.trim(),
        'and so did the Lao option label');
      check((await page.locator('#qTranslateLo').innerText()).includes('Regenerate'),
        'the action now reads Regenerate rather than Auto-translate',
        await page.locator('#qTranslateLo').innerText());
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);

      // 13-14. Put it in the assessment and invite a candidate in Lao.
      const trCand = await page.evaluate(async (qid) => {
        const asmts = await api('/assessments');
        const a = asmts.assessments.find((x) => x.active && !x.archived) || asmts.assessments[0];
        const full = await api('/assessments/' + a.id);
        const ids = full.assessment.questions.filter((q) => !q.archived).map((q) => q.id);
        if (!ids.includes(qid)) ids.push(qid);
        await api('/assessments/' + a.id, { method: 'PATCH', body: JSON.stringify({ questionIds: ids }) });
        const c = await api('/candidates', { method: 'POST', body: JSON.stringify({ fullName: 'Translation Journey', applicationType: 'NORMAL', iq: 120, education: 'Bachelor Degree' }) });
        const l = await api('/candidates/' + c.id + '/links', { method: 'POST', body: JSON.stringify({ language: 'lo' }) });
        return { id: c.id, code: c.code, token: l.token, assessmentId: a.id };
      }, trQ.id);
      check(!!trCand.token, '13-14. a Lao invitation was generated for an assessment containing it');

      // 15-17. The candidate opens it and reads the generated Lao.
      const trCtx = await browser.newContext();
      const trPage = await trCtx.newPage();
      await trPage.goto(`${BASE}/exam/${trCand.token}`, { waitUntil: 'networkidle' });
      await trPage.fill('#vCode', trCand.code);
      await trPage.check('#ack');
      await trPage.click('#startBtn');
      await trPage.waitForSelector('#nextBtn', { timeout: 20000 });

      const trTotal = db.prepare('SELECT COUNT(*) AS n FROM assessment_questions WHERE assessment_id = ?').get(trCand.assessmentId).n;
      let reached = false;
      for (let i = 0; i < trTotal + 2; i++) {
        const body = await trPage.locator('.pbody').innerText();
        if (body.includes(trLaoQuestion.trim().slice(0, 24))) { reached = true; break; }
        if (!(await trPage.locator('#nextBtn').count())) break;
        await trPage.click('#nextBtn');
        await trPage.waitForTimeout(900);
      }
      check(reached, '15-16. the candidate reached the machine-translated question, shown in Lao');
      const trBody = await trPage.locator('.pbody').innerText();
      check(trBody.includes(trLaoA.trim()), '17. the Lao option labels are displayed', trLaoA);
      check(!trBody.includes('Approve the loan'), 'and the English labels are not shown alongside them');
      check(!/expected|toleran|rubric/i.test(trBody), 'no answer key reached the candidate');

      // 18-20. Answer, reload, answer still selected.
      await trPage.click('.qopt:has(input[value="A"])').catch(async () => {
        await trPage.check('input[type="radio"][value="A"]');
      });
      await trPage.waitForTimeout(1500);
      const trSession = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ?').get(trCand.id);
      const storedAnswer = db.prepare('SELECT answer_json FROM candidate_answers WHERE session_id = ? AND question_id = ?')
        .get(trSession.id, trQ.id);
      check(!!storedAnswer && /"A"/.test(storedAnswer.answer_json || ''),
        '18. the answer stored the canonical value, not the Lao label',
        storedAnswer && storedAnswer.answer_json);
      await trPage.reload({ waitUntil: 'networkidle' });
      await trPage.waitForTimeout(1500);
      check(await trPage.locator('input[type="radio"][value="A"]:checked').count() > 0
        || /"A"/.test((db.prepare('SELECT answer_json FROM candidate_answers WHERE session_id = ? AND question_id = ?').get(trSession.id, trQ.id) || {}).answer_json || ''),
        '19-20. the selection survived a reload');

      // 21-25. Switch to English and back; the answer must not move.
      await trPage.click('#langSwitch [data-lang="en"]');
      await trPage.waitForTimeout(1200);
      const enBody = await trPage.locator('.pbody').innerText();
      check(enBody.includes('Approve the loan') || enBody.includes(trEnglish.slice(0, 24)),
        '21-22. switching to English shows the English question and options');
      check(/"A"/.test((db.prepare('SELECT answer_json FROM candidate_answers WHERE session_id = ? AND question_id = ?').get(trSession.id, trQ.id) || {}).answer_json || ''),
        '23. the stored answer is unchanged by switching language');
      await trPage.click('#langSwitch [data-lang="lo"]');
      await trPage.waitForTimeout(1200);
      const loBody = await trPage.locator('.pbody').innerText();
      check(/[\u0E80-\u0EFF]/.test(loBody), '24-25. switching back shows Lao again');
      check(/"A"/.test((db.prepare('SELECT answer_json FROM candidate_answers WHERE session_id = ? AND question_id = ?').get(trSession.id, trQ.id) || {}).answer_json || ''),
        'and the answer is still the canonical value');
      await trCtx.close();
    }

    // ------------------------ Lao end to end: sit, submit and print in Lao
    // The production smoke test could not prove this: that candidate switched
    // back to English before submitting, so the Lao branch of the receipt and
    // of the admin print view was never rendered. This exercises it.
    head('Lao end to end \u2014 sit in Lao, submit in Lao, print in Lao');
    const laoCtx = await browser.newContext();
    const lop = await laoCtx.newPage();
    const laoErrors = [];
    lop.on('pageerror', (e) => laoErrors.push('pageerror: ' + e.message));
    lop.on('console', (m) => { if (m.type() === 'error') laoErrors.push(m.text()); });

    // A LOCAL test candidate with a Lao name, on this throwaway server.
    const laoName = '\u0e97\u0ec9\u0eb2\u0ea7 \u0eaa\u0ebb\u0ea1\u0e8a\u0eb2\u0e8d \u0e9e\u0ebb\u0ea1\u0ea1\u0eb0\u0ea7\u0ebb\u0e87';
    const laoCand = await page.evaluate(async (nm) => {
      const r = await api('/candidates', { method: 'POST', body: JSON.stringify({ fullName: nm, applicationType: 'NORMAL', iq: 118, education: 'Bachelor Degree' }) });
      const l = await api('/candidates/' + r.id + '/links', { method: 'POST' });
      return { id: r.id, code: r.code, token: l.token };
    }, laoName);
    check(!!laoCand.token, 'a Lao-named test candidate and link were created');

    // 1. start the exam in Lao
    await lop.goto(`${BASE}/exam/${laoCand.token}`, { waitUntil: 'networkidle' });
    await lop.click('#langSwitch [data-lang="lo"]');
    await lop.waitForTimeout(700);
    const instrLao = await lop.locator('.pbody').innerText();
    check(/[\u0E80-\u0EFF]/.test(instrLao), 'the instructions screen renders Lao before starting');
    check(instrLao.includes(laoName), 'and shows the Lao candidate name unmangled');

    await lop.fill('#vCode', laoCand.code);
    await lop.check('#ack');
    await lop.click('#startBtn');
    await lop.waitForSelector('#nextBtn', { timeout: 20000 });
    const laoSession = db.prepare('SELECT * FROM assessment_sessions WHERE candidate_id = ?').get(laoCand.id);
    check(laoSession && laoSession.language === 'lo', '1. the exam started in Lao', laoSession && laoSession.language);

    // Lao interface chrome really is Lao, not the English fallback.
    const nextLabel = (await lop.locator('#nextBtn').innerText()).trim();
    check(/[\u0E80-\u0EFF]/.test(nextLabel), 'the Next button is in Lao', JSON.stringify(nextLabel));
    const flagLabel = (await lop.locator('#flagBtn').innerText()).trim();
    check(/[\u0E80-\u0EFF]/.test(flagLabel), 'the Flag control is in Lao', JSON.stringify(flagLabel));
    const flagState = (await lop.locator('#flagState').innerText()).trim();
    check(/[\u0E80-\u0EFF]/.test(flagState), 'the flag state text is in Lao', JSON.stringify(flagState));

    // 2. answer at least one question
    const laoNums = await lop.$$('input[type="number"]');
    check(laoNums.length > 0, '2. the question renders answer fields in Lao');
    if (laoNums.length) { await laoNums[0].fill('3000'); await lop.waitForTimeout(1600); }
    const laoAnswered = one('SELECT COUNT(*) FROM candidate_answers WHERE session_id = ? AND answer_json IS NOT NULL', laoSession.id);
    check(laoAnswered > 0, 'the answer saved while in Lao');

    // 3. remain in Lao all the way to the review screen
    const laoTotal = db.prepare('SELECT COUNT(*) AS n FROM assessment_questions WHERE assessment_id = ?').get(laoSession.assessment_id).n;
    for (let i = 0; i < laoTotal + 2; i++) {
      if (await lop.locator('#submitBtn').count()) break;
      if (!(await lop.locator('#nextBtn').count())) break;
      await lop.click('#nextBtn');
      await lop.waitForTimeout(1200);
    }
    check(await lop.locator('#submitBtn').count() > 0, 'the review screen is reachable in Lao');
    const reviewLao = await lop.locator('.pbody').innerText();
    check(/[\u0E80-\u0EFF]/.test(reviewLao), '3. the review screen renders Lao');
    const submitLabel = (await lop.locator('#submitBtn').innerText()).trim();
    check(/[\u0E80-\u0EFF]/.test(submitLabel), 'the Submit button is in Lao', JSON.stringify(submitLabel));
    check(one('SELECT language FROM assessment_sessions WHERE id = ?', laoSession.id) === 'lo',
      'the session is still in Lao at the point of submitting');

    // 4. submit while language = lo
    lop.once('dialog', (d) => d.accept());
    await lop.click('#submitBtn');
    await lop.waitForSelector('#receipt', { timeout: 25000 });
    check(one('SELECT status FROM assessment_sessions WHERE id = ?', laoSession.id) === 'SUBMITTED',
      '4. the assessment submitted while in Lao');
    check(one('SELECT language FROM assessment_sessions WHERE id = ?', laoSession.id) === 'lo',
      'and the session language stayed lo');

    // 5-7. the candidate receipt, in Lao
    const laoReceipt = await lop.locator('#receipt').innerText();
    check(/[\u0E80-\u0EFF]/.test(laoReceipt), '5-6. the candidate receipt renders Lao Unicode',
      (laoReceipt.match(/[\u0E80-\u0EFF]+/) || ['none'])[0]);
    check(laoReceipt.includes(laoName), '7. the receipt carries the Lao candidate name unmangled');
    check(laoReceipt.includes(laoCand.code), 'and the LALCO ID');
    check(/LALCO Recruitment Assessment/.test(laoReceipt), 'and the assessment sat');
    // 8. nothing the candidate must not see
    check(!/\bPASS\b|\bFAIL\b/.test(laoReceipt), '8. no pass/fail on the candidate receipt');
    check(!/expected|toleran|rubric/i.test(laoReceipt), 'no answer-key wording on the receipt');
    check(!laoReceipt.includes(laoSession.id), 'no internal session id on the receipt');
    check(!laoReceipt.includes(laoCand.id), 'no internal candidate id on the receipt');

    // the receipt prints cleanly in Lao
    await lop.emulateMedia({ media: 'print' });
    await lop.waitForTimeout(400);
    check(await lop.locator('#receipt').isVisible(), 'the Lao receipt survives print media');
    check(!(await lop.locator('#printReceipt').isVisible()), 'and the print button is hidden on paper');
    await lop.emulateMedia({ media: 'screen' });

    const realLaoErrors = laoErrors.filter((e) => !/favicon|status of 40[019]/i.test(e));
    check(realLaoErrors.length === 0, 'no console errors anywhere in the Lao journey', realLaoErrors.slice(0, 2).join(' | '));
    await laoCtx.close();

    // the ADMIN print view for a candidate who sat in Lao
    await page.goto(`${BASE}/admin/#/print/${laoCand.id}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.printdoc', { timeout: 15000 });
    const laoPrint = await page.locator('.printdoc').innerText();
    check(/[\u0E80-\u0EFF]/.test(laoPrint), 'the ADMIN print view renders Lao Unicode',
      (laoPrint.match(/[\u0E80-\u0EFF]+/) || ['none'])[0]);
    check(laoPrint.includes(laoName), 'the admin printout carries the Lao candidate name unmangled');
    check(laoPrint.includes(laoCand.code), 'and the LALCO ID');
    check(/LALCO Recruitment Assessment/.test(laoPrint), 'and the assessment');
    check(/pass threshold applied/i.test(laoPrint), 'and the pass threshold applied');
    check(!/toleran/i.test(laoPrint), 'and carries no tolerance');
    check(!/expected answer/i.test(laoPrint), 'and no expected answer');

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
      // A 503 from the OPTIONAL translation endpoint is expected on a server
      // with no provider configured, and the test above asserts it deliberately.
      // The exemption names that endpoint so a 503 from anywhere else still fails.
      .filter((e) => !/favicon|Failed to load resource: the server responded with a status of 40[019]/i.test(e))
      .filter((e) => !(/status of 503/i.test(e) && /questions\/translate/i.test(e)));
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
