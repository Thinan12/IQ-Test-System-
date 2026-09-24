'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&lt;'[0] === '&' ? '&amp;' : c }[c] || ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
function toast(msg) { let w = $('.toast-wrap'); if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); } const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; w.appendChild(t); setTimeout(() => t.remove(), 2600); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
// A timestamp with no timezone marker is UTC (SQLite's datetime() shape);
// JavaScript would otherwise read it as local time and skew the countdown.
function parseDbDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) return new Date(s.replace(' ', 'T') + 'Z');
  return new Date(s);
}

const TOKEN = location.pathname.split('/').filter(Boolean)[1] || '';
const LS_KEY = 'lalco_exam_' + TOKEN;

async function exam(path, opts = {}) {
  const res = await fetch('/api/exam/' + TOKEN + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) { const err = new Error((data && data.error) || 'Request failed'); err.status = res.status; err.data = data; throw err; }
  return data;
}

let STATE = { step: 'loading', questions: [], idx: 0, expiresAt: null, timerInterval: null, pausePoll: null, language: 'en', switchingLanguage: false, integrity: { pasteEvents: 0, focusChanges: 0, largestPaste: 0 } };

// Candidate-facing interface strings. English is the source language; the Lao
// column is filled in by the LALCO team. A blank Lao entry falls back to
// English rather than showing an empty control.
// Candidate-facing strings. English is the SOURCE language: every English
// string here is exactly what a candidate has always been shown.
//
// Anything null in `lo` falls back to English, and that fallback is
// deliberate — correct English beats guessed Lao in front of a candidate.
//
// LAO REVIEW STATUS -- read before changing:
//   * The Lao below is standard interface terminology (buttons, labels,
//     status words) supplied for NATIVE SIGN-OFF. It is not machine
//     translation of anything a candidate is marked on.
//   * Longer prose (instructions, paused/ended/expired explanations, the
//     receipt wording) is deliberately still null. Those need a Lao speaker
//     to write them; they are listed in LAO_TODO below so nothing is hidden.
//   * Question stems, option labels and marking text are NOT here. They live
//     in the Question Bank and are governed by translation_status=APPROVED.
const UI_STRINGS = {
  en: {
    langLabel: 'English', otherLangLabel: 'ລາວ',

    // ---- navigation and buttons
    previous: 'Previous', next: 'Next', review: 'Review Answers',
    submit: 'Submit Assessment', back: 'Back', edit: 'Edit',
    startAssessment: 'Start Assessment', starting: 'Starting…',
    switching: 'Switching…', saving: 'Saving…',

    // ---- question screen
    questionOf: (i, n) => `Question ${i} of ${n}`,
    writtenResponse: 'Written response',
    autosave: 'Answer autosaves as you type.',
    essayPlaceholder: 'Write your answer here...',

    // ---- flags
    flag: 'Flag for review', unflag: 'Remove flag',
    flagged: 'Flagged for review', notFlagged: 'Not flagged',
    flagging: 'Saving…',
    flagHint: 'Flagging is just a bookmark for you. It does not change your answer, your time or your marks.',
    flaggedCount: (n) => `${n} flagged for review`,
    reviewColumn: 'Review',

    // ---- instructions / verification
    candidateAssessment: 'Candidate Assessment',
    candidateLabel: 'Candidate', positionLabel: 'Position',
    questionsLabel: 'Questions', durationLabel: 'Duration', minutesLabel: 'minutes',
    rule1: 'Answer all questions carefully.',
    rule2: 'Your answers are automatically saved.',
    rule3: 'Do not close the browser during the assessment.',
    rule4: 'You may use a mobile phone or computer.',
    rule5: 'Once submitted, the assessment cannot be changed.',
    confirmIdentity: 'Confirm your identity',
    candidateIdLabel: 'Candidate ID', phoneLabel: 'Phone number', dobLabel: 'Date of birth',
    acknowledge: 'I understand the assessment instructions.',

    // ---- review screen
    reviewTitle: 'Review your answers',
    answeredLabel: 'Answered', unansweredLabel: 'Unanswered',
    unansweredWarning: (n) => `You have ${n} unanswered question(s).`,
    canGoBack: 'You can go back before submitting.',
    flaggedShownBelow: 'Flagged questions are shown below so you can come back to them.',
    submitConfirm: 'Submit your assessment? You will not be able to change your answers afterwards.',

    // ---- loading and link errors
    loading: 'Loading your assessment…',
    invalidLink: 'Invalid link',
    noToken: 'No assessment token was found in this URL.',
    linkUnavailable: 'Assessment link unavailable',

    // ---- paused
    pausedTitle: 'Assessment paused',
    pausedByAdmin: 'An administrator has paused your assessment.',
    pausedSafe: 'Your answers are saved and your remaining time is frozen. Please wait — this page will continue automatically.',
    pausedRemaining: (m, sec) => `Time remaining when paused: ${m}m ${sec}s — it is frozen and will not run down.`,

    // ---- terminated
    endedTitle: 'Assessment ended',
    endedByAdmin: 'This assessment was ended by an administrator. The answers you had saved have been submitted.',
    endedContact: 'Please speak to the recruitment team if you have any questions.',
    endedAt: 'Ended',

    // ---- time expired
    timeExpiredTitle: 'TIME EXPIRED',
    timeEnded: 'Your assessment time has ended.',
    autoSubmittedMsg: 'Your saved answers have been submitted automatically.',
    thanks: 'Thank you.',
    answeredUnanswered: (a, u) => `${a} answered · ${u} unanswered`,

    // ---- submitted + printable receipt
    submittedTitle: 'Assessment submitted',
    submittedThanks: 'Thank you for completing the LALCO recruitment assessment. Our HR team will contact you regarding the next steps, including your interview.',
    submittedAtLabel: 'Submitted',
    receiptTitle: 'Assessment submission confirmation',
    receiptCandidate: 'Candidate', receiptId: 'LALCO ID',
    receiptAssessment: 'Assessment', receiptStatus: 'Status',
    receiptStatusValue: 'Submitted — awaiting marking',
    receiptNoResults: 'Your results are not shown here. LALCO HR will contact you about the outcome.',
    printConfirmation: 'Print confirmation',

    // ---- fallback notice for a question with no approved Lao
    laoUnavailable: 'Lao translation not available for this question. The English version is shown below.',
    laoUnavailableTitle: 'ບໍ່ມີການແປພາສາລາວ',
  },

  lo: {
    langLabel: 'ລາວ', otherLangLabel: 'English',

    // ---- navigation and buttons (supplied, pending native sign-off)
    previous: 'ກ່ອນໜ້າ',
    next: 'ຕໍ່ໄປ',
    review: 'ກວດຄືນຄຳຕອບ',
    submit: 'ສົ່ງການປະເມີນ',
    back: 'ກັບຄືນ',
    edit: 'ແກ້ໄຂ',
    startAssessment: 'ເລີ່ມການປະເມີນ',
    starting: 'ກຳລັງເລີ່ມ…',
    switching: 'ກຳລັງປ່ຽນ…',
    saving: 'ກຳລັງບັນທຶກ…',

    // ---- question screen
    questionOf: null,                       // LAO_TODO: needs Lao number phrasing
    writtenResponse: 'ຄຳຕອບແບບຂຽນ',
    autosave: null,                         // LAO_TODO: sentence
    essayPlaceholder: null,                 // LAO_TODO: sentence

    // ---- flags (supplied, pending native sign-off)
    flag: 'ໝາຍໄວ້ເພື່ອກວດຄືນ',
    unflag: 'ເອົາເຄື່ອງໝາຍອອກ',
    flagged: 'ໝາຍໄວ້ເພື່ອກວດຄືນແລ້ວ',
    notFlagged: 'ຍັງບໍ່ໄດ້ໝາຍ',
    flagging: 'ກຳລັງບັນທຶກ…',
    flagHint: null,                         // LAO_TODO: sentence
    flaggedCount: null,                     // LAO_TODO: needs Lao number phrasing
    reviewColumn: 'ກວດຄືນ',

    // ---- instructions / verification
    candidateAssessment: null,              // LAO_TODO
    candidateLabel: 'ຜູ້ສະໝັກ',
    positionLabel: 'ຕຳແໜ່ງ',
    questionsLabel: 'ຄຳຖາມ',
    durationLabel: 'ໄລຍະເວລາ',
    minutesLabel: 'ນາທີ',
    rule1: null, rule2: null, rule3: null, rule4: null, rule5: null,   // LAO_TODO: sentences
    confirmIdentity: null,                  // LAO_TODO
    candidateIdLabel: null, phoneLabel: null, dobLabel: null,          // LAO_TODO
    acknowledge: null,                      // LAO_TODO: sentence

    // ---- review screen
    reviewTitle: null,                      // LAO_TODO
    answeredLabel: 'ຕອບແລ້ວ',
    unansweredLabel: 'ຍັງບໍ່ໄດ້ຕອບ',
    unansweredWarning: null,                // LAO_TODO: sentence
    canGoBack: null,                        // LAO_TODO: sentence
    flaggedShownBelow: null,                // LAO_TODO: sentence
    submitConfirm: null,                    // LAO_TODO: sentence

    // ---- loading and link errors
    loading: null, invalidLink: null, noToken: null, linkUnavailable: null,  // LAO_TODO

    // ---- paused / ended / expired  (all LAO_TODO: sentences)
    pausedTitle: null, pausedByAdmin: null, pausedSafe: null, pausedRemaining: null,
    endedTitle: null, endedByAdmin: null, endedContact: null, endedAt: null,
    timeExpiredTitle: null, timeEnded: null, autoSubmittedMsg: null,
    thanks: null, answeredUnanswered: null,

    // ---- submitted + receipt
    submittedTitle: null,                   // LAO_TODO
    submittedThanks: null,                  // LAO_TODO: sentence
    submittedAtLabel: 'ສົ່ງແລ້ວ',
    receiptTitle: null,                     // LAO_TODO
    receiptCandidate: 'ຜູ້ສະໝັກ',
    receiptId: null,                        // LAO_TODO: keep "LALCO ID" as a proper noun?
    receiptAssessment: 'ການປະເມີນ',
    receiptStatus: 'ສະຖານະ',
    receiptStatusValue: null,               // LAO_TODO: sentence
    receiptNoResults: null,                 // LAO_TODO: sentence
    printConfirmation: 'ພິມໃບຢືນຢັນ',

    laoUnavailable: null,                   // LAO_TODO: sentence
    laoUnavailableTitle: 'ບໍ່ມີການແປພາສາລາວ',
  },
};

