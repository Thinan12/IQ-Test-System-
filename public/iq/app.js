'use strict';
// LALCO reasoning (IQ) test — candidate portal.
//
// It talks to the SAME /api/exam endpoints as the recruitment assessment, so
// the session, the server-authoritative deadline, autosave, the language
// column and server-side marking are the ones already in production. Only the
// presentation differs: one question at a time, multiple choice, a progress
// bar, and a review summary before submitting.
//
// Nothing here can reveal an answer: the candidate API never sends `expected`,
// a tolerance, an explanation or a mark scheme, and this file never asks for
// one. The score is computed on the server when the test is submitted.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TOKEN = (location.pathname.match(/\/iq\/([^/?#]+)/) || [])[1] || '';
const LS_KEY = 'lalco_iq_' + TOKEN;

let STATE = {
  step: 'loading',
  questions: [],
  idx: 0,
  answers: {},          // questionId -> canonical option value
  expiresAt: null,
  timerInterval: null,
  language: 'en',
  switchingLanguage: false,
  candidateName: null,
  assessmentName: null,
  durationMinutes: null,
  questionCount: 0,
};

// ---------------------------------------------------------------- strings
// English is the source language. A null Lao entry falls back to English
// rather than showing an empty control.
//
// The Lao below is reused VERBATIM from the strings already supplied for the
// recruitment portal — the same words for the same concepts. Nothing new has
// been invented here: anything this test needs that the other portal did not
// already have is left null, so a Lao candidate reads correct English rather
// than a guess. See public/exam/app.js for the same policy.
const UI = {
  en: {
    langLabel: 'English', otherLangLabel: 'ລາວ',
    title: 'Reasoning Test',
    loading: 'Loading your test…',
    invalidLink: 'Invalid link',
    noToken: 'No test token was found in this URL.',
    linkUnavailable: 'Test link unavailable',
    candidateLabel: 'Candidate',
    questionsLabel: 'Questions', durationLabel: 'Duration', minutesLabel: 'minutes',
    chooseLanguage: 'Choose your language',
    rule1: 'Each question has one correct answer.',
    rule2: 'Your answers are saved automatically as you go.',
    rule3: 'You may move backwards and forwards between questions.',
    rule4: 'You can change language at any time without losing your answers.',
    rule5: 'The test ends automatically when the time runs out.',
    confirmIdentity: 'Confirm your identity',
    candidateIdLabel: 'Candidate ID',
    acknowledge: 'I understand the instructions.',
    start: 'Start Test', starting: 'Starting…',
    questionOf: (i, n) => `Question ${i} of ${n}`,
    answeredOf: (a, n) => `${a} of ${n} answered`,
    previous: 'Previous', next: 'Next', review: 'Review Answers',
    back: 'Back', submit: 'Submit Test', saving: 'Saving…', switching: 'Switching…',
    reviewTitle: 'Review your answers',
    answered: 'Answered', unanswered: 'Unanswered', edit: 'Edit',
    unansweredWarning: (n) => `You have ${n} unanswered question(s).`,
    canGoBack: 'You can go back before submitting.',
    submitConfirm: 'Submit your test? You will not be able to change your answers afterwards.',
    submittedTitle: 'Test submitted',
    submittedThanks: 'Thank you for completing the LALCO reasoning test. Our HR team will contact you about the next steps.',
    resultsNotShown: 'Your result is not shown here. LALCO HR will contact you about the outcome.',
    timeExpiredTitle: 'TIME EXPIRED',
    timeEnded: 'Your time has ended.',
    autoSubmitted: 'Your saved answers have been submitted automatically.',
    thanks: 'Thank you.',
    pausedTitle: 'Test paused',
    pausedByAdmin: 'An administrator has paused your test.',
    pausedSafe: 'Your answers are saved and your remaining time is frozen. Please wait — this page will continue automatically.',
    endedTitle: 'Test ended',
    endedByAdmin: 'This test was ended by an administrator. The answers you had saved have been submitted.',
    laoUnavailable: 'Lao translation not available for this question. The English version is shown below.',
    laoUnavailableTitle: 'ບໍ່ມີການແປພາສາລາວ',
    categories: {
      NUMERICAL: 'Numerical reasoning', LOGICAL: 'Logical reasoning',
      PATTERN: 'Pattern recognition', VERBAL: 'Verbal reasoning',
      SPATIAL: 'Spatial reasoning', SEQUENCE: 'Sequence reasoning',
    },
  },
  lo: {
    langLabel: 'ລາວ', otherLangLabel: 'English',
    title: null,
    loading: null,
    invalidLink: null, noToken: null, linkUnavailable: null,
    candidateLabel: 'ຜູ້ສະໝັກ',
    questionsLabel: 'ຄຳຖາມ', durationLabel: 'ໄລຍະເວລາ', minutesLabel: 'ນາທີ',
    chooseLanguage: null,
    rule1: null, rule2: null, rule3: null, rule4: null, rule5: null,
    confirmIdentity: null,
    candidateIdLabel: null,
    acknowledge: null,
    start: 'ເລີ່ມການປະເມີນ', starting: 'ກຳລັງເລີ່ມ…',
    questionOf: null,
    answeredOf: null,
    previous: 'ກ່ອນໜ້າ', next: 'ຕໍ່ໄປ', review: 'ກວດຄືນຄຳຕອບ',
    back: 'ກັບຄືນ', submit: 'ສົ່ງການປະເມີນ', saving: 'ກຳລັງບັນທຶກ…', switching: 'ກຳລັງປ່ຽນ…',
    reviewTitle: null,
    answered: 'ຕອບແລ້ວ', unanswered: 'ຍັງບໍ່ໄດ້ຕອບ', edit: 'ແກ້ໄຂ',
    unansweredWarning: null, canGoBack: null, submitConfirm: null,
    submittedTitle: null, submittedThanks: null, resultsNotShown: null,
    timeExpiredTitle: null, timeEnded: null, autoSubmitted: null, thanks: null,
    pausedTitle: null, pausedByAdmin: null, pausedSafe: null,
    endedTitle: null, endedByAdmin: null,
    laoUnavailable: null,
    laoUnavailableTitle: 'ບໍ່ມີການແປພາສາລາວ',
    categories: null,
  },
};

