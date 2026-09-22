'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&lt;'[0] === '&' ? '&amp;' : c }[c] || ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
function toast(msg) { let w = $('.toast-wrap'); if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); } const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; w.appendChild(t); setTimeout(() => t.remove(), 2600); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

const TOKEN = location.pathname.split('/').filter(Boolean)[1] || '';
const LS_KEY = 'lalco_exam_' + TOKEN;

async function exam(path, opts = {}) {
  const res = await fetch('/api/exam/' + TOKEN + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) { const err = new Error((data && data.error) || 'Request failed'); err.status = res.status; err.data = data; throw err; }
  return data;
}

let STATE = { step: 'loading', questions: [], idx: 0, expiresAt: null, timerInterval: null, integrity: { pasteEvents: 0, focusChanges: 0, largestPaste: 0 } };

function shell(inner, opts = {}) {
  document.title = 'LALCO Assessment';
  $('#app').innerHTML = `<div class="portal">
    <div class="ptop"><div class="row1"><div class="pbrand"><div class="mark"></div>LALCO Assessment</div>${opts.timer ? `<div class="timer" id="timer">--:--</div>` : ''}</div>
    ${opts.progress != null ? `<div class="progress"><div style="width:${opts.progress}%"></div></div><div class="faint" style="margin-top:5px;font-size:11.5px;">${opts.stepLabel || ''}</div>` : ''}</div>
    <div class="pbody">${inner}</div>
    ${opts.nav || ''}
  </div>`;
}

async function boot() {
  if (!TOKEN) { shell(`<div style="text-align:center;padding-top:60px;"><h2>Invalid link</h2><p class="muted">No assessment token was found in this URL.</p></div>`); return; }
  shell('<p class="muted">Loading your assessment…</p>');
  try {
    const info = await exam('');
    if (info.session && info.session.status === 'AUTO_SUBMITTED') return renderTimeExpired(info.session);
    if (info.session && info.session.status === 'SUBMITTED') return renderDone(info.session.submittedAt);
    if (info.session && info.session.status === 'IN_PROGRESS') { STATE.expiresAt = info.session.scheduledEndAt || info.session.expiresAt; return renderQuestionFlow(info); }
    renderInstructions(info);
  } catch (e) {
    // The server finalizes an expired assessment on any request, so this is the
    // normal path for a candidate who reopens the link after time ran out.
    if (e.data && e.data.autoSubmitted) return renderTimeExpired(e.data);
    shell(`<div style="text-align:center;padding-top:60px;"><h2>Assessment link unavailable</h2><p class="muted">${esc(e.data && e.data.error || e.message)}</p></div>`);
  }
}

function renderInstructions(info) {
  const v = info.verification;
  shell(`
    <h2 style="margin-bottom:6px;">Candidate Assessment</h2>
    <p class="faint" style="margin-bottom:16px;">Candidate: <b>${esc(info.candidateName)}</b> · Position: <b>${esc(info.position || '—')}</b></p>
    <div class="card">
      <div class="section-title">${esc(info.assessmentName)}</div>
      <p style="font-size:13px;">Questions: <b>${info.questionCount}</b> · Duration: <b>${info.durationMinutes} minutes</b></p>
      <ul style="padding-left:18px;font-size:13.5px;line-height:1.7;">
        <li>Answer all questions carefully.</li>
        <li>Your answers are automatically saved.</li>
        <li>Do not close the browser during the assessment.</li>
        <li>You may use a mobile phone or computer.</li>
        <li>Once submitted, the assessment cannot be changed.</li>
      </ul>
    </div>
    ${(v.requireCandidateId || v.requirePhone || v.requireDob) ? `<div class="card" style="margin-top:14px;"><div class="section-title">Confirm your identity</div>
      ${v.requireCandidateId ? `<div class="field"><label class="field-label">Candidate ID</label><input id="vCode" placeholder="LALCO-2026-00021"></div>` : ''}
      ${v.requirePhone ? `<div class="field"><label class="field-label">Phone number</label><input id="vPhone"></div>` : ''}
      ${v.requireDob ? `<div class="field"><label class="field-label">Date of birth</label><input type="date" id="vDob"></div>` : ''}
    </div>` : ''}
    <label style="display:flex;gap:10px;align-items:flex-start;margin:16px 0;font-size:13.5px;">
      <input type="checkbox" id="ack" style="width:18px;height:18px;margin-top:2px;"> <span>I understand the assessment instructions.</span>
    </label>
    <p class="faint" id="startErr" style="color:var(--danger);"></p>
  `, { nav: `<div class="pnav"><button class="btn btn-primary" id="startBtn" disabled>Start Assessment</button></div>` });
  $('#ack').onchange = (e) => { $('#startBtn').disabled = !e.target.checked; };
  $('#startBtn').onclick = async () => {
    // Already guarded: disabling here means a second tap is a no-op, so a
    // double tap cannot create two sessions.
    if ($('#startBtn').disabled) return;
    $('#startBtn').disabled = true; $('#startBtn').textContent = 'Starting…';
    try {
      const body = {};
      if (v.requireCandidateId) body.candidateCode = $('#vCode').value;
      if (v.requirePhone) body.phone = $('#vPhone').value;
      if (v.requireDob) body.dob = $('#vDob').value;
      const res = await exam('/start', { method: 'POST', body: JSON.stringify(body) });
      STATE.expiresAt = res.expiresAt;
      const qinfo = await exam('/questions');
      renderQuestionFlow({ questions: qinfo.questions });
    } catch (e) {
      $('#startErr').textContent = (e.data && e.data.error) || 'Could not start the assessment.';
      $('#startBtn').disabled = false; $('#startBtn').textContent = 'Start Assessment';
    }
  };
}