// Returns the string for the active language, falling back to English.
function t(key, ...args) {
  const lang = STATE.language || 'en';
  const candidate = (UI_STRINGS[lang] || {})[key];
  const value = (candidate === null || candidate === undefined || candidate === '')
    ? UI_STRINGS.en[key] : candidate;
  return typeof value === 'function' ? value(...args) : value;
}

function shell(inner, opts = {}) {
  document.title = 'LALCO Assessment';
  $('#app').innerHTML = `<div class="portal">
    <div class="ptop"><div class="row1"><div class="pbrand"><div class="mark"></div>LALCO Assessment</div>
      <div style="display:flex;align-items:center;gap:10px;">
        ${opts.language === false ? '' : languageToggleHTML()}
        ${opts.timer ? `<div class="timer" id="timer">--:--</div>` : ''}
      </div></div>
    ${opts.progress != null ? `<div class="progress"><div style="width:${opts.progress}%"></div></div><div class="faint" style="margin-top:5px;font-size:11.5px;">${opts.stepLabel || ''}</div>` : ''}</div>
    <div class="pbody">${inner}</div>
    ${opts.nav || ''}
  </div>`;
}

// English | ລາວ. Presentation only — it never submits, never reloads the
// session, and never touches the deadline.
function languageToggleHTML() {
  const lang = STATE.language || 'en';
  const btn = (code, label) => `<button type="button" class="langbtn ${lang === code ? 'active' : ''}" data-lang="${code}"${lang === code ? ' aria-current="true"' : ''}>${label}</button>`;
  return `<div class="langswitch" id="langSwitch" role="group" aria-label="Language">${btn('en', 'English')}${btn('lo', 'ລາວ')}</div>`;
}

