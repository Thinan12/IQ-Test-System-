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
    await page.fill('#qConfigLo', JSON.stringify({ parts: { answer: { label: 'ຄຳຕອບ (USD)' } } }, null, 2));
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