function startTimer() {
  clearInterval(STATE.timerInterval);
  STATE.timerInterval = setInterval(() => {
    const el = $('#timer'); if (!el) return;
    const remaining = Math.max(0, Math.floor((new Date(STATE.expiresAt) - Date.now()) / 1000));
    el.textContent = String(Math.floor(remaining / 60)).padStart(2, '0') + ':' + String(remaining % 60).padStart(2, '0');
    if (remaining < 120) el.classList.add('low');
    if (remaining <= 0) {
      clearInterval(STATE.timerInterval);
      // Real auto-submit. The server is authoritative and will finalize this
      // assessment regardless, but sending it immediately means the candidate
      // sees the outcome straight away instead of waiting for the sweep.
      autoSubmit();
    }
  }, 1000);
}

async function renderQuestionFlow(info) {
  const qres = info.questions ? info : await exam('/questions');
  STATE.questions = qres.questions;
  STATE.answered = new Set(qres.answered || []);
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
  STATE.idx = saved && saved.idx < STATE.questions.length ? saved.idx : 0;
  STATE.step = 'question';
  showQuestion();
}
function persistLocalProgress() { try { localStorage.setItem(LS_KEY, JSON.stringify({ idx: STATE.idx })); } catch (e) {} }

async function showQuestion() {
  const total = STATE.questions.length;
  const qMeta = STATE.questions[STATE.idx];
  const { question: q, savedAnswer } = await exam('/question/' + qMeta.id);
  const isEssay = q.type === 'ESSAY';
  let body;
  if (isEssay) {
    body = `<div class="faint" style="margin-bottom:6px;">Question ${STATE.idx + 1} of ${total} — Written response</div>
      <p style="font-size:14.5px;margin-bottom:14px;">${esc(q.text)}</p>
      <textarea id="ans" style="min-height:220px;" placeholder="Write your answer here...">${savedAnswer ? esc(savedAnswer.text) : ''}</textarea>
      <div class="faint" style="margin-top:6px;">Answer autosaves as you type.</div>`;
  } else {
    body = `<div class="faint" style="margin-bottom:6px;">Question ${STATE.idx + 1} of ${total}</div>
      <p style="font-size:14.5px;margin-bottom:14px;">${esc(q.text)}</p>
      ${q.parts.map((p) => {
        const existing = savedAnswer ? savedAnswer[p.key] : '';
        if (p.type === 'choice') return `<div class="field"><label class="field-label">${esc(p.label)}</label>${p.options.map((o) => `<label class="qopt ${existing === o ? 'checked' : ''}"><input type="radio" name="opt_${p.key}" value="${esc(o)}" ${existing === o ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`;
        return `<div class="field"><label class="field-label">${esc(p.label)}</label><input type="number" step="0.01" inputmode="decimal" id="part_${p.key}" value="${existing != null && existing !== '' ? existing : ''}"></div>`;
      }).join('')}
      <div class="faint">Answers autosave as you type.</div>`;
  }
  shell(body, {
    timer: true, progress: Math.round((STATE.idx / total) * 100), stepLabel: `Question ${STATE.idx + 1} of ${total}`,
    nav: `<div class="pnav">${STATE.idx > 0 ? '<button class="btn" id="prevBtn">Previous</button>' : ''}<button class="btn btn-primary" id="nextBtn">${STATE.idx === total - 1 ? 'Review Answers' : 'Next'}</button></div>`,
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
      // 410 means the server's deadline passed and it finalized the assessment
      // while the candidate was still typing. Show that, don't ask them to act.
      if (e.status === 410) { renderTimeExpired(e.data || {}); }
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
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
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
  if ($('#prevBtn')) $('#prevBtn').onclick = () => navigate(-1);
  $('#nextBtn').onclick = () => navigate(1);
}

async function showReview() {
  const qres = await exam('/questions');
  const answered = qres.answered || [];
  const total = STATE.questions.length;
  const unanswered = total - answered.length;
  shell(`
    <h2 style="margin-bottom:12px;">Review your answers</h2>
    <div class="grid grid-2" style="margin-bottom:16px;">
      <div class="kpi"><div class="num">${answered.length}</div><div class="lbl">Answered</div></div>
      <div class="kpi"><div class="num">${unanswered}</div><div class="lbl">Unanswered</div></div>
    </div>
    ${unanswered ? `<div class="card" style="background:var(--warning-bg);"><b>You have ${unanswered} unanswered question(s).</b> You can go back before submitting.</div>` : ''}
    <div class="table-wrap" style="margin-top:14px;"><table><thead><tr><th>#</th><th>Status</th><th></th></tr></thead>
    <tbody>${STATE.questions.map((qq, i) => `<tr><td>${i + 1}</td><td>${answered.includes(qq.id) ? '<span class="badge badge-success">Answered</span>' : '<span class="badge badge-warning">Unanswered</span>'}</td><td><button class="btn btn-sm" data-i="${i}">Edit</button></td></tr>`).join('')}</tbody></table></div>
  `, { timer: true, nav: `<div class="pnav"><button class="btn" id="backBtn">Back</button><button class="btn btn-gold" id="submitBtn">Submit Assessment</button></div>` });
  startTimer();
  $$('button[data-i]').forEach((b) => (b.onclick = () => { STATE.idx = Number(b.dataset.i); STATE.step = 'question'; showQuestion(); }));
  $('#backBtn').onclick = () => { STATE.idx = STATE.questions.length - 1; STATE.step = 'question'; showQuestion(); };
  $('#submitBtn').onclick = () => {
    if (!confirm('Submit your assessment? You will not be able to change your answers afterwards.')) return;
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

function renderTimeExpired(info) {
  info = info || {};
  clearInterval(STATE.timerInterval);
  STATE.step = 'done';
  const counts = (info.answered != null && info.unanswered != null)
    ? `<p class="faint" style="margin-top:10px;">${info.answered} answered · ${info.unanswered} unanswered</p>`
    : '';
  shell(`<div style="text-align:center;padding-top:30px;">
    <div style="font-size:44px;margin-bottom:10px;">⏱</div>
    <h2>TIME EXPIRED</h2>
    <p class="muted" style="margin-top:8px;">Your assessment time has ended.</p>
    <p class="muted" style="margin-top:6px;">Your saved answers have been submitted automatically.</p>
    <p class="muted" style="margin-top:6px;">Thank you.</p>
    ${counts}
    <p class="faint" style="margin-top:14px;">${info.submittedAt ? 'Submitted ' + new Date(info.submittedAt).toLocaleString() : ''}</p>
  </div>`);
}

function renderDone(submittedAt) {
  clearInterval(STATE.timerInterval);
  shell(`<div style="text-align:center;padding-top:30px;">
    <div style="font-size:44px;margin-bottom:10px;">✓</div>
    <h2>Assessment submitted</h2>
    <p class="muted" style="margin-top:8px;">Thank you for completing the LALCO recruitment assessment. Our HR team will contact you regarding the next steps, including your interview.</p>
    <p class="faint" style="margin-top:14px;">Submitted ${submittedAt ? new Date(submittedAt).toLocaleString() : ''}</p>
  </div>`);
}

document.addEventListener('visibilitychange', () => {
  if (STATE.step === 'question' && document.hidden) {
    exam('/event', { method: 'POST', body: JSON.stringify({ type: 'VISIBILITY_CHANGE' }) }).catch(() => {});
  }
});

boot();