// Wires the toggle. The current answer is saved BEFORE switching, so nothing a
// candidate has typed can be lost by changing language.
function wireLanguageToggle(onSwitched) {
  $$('#langSwitch [data-lang]').forEach((btn) => {
    btn.onclick = async () => {
      const next = btn.dataset.lang;
      if (next === STATE.language || STATE.switchingLanguage) return;
      STATE.switchingLanguage = true;
      $$('#langSwitch [data-lang]').forEach((b) => { b.disabled = true; });
      try {
        // No session yet (instructions screen): hold the choice locally and
        // send it with /start. Nothing to persist and nothing to lose.
        if (STATE.step === 'instructions') {
          STATE.language = next;
          if (typeof onSwitched === 'function') await onSwitched();
          return;
        }
        // Persist whatever is on screen first.
        if (typeof onSwitched === 'function' && onSwitched.saveFirst) await onSwitched.saveFirst();
        const res = await exam('/language', { method: 'POST', body: JSON.stringify({ language: next }) });
        STATE.language = res.language;
        // The server echoes the deadline back; it must not have moved.
        if (res.expiresAt) STATE.expiresAt = res.expiresAt;
        if (typeof onSwitched === 'function') await onSwitched();
      } catch (e) {
        if (e.status === 423) return renderPaused(e.data || {});
        if (e.status === 410) return renderTimeExpired(e.data || {});
        toast((e.data && e.data.error) || 'Could not change language.');
        $$('#langSwitch [data-lang]').forEach((b) => { b.disabled = false; });
      } finally {
        STATE.switchingLanguage = false;
      }
    };
  });
}

async function boot() {
  if (!TOKEN) { shell(`<div style="text-align:center;padding-top:60px;"><h2>${esc(t('invalidLink'))}</h2><p class="muted">${esc(t('noToken'))}</p></div>`); return; }
  shell(`<p class="muted">${esc(t('loading'))}</p>`);
  try {
    const info = await exam('');
    STATE.candidateName = info.candidateName || null;
    STATE.candidateCode = info.candidateCode || null;
    STATE.assessmentName = info.assessmentName || null;
    // Which language this candidate sees, decided before anything renders so
    // the very first screen is already right and nothing flashes in English.
    // A live session's own stored language wins — it is what the candidate
    // last chose. Otherwise the language the admin picked when generating the
    // invitation applies, so a Lao link opens in Lao with no action needed.
    // This survives reload and resume because both values come from the server.
    STATE.language = (info.session && info.session.language) || info.linkLanguage || STATE.language;
    if (info.session && info.session.status === 'AUTO_SUBMITTED') return renderTimeExpired(info.session);
    if (info.session && info.session.status === 'TERMINATED') return renderTerminated(info.session);
    if (info.session && (info.session.status === 'PAUSED' || info.session.paused)) return renderPaused(info.session);
    if (info.session && info.session.status === 'SUBMITTED') return renderDone(info.session.submittedAt);
    if (info.session && info.session.status === 'IN_PROGRESS') {
      STATE.expiresAt = info.session.scheduledEndAt || info.session.expiresAt;
      if (info.session.language) STATE.language = info.session.language;
      return renderQuestionFlow(info);
    }
    if (info.profileStatus !== 'PROFILE_COMPLETED') return renderProfile(info);
    renderInstructions(info);
  } catch (e) {
    // The server finalizes an expired assessment on any request, so this is the
    // normal path for a candidate who reopens the link after time ran out.
    if (e.data && e.data.autoSubmitted) return renderTimeExpired(e.data);
    if (e.status === 423 || (e.data && e.data.paused)) return renderPaused(e.data || {});
    shell(`<div style="text-align:center;padding-top:60px;"><h2>${esc(t('linkUnavailable'))}</h2><p class="muted">${esc(e.data && e.data.error || e.message)}</p></div>`);
  }
}