function t(key, ...args) {
  const lang = STATE.language === 'lo' ? 'lo' : 'en';
  let v = UI[lang] && UI[lang][key];
  if (v === null || v === undefined) v = UI.en[key];
  return typeof v === 'function' ? v(...args) : v;
}
function categoryLabel(key) {
  const lang = STATE.language === 'lo' ? 'lo' : 'en';
  const table = (UI[lang] && UI[lang].categories) || UI.en.categories;
  return (table && table[key]) || (UI.en.categories[key] || key || '');
}

// -------------------------------------------------------------------- api
async function api(path, opts = {}) {
  const res = await fetch('/api/exam/' + TOKEN + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.error) || t('requestFailed') || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg) {
  let w = $('.toast-wrap');
  if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  w.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ------------------------------------------------------------------ shell
function shell(inner, opts = {}) {
  document.title = 'LALCO ' + t('title');
  $('#app').innerHTML = `<div class="portal">
    <div class="ptop"><div class="row1">
      <div class="pbrand"><div class="mark"></div>LALCO ${esc(t('title'))}</div>
      <div style="display:flex;align-items:center;gap:10px;">
        ${opts.language === false ? '' : languageToggleHTML()}
        ${opts.timer ? '<div class="timer" id="timer">--:--</div>' : ''}
      </div></div>
      ${opts.progress ? progressHTML() : ''}
    </div>
    <div class="pbody">${inner}</div>
    ${opts.nav || ''}
  </div>`;
}

function progressHTML() {
  const total = STATE.questions.length || 1;
  const done = Object.keys(STATE.answers).length;
  const pct = Math.round((Math.min(STATE.idx + 1, total) / total) * 100);
  return `<div class="pmeta"><span>${esc(t('questionOf', Math.min(STATE.idx + 1, total), total))}</span>
    <span>${esc(t('answeredOf', done, total))}</span></div>
    <div class="progress"><span style="width:${pct}%"></span></div>`;
}

function languageToggleHTML() {
  const lang = STATE.language || 'en';
  const btn = (code, label) => `<button type="button" class="${lang === code ? 'active' : ''}" data-lang="${code}"${lang === code ? ' aria-current="true"' : ''}>${label}</button>`;
  return `<div class="langswitch" id="langSwitch" role="group" aria-label="Language">${btn('en', 'English')}${btn('lo', 'ລາວ')}</div>`;
}

// Switching language changes PRESENTATION only. The current answer is written
// to the server first, so nothing a candidate has chosen can be lost by it, and
// the server keeps the same session, the same deadline and the same answers.
function wireLanguageToggle(onSwitched) {
  $$('#langSwitch [data-lang]').forEach((btn) => {
    btn.onclick = async () => {
      const next = btn.dataset.lang;
      if (next === STATE.language || STATE.switchingLanguage) return;
      STATE.switchingLanguage = true;
      $$('#langSwitch [data-lang]').forEach((b) => { b.disabled = true; });
      try {
        if (STATE.step === 'instructions') {
          // No session yet: hold the choice locally and send it with /start.
          STATE.language = next;
          if (typeof onSwitched === 'function') await onSwitched();
          return;
        }
        await saveCurrentAnswer();
        const res = await api('/language', { method: 'POST', body: JSON.stringify({ language: next }) });
        STATE.language = res.language;
        if (res.expiresAt) STATE.expiresAt = res.expiresAt;
        await reloadQuestions();
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

// ------------------------------------------------------------------ timer
// Display only. The deadline is the server's: it finalizes an expired test on
// any request, and the sweep finalizes one nobody is looking at. This clock
// exists so the candidate can see the time, not to decide when time is up.
function startTimer() {
  stopTimer();
  const tick = () => {
    const el = $('#timer');
    if (!el || !STATE.expiresAt) return;
    const left = Math.max(0, Math.floor((new Date(STATE.expiresAt) - Date.now()) / 1000));
    const m = Math.floor(left / 60), s = left % 60;
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('low', left <= 120);
    if (left <= 0) { stopTimer(); handleTimeUp(); }
  };
  tick();
  STATE.timerInterval = setInterval(tick, 1000);
}
function stopTimer() { if (STATE.timerInterval) { clearInterval(STATE.timerInterval); STATE.timerInterval = null; } }

async function handleTimeUp() {
  try {
    const info = await api('');
    if (info.session && (info.session.status === 'AUTO_SUBMITTED' || info.session.status === 'SUBMITTED')) {
      return renderTimeExpired(info.session);
    }
    renderTimeExpired({});
  } catch (e) {
    renderTimeExpired((e.data && e.data) || {});
  }
}

// ----------------------------------------------------------------- screens
function renderInstructions(info) {
  STATE.step = 'instructions';
  const v = info.verification || {};
  shell(`
    <h2 style="margin-bottom:6px;">${esc(t('title'))}</h2>
    <p class="faint" style="margin-bottom:16px;">${esc(t('candidateLabel'))}: <b>${esc(info.candidateName || '')}</b></p>
    <div class="card">
      <div class="section-title">${esc(info.assessmentName || t('title'))}</div>
      <p style="font-size:13px;">${esc(t('questionsLabel'))}: <b>${info.questionCount}</b> · ${esc(t('durationLabel'))}: <b>${info.durationMinutes} ${esc(t('minutesLabel'))}</b></p>
      <ul style="padding-left:18px;font-size:13.5px;line-height:1.7;">
        <li>${esc(t('rule1'))}</li><li>${esc(t('rule2'))}</li><li>${esc(t('rule3'))}</li>
        <li>${esc(t('rule4'))}</li><li>${esc(t('rule5'))}</li>
      </ul>
    </div>
    <div class="card" style="margin-top:14px;">
      <div class="section-title">${esc(t('confirmIdentity'))}</div>
      ${v.requireCandidateId ? `<div class="field"><label class="field-label" for="vCode">${esc(t('candidateIdLabel'))}</label><input id="vCode" placeholder="LALCO-2026-00021"></div>` : ''}
      <label class="qopt" style="margin-top:6px;"><input type="checkbox" id="ack"><span>${esc(t('acknowledge'))}</span></label>
      <div id="startErr" class="faint" style="color:var(--danger);margin-top:8px;"></div>
      <button class="btn btn-primary" id="startBtn" style="width:100%;justify-content:center;margin-top:10px;" disabled>${esc(t('start'))}</button>
    </div>`, { timer: false });

  wireLanguageToggle(() => renderInstructions(info));
  const ack = $('#ack');
  const btn = $('#startBtn');
  ack.onchange = () => { btn.disabled = !ack.checked; };
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = t('starting');
    $('#startErr').textContent = '';
    try {
      const body = { language: STATE.language };
      if ($('#vCode')) body.candidateCode = $('#vCode').value.trim();
      const res = await api('/start', { method: 'POST', body: JSON.stringify(body) });
      STATE.expiresAt = res.expiresAt;
      STATE.language = res.language || STATE.language;
      STATE.assessmentName = res.assessmentName || STATE.assessmentName;
      await reloadQuestions();
      STATE.idx = 0;
      renderQuestion();
    } catch (e) {
      if (e.status === 423) return renderPaused(e.data || {});
      if (e.status === 410) return renderTimeExpired(e.data || {});
      $('#startErr').textContent = (e.data && e.data.error) || 'Could not start the test.';
      btn.disabled = false;
      btn.textContent = t('start');
    }
  };
}

// The question list carries every question plus which ones already have an
// answer, so a reload rebuilds the whole state from the server.
async function reloadQuestions() {
  const res = await api('/questions');
  STATE.questions = res.questions || [];
  STATE.language = res.language || STATE.language;
  if (res.expiresAt) STATE.expiresAt = res.expiresAt;
  STATE.answers = {};
  // Saved answers come back per question; fetch them lazily as the candidate
  // navigates, but seed the answered set now so the progress bar is right.
  (res.answered || []).forEach((id) => { STATE.answers[id] = STATE.answers[id] || '__saved__'; });
  return res;
}

function currentQuestion() { return STATE.questions[STATE.idx] || null; }

async function renderQuestion() {
  const q = currentQuestion();
  if (!q) return renderReview();
  STATE.step = 'question';

  // Fetch the saved answer for this question so a reload, a language switch or
  // going back always shows what the candidate actually chose.
  let saved = null;
  try {
    const one = await api('/question/' + encodeURIComponent(q.id));
    saved = one.savedAnswer || null;
    if (one.question) STATE.questions[STATE.idx] = one.question;
  } catch (e) {
    if (e.status === 423) return renderPaused(e.data || {});
    if (e.status === 410) return renderTimeExpired(e.data || {});
  }
  const question = STATE.questions[STATE.idx];
  const part = (question.parts || [])[0] || { key: 'answer', options: [] };
  const chosen = saved && saved[part.key] !== undefined ? String(saved[part.key]) : null;
  if (chosen) STATE.answers[question.id] = chosen;

  const last = STATE.idx === STATE.questions.length - 1;
  shell(`
    ${question.laoUnavailable ? `<div class="notice"><b>${esc(t('laoUnavailableTitle'))}</b><div class="faint" style="margin-top:4px;">${esc(t('laoUnavailable'))}</div></div>` : ''}
    <div class="qcat">${esc(categoryLabel(question.category))}</div>
    <div class="qstem">${esc(question.text)}</div>
    <div id="opts">${(part.options || []).map((o, i) => `
      <label class="qopt ${chosen === String(o.value) ? 'checked' : ''}">
        <input type="radio" name="opt" value="${esc(o.value)}" ${chosen === String(o.value) ? 'checked' : ''}>
        <span class="qoptval">${esc(String.fromCharCode(65 + i))}</span><span>${esc(o.label)}</span>
      </label>`).join('')}</div>
  `, {
    timer: true,
    progress: true,
    nav: `<div class="pnav">
      <button class="btn" id="prevBtn" ${STATE.idx === 0 ? 'disabled' : ''}>${esc(t('previous'))}</button>
      <button class="btn btn-primary" id="nextBtn">${esc(last ? t('review') : t('next'))}</button>
    </div>`,
  });

  startTimer();
  wireLanguageToggle(() => renderQuestion());

  $$('#opts input[type="radio"]').forEach((input) => {
    input.onchange = async () => {
      $$('#opts .qopt').forEach((l) => l.classList.remove('checked'));
      input.closest('.qopt').classList.add('checked');
      STATE.answers[question.id] = input.value;
      persistLocal();
      await saveCurrentAnswer();
      const bar = $('.progress > span');
      if (bar) $('.pmeta').innerHTML = `<span>${esc(t('questionOf', STATE.idx + 1, STATE.questions.length))}</span><span>${esc(t('answeredOf', Object.keys(STATE.answers).length, STATE.questions.length))}</span>`;
    };
  });

  $('#prevBtn').onclick = async () => { await move(-1); };
  $('#nextBtn').onclick = async () => { await move(1); };
}

async function move(delta) {
  const btn = delta > 0 ? $('#nextBtn') : $('#prevBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('saving'); }
  try {
    await saveCurrentAnswer();
    STATE.idx = Math.max(0, STATE.idx + delta);
    persistLocal();
    if (STATE.idx >= STATE.questions.length) return renderReview();
    await renderQuestion();
  } catch (e) {
    if (e.status === 423) return renderPaused(e.data || {});
    if (e.status === 410) return renderTimeExpired(e.data || {});
    if (btn) { btn.disabled = false; btn.textContent = delta > 0 ? t('next') : t('previous'); }
    toast((e.data && e.data.error) || 'Could not save your answer. Please try again.');
  }
}

// Autosave. The answer is written as the canonical option VALUE — the same
// string the server marks against — so the language on screen is irrelevant to
// the result.
async function saveCurrentAnswer() {
  const q = currentQuestion();
  if (!q) return;
  const value = STATE.answers[q.id];
  if (!value || value === '__saved__') return;
  const part = (q.parts || [])[0] || { key: 'answer' };
  await api('/answer', {
    method: 'POST',
    body: JSON.stringify({ questionId: q.id, answer: { [part.key]: value }, timeSpentDeltaSeconds: 0 }),
  });
}

function persistLocal() {
  // Only the cursor position, as a convenience. The answers themselves live on
  // the server: local storage is never treated as the record.
  try { localStorage.setItem(LS_KEY, JSON.stringify({ idx: STATE.idx })); } catch (e) {}
}

async function renderReview() {
  STATE.step = 'review';
  await saveCurrentAnswer();
  const res = await reloadQuestions();
  const answered = new Set(res.answered || []);
  const missing = STATE.questions.filter((q) => !answered.has(q.id)).length;

  shell(`
    <h2 style="margin-bottom:12px;">${esc(t('reviewTitle'))}</h2>
    <div class="grid grid-2" style="margin-bottom:16px;">
      <div class="kpi"><div class="num">${answered.size}</div><div class="lbl">${esc(t('answered'))}</div></div>
      <div class="kpi"><div class="num">${missing}</div><div class="lbl">${esc(t('unanswered'))}</div></div>
    </div>
    ${missing ? `<div class="notice"><b>${esc(t('unansweredWarning', missing))}</b> ${esc(t('canGoBack'))}</div>` : ''}
    <div class="table-wrap"><table class="summary"><thead><tr><th>#</th><th></th><th></th><th></th></tr></thead>
      <tbody>${STATE.questions.map((q, i) => `<tr>
        <td>${i + 1}</td>
        <td class="faint">${esc(categoryLabel(q.category))}</td>
        <td>${answered.has(q.id) ? `<span class="badge badge-success">${esc(t('answered'))}</span>` : `<span class="badge badge-warning">${esc(t('unanswered'))}</span>`}</td>
        <td><button class="btn btn-sm" data-i="${i}">${esc(t('edit'))}</button></td>
      </tr>`).join('')}</tbody></table></div>
  `, {
    timer: true,
    nav: `<div class="pnav">
      <button class="btn" id="backBtn">${esc(t('back'))}</button>
      <button class="btn btn-gold" id="submitBtn">${esc(t('submit'))}</button>
    </div>`,
  });

  startTimer();
  wireLanguageToggle(() => renderReview());
  $$('button[data-i]').forEach((b) => (b.onclick = async () => { STATE.idx = Number(b.dataset.i); await renderQuestion(); }));
  $('#backBtn').onclick = async () => { STATE.idx = Math.max(0, STATE.questions.length - 1); await renderQuestion(); };
  $('#submitBtn').onclick = async () => {
    if (!confirm(t('submitConfirm'))) return;
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = t('saving');
    try {
      const res = await api('/submit', { method: 'POST' });
      stopTimer();
      try { localStorage.removeItem(LS_KEY); } catch (e) {}
      if (res.status === 'AUTO_SUBMITTED') return renderTimeExpired(res);
      renderDone(res.submittedAt);
    } catch (e) {
      if (e.status === 423) return renderPaused(e.data || {});
      if (e.status === 410) return renderTimeExpired(e.data || {});
      if (e.data && (e.data.alreadySubmitted || e.data.autoSubmitted)) return renderDone(null);
      btn.disabled = false;
      btn.textContent = t('submit');
      toast((e.data && e.data.error) || 'Submission failed. Please try again.');
    }
  };
}

// The candidate is told the test was received. No score, no pass/fail, no
// per-question outcome: results are HR's to release.
function renderDone(submittedAt) {
  STATE.step = 'done';
  stopTimer();
  shell(`<div style="text-align:center;padding-top:40px;">
    <div style="font-size:42px;">✓</div>
    <h2>${esc(t('submittedTitle'))}</h2>
    <p class="muted" style="margin-top:8px;">${esc(t('submittedThanks'))}</p>
    <p class="faint" style="margin-top:14px;">${submittedAt ? esc(new Date(submittedAt).toLocaleString()) : ''}</p>
    <p class="faint" style="margin-top:10px;font-size:11.5px;">${esc(t('resultsNotShown'))}</p>
  </div>`, { language: false });
}

function renderTimeExpired(info) {
  STATE.step = 'expired';
  stopTimer();
  shell(`<div style="text-align:center;padding-top:40px;">
    <h2>${esc(t('timeExpiredTitle'))}</h2>
    <p class="muted" style="margin-top:8px;">${esc(t('timeEnded'))}</p>
    <p class="muted" style="margin-top:6px;">${esc(t('autoSubmitted'))}</p>
    <p class="muted" style="margin-top:6px;">${esc(t('thanks'))}</p>
    <p class="faint" style="margin-top:14px;">${info && info.submittedAt ? esc(new Date(info.submittedAt).toLocaleString()) : ''}</p>
  </div>`, { language: false });
}

function renderPaused(info) {
  STATE.step = 'paused';
  stopTimer();
  shell(`<div style="text-align:center;padding-top:40px;">
    <h2>${esc(t('pausedTitle'))}</h2>
    <p class="muted" style="margin-top:8px;">${esc(t('pausedByAdmin'))}</p>
    <p class="muted" style="margin-top:6px;">${esc(t('pausedSafe'))}</p>
  </div>`, { language: false });
  setTimeout(boot, 8000);
}

function renderEnded(info) {
  STATE.step = 'ended';
  stopTimer();
  shell(`<div style="text-align:center;padding-top:40px;">
    <h2>${esc(t('endedTitle'))}</h2>
    <p class="muted" style="margin-top:8px;">${esc(t('endedByAdmin'))}</p>
  </div>`, { language: false });
}

// ------------------------------------------------------------------- boot
async function boot() {
  if (!TOKEN) {
    shell(`<div style="text-align:center;padding-top:60px;"><h2>${esc(t('invalidLink'))}</h2><p class="muted">${esc(t('noToken'))}</p></div>`, { language: false });
    return;
  }
  shell(`<p class="muted">${esc(t('loading'))}</p>`, { language: false });
  try {
    const info = await api('');
    STATE.candidateName = info.candidateName || null;
    STATE.assessmentName = info.assessmentName || null;
    STATE.questionCount = info.questionCount || 0;
    STATE.durationMinutes = info.durationMinutes || null;
    // A live session's stored language wins; otherwise the language the admin
    // chose when generating the invitation. Both come from the server, so a
    // reload or a resume lands in the same language every time.
    STATE.language = (info.session && info.session.language) || info.linkLanguage || STATE.language;

    if (info.session && info.session.status === 'AUTO_SUBMITTED') return renderTimeExpired(info.session);
    if (info.session && info.session.status === 'TERMINATED') return renderEnded(info.session);
    if (info.session && (info.session.status === 'PAUSED' || info.session.paused)) return renderPaused(info.session);
    if (info.session && info.session.status === 'SUBMITTED') return renderDone(info.session.submittedAt);
    if (info.session && info.session.status === 'IN_PROGRESS') {
      STATE.expiresAt = info.session.scheduledEndAt || info.session.expiresAt;
      await reloadQuestions();
      // Resume where they left off, but never past the end of the test.
      let idx = 0;
      try { idx = Number((JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}).idx) || 0; } catch (e) { idx = 0; }
      STATE.idx = Math.min(Math.max(0, idx), Math.max(0, STATE.questions.length - 1));
      return renderQuestion();
    }
    renderInstructions(info);
  } catch (e) {
    if (e.data && e.data.autoSubmitted) return renderTimeExpired(e.data);
    if (e.status === 423 || (e.data && e.data.paused)) return renderPaused(e.data || {});
    shell(`<div style="text-align:center;padding-top:60px;"><h2>${esc(t('linkUnavailable'))}</h2>
      <p class="muted">${esc((e.data && e.data.error) || '')}</p></div>`, { language: false });
  }
}

boot();