// The candidate's own details, asked for before the assessment. The form is
// shared with the IQ portal so both products ask in the same way.
function renderProfile(info) {
  STATE.step = 'profile'; // no session yet: the language choice is local
  window.CandidateProfileForm.reset(info.profile);
  window.CandidateProfileForm.render({
    t, esc, shell, api: exam, info,
    lang: () => STATE.language,
    languageToggle: (rerender) => wireLanguageToggle(rerender),
    onSaved: (saved) => {
      const next = Object.assign({}, info, { profile: saved, profileStatus: 'PROFILE_COMPLETED' });
      if (saved && saved.fullName) {
        STATE.candidateName = saved.fullName;
        next.candidateName = saved.fullName;
      }
      renderInstructions(next);
    },
  });
}

function renderInstructions(info) {
  STATE.step = 'instructions'; // no session yet: the language choice is local
  const v = info.verification;
  shell(`
    <h2 style="margin-bottom:6px;">${esc(t('candidateAssessment'))}</h2>
    <p class="faint" style="margin-bottom:16px;">${esc(t('candidateLabel'))}: <b>${esc(info.candidateName)}</b> · ${esc(t('positionLabel'))}: <b>${esc(info.position || '—')}</b></p>
    <div class="card">
      <div class="section-title">${esc(info.assessmentName)}</div>
      <p style="font-size:13px;">${esc(t('questionsLabel'))}: <b>${info.questionCount}</b> · ${esc(t('durationLabel'))}: <b>${info.durationMinutes} ${esc(t('minutesLabel'))}</b></p>
      <ul style="padding-left:18px;font-size:13.5px;line-height:1.7;">
        <li>${esc(t('rule1'))}</li>
        <li>${esc(t('rule2'))}</li>
        <li>${esc(t('rule3'))}</li>
        <li>${esc(t('rule4'))}</li>
        <li>${esc(t('rule5'))}</li>
      </ul>
    </div>
    ${(v.requireCandidateId || v.requirePhone || v.requireDob) ? `<div class="card" style="margin-top:14px;"><div class="section-title">${esc(t('confirmIdentity'))}</div>
      ${v.requireCandidateId ? `<div class="field"><label class="field-label">${esc(t('candidateIdLabel'))}</label><input id="vCode" placeholder="LALCO-2026-00021"></div>` : ''}
      ${v.requirePhone ? `<div class="field"><label class="field-label">${esc(t('phoneLabel'))}</label><input id="vPhone"></div>` : ''}
      ${v.requireDob ? `<div class="field"><label class="field-label">${esc(t('dobLabel'))}</label><input type="date" id="vDob"></div>` : ''}
    </div>` : ''}
    <label style="display:flex;gap:10px;align-items:flex-start;margin:16px 0;font-size:13.5px;">
      <input type="checkbox" id="ack" style="width:18px;height:18px;margin-top:2px;"> <span>${esc(t('acknowledge'))}</span>
    </label>
    <p class="faint" id="startErr" style="color:var(--danger);"></p>
  `, { nav: `<div class="pnav"><button class="btn btn-primary" id="startBtn" disabled>${esc(t('startAssessment'))}</button></div>` });
  $('#ack').onchange = (e) => { $('#startBtn').disabled = !e.target.checked; };
  // Before the assessment exists there is no session to persist to, so the
  // choice is held client-side and sent with /start.
  wireLanguageToggle(() => renderInstructions(info));
  $('#startBtn').onclick = async () => {
    // Already guarded: disabling here means a second tap is a no-op, so a
    // double tap cannot create two sessions.
    if ($('#startBtn').disabled) return;
    $('#startBtn').disabled = true; $('#startBtn').textContent = t('starting');
    try {
      const body = { language: STATE.language };
      if (v.requireCandidateId) body.candidateCode = $('#vCode').value;
      if (v.requirePhone) body.phone = $('#vPhone').value;
      if (v.requireDob) body.dob = $('#vDob').value;
      const res = await exam('/start', { method: 'POST', body: JSON.stringify(body) });
      STATE.expiresAt = res.expiresAt;
      // Keep what the server confirmed, so the submission receipt can identify
      // the candidate even if they never reload the page.
      if (res.candidateCode) STATE.candidateCode = res.candidateCode;
      if (res.assessmentName) STATE.assessmentName = res.assessmentName;
      const qinfo = await exam('/questions');
      renderQuestionFlow({ questions: qinfo.questions });
    } catch (e) {
      $('#startErr').textContent = (e.data && e.data.error) || 'Could not start the assessment.';
      $('#startBtn').disabled = false; $('#startBtn').textContent = t('startAssessment');
    }
  };
}

function startTimer() {
  clearInterval(STATE.timerInterval);
  function tick() {
    const el = $('#timer'); if (!el) return;
    const remaining = Math.max(0, Math.floor((parseDbDate(STATE.expiresAt) - Date.now()) / 1000));
    el.textContent = String(Math.floor(remaining / 60)).padStart(2, '0') + ':' + String(remaining % 60).padStart(2, '0');
    if (remaining < 120) el.classList.add('low');
    if (remaining <= 0) {
      clearInterval(STATE.timerInterval);
      // Real auto-submit. The server is authoritative and will finalize this
      // assessment regardless, but sending it immediately means the candidate
      // sees the outcome straight away instead of waiting for the sweep.
      autoSubmit();
    }
  }
  // Paint once immediately: startTimer() runs on every question screen, so
  // waiting for the first interval tick left the candidate looking at "--:--"
  // for a second each time they moved between questions.
  tick();
  STATE.timerInterval = setInterval(tick, 1000);
}

async function renderQuestionFlow(info) {
  const qres = info.questions ? info : await exam('/questions');
  STATE.questions = qres.questions;
  STATE.answered = new Set(qres.answered || []);
  STATE.flagged = new Set(qres.flagged || []);
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
  STATE.idx = saved && saved.idx < STATE.questions.length ? saved.idx : 0;
  STATE.step = 'question';
  showQuestion();
}
function persistLocalProgress() { try { localStorage.setItem(LS_KEY, JSON.stringify({ idx: STATE.idx })); } catch (e) {} }

async function showQuestion() {
  const total = STATE.questions.length;
  const qMeta = STATE.questions[STATE.idx];
  const { question: q, savedAnswer, flagged } = await exam('/question/' + qMeta.id);
  // The server is the authority on the flag, so a reload, a reconnect, a
  // language switch and navigating back all show the true state.
  if (!STATE.flagged) STATE.flagged = new Set();
  if (flagged) STATE.flagged.add(q.id); else STATE.flagged.delete(q.id);
  const isEssay = q.type === 'ESSAY';
  let body;
  if (isEssay) {
    body = `${laoBannerHTML(q)}<div class="faint" style="margin-bottom:6px;">${t('questionOf', STATE.idx + 1, total)} — ${t('writtenResponse')}</div>
      <p style="font-size:14.5px;margin-bottom:14px;">${esc(q.text)}</p>
      <textarea id="ans" style="min-height:220px;" placeholder="${esc(t('essayPlaceholder'))}">${savedAnswer ? esc(savedAnswer.text) : ''}</textarea>
      <div class="faint" style="margin-top:6px;">${t('autosave')}</div>
      ${flagControlHTML(STATE.flagged.has(q.id))}`;
  } else {
    body = `${laoBannerHTML(q)}<div class="faint" style="margin-bottom:6px;">${t('questionOf', STATE.idx + 1, total)}</div>
      <p style="font-size:14.5px;margin-bottom:14px;">${esc(q.text)}</p>
      ${q.parts.map((p) => {
        const existing = savedAnswer ? savedAnswer[p.key] : '';
        // Options arrive as {value,label}. The VALUE is the canonical English
        // string the server grades against, so it is what gets submitted; only
        // the label is translated. Switching language cannot change a mark.
        if (p.type === 'choice') return `<div class="field"><label class="field-label">${esc(p.label)}</label>${p.options.map((o) => `<label class="qopt ${existing === o.value ? 'checked' : ''}"><input type="radio" name="opt_${p.key}" value="${esc(o.value)}" ${existing === o.value ? 'checked' : ''}><span>${esc(o.label)}</span></label>`).join('')}</div>`;
        return `<div class="field"><label class="field-label">${esc(p.label)}</label><input type="number" step="0.01" inputmode="decimal" id="part_${p.key}" value="${existing != null && existing !== '' ? existing : ''}"></div>`;
      }).join('')}
      <div class="faint">${t('autosave')}</div>
      ${flagControlHTML(STATE.flagged.has(q.id))}`;
  }
  shell(body, {
    timer: true, progress: Math.round((STATE.idx / total) * 100), stepLabel: `Question ${STATE.idx + 1} of ${total}`,
    nav: `<div class="pnav">${STATE.idx > 0 ? `<button class="btn" id="prevBtn">${t('previous')}</button>` : ''}<button class="btn btn-primary" id="nextBtn">${esc(STATE.idx === total - 1 ? t('review') : t('next'))}</button></div>`,
  });
  startTimer();

  let questionStartedAt = Date.now();
  function collectAnswer() {
    if (isEssay) return { text: $('#ans').value };
    const out = {};
    q.parts.forEach((p) => {
      if (p.type === 'choice') { const el = document.querySelector(`input[name="opt_${p.key}"]:checked`); out[p.key] = el ? el.value : ''; }
      else { const el = $('#part_' + p.key); out[p.key] = el.value === '' ? '' : Number(el.value); }
    });
    return out;
  }
  async function saveAnswer() {
    const deltaSeconds = Math.round((Date.now() - questionStartedAt) / 1000);
    questionStartedAt = Date.now();
    try { await exam('/answer', { method: 'POST', body: JSON.stringify({ questionId: q.id, answer: collectAnswer(), timeSpentDeltaSeconds: deltaSeconds }) }); }
    catch (e) {
      // 410: the server's deadline passed and it finalized the assessment while
      // the candidate was typing. 423: an administrator paused it. Either way,
      // show the real state rather than asking the candidate to do something.
      if (e.status === 410) { renderTimeExpired(e.data || {}); }
      else if (e.status === 423) { renderPaused(e.data || {}); }
    }
  }
  const debouncedSave = debounce(saveAnswer, 500);
  if (isEssay) {
    const ta = $('#ans');
    ta.addEventListener('input', debouncedSave);
    ta.addEventListener('paste', async (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      try { await exam('/event', { method: 'POST', body: JSON.stringify({ questionId: q.id, type: 'PASTE', meta: { length: text.length } }) }); } catch (e2) {}
    });
  } else {
    $$('.pbody input').forEach((inp) => { inp.addEventListener('input', debouncedSave); inp.addEventListener('change', debouncedSave); });
    $$('.qopt input').forEach((r) => r.addEventListener('change', () => { $$('.qopt').forEach((o) => o.classList.remove('checked')); r.closest('.qopt').classList.add('checked'); }));
  }
  // Navigation saves before moving. Guard against a double tap firing two
  // saves or skipping a question, and show the candidate that it is working.
  let navigating = false;
  async function navigate(delta) {
    if (navigating) return;
    navigating = true;
    const btn = delta > 0 ? $('#nextBtn') : $('#prevBtn');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = t('saving'); }
    try {
      await saveAnswer();
      if (delta > 0 && STATE.idx === total - 1) { STATE.step = 'review'; persistLocalProgress(); showReview(); return; }
      STATE.idx += delta;
      persistLocalProgress();
      showQuestion();
    } finally {
      navigating = false;
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
    }
  }
  // Switching language saves the current answer first, then re-renders THIS
  // question in the new language: same index, same saved answer, same timer.
  const reRender = () => showQuestion();
  reRender.saveFirst = saveAnswer;
  wireLanguageToggle(reRender);

  wireFlagButton(q.id);

  if ($('#prevBtn')) $('#prevBtn').onclick = () => navigate(-1);
  $('#nextBtn').onclick = () => navigate(1);
}

// "Flag for review" — the candidate's own bookmark on this question.
// Deliberately separated from the answer controls and from Next/Previous, so it
// cannot be mistaken for submitting or for moving on.
function flagControlHTML(isFlagged) {
  return `<div class="flagrow">
    <button type="button" class="btn btn-sm flagbtn ${isFlagged ? 'on' : ''}" id="flagBtn"
      aria-pressed="${isFlagged ? 'true' : 'false'}">
      <span class="flagmark" aria-hidden="true">${isFlagged ? '\u2691' : '\u2690'}</span>
      <span id="flagLabel">${esc(isFlagged ? t('unflag') : t('flag'))}</span>
    </button>
    <span class="faint" id="flagState">${esc(isFlagged ? t('flagged') : t('notFlagged'))}</span>
  </div>
  <div class="faint" style="font-size:11.5px;margin:-2px 0 10px;">${esc(t('flagHint'))}</div>`;
}

// Wires the button. Flagging never saves, submits, re-orders or re-times
// anything — it posts one call and repaints one button.
function wireFlagButton(questionId) {
  const btn = $('#flagBtn');
  if (!btn) return;
  let busy = false;
  btn.onclick = async () => {
    if (busy) return;
    busy = true;
    const wasFlagged = STATE.flagged.has(questionId);
    const label = $('#flagLabel');
    const previousLabel = label.textContent;
    btn.disabled = true;
    label.textContent = t('flagging');
    try {
      const res = await exam(wasFlagged ? '/unflag' : '/flag', {
        method: 'POST', body: JSON.stringify({ questionId }),
      });
      // Trust the server's answer, not the optimistic guess.
      if (res.flagged) STATE.flagged.add(questionId); else STATE.flagged.delete(questionId);
      const nowFlagged = !!res.flagged;
      btn.classList.toggle('on', nowFlagged);
      btn.setAttribute('aria-pressed', nowFlagged ? 'true' : 'false');
      label.textContent = nowFlagged ? t('unflag') : t('flag');
      $('.flagmark', btn).textContent = nowFlagged ? '\u2691' : '\u2690';
      $('#flagState').textContent = nowFlagged ? t('flagged') : t('notFlagged');
    } catch (e) {
      // The assessment ended or was paused while the button was being pressed:
      // show the real state rather than a stale question screen.
      if (e.status === 410) return renderTimeExpired(e.data || {});
      if (e.status === 423) return renderPaused(e.data || {});
      label.textContent = previousLabel;
      toast((e.data && e.data.error) || 'Could not update the flag. Please try again.');
    } finally {
      busy = false;
      if (btn.isConnected) btn.disabled = false;
    }
  };
}

// Shown when Lao is selected but this question has no APPROVED translation.
// The English text is displayed beneath it, clearly labelled — never English
// passed off as Lao, and never machine-generated text.
function laoBannerHTML(q) {
  if (!q || !q.laoUnavailable) return '';
  return `<div class="card" style="background:var(--warning-bg);border:1px solid var(--gold);margin-bottom:12px;padding:10px 12px;">
    <b>${esc(t('laoUnavailableTitle'))}</b><div class="faint" style="margin-top:4px;">${esc(t('laoUnavailable'))}</div></div>`;
}

async function showReview() {
  const qres = await exam('/questions');
  const answered = qres.answered || [];
  STATE.flagged = new Set(qres.flagged || []);
  const total = STATE.questions.length;
  const unanswered = total - answered.length;
  const flaggedCount = STATE.flagged.size;
  shell(`
    <h2 style="margin-bottom:12px;">${esc(t('reviewTitle'))}</h2>
    <div class="grid grid-2" style="margin-bottom:16px;">
      <div class="kpi"><div class="num">${answered.length}</div><div class="lbl">${esc(t('answeredLabel'))}</div></div>
      <div class="kpi"><div class="num">${unanswered}</div><div class="lbl">${esc(t('unansweredLabel'))}</div></div>
    </div>
    ${unanswered ? `<div class="card" style="background:var(--warning-bg);"><b>${esc(t('unansweredWarning', unanswered))}</b> ${esc(t('canGoBack'))}</div>` : ''}
    ${flaggedCount ? `<div class="card" style="background:var(--warning-bg);"><b>${esc(t('flaggedCount', flaggedCount))}.</b> ${esc(t('flaggedShownBelow'))}</div>` : ''}
    <div class="table-wrap" style="margin-top:14px;"><table><thead><tr><th>#</th><th>${esc(t('answeredLabel'))}</th><th>${esc(t('reviewColumn'))}</th><th></th></tr></thead>
    <tbody>${STATE.questions.map((qq, i) => `<tr><td>${i + 1}</td><td>${answered.includes(qq.id) ? `<span class="badge badge-success">${esc(t('answeredLabel'))}</span>` : `<span class="badge badge-warning">${esc(t('unansweredLabel'))}</span>`}</td><td>${STATE.flagged.has(qq.id) ? `<span class="badge badge-warning">\u2691 ${esc(t('flagged'))}</span>` : '<span class="faint">\u2014</span>'}</td><td><button class="btn btn-sm" data-i="${i}">${esc(t('edit'))}</button></td></tr>`).join('')}</tbody></table></div>
  `, { timer: true, nav: `<div class="pnav"><button class="btn" id="backBtn">${esc(t('back'))}</button><button class="btn btn-gold" id="submitBtn">${esc(t('submit'))}</button></div>` });
  startTimer();
  $$('button[data-i]').forEach((b) => (b.onclick = () => { STATE.idx = Number(b.dataset.i); STATE.step = 'question'; showQuestion(); }));
  $('#backBtn').onclick = () => { STATE.idx = STATE.questions.length - 1; STATE.step = 'question'; showQuestion(); };
  $('#submitBtn').onclick = () => {
    if (!confirm(t('submitConfirm'))) return;
    doSubmit();
  };
}

// Guard so the countdown, a retry and a manual tap cannot fire three requests.
// The server is idempotent anyway; this just keeps the UI sane.
let SUBMITTING = false;

async function doSubmit() {
  if (SUBMITTING) return;
  SUBMITTING = true;
  try {
    const res = await exam('/submit', { method: 'POST' });
    localStorage.removeItem(LS_KEY);
    if (res.status === 'AUTO_SUBMITTED') return renderTimeExpired(res);
    renderDone(res.submittedAt);
  } catch (e) {
    // Already finalized (e.g. the server swept it first) — show the real outcome
    // rather than an error the candidate can do nothing about.
    if (e.data && (e.data.alreadySubmitted || e.data.autoSubmitted)) {
      localStorage.removeItem(LS_KEY);
      if (e.data.status === 'AUTO_SUBMITTED') return renderTimeExpired(e.data);
      return renderDone(e.data.submittedAt);
    }
    toast((e.data && e.data.error) || 'Submission failed. Please try again.');
  } finally {
    SUBMITTING = false;
  }
}

// Fired by the countdown reaching zero. No confirmation prompt: the candidate's
// time is over and there is nothing left to decide.
async function autoSubmit() {
  if (SUBMITTING) return;
  SUBMITTING = true;
  try {
    const res = await exam('/submit', { method: 'POST' });
    localStorage.removeItem(LS_KEY);
    renderTimeExpired(res);
  } catch (e) {
    localStorage.removeItem(LS_KEY);
    if (e.data && (e.data.autoSubmitted || e.data.alreadySubmitted)) return renderTimeExpired(e.data);
    // Even if this request failed (offline, asleep), the server finalizes the
    // assessment on its own. Tell the candidate the truth: their time is over.
    renderTimeExpired({ submittedAt: null, offline: true });
  } finally {
    SUBMITTING = false;
  }
}

// Paused by an administrator. The countdown is frozen server-side, so the
// candidate loses nothing by waiting; this screen polls until it resumes.
function renderPaused(info) {
  info = info || {};
  clearInterval(STATE.timerInterval);
  STATE.step = 'paused';
  const left = info.remainingSeconds != null
    ? `<p class="faint" style="margin-top:10px;">${esc(t('pausedRemaining', Math.floor(info.remainingSeconds / 60), info.remainingSeconds % 60))}</p>`
    : '';
  shell(`<div style="text-align:center;padding-top:30px;">
    <div style="font-size:44px;margin-bottom:10px;">⏸</div>
    <h2>${esc(t('pausedTitle'))}</h2>
    <p class="muted" style="margin-top:8px;">${esc(t('pausedByAdmin'))}</p>
    <p class="muted" style="margin-top:6px;">${esc(t('pausedSafe'))}</p>
    ${left}
  </div>`);
  // Poll gently until an administrator resumes it.
  clearTimeout(STATE.pausePoll);
  STATE.pausePoll = setTimeout(boot, 7000);
}

function renderTerminated(info) {
  clearInterval(STATE.timerInterval);
  STATE.step = 'done';
  shell(`<div style="text-align:center;padding-top:30px;">
    <div style="font-size:44px;margin-bottom:10px;">■</div>
    <h2>${esc(t('endedTitle'))}</h2>
    <p class="muted" style="margin-top:8px;">${esc(t('endedByAdmin'))}</p>
    <p class="muted" style="margin-top:6px;">${esc(t('endedContact'))}</p>
    <p class="faint" style="margin-top:14px;">${info && info.submittedAt ? esc(t('endedAt')) + ' ' + new Date(info.submittedAt).toLocaleString() : ''}</p>
  </div>`);
}

function renderTimeExpired(info) {
  info = info || {};
  clearInterval(STATE.timerInterval);
  STATE.step = 'done';
  const counts = (info.answered != null && info.unanswered != null)
    ? `<p class="faint" style="margin-top:10px;">${esc(t('answeredUnanswered', info.answered, info.unanswered))}</p>`
    : '';
  shell(`<div style="text-align:center;padding-top:30px;">
    <div style="font-size:44px;margin-bottom:10px;">⏱</div>
    <h2>${esc(t('timeExpiredTitle'))}</h2>
    <p class="muted" style="margin-top:8px;">${esc(t('timeEnded'))}</p>
    <p class="muted" style="margin-top:6px;">${esc(t('autoSubmittedMsg'))}</p>
    <p class="muted" style="margin-top:6px;">${esc(t('thanks'))}</p>
    ${counts}
    <p class="faint" style="margin-top:14px;">${info.submittedAt ? esc(t('submittedAtLabel')) + ' ' + new Date(info.submittedAt).toLocaleString() : ''}</p>
  </div>`);
}

// The candidate's own receipt. It carries only what they already know —
// their name, their LALCO ID, which assessment they sat and when they
// submitted it. No score, no answer, no marking information of any kind:
// results are not the candidate's to print, and nothing here is graded yet.
function renderDone(submittedAt) {
  clearInterval(STATE.timerInterval);
  shell(`<div style="text-align:center;padding-top:30px;">
    <div style="font-size:44px;margin-bottom:10px;">✓</div>
    <h2>${esc(t('submittedTitle'))}</h2>
    <p class="muted" style="margin-top:8px;">${esc(t('submittedThanks'))}</p>
  </div>
  <div class="receipt" id="receipt">
    <div class="receipthead"><b>LALCO</b> — ${esc(t('receiptTitle'))}</div>
    <table class="receiptkv">
      <tr><th>${esc(t('receiptCandidate'))}</th><td>${esc(STATE.candidateName || '')}</td></tr>
      ${STATE.candidateCode ? `<tr><th>${esc(t('receiptId'))}</th><td>${esc(STATE.candidateCode)}</td></tr>` : ''}
      <tr><th>${esc(t('receiptAssessment'))}</th><td>${esc(STATE.assessmentName || 'LALCO Recruitment Assessment')}</td></tr>
      <tr><th>${esc(t('submittedAtLabel'))}</th><td>${esc(submittedAt ? new Date(submittedAt).toLocaleString() : '')}</td></tr>
      <tr><th>${esc(t('receiptStatus'))}</th><td>${esc(t('receiptStatusValue'))}</td></tr>
    </table>
    <p class="faint" style="font-size:11px;margin:10px 0 0;">${esc(t('receiptNoResults'))}</p>
  </div>
  <div style="text-align:center;margin-top:16px;" class="no-print">
    <button class="btn" id="printReceipt">${esc(t('printConfirmation'))}</button>
  </div>`, { language: false });
  const p = $('#printReceipt');
  if (p) p.onclick = () => window.print();
}

document.addEventListener('visibilitychange', () => {
  if (STATE.step === 'question' && document.hidden) {
    exam('/event', { method: 'POST', body: JSON.stringify({ type: 'VISIBILITY_CHANGE' }) }).catch(() => {});
  }
});

boot();
