'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// SQLite's datetime() stores 'YYYY-MM-DD HH:MM:SS' in UTC with no timezone
// marker, and JavaScript parses that shape as LOCAL time — which showed every
// created_at/updated_at seven hours out in Laos. Anything stored goes through
// this before being rendered.
function parseDbDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) return new Date(s.replace(' ', 'T') + 'Z');
  return new Date(s);
}
function fmtDT(iso) { const d = parseDbDate(iso); if (!d) return '—'; return d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
function fmtT(iso) { const d = parseDbDate(iso); if (!d) return '—'; return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function toast(msg, isError) { let w = $('.toast-wrap'); if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); } const t = document.createElement('div'); t.className = 'toast' + (isError ? ' error' : ''); t.textContent = msg; w.appendChild(t); setTimeout(() => t.remove(), 3200); }

let AUTH = JSON.parse(localStorage.getItem('lalco_admin_auth') || 'null'); // {token, user}
function saveAuth() { localStorage.setItem('lalco_admin_auth', JSON.stringify(AUTH)); }

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (AUTH && AUTH.token) headers.Authorization = 'Bearer ' + AUTH.token;
  let res;
  try {
    res = await fetch('/api/admin' + path, Object.assign({}, opts, { headers }));
  } catch (e) {
    // Network down / DNS / CORS. Never let this look like a success.
    const msg = 'Could not reach the server. Check your connection and try again.';
    toast(msg, true);
    const err = new Error(msg); err.offline = true; throw err;
  }
  if (res.status === 401) {
    AUTH = null; saveAuth();
    toast('Your session expired. Please sign in again.', true);
    location.hash = '#/login'; render();
    const err = new Error('Session expired'); err.status = 401; throw err;
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.blob();
  if (!res.ok) {
    const msg = httpMessage(res.status, data && data.error);
    toast(msg, true);
    const err = new Error(msg); err.status = res.status; err.data = data; throw err;
  }
  return data;
}
async function downloadFile(path, filenameFallback) {
  const headers = {}; if (AUTH && AUTH.token) headers.Authorization = 'Bearer ' + AUTH.token;
  let res;
  try {
    res = await fetch('/api/admin' + path, { headers });
  } catch (e) {
    toast('Could not reach the server. Check your connection and try again.', true);
    return;
  }
  if (res.status === 401) { AUTH = null; saveAuth(); toast('Your session expired. Please sign in again.', true); location.hash = '#/login'; render(); return; }
  if (!res.ok) { toast(httpMessage(res.status, await safeError(res)), true); return; }
  const blob = await res.blob();
  // Never hand the user an empty file and call it a success.
  if (!blob || blob.size === 0) { toast('The server returned an empty file. Nothing was downloaded.', true); return; }
  const disp = res.headers.get('content-disposition') || '';
  const m = disp.match(/filename="(.+)"/);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = m ? m[1] : filenameFallback;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function safeError(res) {
  try { const d = await res.clone().json(); return d && d.error; } catch (e) { return null; }
}

// Turns an HTTP status into something a human can act on (section 30).
function httpMessage(status, serverMessage) {
  if (serverMessage) return serverMessage;
  const map = {
    400: 'That request was not valid. Please check the values and try again.',
    401: 'Your session expired. Please sign in again.',
    403: 'You are not authorized to do that.',
    404: 'That record could not be found.',
    409: 'That action conflicts with the current state — it may already have been done.',
    422: 'Some values were rejected. Please correct them and try again.',
    429: 'Too many requests. Please wait a moment and try again.',
    500: 'The server hit an error. Nothing was changed. Please try again.',
    503: 'That service is temporarily unavailable. Please try again shortly.',
  };
  return map[status] || ('Request failed (HTTP ' + status + ').');
}

const NAV = [
  { key: 'dashboard', label: 'Dashboard', roles: null },
  { key: 'candidates', label: 'Candidates', roles: null },
  { key: 'live', label: 'Live Assessments', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER'] },
  { key: 'links', label: 'Assessment Links', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'] },
  { key: 'assessments', label: 'Assessments', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'EVALUATOR', 'RECRUITER', 'INTERVIEWER'] },
  { key: 'questions', label: 'Question Bank', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'EVALUATOR', 'MANAGER'] },
  { key: 'interviews', label: 'Interviews', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'INTERVIEWER', 'MANAGER'] },
  { key: 'analytics', label: 'Analytics', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER'] },
  { key: 'scholarship', label: 'Scholarship Policy', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER'] },
  { key: 'users', label: 'Users', roles: ['SUPER_ADMIN'] },
  { key: 'settings', label: 'Admin Settings', roles: ['SUPER_ADMIN'] },
  { key: 'data', label: 'Data Management', roles: ['SUPER_ADMIN'] },
  { key: 'audit', label: 'Audit Logs', roles: ['SUPER_ADMIN', 'HR_ADMIN'] },
];
function navAllowed(item) { return !item.roles || (AUTH && item.roles.includes(AUTH.user.role)); }
function route() { const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean); return parts; }
function goto(p) { location.hash = '#/' + p; }
window.addEventListener('hashchange', render);
window.goto = goto;

function render() {
  const parts = route();
  if (!AUTH) return renderLogin();
  renderShell(parts.length ? parts : ['dashboard']);
}

function renderLogin() {
  document.body.innerHTML = `<div id="app"></div>`;
  $('#app').innerHTML = `
  <div class="login-wrap"><div class="login-card">
    <div style="width:44px;height:44px;border-radius:9px;background:linear-gradient(155deg,var(--gold),#8a6a22);margin-bottom:14px;"></div>
    <h2 style="margin-bottom:4px;">LALCO Admin</h2>
    <p class="muted" style="margin-bottom:18px;">Sign in to manage recruitment &amp; assessments.</p>
    <div class="field"><label class="field-label">Email</label><input type="email" id="lEmail" placeholder="hradmin@lalco.demo"></div>
    <div class="field"><label class="field-label">Password</label><input type="password" id="lPass"></div>
    <button class="btn btn-primary" id="lBtn" data-busy="Signing in…" style="width:100%;justify-content:center;padding:11px;">Sign in</button>
    <p class="faint" id="lErr" style="color:var(--danger); margin-top:10px;"></p>
    <p class="faint" style="margin-top:14px;">Demo accounts (see README): hradmin@lalco.demo, superadmin@lalco.demo, recruiter@lalco.demo, interviewer@lalco.demo, evaluator@lalco.demo, manager@lalco.demo</p>
  </div></div>`;
  $('#lBtn').onclick = async () => {
    try {
      const res = await fetch('/api/admin/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#lEmail').value, password: $('#lPass').value }) });
      const data = await res.json();
      if (!res.ok) { $('#lErr').textContent = data.error; return; }
      AUTH = data; saveAuth(); goto('dashboard'); render();
    } catch (e) { $('#lErr').textContent = 'Could not reach server.'; }
  };
}
function logout() { AUTH = null; saveAuth(); goto(''); render(); }

function sidebarHTML(active) {
  return `
    <div class="sidebar-brand">LALCO<div class="sub">Recruitment Platform</div></div>
    <nav class="sidebar-nav">${NAV.filter(navAllowed).map((n) => `<a data-nav="${n.key}" class="${n.key === active ? 'active' : ''}">${n.label}</a>`).join('')}</nav>
    <div class="sidebar-foot"><b>${esc(AUTH.user.name)}</b><span class="badge badge-neutral">${AUTH.user.role}</span><br><button class="btn btn-sm" style="margin-top:8px;" id="logoutBtn">Sign out</button></div>`;
}
let LIVE_TIMER = null;
function stopLiveRefresh() { if (LIVE_TIMER) { clearInterval(LIVE_TIMER); LIVE_TIMER = null; } }

function renderShell(parts) {
  stopLiveRefresh(); // never leave a timer running against a replaced view
  const key = parts[0];
  const item = NAV.find((n) => n.key === key);
  document.body.innerHTML = `<div id="app"></div>`;
  const app = $('#app');
  app.innerHTML = `<div class="shell"><aside class="sidebar">${sidebarHTML(key)}</aside>
    <div class="main"><div class="topbar"><h2 style="font-size:16px;">${item ? item.label : ''}</h2></div><div class="content" id="content"></div></div></div>`;
  $$('.sidebar-nav a').forEach((a) => (a.onclick = () => goto(a.dataset.nav)));
  $('#logoutBtn').onclick = logout;
  if (item && !navAllowed(item)) { $('#content').innerHTML = `<div class="empty"><h3>Not authorized</h3><p>Your role does not have access to this section.</p></div>`; return; }
  const views = { print: viewPrintCandidate, dashboard: viewDashboard, candidates: viewCandidates, live: viewLive, links: viewLinks, assessments: viewAssessments, questions: viewQuestions, interviews: viewInterviews, analytics: viewAnalytics, scholarship: viewScholarship, users: viewUsers, settings: viewSettings, data: viewDataManagement, audit: viewAudit };
  // A view that throws must show a real error with a way out, never a page
  // stuck on "Loading…" (sections 26/29/30).
  Promise.resolve()
    .then(() => (views[key] || viewDashboard)(parts.slice(1), $('#content')))
    .catch((e) => {
      if (e && e.status === 401) return; // already redirected to login
      const content = $('#content');
      if (!content) return;
      content.innerHTML = `<div class="empty"><h3>This section could not be loaded</h3>
        <p>${esc(e && e.message ? e.message : 'Unexpected error.')}</p>
        <button class="btn btn-sm" id="retryView">Retry</button></div>`;
      const retry = $('#retryView');
      if (retry) retry.onclick = () => renderShell(parts);
    });
}

// ---------------- Dashboard ----------------
async function viewDashboard(_, el) {
  el.innerHTML = 'Loading…';
  const [{ candidates }, analytics] = await Promise.all([api('/candidates'), api('/analytics')]);
  el.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:16px;">
      <div class="kpi"><div class="num">${analytics.totals.total}</div><div class="lbl">Total candidates</div></div>
      <div class="kpi"><div class="num">${analytics.totals.eligible}</div><div class="lbl">Eligible</div></div>
      <div class="kpi"><div class="num">${analytics.totals.passed}</div><div class="lbl">Passed</div></div>
      <div class="kpi"><div class="num">${analytics.totals.avgScore || '—'}</div><div class="lbl">Average final score</div></div>
    </div>
    <div class="card"><div class="section-title">Recent candidates</div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Position</th><th>Eligibility</th><th>Final</th><th>Status</th></tr></thead>
      <tbody>${candidates.slice(0, 10).map((c) => `<tr><td>${esc(c.fullName)}${c.isDemo ? ' <span class="badge badge-neutral">demo</span>' : ''}</td><td class="faint">${esc(c.appliedPosition || '—')}</td><td>${eligBadge(c.eligibilityStatus)}</td><td class="mono">${c.final ?? '—'}</td><td>${statusBadge(c.status)}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
}
function eligBadge(s) { return s === 'ELIGIBLE' ? '<span class="badge badge-success">Eligible</span>' : s === 'NOT_ELIGIBLE' ? '<span class="badge badge-danger">Not Eligible</span>' : '<span class="badge badge-warning">Pending</span>'; }
function statusBadge(s) {
  const map = { PASSED: 'success', HIRED: 'success', SCHOLARSHIP_SELECTED: 'success', FAILED: 'danger', REJECTED: 'danger', WITHDRAWN: 'neutral', DRAFT: 'neutral', INVITED: 'info', ASSESSMENT_STARTED: 'info', ASSESSMENT_COMPLETED: 'info', INTERVIEW_PENDING: 'warning' };
  return `<span class="badge badge-${map[s] || 'neutral'}">${esc(s || '—')}</span>`;
}
function riskBadge(r) { const m = { Low: 'success', Medium: 'warning', High: 'danger' }; return `<span class="badge badge-${m[r] || 'neutral'}">${r}</span>`; }

// ---------------- Candidates list ----------------
async function viewCandidates(params, el) {
  if (params[0]) return viewCandidateDetail(params, el);
  el.innerHTML = `
    <div class="card" style="margin-bottom:14px; display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
      <div class="field" style="flex:1; min-width:200px; margin:0;"><label class="field-label">Search</label><input id="fq" placeholder="Name or code"></div>
      <div class="field" style="margin:0;"><label class="field-label">Show</label>
        <select id="fArchived"><option value="">Active candidates</option><option value="1">Archived</option></select></div>
      <button class="btn btn-primary" id="newCandBtn">+ New Candidate</button>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Position</th><th>Type</th><th>Eligibility</th><th>Calc</th><th>Essay</th><th>Interview</th><th>Final</th><th>Status</th><th>AI Risk</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>`;
  async function load() {
    const q = $('#fq').value;
    const archived = $('#fArchived').value;
    const params = [];
    if (q) params.push('q=' + encodeURIComponent(q));
    if (archived) params.push('archived=1');
    const { candidates } = await api('/candidates' + (params.length ? '?' + params.join('&') : ''));
    $('#rows').innerHTML = candidates.map((c) => `<tr style="cursor:pointer" data-id="${c.id}">
      <td class="mono faint">${c.code}</td><td>${esc(c.fullName)}${c.isDemo ? ' <span class="badge badge-neutral">demo</span>' : ''}</td>
      <td class="faint">${esc(c.appliedPosition || '—')}</td><td>${c.applicationType === 'SCHOLARSHIP' ? '<span class="badge badge-info">Scholarship</span>' : '<span class="badge badge-neutral">Normal</span>'}</td>
      <td>${eligBadge(c.eligibilityStatus)}</td><td class="mono">${c.calc ?? '—'}</td><td class="mono">${c.essay ?? '—'}</td><td class="mono">${c.interview ?? '—'}</td>
      <td class="mono"><b>${c.final ?? '—'}</b></td><td>${statusBadge(c.status)}</td><td>${riskBadge(c.aiRisk)}</td><td><button class="btn btn-sm">Open →</button></td></tr>`).join('') || `<tr><td colspan="12" class="faint" style="text-align:center;padding:20px;">No candidates.</td></tr>`;
    $$('#rows tr[data-id]').forEach((tr) => (tr.onclick = () => goto('candidates/' + tr.dataset.id)));
  }
  $('#fq').addEventListener('input', debounce(load, 300));
  $('#fArchived').onchange = load;
  $('#newCandBtn').onclick = () => openNewCandidateModal(load);
  load();
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---- Duplicate-action prevention + loading states -------------------------
// Any button carrying data-busy="Label" is decorated so that clicking it
// disables it for the WHOLE async operation (not just until the click handler
// returns) and shows the label while it runs. Two rapid clicks on Generate
// Link, Save or Backup therefore produce exactly one operation.
//
// Views assign their handlers synchronously right after setting innerHTML, so
// a MutationObserver — whose callback runs after that synchronous block — is
// enough to decorate them without touching any call site. Decoration is
// idempotent, so re-renders are safe.
function decorateBusyButtons() {
  $$('button[data-busy]').forEach((btn) => {
    if (btn.dataset.guarded || typeof btn.onclick !== 'function') return;
    btn.dataset.guarded = '1';
    const original = btn.onclick;
    btn.onclick = async (event) => {
      if (btn.disabled) return;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = btn.dataset.busy || 'Working…';
      try {
        await original.call(btn, event);
      } catch (e) {
        // api() has already shown the user what went wrong. Swallowing it here
        // keeps a refused action from surfacing as an unhandled rejection and
        // leaves the button — and any modal it opened — usable for a retry.
      } finally {
        // If the action re-rendered the view the button is gone; leave it be.
        if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
      }
    };
  });
}
new MutationObserver(decorateBusyButtons).observe(document.documentElement, { childList: true, subtree: true });

// ---- Modal helper ---------------------------------------------------------
// Guarantees a modal can always be dismissed: Escape, clicking the backdrop,
// or the Cancel button. Without this a failed action could leave the page
// permanently covered by an un-closable overlay.
function makeDismissable(overlay, onClose) {
  const close = () => {
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose(); else overlay.remove();
  };
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  return close;
}

function openNewCandidateModal(onDone) {
  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(10,18,26,.45);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px;overflow:auto;';
  bg.innerHTML = `<div class="card" style="max-width:520px;width:100%;">
    <div class="section-title">New candidate</div>
    <div class="grid grid-2">
      <div class="field"><label class="field-label">Full name *</label><input id="nFullName"></div>
      <div class="field"><label class="field-label">LALCO ID (optional)</label><input id="nCode" placeholder="leave blank to generate automatically" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label class="field-label">Application type *</label><select id="nType"><option value="NORMAL">Normal Staff</option><option value="SCHOLARSHIP">Scholarship Staff</option></select></div>
      <div class="field"><label class="field-label">IQ</label><input type="number" id="nIQ"></div>
      <div class="field"><label class="field-label">Education</label><input id="nEdu" placeholder="High school / Bachelor Degree"></div>
      <div class="field"><label class="field-label">GPA</label><input type="number" step="0.1" id="nGpa"></div>
      <div class="field"><label class="field-label">Position</label><input id="nPos" placeholder="Marketing Staff"></div>
      <div class="field"><label class="field-label">Department</label><input id="nDept"></div>
      <div class="field"><label class="field-label">Branch</label><input id="nBranch"></div>
      <div class="field"><label class="field-label">Phone</label><input id="nPhone"></div>
      <div class="field"><label class="field-label">Date of birth</label><input type="date" id="nDob"></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn" id="cancelBtn">Cancel</button><button class="btn btn-primary" id="saveBtn" data-busy="Creating…">Create candidate</button></div>
  </div>`;
  document.body.appendChild(bg);
  const closeModal = makeDismissable(bg);
  $('#cancelBtn', bg).onclick = closeModal;
  const firstField = $('#nFullName', bg);
  if (firstField) firstField.focus();
  $('#saveBtn', bg).onclick = async () => {
    const fullName = $('#nFullName', bg).value.trim();
    if (!fullName) return toast('Full name is required', true);
    try {
      const customCode = $('#nCode', bg).value.trim();
      await api('/candidates', { method: 'POST', body: JSON.stringify({ fullName, code: customCode || undefined, applicationType: $('#nType', bg).value, iq: Number($('#nIQ', bg).value) || null, education: $('#nEdu', bg).value, gpa: Number($('#nGpa', bg).value) || null, position: $('#nPos', bg).value, department: $('#nDept', bg).value, branch: $('#nBranch', bg).value, phone: $('#nPhone', bg).value, dob: $('#nDob', bg).value }) });
      toast('Candidate created'); closeModal(); onDone && onDone();
    } catch (e) {}
  };
}

// ---------------- Candidate detail ----------------
let profileTab = 'overview';
async function viewCandidateDetail(params, el) {
  const id = params[0];
  el.innerHTML = 'Loading…';
  const d = await api('/candidates/' + id);
  const c = d.candidate;
  const tabs = [['overview', 'Overview'], ['eligibility', 'Eligibility'], ['assessment', 'Assessment'], ['questions', 'Questions'], ['interview', 'Interview'], ['performance', 'Performance'], ['integrity', 'Integrity'], ['reports', 'Reports'], ['audit', 'Audit']];
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;flex-wrap:wrap;">
      <div style="width:52px;height:52px;border-radius:50%;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;font-family:Georgia,serif;font-size:18px;">${esc(initials(c.full_name))}</div>
      <div style="flex:1;min-width:200px;"><h2 style="font-size:18px;">${esc(c.full_name)} <span class="faint mono" style="font-size:12px;">${c.code}</span></h2><div class="faint">${esc(c.appliedPosition || '—')} · ${esc(c.branch || '—')} · ${c.application_type}</div></div>
      <div style="display:flex;gap:8px;">${eligBadge(d.eligibility.status)}${statusBadge(c.status)}${d.scores && d.scores.final_marks != null ? `<span class="badge badge-neutral">${d.scores.final_marks}/100</span>` : ''}</div>
      <button class="btn" onclick="goto('candidates')">← Back</button>
    </div>
    <div class="tabs" id="profTabs">${tabs.map(([k, l]) => `<button data-t="${k}" class="${profileTab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="profBody"></div>`;
  $$('#profTabs button').forEach((b) => (b.onclick = () => { profileTab = b.dataset.t; viewCandidateDetail(params, el); }));
  const body = $('#profBody');
  const renderers = { overview: tabOverview, eligibility: tabEligibility, assessment: tabAssessment, questions: tabQuestions, interview: tabInterview, performance: tabPerformance, integrity: tabIntegrity, reports: tabReports, audit: tabAudit };
  (renderers[profileTab] || tabOverview)(d, body, id);
}
function initials(n) { return (n || '').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase(); }
function kv(k, v) { return `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:13px;"><span class="muted">${esc(k)}</span><span style="font-weight:500;text-align:right;">${esc(v == null || v === '' ? '—' : v)}</span></div>`; }

function tabOverview(d, el) {
  const c = d.candidate;
  el.innerHTML = `<div class="grid grid-2">
    <div class="card"><div class="section-title">Profile</div>${kv('Gender', c.gender)}${kv('DOB', c.dob)}${kv('Nationality', c.nationality)}${kv('Phone', c.phone)}${kv('Email', c.email)}${kv('Province', c.province)}${kv('Education', c.education)}${kv('GPA', c.gpa)}${kv('IQ', c.iq)}</div>
    <div class="card"><div class="section-title">Application</div>${kv('Type', c.application_type)}${kv('Department', c.appliedDepartment)}${kv('Position', c.appliedPosition)}${kv('Branch', c.branch)}${kv('Application date', c.application_date)}${kv('Batch', c.recruitment_batch)}${kv('Status', c.status)}</div>
  </div>`;
}
function tabEligibility(d, el) {
  el.innerHTML = `<div class="card"><div class="section-title">Eligibility: ${eligBadge(d.eligibility.status)}</div>
  <div class="table-wrap"><table><thead><tr><th>Condition</th><th>Candidate Value</th><th>Required</th><th>Status</th><th>Reason</th></tr></thead>
  <tbody>${d.eligibility.checks.map((ch) => `<tr><td>${ch.condition}</td><td>${esc(ch.candidateValue)}</td><td>${esc(ch.requiredValue)}</td><td>${ch.status === 'PASSED' ? '<span class="badge badge-success">PASSED</span>' : ch.status === 'FAILED' ? '<span class="badge badge-danger">FAILED</span>' : '<span class="badge badge-neutral">INFO</span>'}</td><td class="faint">${esc(ch.reason)}</td></tr>`).join('')}</tbody></table></div></div>`;
}
function tabAssessment(d, el, id) {
  const active = d.links.find((l) => l.status === 'ACTIVE');
  el.innerHTML = `<div class="grid grid-2">
    <div class="card"><div class="section-title">Secure exam link</div>
      ${active ? `<div class="mono faint" style="word-break:break-all;">${location.origin}/exam/${active.token}</div><div class="faint" style="margin-top:6px;">Created ${fmtT(active.created_at)} · Expires ${fmtT(active.expires_at)}</div>` : '<p class="faint">No active link.</p>'}
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-gold btn-sm" id="genLink" data-busy="Generating…">Generate New Link</button>
        ${active ? `<button class="btn btn-sm" id="copyLink">Copy Link</button><button class="btn btn-sm" id="copyWA">Copy WhatsApp Message</button><button class="btn btn-danger btn-sm" id="revokeLink" data-busy="Revoking…" data-link="${active.id}">Revoke Link</button>` : ''}
      </div>
    </div>
    <div class="card"><div class="section-title">Link history</div><div class="table-wrap"><table><thead><tr><th>Token</th><th>Status</th><th>Created</th><th>Expires</th><th>Accessed</th><th>Actions</th></tr></thead>
    <tbody>${d.links.map((l) => `<tr><td class="mono faint">${l.token.slice(0, 10)}…</td><td><span class="badge badge-${linkBadgeTone(l.liveStatus)}">${l.liveStatus}</span></td><td class="faint">${fmtT(l.created_at)}</td><td class="faint">${fmtT(l.expires_at)}</td><td class="faint">${l.first_access_at ? fmtT(l.first_access_at) : '—'}</td>
      <td style="white-space:nowrap;">${linkActionsHTML(l)}</td></tr>`).join('') || '<tr><td colspan="6" class="faint">No links yet.</td></tr>'}</tbody></table></div></div>
  </div>
  ${candidateLifecycleHTML(d)}
  ${submissionRecordHTML(d.session)}
  <div class="card" style="margin-top:14px;"><div class="section-title">Score summary</div><div class="grid grid-3">
    <div class="kpi"><div class="num">${d.scores ? d.scores.calc_marks : 0}/30</div><div class="lbl">Calculation</div></div>
    <div class="kpi"><div class="num">${d.scores && d.scores.essay_marks != null ? d.scores.essay_marks : '—'}/30</div><div class="lbl">Written</div></div>
    <div class="kpi"><div class="num">${d.scores && d.scores.interview_marks != null ? d.scores.interview_marks : '—'}/40</div><div class="lbl">Interview</div></div>
  </div></div>`;
  $('#genLink').onclick = async () => { await api('/candidates/' + id + '/links', { method: 'POST' }); toast('New secure link generated.'); viewCandidateDetail([id], el.parentElement); };
  if ($('#copyLink')) $('#copyLink').onclick = () => copyText(`${location.origin}/exam/${active.token}`, 'Link copied.');
  wireLinkActions(d, id, el);
  wireCandidateLifecycle(d, id, el);
  if ($('#revokeLink')) $('#revokeLink').onclick = async () => {
    if (!confirm('Revoke this assessment link? The candidate will no longer be able to open it. Link history is kept.')) return;
    await api('/candidates/links/' + $('#revokeLink').dataset.link + '/revoke', { method: 'POST' });
    toast('Assessment link revoked.');
    viewCandidateDetail([id], el.parentElement);
  };
  if ($('#copyWA')) $('#copyWA').onclick = () => { copyText(`Dear ${d.candidate.full_name},\n\nYou are invited to complete the LALCO recruitment assessment.\n\nAssessment link:\n${location.origin}/exam/${active.token}\n\nThis invitation link expires shortly. Please complete the assessment within the allocated assessment time once you begin.\n\nThank you.`, 'WhatsApp message copied.'); };
}
// How the assessment ended: manual submission or server-side automatic
// submission on time expiry. Shown to HR alongside the timing record.
function submissionRecordHTML(session) {
  if (!session) return '';
  const auto = session.submissionType === 'AUTO_SUBMITTED';
  const status = session.displayStatus || session.status;
  const badge = auto
    ? '<span class="badge badge-warning">AUTO_SUBMITTED</span>'
    : status === 'SUBMITTED'
      ? '<span class="badge badge-success">SUBMITTED</span>'
      : `<span class="badge badge-info">${esc(status)}</span>`;
  const row = (label, value) => `<tr><td class="faint" style="width:190px;">${label}</td><td>${value}</td></tr>`;
  return `<div class="card" style="margin-top:14px;"><div class="section-title">Submission record</div>
    <div class="table-wrap"><table><tbody>
      ${row('Status', badge)}
      ${row('Reason', session.submissionReason ? `<span class="mono">${esc(session.submissionReason)}</span>` : '<span class="faint">—</span>')}
      ${row('Started', session.started_at ? fmtDT(session.started_at) : '—')}
      ${row('Scheduled end', session.scheduledEndAt ? fmtDT(session.scheduledEndAt) : '—')}
      ${row('Actual end', session.submitted_at ? fmtDT(session.submitted_at) : '<span class="faint">not finished</span>')}
      ${row('Duration', session.durationLabel || '—')}
      ${row('Answered', session.answeredCount != null ? `<b>${session.answeredCount}</b>` : '—')}
      ${row('Unanswered', session.unansweredCount != null ? `<b>${session.unansweredCount}</b>` : '—')}
    </tbody></table></div>
    ${auto ? '<p class="faint" style="margin-top:8px;">The assessment time ran out. The server finalized it automatically and graded the answers the candidate had already saved; unanswered questions were left unanswered.</p>' : ''}
  </div>`;
}
// The Clipboard API rejects in insecure contexts and when permission is
// denied. Falling back keeps Copy working, and a failure is reported rather
// than silently doing nothing.
async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage);
    return;
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? successMessage : 'Could not copy automatically — please copy the link manually.', !ok);
  } catch (e2) {
    toast('Could not copy automatically — please copy the link manually.', true);
  }
}

function linkBadge(status, expiresAt) {
  let live = status;
  if (status === 'ACTIVE' && parseDbDate(expiresAt) < new Date()) live = 'EXPIRED';
  const m = { ACTIVE: 'success', EXPIRED: 'warning', USED: 'info', REVOKED: 'danger' };
  return `<span class="badge badge-${m[live]}">${live}</span>`;
}

function tabQuestions(d, el, id) {
  const calc = d.answers.filter((a) => a.type === 'CALC');
  const essay = d.answers.find((a) => a.type === 'ESSAY');
  const flags = d.answers.filter((a) => a.flagged);
  el.innerHTML = `${flagSummaryHTML(flags, d)}
    <div class="table-wrap"><table><thead><tr><th>Q</th><th>Category</th><th>Max</th><th>Score</th><th>Time</th><th>Flag</th><th>Status</th><th></th></tr></thead>
    <tbody>${calc.map((a, i) => {
      const b = a.breakdown; const status = !b ? 'SKIPPED' : b.marks === b.max ? 'PASS' : b.marks === 0 ? 'FAIL' : 'PARTIAL';
      const m = { PASS: 'success', PARTIAL: 'warning', FAIL: 'danger', SKIPPED: 'neutral' };
      return `<tr><td>Q${i + 1}</td><td class="faint">${esc(a.category)}</td><td>${a.maxMarks}</td><td class="mono">${b ? b.marks : '—'}</td><td class="faint mono">${fmtSec(a.timeSpentSeconds)}</td><td>${flagCellHTML(a)}</td><td><span class="badge badge-${m[status]}">${status}</span></td><td><button class="btn btn-sm" data-i="${i}">Details ▾</button></td></tr>
      <tr class="qd" data-d="${i}" style="display:none;"><td colspan="8">${b ? questionDetail(a, b) : '<span class="faint">Not attempted.</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>
    ${essayCard(essay, d, id)}`;
  $$('#content button[data-i]').forEach((b) => (b.onclick = () => { const r = $(`.qd[data-d="${b.dataset.i}"]`); r.style.display = r.style.display === 'none' ? 'table-row' : 'none'; }));
  wireEssayCard(d, id, el);
}
// The candidate's own "flag for review" marks, shown to evaluators as context
// for how the candidate worked. They carry no marks and never change a score.
function flagCellHTML(a) {
  if (!a.flagged) return '<span class="faint">—</span>';
  return `<span class="badge badge-warning" title="Flagged ${esc(fmtDT(a.flaggedAt))}">⚑ Flagged</span>`;
}
function flagSummaryHTML(flags, d) {
  if (!d.session) return '';
  if (!flags.length) {
    return '<p class="faint" style="margin-top:0;">The candidate flagged no questions for review.</p>';
  }
  return `<div class="card" style="background:var(--warning-bg);margin-bottom:12px;">
    <div class="section-title" style="margin-bottom:6px;">⚑ ${flags.length} question(s) the candidate flagged for review</div>
    <p class="faint" style="margin:0 0 8px;">The candidate's own bookmarks while sitting the assessment. Context only — flagging carries no marks and did not affect the score.</p>
    ${flags.map((a) => `<div style="font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--line-soft);">${esc(a.category || a.type)} <span class="faint">— flagged ${esc(fmtDT(a.flaggedAt))}</span></div>`).join('')}
  </div>`;
}
function fmtSec(s) { if (!s) return '—'; const m = Math.floor(s / 60), r = s % 60; return m + 'm ' + String(r).padStart(2, '0') + 's'; }
function questionDetail(a, b) {
  return `<div style="padding:6px 4px;"><p style="margin-bottom:8px;font-size:13px;">${esc(a.text)}</p>
  <table style="font-size:12.6px;"><thead><tr><th>Step</th><th>Candidate answer</th><th>Correct value</th><th>Marks</th></tr></thead>
  <tbody>${b.parts.map((p) => `<tr><td>${esc(p.label)}</td><td class="mono">${esc(p.submitted)}</td><td class="mono">${esc(p.expected)}</td><td class="mono">${p.awarded}/${p.max} ${p.correct ? '✓' : '✗'}</td></tr>`).join('')}</tbody></table>
  <div class="faint" style="margin-top:8px;"><b>Reason:</b> ${esc(b.reason)}</div><div class="faint"><b>Explanation:</b> ${esc(a.explanation)}</div></div>`;
}
function essayCard(essay, d, id) {
  if (!essay) return '';
  const s = d.scores;
  const rubric = [['content', 'Content'], ['accuracy', 'Accuracy'], ['reasoning', 'Reasoning'], ['communication', 'Communication'], ['professionalism', 'Professionalism']];
  const existing = s && s.essay_breakdown_json ? JSON.parse(s.essay_breakdown_json) : {};
  return `<div class="card" style="margin-top:14px;" id="essayCard"><div class="section-title">Written / Essay (30 marks)</div>
    <p style="font-size:13px;">${esc(essay.text)}</p>
    <div style="background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:12px;font-size:13px;white-space:pre-wrap;margin:10px 0;">${essay.answer ? esc(essay.answer.text) : '<span class="faint">No answer submitted.</span>'}</div>
    ${essay.answer ? `<div class="grid grid-2">${rubric.map(([k, l]) => `<div class="field"><label class="field-label">${l} (0–6)</label><input type="number" min="0" max="6" id="rub_${k}" value="${existing[k] ?? ''}"></div>`).join('')}</div>
    <div class="field"><label class="field-label">Comments</label><textarea id="essayComments">${s ? esc(s.essay_comments || '') : ''}</textarea></div>
    <button class="btn btn-primary btn-sm" id="saveEssay" data-busy="Saving…">Save essay score</button> <span class="faint">Current: ${s && s.essay_marks != null ? s.essay_marks + '/30' : 'not yet scored'}</span>` : ''}
    </div>`;
}
function wireEssayCard(d, id, el) {
  if (!$('#saveEssay')) return;
  $('#saveEssay').onclick = async () => {
    const rubricScores = {}; ['content', 'accuracy', 'reasoning', 'communication', 'professionalism'].forEach((k) => { rubricScores[k] = Number($('#rub_' + k).value) || 0; });
    await api('/candidates/' + id + '/essay-score', { method: 'POST', body: JSON.stringify({ rubricScores, comments: $('#essayComments').value }) });
    toast('Essay score saved.'); viewCandidateDetail([id], el.closest('#content'));
  };
}

function tabInterview(d, el, id) {
  el.innerHTML = 'Loading…';
  Promise.all([api('/questions/interview/questions'), api('/questions/interview/criteria')]).then(([qres, cres]) => {
    const s = d.scores; const existing = s && s.interview_breakdown_json ? JSON.parse(s.interview_breakdown_json) : {};
    el.innerHTML = `<div class="card"><div class="section-title">Interview questions</div>${qres.questions.filter((q) => q.active).map((q) => `<div style="padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:13px;">${esc(q.text)} ${q.disqualifying ? '<span class="badge badge-warning">Can disqualify</span>' : ''}</div>`).join('')}</div>
    <div class="card" style="margin-top:14px;"><div class="section-title">Scoring rubric (40 marks)</div><div class="grid grid-2">${cres.criteria.map((c) => `<div class="field"><label class="field-label">${c.label} (0–${c.max_marks}) <span class="faint">${esc(c.hint || '')}</span></label><input type="number" min="0" max="${c.max_marks}" id="crit_${c.key}" value="${existing[c.key] ?? ''}"></div>`).join('')}</div>
    <div class="field"><label class="field-label">Comments</label><textarea id="ivComments">${s ? esc(s.interview_comments || '') : ''}</textarea></div>
    <button class="btn btn-primary btn-sm" id="saveIv" data-busy="Saving…">Save interview score</button> <span class="faint">Current: ${s && s.interview_marks != null ? s.interview_marks + '/40' : 'not yet scored'}</span></div>`;
    $('#saveIv').onclick = async () => {
      const scores = {}; cres.criteria.forEach((c) => { scores[c.key] = Number($('#crit_' + c.key).value) || 0; });
      await api('/candidates/' + id + '/interview-score', { method: 'POST', body: JSON.stringify({ scores, comments: $('#ivComments').value }) });
      toast('Interview score saved.'); viewCandidateDetail([id], el.closest('#content'));
    };
  });
}

function tabPerformance(d, el, id) {
  api('/candidates/' + id + '/failure-analysis').then((fa) => {
    const times = d.answers.filter((a) => a.type === 'CALC').map((a) => a.timeSpentSeconds).filter((t) => t > 0);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    el.innerHTML = `<div class="grid grid-4" style="margin-bottom:14px;">
      <div class="kpi"><div class="num">${d.scores ? d.scores.final_marks ?? '—' : '—'}</div><div class="lbl">Total score</div></div>
      <div class="kpi"><div class="num">${times.length}/6</div><div class="lbl">Calc questions answered</div></div>
      <div class="kpi"><div class="num">${avg ? fmtSec(Math.round(avg)) : '—'}</div><div class="lbl">Avg. question time</div></div>
      <div class="kpi"><div class="num">${d.session && d.session.submitted_at ? '✓' : '—'}</div><div class="lbl">Submitted</div></div>
    </div>
    <div class="card"><div class="section-title">${fa.headline}</div><ul style="padding-left:18px;">${fa.detail.map((l) => `<li style="margin-bottom:6px;">${esc(l)}</li>`).join('')}</ul>${fa.gaps && fa.gaps.length ? `<div class="faint"><b>Gaps:</b><ul style="padding-left:18px;">${fa.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}</div>`;
  });
}
function tabIntegrity(d, el) {
  const i = d.integrity;
  el.innerHTML = `<div class="card"><div class="section-title">AI Assistance Risk: ${riskBadge(i ? i.risk_level : 'Low')}</div>
  <p class="faint">Potential indicators only — requires human review, never used to auto-reject.</p>
  ${i && i.evidence_json && JSON.parse(i.evidence_json).length ? JSON.parse(i.evidence_json).map((e) => `<div style="padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:12.6px;">⚠ ${esc(e)}</div>`).join('') : '<p class="faint">No integrity concerns recorded.</p>'}</div>`;
}
function tabReports(d, el, id) {
  el.innerHTML = `<div class="card"><div class="section-title">Individual report</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" id="printBtn">Print report</button>
      <button class="btn btn-sm" id="pdfBtn" data-busy="Preparing…">Download PDF</button>
      <button class="btn btn-sm" id="csvBtn" data-busy="Preparing…">Export CSV</button></div>
    <p class="faint" style="margin:10px 0 0;">Print opens a clean page laid out for paper and uses your browser's own print dialogue, so Lao text renders with the fonts already on the machine. Download PDF produces the same report as a file. Neither changes any stored data.</p></div>`;
  $('#printBtn').onclick = () => goto('print/' + id);
  $('#pdfBtn').onclick = () => downloadFile('/reports/candidate/' + id + '.pdf', 'report.pdf');
  $('#csvBtn').onclick = () => downloadFile('/reports/candidate/' + id + '.csv', 'report.csv');
}
function tabAudit(d, el, id) {
  api('/audit?q=' + encodeURIComponent(d.candidate.code)).then(({ logs }) => {
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Timestamp</th><th>User</th><th>Action</th><th>Target</th></tr></thead>
    <tbody>${logs.map((l) => `<tr><td class="faint mono">${fmtDT(l.created_at)}</td><td>${esc(l.user_name)}</td><td>${esc(l.action)}</td><td class="faint">${esc(l.target)}</td></tr>`).join('') || '<tr><td colspan="4" class="faint">No entries.</td></tr>'}</tbody></table></div>`;
  });
}

// ---------------- Links (global) ----------------
async function viewLinks(_, el) {
  const { links } = await api('/links');
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Token</th><th>Status</th><th>Created</th><th>Expires</th><th>Accessed</th><th>Attempts</th><th></th></tr></thead>
  <tbody>${links.map((l) => `<tr><td>${esc(l.candidateName)} <span class="faint mono" style="font-size:11px;">${l.candidateCode}</span></td><td class="mono faint">${l.token.slice(0, 10)}…</td><td><span class="badge badge-${{ ACTIVE: 'success', EXPIRED: 'warning', USED: 'info', REVOKED: 'danger' }[l.status]}">${l.status}</span></td><td class="faint">${fmtT(l.createdAt)}</td><td class="faint">${fmtT(l.expiresAt)}</td><td class="faint">${l.firstAccessAt ? fmtT(l.firstAccessAt) : '—'}</td><td class="faint">${l.accessAttempts} (${l.successfulAccess} ok)</td><td><button class="btn btn-sm" data-id="${l.candidateId}">View</button></td></tr>`).join('') || '<tr><td colspan="8" class="faint">No links yet.</td></tr>'}</tbody></table></div>`;
  $$('button[data-id]', el).forEach((b) => (b.onclick = () => goto('candidates/' + b.dataset.id)));
}

// ---------------- Print view ----------------
// A real browser print view rather than another generated document: the page
// is rendered by the browser, so Lao and English text use the fonts already on
// the machine and read correctly on paper.
//
// It is reached through the ordinary admin router, so it carries the same
// authentication and RBAC as every other screen — there is no unauthenticated
// print URL. It reads the candidate record and writes nothing.
async function viewPrintCandidate(params, el) {
  const id = params[0];
  if (!id) { el.innerHTML = '<div class="empty"><h3>No candidate selected</h3></div>'; return; }
  el.innerHTML = 'Loading…';
  const d = await api('/candidates/' + id);
  const c = d.candidate;
  const s = d.session;
  const sc = d.scores;
  const flags = (d.answers || []).filter((a) => a.flagged);

  const row = (k, v) => `<tr><th style="text-align:left;padding:3px 10px 3px 0;font-weight:600;white-space:nowrap;">${esc(k)}</th><td style="padding:3px 0;">${esc(v == null || v === '' ? '\u2014' : v)}</td></tr>`;

  el.innerHTML = `
    <div class="no-print" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center;">
      <button class="btn btn-primary" id="doPrint">Print this report</button>
      <button class="btn" id="backFromPrint">\u2190 Back to candidate</button>
      <span class="faint">Nothing on this page is saved or changed by printing.</span>
    </div>

    <div class="printdoc" id="printDoc">
      <div class="printhead">
        <div>
          <div class="printbrand">LALCO</div>
          <div class="faint" style="font-size:11.5px;">Lao Asean Leasing Public Company</div>
        </div>
        <div style="text-align:right;font-size:11.5px;" class="faint">
          Candidate assessment report<br>Printed ${esc(new Date().toLocaleString())}<br>Printed by ${esc(AUTH && AUTH.user ? AUTH.user.name : '')}
        </div>
      </div>

      <h2 style="margin:14px 0 2px;">${esc(c.full_name)}</h2>
      <div class="faint mono" style="margin-bottom:12px;">LALCO ID: ${esc(c.code)}</div>

      <div class="printgrid">
        <section>
          <h3 class="printh">Candidate</h3>
          <table class="printkv">
            ${row('LALCO ID', c.code)}
            ${row('Full name', c.full_name)}
            ${row('Application type', c.application_type)}
            ${row('Position applied for', c.appliedPosition)}
            ${row('Department', c.appliedDepartment)}
            ${row('Branch', c.branch)}
            ${row('Education', c.education)}
            ${row('IQ', c.iq)}
            ${row('GPA', c.gpa)}
            ${row('Candidate status', c.status)}
            ${row('Eligibility', d.eligibility ? d.eligibility.status : null)}
          </table>
        </section>

        <section>
          <h3 class="printh">Assessment</h3>
          <table class="printkv">
            ${row('Assessment', s && s.assessmentName ? s.assessmentName : 'LALCO Recruitment Assessment')}
            ${row('Status', s ? (s.displayStatus || s.status) : 'Not started')}
            ${row('Language sat in', s ? (s.language === 'lo' ? '\u0ea5\u0eb2\u0ea7 (Lao)' : 'English') : null)}
            ${row('Started', s && s.started_at ? fmtDT(s.started_at) : null)}
            ${row('Submitted', s && s.submitted_at ? fmtDT(s.submitted_at) : null)}
            ${row('Allowed duration', s ? s.duration_minutes + ' minutes' : null)}
            ${row('Pass threshold applied', s && s.pass_threshold != null ? s.pass_threshold + ' / ' + (s.total_max != null ? s.total_max : 100) : null)}
          </table>
        </section>
      </div>

      <h3 class="printh">Scores</h3>
      <table class="printtable">
        <thead><tr><th>Section</th><th>Marks</th></tr></thead>
        <tbody>
          <tr><td>Calculation</td><td class="mono">${esc(printScore(sc && sc.calc_marks, sc && sc.calc_max))}</td></tr>
          <tr><td>Written</td><td class="mono">${esc(printScore(sc && sc.essay_marks, sc && sc.essay_max))}</td></tr>
          <tr><td>Interview</td><td class="mono">${esc(printScore(sc && sc.interview_marks, sc && sc.interview_max))}</td></tr>
          <tr><td><b>Final</b></td><td class="mono"><b>${esc(printScore(sc && sc.final_marks, s && s.total_max != null ? s.total_max : 100))}</b></td></tr>
          <tr><td>Result</td><td>${sc && sc.pass != null ? (sc.pass ? 'PASS' : 'FAIL') : 'Not decided'}</td></tr>
        </tbody>
      </table>

      <h3 class="printh">Question performance</h3>
      <table class="printtable">
        <thead><tr><th>#</th><th>Category</th><th>Marks</th><th>Time</th><th>Flagged by candidate</th></tr></thead>
        <tbody>${(d.answers || []).filter((a) => a.type === 'CALC').map((a, i) => `<tr>
          <td>Q${i + 1}</td>
          <td>${esc(a.category || '\u2014')}</td>
          <td class="mono">${a.breakdown ? esc(a.breakdown.marks + ' / ' + a.maxMarks) : 'Not answered'}</td>
          <td class="mono">${esc(fmtSec(a.timeSpentSeconds))}</td>
          <td>${a.flagged ? '\u2691 Yes \u2014 ' + esc(fmtDT(a.flaggedAt)) : '\u2014'}</td>
        </tr>`).join('')}</tbody>
      </table>
      <p class="faint" style="font-size:11px;">Marks are shown as awarded. Model answers and internal marking detail are deliberately left off this printout.</p>

      <h3 class="printh">Flagged for review by the candidate</h3>
      ${flags.length
        ? `<table class="printtable"><thead><tr><th>Question</th><th>Flagged at</th></tr></thead><tbody>${flags.map((a) => `<tr><td>${esc(a.category || a.type)}</td><td class="mono">${esc(fmtDT(a.flaggedAt))}</td></tr>`).join('')}</tbody></table>
           <p class="faint" style="font-size:11px;">The candidate's own bookmarks while sitting the assessment. They carry no marks and did not affect the score.</p>`
        : '<p class="faint">The candidate flagged no questions for review.</p>'}

      <h3 class="printh">Assessment integrity</h3>
      <p>Risk level: <b>${esc(d.integrity ? d.integrity.risk_level : 'Low')}</b></p>
      ${d.integrity && d.integrity.evidence_json && JSON.parse(d.integrity.evidence_json).length
        ? `<ul style="margin:4px 0 0 18px;padding:0;">${JSON.parse(d.integrity.evidence_json).map((e) => `<li style="font-size:12px;">${esc(e)}</li>`).join('')}</ul>
           <p class="faint" style="font-size:11px;">Indicators requiring human review. Never used on their own to reject a candidate.</p>`
        : '<p class="faint">No integrity concerns recorded.</p>'}

      <div class="printfoot faint">
        LALCO confidential \u2014 recruitment record for ${esc(c.code)}. Handle according to company data policy.
      </div>
    </div>`;

  // Scoped to `el`, not the document. A view that awaits an API call can have
  // its container detached by a second navigation landing first; a document-
  // wide lookup then returns null and throws. Scoping keeps the wiring with
  // the markup it belongs to, and the guard means a detached render is simply
  // discarded instead of breaking the page.
  const printBtn = $('#doPrint', el);
  if (printBtn) printBtn.onclick = () => window.print();
  const backBtn = $('#backFromPrint', el);
  if (backBtn) backBtn.onclick = () => goto('candidates/' + id);
}

// "0 / 30" and "Not marked" are different facts and must not look alike.
function printScore(marks, max) {
  if (marks == null) return 'Not marked';
  return marks + (max != null ? ' / ' + max : '');
}

// ---------------- Assessments ----------------
async function viewAssessments(_, el) {
  let showArchived = false;
  let search = '';

  async function load() {
    const params = [];
    if (showArchived) params.push('archived=1');
    if (search) params.push('q=' + encodeURIComponent(search));
    const { assessments, canEdit } = await api('/assessments' + (params.length ? '?' + params.join('&') : ''));

    el.innerHTML = `
      <div class="card" style="margin-bottom:12px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
        <div class="field" style="flex:1;min-width:200px;margin:0;"><label class="field-label">Search</label>
          <input id="aSearch" placeholder="Name or description" value="${esc(search)}"></div>
        <div class="field" style="margin:0;"><label class="field-label">Show</label>
          <select id="aArchived">
            <option value="">Current</option>
            <option value="1" ${showArchived ? 'selected' : ''}>Archived</option>
          </select></div>
        ${canEdit ? '<button class="btn btn-primary" id="newAsmtBtn">+ New Assessment</button>' : ''}
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>Name</th><th>Status</th><th>Questions</th><th>Duration</th><th>Invite expiry</th>
        <th>Scoring</th><th>Pass</th><th>Sat</th><th>Actions</th></tr></thead>
      <tbody>${assessments.map((a) => assessmentRowHTML(a, canEdit)).join('') || `<tr><td colspan="9" class="faint" style="text-align:center;padding:22px;">No ${showArchived ? 'archived ' : ''}assessments.</td></tr>`}</tbody></table></div>
      <p class="faint" style="margin-top:10px;">Changing an assessment affects invitations issued and exams started from that point on. Links already issued keep their own expiry, running exams keep their own deadline, and completed results keep the pass threshold they were judged under.</p>`;

    $('#aSearch').addEventListener('input', debounce((e) => { search = e.target.value.trim(); load(); }, 300));
    $('#aArchived').onchange = (e) => { showArchived = e.target.value === '1'; load(); };
    if ($('#newAsmtBtn')) $('#newAsmtBtn').onclick = () => openAssessmentModal(null, load);
    wireAssessmentActions(assessments, load);
  }

  el.innerHTML = 'Loading…';
  await load();
}

function assessmentRowHTML(a, canEdit) {
  const status = a.archived
    ? '<span class="badge badge-neutral">ARCHIVED</span>'
    : a.active ? '<span class="badge badge-success">ACTIVE</span>' : '<span class="badge badge-warning">INACTIVE</span>';
  const mismatch = a.questionMarks !== (a.calc_max + a.written_max);
  return `<tr>
    <td><b>${esc(a.name)}</b>${a.description ? `<br><span class="faint">${esc(a.description.slice(0, 70))}${a.description.length > 70 ? '…' : ''}</span>` : ''}</td>
    <td>${status}</td>
    <td class="mono">${a.questionCount}<br><span class="faint" style="font-size:11px;">${a.questionMarks} marks${mismatch ? ' ⚠' : ''}</span></td>
    <td class="mono">${a.duration_minutes} min</td>
    <td class="mono">${a.link_expiry_minutes} min</td>
    <td class="mono" style="font-size:11.5px;">${a.calc_max}/${a.written_max}/${a.interview_max}<br><span class="faint">= ${a.total_max}</span></td>
    <td class="mono"><b>${a.pass_threshold}</b></td>
    <td class="mono faint">${a.sessionCount}</td>
    <td style="white-space:nowrap;">
      <button class="btn btn-sm" data-aact="view" data-aid="${a.id}">View</button>
      ${canEdit ? `
        ${a.archived ? '' : `<button class="btn btn-sm" data-aact="edit" data-aid="${a.id}">Edit</button>`}
        ${a.archived ? '' : `<button class="btn btn-sm" data-aact="duplicate" data-aid="${a.id}" data-busy="Duplicating…">Duplicate</button>`}
        ${!a.archived && !a.active ? `<button class="btn btn-sm" data-aact="activate" data-aid="${a.id}" data-busy="Activating…">Activate</button>` : ''}
        ${!a.archived && a.active ? `<button class="btn btn-sm" data-aact="deactivate" data-aid="${a.id}" data-busy="Deactivating…">Deactivate</button>` : ''}
        ${a.archived
          ? `<button class="btn btn-sm" data-aact="restore" data-aid="${a.id}" data-busy="Restoring…">Restore</button>`
          : `<button class="btn btn-danger btn-sm" data-aact="archive" data-aid="${a.id}" data-busy="Archiving…">Archive</button>`}
      ` : ''}
    </td></tr>`;
}

function wireAssessmentActions(assessments, reload) {
  $$('[data-aact]').forEach((btn) => {
    btn.onclick = async () => {
      const a = assessments.find((x) => x.id === btn.dataset.aid);
      const act = btn.dataset.aact;
      // View and Edit carry no data-busy label, so they are not wrapped by
      // decorateBusyButtons — they catch their own failures.
      if (act === 'view') return openAssessmentModal(a, reload, true).catch(() => {});
      if (act === 'edit') return openAssessmentModal(a, reload).catch(() => {});
      if (act === 'duplicate') {
        const name = prompt('Name for the copy:', a.name + ' (copy)');
        if (name === null) return;
        const r = await api('/assessments/' + a.id + '/duplicate', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
        toast(`Duplicated as "${r.assessment.name}". It starts inactive so it can be reviewed first.`);
        return reload();
      }
      if (act === 'activate' || act === 'deactivate') {
        const on = act === 'activate';
        if (!on && !confirm('Deactivate this assessment? No new invitations can be issued for it. Exams already running are unaffected.')) return;
        await api('/assessments/' + a.id + '/active', { method: 'POST', body: JSON.stringify({ active: on }) });
        toast(on ? 'Assessment activated.' : 'Assessment deactivated.');
        return reload();
      }
      if (act === 'archive') {
        if (!confirm('Archive this assessment? It can no longer receive invitations. Completed results are kept exactly as they are, and you can restore it later.')) return;
        const r = await api('/assessments/' + a.id + '/archive', { method: 'POST' });
        toast(`Archived.${r.historicalSessions ? ` ${r.historicalSessions} completed assessment(s) kept.` : ''}`);
        return reload();
      }
      if (act === 'restore') {
        await api('/assessments/' + a.id + '/restore', { method: 'POST' });
        toast('Restored. It stays inactive until you activate it.');
        return reload();
      }
    };
  });
}

// Editor: General / Timing / Scoring / Eligibility / Questions.
async function openAssessmentModal(assessment, onDone, readOnly) {
  const editing = !!assessment;
  const { questions: bank } = await api('/questions');
  const selected = editing ? assessment.questions.map((q) => q.id) : [];

  const a = editing ? assessment : {
    name: '', description: '', duration_minutes: 45, link_expiry_minutes: 10,
    calc_max: 30, written_max: 30, interview_max: 40, total_max: 100,
    pass_threshold: 70, eligibility_rules_id: 1,
  };

  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(10,18,26,.5);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:4vh 16px;overflow:auto;';
  const ro = readOnly ? 'disabled' : '';
  bg.innerHTML = `<div class="card" style="max-width:860px;width:100%;">
    <div class="section-title">${readOnly ? 'Assessment' : editing ? 'Edit assessment' : 'New assessment'}${editing ? ' — ' + esc(a.name) : ''}</div>

    <div class="field-label" style="margin-top:4px;">General</div>
    <div class="grid grid-2" style="gap:12px;">
      <div class="field"><label class="field-label">Name *</label><input id="aName" ${ro} value="${esc(a.name)}"></div>
      <div class="field"><label class="field-label">Description</label><input id="aDesc" ${ro} value="${esc(a.description || '')}"></div>
    </div>

    <div class="field-label">Timing — the invitation window and the exam clock are independent</div>
    <div class="grid grid-2" style="gap:12px;">
      <div class="field"><label class="field-label">Exam duration (minutes)</label><input type="number" id="aDuration" ${ro} min="1" max="600" value="${a.duration_minutes}">
        <span class="faint">How long the candidate has once they start.</span></div>
      <div class="field"><label class="field-label">Invitation expiry (minutes)</label><input type="number" id="aExpiry" ${ro} min="1" max="1440" value="${a.link_expiry_minutes}">
        <span class="faint">How long they have to open the link. Links already issued keep their own expiry.</span></div>
    </div>

    <div class="field-label">Scoring</div>
    <div class="grid grid-3" style="gap:12px;">
      <div class="field"><label class="field-label">Calculation marks</label><input type="number" id="aCalc" ${ro} value="${a.calc_max}"></div>
      <div class="field"><label class="field-label">Written marks</label><input type="number" id="aWritten" ${ro} value="${a.written_max}"></div>
      <div class="field"><label class="field-label">Interview marks</label><input type="number" id="aInterview" ${ro} value="${a.interview_max}"></div>
      <div class="field"><label class="field-label">Total marks</label><input type="number" id="aTotal" ${ro} value="${a.total_max}"></div>
      <div class="field"><label class="field-label">Pass threshold</label><input type="number" id="aThreshold" ${ro} value="${a.pass_threshold}"></div>
      <div class="field"><label class="field-label">Eligibility policy</label>
        <select id="aEligibility" ${ro}><option value="1" selected>Standard LALCO eligibility rules</option></select>
        <span class="faint">Configured under Admin Settings.</span></div>
    </div>
    <p class="faint">Calculation + written + interview must equal the total. Completed assessments keep the threshold they were judged under.</p>

    <div class="field-label">Questions — drawn from the Question Bank by reference, never copied</div>
    <div class="table-wrap" style="max-height:260px;overflow:auto;"><table><thead><tr><th style="width:40px;">Use</th><th>Question</th><th>Type</th><th>Marks</th><th>Lao</th><th style="width:90px;">Order</th></tr></thead>
    <tbody id="aQuestions">${bank.map((q) => {
      const idx = selected.indexOf(q.id);
      return `<tr>
        <td><input type="checkbox" class="aq-use" data-qid="${q.id}" ${idx >= 0 ? 'checked' : ''} ${ro} style="width:16px;height:16px;"></td>
        <td style="font-size:12.5px;">${esc(String(q.text).slice(0, 90))}${String(q.text).length > 90 ? '…' : ''}</td>
        <td><span class="badge badge-neutral">${q.type}</span></td>
        <td class="mono">${q.max_marks}</td>
        <td>${q.translationStatus === 'APPROVED' ? '<span class="badge badge-success">LO</span>' : '<span class="faint">—</span>'}</td>
        <td><input type="number" class="aq-order" data-qid="${q.id}" ${ro} value="${idx >= 0 ? idx : ''}" style="width:70px;" placeholder="—"></td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <p class="faint">Order decides the sequence the candidate sees. Leave blank for questions this assessment does not use.</p>

    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" id="aCancel">${readOnly ? 'Close' : 'Cancel'}</button>
      ${readOnly ? '' : `<button class="btn btn-primary" id="aSave" data-busy="Saving…">${editing ? 'Save changes' : 'Create assessment'}</button>`}
    </div>
  </div>`;

  document.body.appendChild(bg);
  const close = makeDismissable(bg);
  $('#aCancel', bg).onclick = close;
  if (!readOnly) $('#aName', bg).focus();

  if (!readOnly) $('#aSave', bg).onclick = async () => {
    const chosen = $$('.aq-use', bg).filter((c) => c.checked).map((c) => c.dataset.qid);
    // Order by the number typed beside each chosen question; anything left
    // blank falls to the end in bank order, so a half-filled form still saves
    // something sensible rather than failing.
    const orderOf = (qid) => {
      const input = $$('.aq-order', bg).find((i) => i.dataset.qid === qid);
      const v = input && input.value !== '' ? Number(input.value) : Number.POSITIVE_INFINITY;
      return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
    };
    const questionIds = chosen.slice().sort((x, y) => orderOf(x) - orderOf(y));

    const payload = {
      name: $('#aName', bg).value.trim(),
      description: $('#aDesc', bg).value.trim() || null,
      duration_minutes: Number($('#aDuration', bg).value),
      link_expiry_minutes: Number($('#aExpiry', bg).value),
      calc_max: Number($('#aCalc', bg).value),
      written_max: Number($('#aWritten', bg).value),
      interview_max: Number($('#aInterview', bg).value),
      total_max: Number($('#aTotal', bg).value),
      pass_threshold: Number($('#aThreshold', bg).value),
      eligibility_rules_id: Number($('#aEligibility', bg).value),
      questionIds,
    };
    if (!payload.name) return toast('An assessment name is required.', true);

    // The server validates all of this again and is the authority.
    const r = editing
      ? await api('/assessments/' + assessment.id, { method: 'PATCH', body: JSON.stringify(payload) })
      : await api('/assessments', { method: 'POST', body: JSON.stringify(payload) });
    toast(`Assessment ${editing ? 'updated' : 'created'} — ${r.assessment.questionCount} question(s), pass ${r.assessment.pass_threshold}/${r.assessment.total_max}.`);
    close();
    onDone && onDone();
  };
}

// ---------------- Question bank ----------------
const TRANSLATION_TONE = { MISSING: 'danger', DRAFT: 'warning', APPROVED: 'success' };

function translationBadge(status) {
  const s = status || 'MISSING';
  return `<span class="badge badge-${TRANSLATION_TONE[s] || 'neutral'}">${s}</span>`;
}

function canEditQuestions() {
  return AUTH && ['SUPER_ADMIN', 'HR_ADMIN'].includes(AUTH.user.role);
}

async function viewQuestions(_, el) {
  let showArchived = false;

  async function show(tab) {
    el.innerHTML = `<div class="tabs">
        <button class="${tab === 'calc' ? 'active' : ''}" data-qt="calc">Calculation</button>
        <button class="${tab === 'essay' ? 'active' : ''}" data-qt="essay">Essay</button>
        <button class="${tab === 'interview' ? 'active' : ''}" data-qt="interview">Interview</button>
      </div><div id="qBody">Loading…</div>`;
    $$('.tabs button', el).forEach((b) => (b.onclick = () => show(b.dataset.qt)));

    if (tab === 'interview') return showInterview();

    const { questions } = await api('/questions' + (showArchived ? '?archived=1' : ''));
    const list = questions.filter((q) => q.type === tab.toUpperCase());

    $('#qBody').innerHTML = `
      <div class="card" style="margin-bottom:12px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
        <div class="field" style="margin:0;"><label class="field-label">Show</label>
          <select id="qArchived">
            <option value="">Active questions</option>
            <option value="1" ${showArchived ? 'selected' : ''}>Archived</option>
          </select></div>
        <span style="flex:1"></span>
        ${canEditQuestions() ? `<button class="btn btn-primary btn-sm" id="newQBtn">+ New ${tab === 'calc' ? 'calculation' : 'essay'} question</button>` : ''}
      </div>
      ${list.map((q) => questionCardHTML(q)).join('') || `<div class="empty"><h3>No ${showArchived ? 'archived ' : ''}${tab === 'calc' ? 'calculation' : 'essay'} questions</h3><p>${showArchived ? 'Nothing has been archived.' : 'Add one with the button above, or run the seed.'}</p></div>`}`;

    $('#qArchived').onchange = (e) => { showArchived = e.target.value === '1'; show(tab); };
    if ($('#newQBtn')) $('#newQBtn').onclick = () => openQuestionModal(null, tab.toUpperCase(), () => show(tab));
    wireQuestionActions(questions, () => show(tab));
  }

  async function showInterview() {
    const { questions } = await api('/questions/interview/questions');
    const { criteria } = await api('/questions/interview/criteria');
    $('#qBody').innerHTML = `<div class="card"><div class="section-title">Interview questions ${canEditQuestions() ? '<button class="btn btn-sm" id="addIv" data-busy="Adding…">+ Add</button>' : ''}</div>
      ${questions.map((q) => `<div style="padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:13px;">${esc(q.text)} ${q.disqualifying ? '<span class="badge badge-warning">Can disqualify</span>' : ''}</div>`).join('')}</div>
      <div class="card" style="margin-top:14px;"><div class="section-title">Scoring rubric (40 marks)</div><table><thead><tr><th>Criterion</th><th>Max</th></tr></thead><tbody>${criteria.map((c) => `<tr><td>${esc(c.label)}</td><td>${c.max_marks}</td></tr>`).join('')}</tbody></table></div>`;
    if ($('#addIv')) $('#addIv').onclick = async () => {
      const text = prompt('New interview question:');
      if (!text) return;
      await api('/questions/interview/questions', { method: 'POST', body: JSON.stringify({ text }) });
      showInterview();
    };
  }

  show('calc');
}

// A question card shows English and Lao side by side, so a reviewer can check a
// translation against its source without opening anything.
function questionCardHTML(q) {
  const parts = q.config && Array.isArray(q.config.parts) ? q.config.parts : [];
  const rubric = q.config && Array.isArray(q.config.rubric) ? q.config.rubric : [];
  const lo = q.configLo && q.configLo.parts ? q.configLo.parts : {};
  return `<div class="card" style="margin-bottom:12px;${q.archived ? 'opacity:.72;' : ''}">
    <div class="section-title">
      <span>${esc(q.category || q.type)} <span class="faint">${q.max_marks} marks</span>
        ${q.archived ? '<span class="badge badge-neutral">ARCHIVED</span>' : ''}
        ${q.active ? '' : '<span class="badge badge-warning">INACTIVE</span>'}</span>
      <span>Lao: ${translationBadge(q.translationStatus)}</span>
    </div>
    <div class="faint" style="font-size:12px;margin:-4px 0 8px;">${
      q.usedByAssessments && q.usedByAssessments.length
        ? 'Used by: ' + q.usedByAssessments.map((n) => esc(n)).join(', ')
        : '<span class="badge badge-warning">NOT IN ANY ASSESSMENT</span> No candidate will see this question until an assessment includes it.'
    }</div>
    <div class="grid grid-2" style="gap:10px;">
      <div><div class="field-label">English question</div><p style="font-size:13px;">${esc(q.text)}</p></div>
      <div><div class="field-label">Lao question</div>${q.text_lo
        ? `<p style="font-size:13px;">${esc(q.text_lo)}</p>`
        : '<p class="faint" style="font-size:13px;">Not translated yet.</p>'}</div>
    </div>
    ${parts.length ? `<table style="font-size:12.6px;margin-top:8px;"><thead><tr><th>Step (English)</th><th>Step (Lao)</th><th>Marks</th></tr></thead><tbody>${parts.map((p) => {
      const l = lo[p.key] || {};
      return `<tr><td>${esc(p.label)}${p.type === 'choice' ? `<br><span class="faint">${(p.options || []).map(esc).join(' · ')}</span>` : ''}</td>
        <td>${l.label ? esc(l.label) : '<span class="faint">—</span>'}${p.type === 'choice' && l.options ? `<br><span class="faint">${(p.options || []).map((o) => esc(l.options[o] || '—')).join(' · ')}</span>` : ''}</td>
        <td>${p.marks}</td></tr>`;
    }).join('')}</tbody></table>` : ''}
    ${rubric.length ? `<table style="font-size:12.6px;margin-top:8px;"><thead><tr><th>Criterion</th><th>Max</th></tr></thead><tbody>${rubric.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.max}</td></tr>`).join('')}</tbody></table>` : ''}
    <p class="faint" style="margin-top:6px;">Answer key and marking rules are only ever shown here, inside the authenticated admin app — never in the candidate exam.</p>
    ${canEditQuestions() ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
      <button class="btn btn-sm" data-qact="edit" data-qid="${q.id}">Edit</button>
      ${q.archived
        ? `<button class="btn btn-sm" data-qact="restore" data-qid="${q.id}" data-busy="Restoring…">Restore</button>`
        : `<button class="btn btn-sm" data-qact="archive" data-qid="${q.id}" data-busy="Archiving…">Archive</button>`}
    </div>` : ''}
  </div>`;
}

function wireQuestionActions(questions, reload) {
  $$('[data-qact]').forEach((btn) => {
    btn.onclick = async () => {
      const q = questions.find((x) => x.id === btn.dataset.qid);
      const act = btn.dataset.qact;
      if (act === 'edit') return openQuestionModal(q, q.type, reload);
      if (act === 'archive') {
        if (!confirm('Archive this question? It is withdrawn from new assessments. Completed assessments keep it, and you can restore it at any time.')) return;
        const r = await api('/questions/' + q.id + '/archive', { method: 'POST' });
        toast(`Question archived.${r.answersReferencing ? ` ${r.answersReferencing} existing answer(s) still reference it.` : ''}`);
        return reload();
      }
      if (act === 'restore') {
        await api('/questions/' + q.id + '/restore', { method: 'POST' });
        toast('Question restored.');
        return reload();
      }
    };
  });
}

// Create / edit. English is required; Lao is optional and can only be marked
// APPROVED deliberately — nothing is auto-translated anywhere in this app.
function openQuestionModal(question, type, onDone) {
  const editing = !!question;
  const cfg = editing ? question.config : (type === 'CALC'
    ? { parts: [{ key: 'answer', label: '', marks: 5, expected: 0, tol: 0.01 }] }
    : { rubric: [{ key: 'content', label: '', max: 10 }] });
  const cfgLo = editing && question.configLo ? question.configLo : { parts: {} };

  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(10,18,26,.5);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:4vh 16px;overflow:auto;';
  bg.innerHTML = `<div class="card" style="max-width:820px;width:100%;">
    <div class="section-title">${editing ? 'Edit question' : 'New ' + (type === 'CALC' ? 'calculation' : 'essay') + ' question'}</div>

    <div class="grid grid-2" style="gap:12px;">
      <div class="field"><label class="field-label">English question *</label>
        <textarea id="qText" style="min-height:96px;">${editing ? esc(question.text) : ''}</textarea></div>
      <div class="field"><label class="field-label">Lao question (ຄຳຖາມພາສາລາວ)</label>
        <textarea id="qTextLo" style="min-height:96px;" placeholder="Leave blank until an approved translation exists">${editing && question.text_lo ? esc(question.text_lo) : ''}</textarea></div>
    </div>

    <div class="grid grid-3" style="gap:12px;">
      <div class="field"><label class="field-label">Category</label><input id="qCategory" value="${editing ? esc(question.category || '') : ''}"></div>
      <div class="field"><label class="field-label">Translation status</label>
        <select id="qStatus">
          ${['MISSING', 'DRAFT', 'APPROVED'].map((st) => `<option value="${st}" ${editing && question.translationStatus === st ? 'selected' : ''}>${st}</option>`).join('')}
        </select>
        <span class="faint">Only APPROVED is shown to candidates.</span></div>
      <div class="field"><label class="field-label">Active</label>
        <select id="qActive">
          <option value="1" ${!editing || question.active ? 'selected' : ''}>Active</option>
          <option value="0" ${editing && !question.active ? 'selected' : ''}>Inactive</option>
        </select></div>
    </div>

    <div class="field"><label class="field-label">Explanation (internal — never shown to candidates)</label>
      <textarea id="qExplanation" style="min-height:60px;">${editing && question.explanation ? esc(question.explanation) : ''}</textarea></div>

    <div class="field"><label class="field-label">${type === 'CALC' ? 'Marking configuration — parts, marks, expected answer and tolerance' : 'Rubric — criteria and maximum marks'} *</label>
      <textarea id="qConfig" class="mono" style="min-height:150px;font-size:12px;">${esc(JSON.stringify(cfg, null, 2))}</textarea>
      <span class="faint">${type === 'CALC'
        ? 'Each part: {"key","label","marks","expected","tol"} — or {"type":"choice","options":[...],"expected":"..."} for a choice. Total marks are computed from the parts.'
        : 'Each criterion: {"key","label","max"}. Total marks are computed from the rubric.'}</span></div>

    ${type === 'CALC' ? `<div class="field"><label class="field-label">Lao text for the parts (labels and option wording only)</label>
      <textarea id="qConfigLo" class="mono" style="min-height:110px;font-size:12px;">${esc(JSON.stringify(cfgLo, null, 2))}</textarea>
      <span class="faint">{"parts":{"&lt;key&gt;":{"label":"…","options":{"Accept":"…","Reject":"…"}}}} — option <b>values</b> are never translated, only how they read, so marking is unaffected.</span></div>` : ''}

    <p class="faint">English is the source language. A Lao translation belongs to the same question ID, so marks, answer key and history are shared.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" id="qCancel">Cancel</button>
      <button class="btn btn-primary" id="qSave" data-busy="Saving…">${editing ? 'Save changes' : 'Create question'}</button>
    </div>
  </div>`;

  document.body.appendChild(bg);
  const close = makeDismissable(bg);
  $('#qCancel', bg).onclick = close;
  $('#qText', bg).focus();

  $('#qSave', bg).onclick = async () => {
    const text = $('#qText', bg).value.trim();
    if (!text) return toast('The English question text is required.', true);

    let config, configLo = null;
    try { config = JSON.parse($('#qConfig', bg).value); }
    catch (e) { return toast('The marking configuration is not valid JSON.', true); }
    if ($('#qConfigLo', bg)) {
      const raw = $('#qConfigLo', bg).value.trim();
      if (raw) {
        try { configLo = JSON.parse(raw); }
        catch (e) { return toast('The Lao part text is not valid JSON.', true); }
      }
    }

    const payload = {
      type: editing ? question.type : type,
      text,
      textLo: $('#qTextLo', bg).value.trim() || null,
      translationStatus: $('#qStatus', bg).value,
      category: $('#qCategory', bg).value.trim() || null,
      explanation: $('#qExplanation', bg).value.trim() || null,
      active: $('#qActive', bg).value === '1',
      config,
      configLo,
    };

    // The server validates all of this again and is the authority; these
    // client checks only save a round trip.
    const r = editing
      ? await api('/questions/' + question.id, { method: 'PATCH', body: JSON.stringify(payload) })
      : await api('/questions', { method: 'POST', body: JSON.stringify(payload) });
    toast(`Question ${editing ? 'updated' : 'created'}. Total ${r.maxMarks} marks · Lao ${r.translationStatus}.`);
    close();
    onDone && onDone();
  };
}

// ---------------- Interviews queue ----------------
async function viewInterviews(_, el) {
  const { queue } = await api('/interviews/queue');
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Calc</th><th>Essay</th><th>Interview</th><th></th></tr></thead>
  <tbody>${queue.map((q) => `<tr><td>${esc(q.fullName)}</td><td class="mono">${q.calc}/30</td><td class="mono">${q.essay}/30</td><td class="mono">${q.interview != null ? q.interview + '/40' : '<span class="badge badge-warning">Pending</span>'}</td><td><button class="btn btn-sm" data-id="${q.id}">${q.interview != null ? 'View' : 'Score'} →</button></td></tr>`).join('') || '<tr><td colspan="5" class="faint">No candidates ready for interview.</td></tr>'}</tbody></table></div>`;
  $$('button[data-id]', el).forEach((b) => (b.onclick = () => { profileTab = 'interview'; goto('candidates/' + b.dataset.id); }));
}

// ---------------- Analytics ----------------
async function viewAnalytics(_, el) {
  const a = await api('/analytics');
  el.innerHTML = `<div class="grid grid-4" style="margin-bottom:14px;">
    <div class="kpi"><div class="num">${a.totals.total}</div><div class="lbl">Total</div></div>
    <div class="kpi"><div class="num">${a.totals.eligible}</div><div class="lbl">Eligible</div></div>
    <div class="kpi"><div class="num">${a.totals.avgScore || '—'}</div><div class="lbl">Average score</div></div>
    <div class="kpi"><div class="num">${a.totals.highest ?? '—'} / ${a.totals.lowest ?? '—'}</div><div class="lbl">Highest / lowest</div></div>
  </div>
  <div class="card"><div class="section-title">Score distribution</div><div style="display:flex;gap:8px;align-items:flex-end;height:140px;">${a.scoreDistribution.map((v, i) => `<div style="flex:1;text-align:center;"><div style="background:var(--teal);height:${Math.max(4, v * 12)}px;border-radius:3px 3px 0 0;"></div><div class="faint" style="margin-top:4px;">${['0–20', '21–40', '41–60', '61–80', '81–100'][i]}<br>${v}</div></div>`).join('')}</div></div>
  <div class="card" style="margin-top:14px;"><div class="section-title">Question analytics</div><div class="table-wrap"><table><thead><tr><th>Question</th><th>Attempts</th><th>Full</th><th>Partial</th><th>Failed</th><th>Avg</th><th>Fail rate</th></tr></thead>
  <tbody>${a.questionStats.map((q) => `<tr><td>${esc(q.category)}</td><td>${q.attempts}</td><td>${q.full}</td><td>${q.partial}</td><td>${q.failed}</td><td class="mono">${q.avgScore}/${q.max}</td><td class="mono">${q.failRate}%</td></tr>`).join('')}</tbody></table></div></div>
  <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
    <button class="btn btn-sm" id="csvBatch" data-busy="Preparing…">Export batch CSV</button>
    <button class="btn btn-sm" id="xlsxBatch" data-busy="Preparing…">Export batch Excel</button>
    <button class="btn btn-sm" id="sheetsBatch" data-busy="Exporting…">Export to Google Sheets</button>
    <span class="faint" id="sheetsBatchMsg"></span>
  </div>`;
  $('#csvBatch').onclick = () => downloadFile('/reports/batch.csv', 'batch.csv');
  $('#xlsxBatch').onclick = () => downloadFile('/reports/batch.xlsx', 'batch.xlsx');
  $('#sheetsBatch').onclick = async () => {
    $('#sheetsBatchMsg').textContent = 'Exporting…';
    try {
      const r = await api('/reports/google-sheets', { method: 'POST' });
      $('#sheetsBatchMsg').textContent = `Candidates ${r.candidates} · Assessments ${r.assessments} · Questions ${r.questions} · Interviews ${r.interviews} · Errors ${r.errors}`;
      toast('Exported to Google Sheets.');
    } catch (e) {
      $('#sheetsBatchMsg').textContent = 'Google Sheets unavailable — data remains in the database and can be retried.';
    }
  };
}

// ---------------- Scholarship ----------------
async function viewScholarship(_, el) {
  const { policy } = await api('/scholarship');
  el.innerHTML = `<div class="grid grid-2">
    ${['current', 'proposed'].map((kind) => `<div class="card"><div class="section-title">${kind === 'current' ? 'Current policy' : 'Proposed policy'}</div>
      ${['y3', 'y4'].map((yr) => `<div style="margin-bottom:14px;"><b style="font-size:13px;">Year ${yr[1]}</b>
        <div class="field"><label class="field-label">Funding</label><input id="${kind}_${yr}_funding" value="${esc(policy[kind][yr].funding)}" ${kind === 'current' ? 'disabled' : ''}></div>
        <div class="field"><label class="field-label">Payment timing</label><input id="${kind}_${yr}_paymentTiming" value="${esc(policy[kind][yr].paymentTiming)}" ${kind === 'current' ? 'disabled' : ''}></div>
        <div class="field"><label class="field-label">Year to start work</label><input type="number" id="${kind}_${yr}_yearToStart" value="${policy[kind][yr].yearToStart}" ${kind === 'current' ? 'disabled' : ''}></div>
        <div class="field"><label class="field-label">Commitment</label><input id="${kind}_${yr}_commitment" value="${esc(policy[kind][yr].commitment)}" ${kind === 'current' ? 'disabled' : ''}></div></div>`).join('')}</div>`).join('')}
  </div><button class="btn btn-primary" id="savePolicy" data-busy="Saving…" style="margin-top:12px;">Save proposed policy</button>`;
  $('#savePolicy').onclick = async () => {
    const proposed = {};
    ['y3', 'y4'].forEach((yr) => { proposed[yr] = { funding: $('#proposed_' + yr + '_funding').value, paymentTiming: $('#proposed_' + yr + '_paymentTiming').value, yearToStart: Number($('#proposed_' + yr + '_yearToStart').value), commitment: $('#proposed_' + yr + '_commitment').value }; });
    await api('/scholarship', { method: 'PUT', body: JSON.stringify({ proposed }) });
    toast('Proposed policy saved.');
  };
}

// ---------------- Settings ----------------
async function viewSettings(_, el) {
  const { settings, eligibilityRules } = await api('/settings');

  el.innerHTML = `<div class="grid grid-2">
    <div class="card"><div class="section-title">Eligibility rules</div>
      <b class="faint">Normal staff</b>
      <div class="field"><label class="field-label">IQ must be more than</label><input type="number" id="nIq" value="${eligibilityRules.normal_iq_min}"></div>
      <hr class="divider"><b class="faint">Scholarship staff</b>
      <div class="field"><label class="field-label">IQ must be more than</label><input type="number" id="sIq" value="${eligibilityRules.scholarship_iq_min}"></div>
      <div class="field"><label class="field-label">GPA must be more than</label><input type="number" step="0.1" id="sGpa" value="${eligibilityRules.scholarship_gpa_min}"></div>
      <button class="btn btn-primary btn-sm" id="saveElig" data-busy="Saving…">Save eligibility rules</button>
    </div>
    <div class="card"><div class="section-title">Defaults for new assessments</div>
      <p class="faint" style="margin-top:0;">Each assessment carries its own duration, invitation expiry and pass threshold — set them under <a href="#/assessments">Assessments</a>. The values here are what a newly created assessment starts with; changing them does not alter an existing assessment, a link already issued, or a result already decided.</p>
      <div class="field"><label class="field-label">Default pass threshold (/100)</label><input type="number" id="passT" value="${settings.pass_threshold}"></div>
      <div class="field"><label class="field-label">Default invitation link expiry (minutes)</label>
        <select id="linkExpPreset">
          ${[5, 10, 15, 20, 30, 60].map((m) => `<option value="${m}" ${settings.link_expiry_minutes === m ? 'selected' : ''}>${m} minutes</option>`).join('')}
          <option value="custom" ${[5, 10, 15, 20, 30, 60].includes(settings.link_expiry_minutes) ? '' : 'selected'}>Custom…</option>
        </select>
        <input type="number" id="linkExp" min="1" max="1440" value="${settings.link_expiry_minutes}" style="margin-top:6px; ${[5, 10, 15, 20, 30, 60].includes(settings.link_expiry_minutes) ? 'display:none;' : ''}">
        <span class="faint">Already-issued links keep the expiry they were created with.</span></div>
      <div class="field"><label class="field-label">Default assessment duration (minutes) — separate timer from the invitation link</label><input type="number" id="duration" value="${settings.assessment_duration_minutes}"></div>
      <div class="field"><label class="field-label">Maximum LTV (%)</label><input type="number" id="maxLtv" value="${settings.max_ltv}"></div>
      <b class="faint">Candidate identity verification (before starting)</b>
      <label style="display:flex;gap:8px;align-items:center;margin:6px 0;"><input type="checkbox" id="reqId" ${settings.require_candidate_id ? 'checked' : ''} style="width:16px;height:16px;"> Require Candidate ID</label>
      <label style="display:flex;gap:8px;align-items:center;margin:6px 0;"><input type="checkbox" id="reqPhone" ${settings.require_phone ? 'checked' : ''} style="width:16px;height:16px;"> Require Phone</label>
      <label style="display:flex;gap:8px;align-items:center;margin:6px 0 12px;"><input type="checkbox" id="reqDob" ${settings.require_dob ? 'checked' : ''} style="width:16px;height:16px;"> Require Date of Birth</label>
      <button class="btn btn-primary btn-sm" id="saveSettings" data-busy="Saving…">Save settings</button>
    </div>
    <div class="card" style="grid-column:1 / -1;">
      <div class="section-title">Data Management</div>
      <p class="muted" style="margin:0 0 10px;">Candidate data statistics, exports, database backup, Google Sheets sync, demo records and the deletion danger zone live on their own page.</p>
      <button class="btn btn-sm" id="gotoData">Open Data Management</button>
    </div>
  </div>`;

  $('#saveElig').onclick = async () => {
    await api('/eligibility-rules', {
      method: 'PUT',
      body: JSON.stringify({
        normalIqMin: Number($('#nIq').value),
        scholarshipIqMin: Number($('#sIq').value),
        scholarshipGpaMin: Number($('#sGpa').value),
      }),
    });
    toast('Eligibility rules saved.');
  };

  $('#linkExpPreset').onchange = () => {
    const v = $('#linkExpPreset').value;
    if (v === 'custom') { $('#linkExp').style.display = ''; $('#linkExp').focus(); }
    else { $('#linkExp').style.display = 'none'; $('#linkExp').value = v; }
  };
  $('#saveSettings').onclick = async () => {
    await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        passThreshold: Number($('#passT').value),
        linkExpiryMinutes: Number($('#linkExp').value),
        assessmentDurationMinutes: Number($('#duration').value),
        maxLtv: Number($('#maxLtv').value),
        requireCandidateId: $('#reqId').checked,
        requirePhone: $('#reqPhone').checked,
        requireDob: $('#reqDob').checked,
      }),
    });
    toast('Settings saved.');
  };

  $('#gotoData').onclick = () => goto('data');
}

// ---------------- Data Management (Super Admin only) ----------------
// Every button here calls a Super-Admin-only API. The server enforces that —
// hiding the nav item is a convenience, not the access control.
const DELETE_PHRASE = 'DELETE ALL CANDIDATES';

async function viewDataManagement(_, el) {
  el.innerHTML = 'Loading…';
  const d = await api('/settings/data-management');
  const s = d.stats;
  const sheetsState = d.googleSyncConfigured
    ? `<span class="badge badge-success">Configured</span>`
    : `<span class="badge badge-warning">Not configured</span>`;

  el.innerHTML = `
    <div class="grid grid-3" style="margin-bottom:14px;">
      <div class="kpi"><div class="num">${s.totalCandidates}</div><div class="lbl">Total Candidates</div></div>
      <div class="kpi"><div class="num">${s.activeAssessments}</div><div class="lbl">Active Assessments</div></div>
      <div class="kpi"><div class="num">${s.completedAssessments}</div><div class="lbl">Completed Assessments</div></div>
      <div class="kpi"><div class="num">${s.passed}</div><div class="lbl">Passed</div></div>
      <div class="kpi"><div class="num">${s.failed}</div><div class="lbl">Failed</div></div>
      <div class="kpi"><div class="num">${s.pending}</div><div class="lbl">Pending</div></div>
    </div>

    <div class="card" style="margin-bottom:12px;">
      <div class="section-title">Export &amp; backup</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        <button class="btn btn-primary btn-sm" id="exportCandidatesBtn" data-busy="Preparing…">Export All Candidate Data</button>
        <button class="btn btn-primary btn-sm" id="exportResultsBtn" data-busy="Preparing…">Export All Assessment Results</button>
        <button class="btn btn-sm" id="backupDbBtn" data-busy="Backing up…">Backup Database</button>
      </div>
      <p class="faint" style="margin:10px 0 0;">A backup is a single consistent SQLite file containing candidates, applications, assessment sessions, answers, scores, interviews, integrity events and audit records. No temporary files are included.</p>
      <div id="backupList" style="margin-top:10px;"></div>
    </div>

    <div class="card" style="margin-bottom:12px;">
      <div class="section-title">Google Sheets (HR reporting) ${sheetsState}</div>
      <p class="faint" style="margin:0 0 10px;">SQLite remains the source of truth. Google Sheets receives a copy for HR reporting, sharing and analysis. Credentials are held server-side only.</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <button class="btn btn-primary btn-sm" id="syncSheetsBtn" data-busy="Syncing…">SYNC TO GOOGLE SHEETS</button>
        <button class="btn btn-sm" id="retrySyncBtn" data-busy="Retrying…">RETRY GOOGLE SHEETS SYNC</button>
        <span class="badge ${d.googleSyncPending ? 'badge-warning' : 'badge-neutral'}">${d.googleSyncPending} assessment(s) pending sync</span>
        <span class="faint">Auto-sync on submit: ${d.googleAutoSyncOnSubmit ? 'on' : 'off'}</span>
      </div>
      <div id="syncResult" class="faint" style="margin-top:10px;"></div>
    </div>

    <div class="card" style="margin-bottom:12px;">
      <div class="section-title">Test / demo data <span class="badge badge-neutral">${s.demoCandidates} demo · ${s.realCandidates} real</span></div>
      <p class="faint" style="margin:0 0 10px;">Demo candidates are flagged <span class="mono">is_demo = true</span>, kept out of HR reporting, and can be deleted without touching real candidates.</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        <button class="btn btn-sm" id="createDemoBtn" data-busy="Creating…">CREATE DEMO CANDIDATES</button>
        <button class="btn btn-sm" id="deleteDemoBtn" data-busy="Deleting…">DELETE DEMO CANDIDATES</button>
      </div>
    </div>

    <div class="card" style="border:1px solid var(--danger); background:rgba(200,40,40,0.04);">
      <div class="section-title" style="color:var(--danger);">DANGER ZONE</div>
      <p class="faint" style="margin:0 0 10px;">Permanently removes every candidate record. The question bank, admin users, marking and eligibility rules, departments, branches, positions, scholarship policies and the audit log are all kept.</p>
      <button class="btn btn-danger btn-sm" id="deleteAllBtn">DELETE ALL CANDIDATE DATA</button>
    </div>

    <div id="deleteModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.65); align-items:center; justify-content:center; z-index:1000; padding:16px;">
      <div style="background:#fff; color:#111827; border-radius:12px; width:min(560px,100%); max-height:90vh; overflow:auto; padding:20px;">
        <h3 style="margin:0 0 10px; color:var(--danger);">WARNING</h3>
        <p style="margin:0 0 10px;">You are about to permanently delete <b>ALL candidate data</b>.</p>
        <p style="margin:0 0 6px;">This includes:</p>
        <ul style="margin:0 0 12px 18px; padding:0;">
          <li>Candidate profiles</li><li>Applications</li><li>Assessment sessions</li>
          <li>Assessment links</li><li>Candidate answers</li><li>Scores</li>
          <li>Essay answers</li><li>Interview scores</li><li>Integrity events</li>
          <li>Candidate reports</li>
        </ul>
        <div id="deletePreview" class="faint" style="margin-bottom:10px;"></div>
        <p style="margin:0 0 8px; font-weight:700; color:var(--danger);">This action cannot be undone.</p>
        <div class="field"><label class="field-label">Type <span class="mono">${DELETE_PHRASE}</span> to continue</label><input type="text" id="deletePhrase" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label class="field-label">Confirm your Super Admin password</label><input type="password" id="deletePassword" autocomplete="current-password"></div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;">
          <button class="btn btn-sm" id="cancelDeleteBtn">Cancel</button>
          <button class="btn btn-danger btn-sm" id="submitDeleteBtn" disabled>DELETE ALL CANDIDATE DATA</button>
        </div>
      </div>
    </div>`;

  renderBackups(d.backups);

  $('#exportCandidatesBtn').onclick = () => downloadFile('/settings/data-management/export-candidates.csv', 'candidate-data.csv');
  $('#exportResultsBtn').onclick = () => downloadFile('/settings/data-management/export-results.csv', 'assessment-results.csv');

  $('#backupDbBtn').onclick = async () => {
    const result = await api('/settings/data-management/backup', { method: 'POST' });
    toast('Backup created: ' + result.createdAtDisplay);
    const { backups } = await api('/settings/data-management/backups');
    renderBackups(backups);
  };

  $('#syncSheetsBtn').onclick = () => runSync('/settings/data-management/google-sync');
  $('#retrySyncBtn').onclick = () => runSync('/settings/data-management/google-sync/retry');

  async function runSync(path) {
    $('#syncResult').textContent = 'Syncing…';
    try {
      const r = await api(path, { method: 'POST' });
      $('#syncResult').innerHTML = `<b>Candidates synced:</b> ${r.candidates} &nbsp; <b>Assessments synced:</b> ${r.assessments} &nbsp; <b>Questions synced:</b> ${r.questions} &nbsp; <b>Interviews synced:</b> ${r.interviews} &nbsp; <b>Errors:</b> ${r.errors}`;
      toast('Google Sheets sync completed.');
      viewDataManagement(_, el);
    } catch (e) {
      $('#syncResult').innerHTML = `<span style="color:var(--danger);">${esc(e.message)}</span> — assessment results remain safely stored in SQLite and can be retried.`;
    }
  }

  $('#createDemoBtn').onclick = async () => {
    const r = await api('/settings/data-management/demo/create', { method: 'POST', body: JSON.stringify({ count: 5 }) });
    toast(r.message);
    viewDataManagement(_, el);
  };
  $('#deleteDemoBtn').onclick = async () => {
    if (!confirm('Delete all demo candidates? Real candidates are not affected.')) return;
    const r = await api('/settings/data-management/demo/delete', { method: 'POST' });
    toast(r.message);
    viewDataManagement(_, el);
  };

  const modal = $('#deleteModal');
  const phrase = $('#deletePhrase');
  const password = $('#deletePassword');
  const submitBtn = $('#submitDeleteBtn');

  function updateDeleteButton() {
    const phraseOK = phrase.value === DELETE_PHRASE;
    submitBtn.disabled = !(phraseOK && password.value.length > 0);
  }
  phrase.addEventListener('input', updateDeleteButton);
  password.addEventListener('input', updateDeleteButton);

  const closeDeleteModal = () => { modal.style.display = 'none'; };
  makeDismissable(modal, closeDeleteModal);
  $('#deleteAllBtn').onclick = async () => {
    phrase.value = ''; password.value = ''; updateDeleteButton();
    modal.style.display = 'flex';
    phrase.focus();
    const { preview } = await api('/settings/data-management/delete-all-candidate-data/preview');
    $('#deletePreview').textContent = `About to remove ${preview.candidates} candidates, ${preview.assessments} assessment sessions, ${preview.answers} answers and ${preview.links} assessment links.`;
  };
  $('#cancelDeleteBtn').onclick = closeDeleteModal;

  submitBtn.onclick = async () => {
    // Explicit loading state here rather than the generic data-busy decorator,
    // because this button's enabled state is governed by the phrase+password
    // check and must not simply be re-enabled when the request settles.
    if (submitBtn.disabled) return;
    const submitLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Deleting…';
    try {
      const r = await api('/settings/data-management/delete-all-candidate-data', {
        method: 'POST',
        body: JSON.stringify({ confirmation: phrase.value, password: password.value }),
      });
      modal.style.display = 'none';
      toast('Candidate data successfully deleted.');
      el.innerHTML = `<div class="card"><div class="section-title">Candidate data successfully deleted.</div>
        <ul style="margin:0 0 12px 18px;">${r.summary.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
        <p class="faint">The question bank, admin users, scoring rules and the audit log were kept. An audit record of this deletion has been written.</p>
        <button class="btn btn-sm" id="backToData">Refresh dashboards</button></div>`;
      $('#backToData').onclick = () => viewDataManagement(_, el);
    } catch (e) {
      submitBtn.textContent = submitLabel;
      updateDeleteButton();
    }
  };
}

function renderBackups(backups) {
  const holder = $('#backupList');
  if (!holder) return;
  if (!backups || !backups.length) { holder.innerHTML = '<p class="faint">No backups yet.</p>'; return; }
  holder.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Backup created</th><th>Size</th><th></th></tr></thead><tbody>
    ${backups.map((b) => `<tr><td class="mono">${fmtDT(b.createdAt)}</td><td class="faint">${Math.round(b.sizeBytes / 1024)} KB</td>
      <td><button class="btn btn-sm" data-busy="Downloading…" data-backup="${esc(b.fileName)}">Download</button></td></tr>`).join('')}
  </tbody></table></div>`;
  $$('[data-backup]').forEach((btn) => {
    btn.onclick = () => downloadFile('/settings/data-management/backup/download?file=' + encodeURIComponent(btn.dataset.backup), btn.dataset.backup);
  });
}

// ---------------- Candidate lifecycle (archive / restore / delete) --------
function candidateLifecycleHTML(d) {
  const c = d.candidate;
  const isSuper = AUTH && AUTH.user.role === 'SUPER_ADMIN';
  const live = d.liveSessionStatus === 'IN_PROGRESS' || d.liveSessionStatus === 'PAUSED';
  return `<div class="card" style="margin-top:14px;">
    <div class="section-title">Candidate record ${c.archived ? '<span class="badge badge-warning">ARCHIVED</span>' : ''}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <button class="btn btn-sm" id="editCandBtn">Edit details</button>
      ${c.archived
        ? '<button class="btn btn-sm" id="restoreCandBtn" data-busy="Restoring…">Restore candidate</button>'
        : '<button class="btn btn-sm" id="archiveCandBtn" data-busy="Archiving…">Archive candidate</button>'}
      ${isSuper ? `<button class="btn btn-danger btn-sm" id="deleteCandBtn" ${live ? 'disabled title="Terminate the live assessment first"' : ''}>Delete permanently</button>` : ''}
    </div>
    <p class="faint" style="margin:8px 0 0;">Archiving hides the candidate from the working list and keeps every record. Permanent deletion is Super Admin only, removes all of their assessment data, and is refused while an assessment is still running.</p>
  </div>`;
}

function wireCandidateLifecycle(d, id, el) {
  const reload = () => viewCandidateDetail([id], el.parentElement);
  if ($('#archiveCandBtn')) $('#archiveCandBtn').onclick = async () => {
    if (!confirm('Archive this candidate? They will be hidden from the active list but nothing is deleted.')) return;
    await api('/candidates/' + id + '/archive', { method: 'POST' });
    toast('Candidate archived.'); reload();
  };
  if ($('#restoreCandBtn')) $('#restoreCandBtn').onclick = async () => {
    await api('/candidates/' + id + '/restore', { method: 'POST' });
    toast('Candidate restored.'); reload();
  };
  if ($('#editCandBtn')) $('#editCandBtn').onclick = () => openEditCandidateModal(d.candidate, reload, { hasAssessment: !!d.session });
  if ($('#deleteCandBtn')) $('#deleteCandBtn').onclick = () => openDeleteCandidateModal(d.candidate, () => goto('candidates'));
}

function openEditCandidateModal(c, onDone, options = {}) {
  // The candidate verifies their identity with this value, so it is locked once
  // an assessment exists — matching the server-side rule.
  const lockCode = !!options.hasAssessment;
  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(10,18,26,.45);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px;overflow:auto;';
  const f = (label, id, value, type) => `<div class="field"><label class="field-label">${label}</label><input id="${id}" ${type ? 'type="' + type + '"' : ''} value="${value == null ? '' : esc(value)}"></div>`;
  bg.innerHTML = `<div class="card" style="max-width:560px;width:100%;">
    <div class="section-title">Edit candidate — ${esc(c.code)}</div>
    <div class="grid grid-2">
      ${f('Full name *', 'eFullName', c.full_name)}
      <div class="field"><label class="field-label">LALCO ID</label>
        <input id="eCode" value="${esc(c.code)}" autocomplete="off" spellcheck="false" ${lockCode ? 'disabled' : ''}>
        ${lockCode ? '<span class="faint">Locked: an assessment has already been started for this candidate.</span>' : '<span class="faint">Letters, digits, hyphen and underscore.</span>'}</div>
      ${f('Phone', 'ePhone', c.phone)}
      ${f('Email', 'eEmail', c.email)}
      ${f('Education', 'eEdu', c.education)}
      ${f('University', 'eUni', c.university)}
      ${f('Major', 'eMajor', c.major)}
      ${f('GPA', 'eGpa', c.gpa, 'number')}
      ${f('IQ', 'eIq', c.iq, 'number')}
      ${f('Date of birth', 'eDob', c.dob, 'date')}
      ${f('Province', 'eProvince', c.province)}
    </div>
    <p class="faint">Changes are audited. Scores and assessment records are not affected.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" id="eCancel">Cancel</button>
      <button class="btn btn-primary" id="eSave" data-busy="Saving…">Save changes</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = makeDismissable(bg);
  $('#eCancel', bg).onclick = close;
  $('#eFullName', bg).focus();
  $('#eSave', bg).onclick = async () => {
    const full_name = $('#eFullName', bg).value.trim();
    if (!full_name) return toast('Full name is required', true);
    const num = (v) => (v === '' ? null : Number(v));
    const newCode = lockCode ? undefined : ($('#eCode', bg).value.trim() || undefined);
    await api('/candidates/' + c.id, { method: 'PATCH', body: JSON.stringify({
      code: newCode,
      full_name,
      phone: $('#ePhone', bg).value.trim(),
      email: $('#eEmail', bg).value.trim(),
      education: $('#eEdu', bg).value.trim(),
      university: $('#eUni', bg).value.trim(),
      major: $('#eMajor', bg).value.trim(),
      gpa: num($('#eGpa', bg).value),
      iq: num($('#eIq', bg).value),
      dob: $('#eDob', bg).value,
      province: $('#eProvince', bg).value.trim(),
    }) });
    toast('Candidate updated.'); close(); onDone && onDone();
  };
}

function openDeleteCandidateModal(c, onDone) {
  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:70;display:flex;align-items:center;justify-content:center;padding:16px;';
  bg.innerHTML = `<div class="card" style="max-width:520px;width:100%;">
    <div class="section-title" style="color:var(--danger);">Permanently delete ${esc(c.code)}</div>
    <p>This removes the candidate and <b>all</b> of their assessment sessions, answers, scores, links and integrity records. It cannot be undone. The audit log keeps a record of the deletion.</p>
    <div class="field"><label class="field-label">Type the candidate code <span class="mono">${esc(c.code)}</span> to confirm</label><input id="dConfirm" autocomplete="off"></div>
    <div class="field"><label class="field-label">Confirm your Super Admin password</label><input id="dPass" type="password" autocomplete="current-password"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" id="dCancel">Cancel</button>
      <button class="btn btn-danger" id="dGo" disabled>Delete permanently</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = makeDismissable(bg);
  const go = $('#dGo', bg);
  const sync = () => { go.disabled = !($('#dConfirm', bg).value.trim() === c.code && $('#dPass', bg).value.length > 0); };
  $('#dConfirm', bg).addEventListener('input', sync);
  $('#dPass', bg).addEventListener('input', sync);
  $('#dCancel', bg).onclick = close;
  $('#dConfirm', bg).focus();
  go.onclick = async () => {
    if (go.disabled) return;
    const label = go.textContent;
    go.disabled = true; go.textContent = 'Deleting…';
    try {
      const r = await api('/candidates/' + c.id, { method: 'DELETE', body: JSON.stringify({ confirmation: $('#dConfirm', bg).value.trim(), password: $('#dPass', bg).value }) });
      close(); toast(r.message || 'Candidate deleted.'); onDone && onDone();
    } catch (e) { go.textContent = label; sync(); }
  };
}

// ---------------- Link actions -------------------------------------------
function linkBadgeTone(status) {
  return { ACTIVE: 'success', EXPIRED: 'warning', USED: 'info', REVOKED: 'danger', DISABLED: 'warning' }[status] || 'neutral';
}

function linkActionsHTML(l) {
  const canControl = AUTH && ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'].includes(AUTH.user.role);
  if (!canControl) return '<span class="faint">—</span>';
  const buttons = [];
  if (l.liveStatus === 'DISABLED') buttons.push(`<button class="btn btn-sm" data-linkact="enable" data-linkid="${l.id}" data-busy="Enabling…">Enable</button>`);
  else if (l.liveStatus === 'ACTIVE') buttons.push(`<button class="btn btn-sm" data-linkact="disable" data-linkid="${l.id}" data-busy="Disabling…">Disable</button>`);
  if (['ACTIVE', 'DISABLED', 'EXPIRED'].includes(l.liveStatus)) {
    buttons.push(`<button class="btn btn-sm" data-linkact="extend" data-linkid="${l.id}" data-busy="Extending…">Extend</button>`);
  }
  return buttons.join(' ') || '<span class="faint">—</span>';
}

function wireLinkActions(d, id, el) {
  $$('[data-linkact]').forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.linkact;
      const linkId = btn.dataset.linkid;
      let body;
      if (act === 'extend') {
        const mins = prompt('Extend this invitation link by how many minutes?', '10');
        if (!mins) return;
        body = JSON.stringify({ addMinutes: Number(mins) });
      }
      await api('/exam-control/links/' + linkId + '/' + act, { method: 'POST', body });
      toast('Link ' + (act === 'extend' ? 'expiry extended' : act + 'd') + '.');
      viewCandidateDetail([id], el.parentElement);
    };
  });
}

// ---------------- Live Assessments ---------------------------------------
function fmtRemaining(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60), sec = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

async function viewLive(_, el) {
  async function load() {
    const { assessments, pausePolicy } = await api('/exam-control/live');
    const rows = assessments.map((a) => {
      const act = (name, label, busy, tone) => a.availableActions.includes(name)
        ? `<button class="btn btn-sm ${tone || ''}" data-live="${name}" data-sid="${a.sessionId}" data-lid="${a.linkId || ''}" data-busy="${busy}">${label}</button>` : '';
      return `<tr>
        <td><b>${esc(a.candidateName)}</b><br><span class="faint mono" style="font-size:11px;">${esc(a.candidateCode)}</span></td>
        <td class="faint">${fmtDT(a.startedAt)}</td>
        <td class="mono ${a.remainingSeconds < 300 ? 'danger-text' : ''}"><b>${fmtRemaining(a.remainingSeconds)}</b>${a.totalPausedSeconds ? `<br><span class="faint" style="font-size:11px;">+${Math.round(a.totalPausedSeconds / 60)}m paused</span>` : ''}</td>
        <td class="mono">${a.answered}/${a.totalQuestions}<br><span class="faint" style="font-size:11px;">${a.progressPercent}%</span></td>
        <td><span class="badge badge-${a.status === 'PAUSED' ? 'warning' : 'info'}">${a.status}</span></td>
        <td>${a.linkStatus ? `<span class="badge badge-${linkBadgeTone(a.linkStatus)}">${a.linkStatus}</span>` : '<span class="faint">—</span>'}</td>
        <td>${riskBadge(a.integrityRisk)}</td>
        <td class="faint">${fmtT(a.lastActivityAt)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" data-live="VIEW" data-cid="${a.candidateId}">View</button>
          ${act('PAUSE', 'Pause', 'Pausing…')}
          ${act('RESUME', 'Resume', 'Resuming…')}
          ${act('CHANGE_TIME', 'Set time', 'Saving…')}
          ${act('EXTEND_TIME', '+Time', 'Extending…')}
          ${act('DISABLE_LINK', 'Disable link', 'Disabling…')}
          ${act('TERMINATE', 'Terminate', 'Terminating…', 'btn-danger')}
        </td></tr>`;
    }).join('');

    el.innerHTML = `<div class="card" style="margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <div><b>${assessments.length}</b> assessment(s) in progress</div>
        <span class="faint">Pause policy: ${pausePolicy === 'FREEZE_AND_CREDIT' ? 'the countdown freezes and the paused time is credited back on resume' : pausePolicy}</span>
        <span style="flex:1"></span>
        <label class="faint" style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="liveAuto" checked style="width:15px;height:15px;"> auto-refresh</label>
        <button class="btn btn-sm" id="liveRefresh">Refresh</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Started</th><th>Time left</th><th>Progress</th><th>Status</th><th>Link</th><th>Integrity</th><th>Last activity</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="faint" style="text-align:center;padding:24px;">No assessments are running right now.</td></tr>'}</tbody></table></div>`;

    $('#liveRefresh').onclick = load;
    $('#liveAuto').onchange = (e) => {
      stopLiveRefresh();
      if (e.target.checked) LIVE_TIMER = setInterval(load, 15000);
    };

    $$('[data-live]').forEach((btn) => {
      btn.onclick = async () => {
        const action = btn.dataset.live;
        const sid = btn.dataset.sid;
        if (action === 'VIEW') return goto('candidates/' + btn.dataset.cid);
        try {
          if (action === 'PAUSE') {
            if (!confirm('Pause this assessment? The candidate is locked out and their countdown freezes.')) return;
            await api('/exam-control/sessions/' + sid + '/pause', { method: 'POST' });
            toast('Assessment paused.');
          } else if (action === 'RESUME') {
            const r = await api('/exam-control/sessions/' + sid + '/resume', { method: 'POST' });
            toast(`Resumed. ${Math.round((r.pausedSeconds || 0) / 60)} minute(s) credited back.`);
          } else if (action === 'CHANGE_TIME') {
            const mins = prompt('Set a NEW total exam duration in minutes (measured from when the candidate started):', '45');
            if (!mins) return;
            await api('/exam-control/sessions/' + sid + '/change-time', { method: 'POST', body: JSON.stringify({ durationMinutes: Number(mins) }) });
            toast('Exam duration changed.');
          } else if (action === 'EXTEND_TIME') {
            const mins = prompt('Add how many minutes to the current deadline?', '10');
            if (!mins) return;
            await api('/exam-control/sessions/' + sid + '/extend-time', { method: 'POST', body: JSON.stringify({ addMinutes: Number(mins) }) });
            toast('Time extended.');
          } else if (action === 'TERMINATE') {
            if (!confirm('Terminate this assessment now? It will be locked immediately and marked from the answers already saved. This cannot be undone.')) return;
            const r = await api('/exam-control/sessions/' + sid + '/terminate', { method: 'POST' });
            toast(`Assessment terminated. ${r.answered} answered, ${r.unanswered} unanswered.`);
          } else if (action === 'DISABLE_LINK') {
            const lid = btn.dataset.lid;
            if (!lid) return toast('This assessment has no link to disable.', true);
            await api('/exam-control/links/' + lid + '/disable', { method: 'POST' });
            toast('Link disabled.');
          }
          load();
        } catch (e) { /* api() already reported it */ }
      };
    });
  }

  el.innerHTML = 'Loading…';
  await load();
  stopLiveRefresh();
  LIVE_TIMER = setInterval(load, 15000);
}

// ---------------- Users ---------------------------------------------------
async function viewUsers(_, el) {
  async function load() {
    const { users, roles, minPasswordLength } = await api('/users');
    el.innerHTML = `<div class="card" style="margin-bottom:12px;display:flex;gap:10px;align-items:center;">
        <div><b>${users.length}</b> account(s)</div><span style="flex:1"></span>
        <button class="btn btn-primary btn-sm" id="newUserBtn">+ New User</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td><b>${esc(u.name)}</b></td><td class="faint">${esc(u.email)}</td>
        <td><span class="badge badge-neutral">${u.role}</span></td>
        <td>${u.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-danger">Disabled</span>'}</td>
        <td class="faint">${fmtDT(u.createdAt)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" data-uact="edit" data-uid="${u.id}">Edit</button>
          <button class="btn btn-sm" data-uact="role" data-uid="${u.id}">Role</button>
          <button class="btn btn-sm" data-uact="active" data-uid="${u.id}" data-active="${u.active ? '0' : '1'}" data-busy="Saving…">${u.active ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-sm" data-uact="reset" data-uid="${u.id}">Reset password</button>
        </td></tr>`).join('')}</tbody></table></div>
      <p class="faint" style="margin-top:10px;">Passwords are bcrypt-hashed and never displayed. Password resets and role changes are written to the audit log.</p>`;

    const byId = (id) => users.find((u) => u.id === id);
    $('#newUserBtn').onclick = () => openUserModal(null, roles, minPasswordLength, load);
    $$('[data-uact]').forEach((btn) => {
      btn.onclick = async () => {
        const u = byId(btn.dataset.uid);
        const act = btn.dataset.uact;
        if (act === 'edit') return openUserModal(u, roles, minPasswordLength, load);
        if (act === 'role') {
          const role = prompt('New role for ' + u.name + '\n(' + roles.join(', ') + ')', u.role);
          if (!role || role === u.role) return;
          await api('/users/' + u.id + '/role', { method: 'POST', body: JSON.stringify({ role: role.trim().toUpperCase() }) });
          toast('Role changed.'); return load();
        }
        if (act === 'active') {
          const makeActive = btn.dataset.active === '1';
          if (!makeActive && !confirm('Disable ' + u.name + '? They will not be able to sign in.')) return;
          await api('/users/' + u.id + '/active', { method: 'POST', body: JSON.stringify({ active: makeActive }) });
          toast(makeActive ? 'User enabled.' : 'User disabled.'); return load();
        }
        if (act === 'reset') {
          if (!confirm('Reset the password for ' + u.name + '? A new one will be generated and shown once.')) return;
          const r = await api('/users/' + u.id + '/reset-password', { method: 'POST', body: JSON.stringify({ generate: true }) });
          window.prompt('New password for ' + u.name + ' — copy it now, it will not be shown again:', r.generatedPassword);
          toast('Password reset.'); return load();
        }
      };
    });
  }

  el.innerHTML = 'Loading…';
  await load();
}

function openUserModal(user, roles, minPasswordLength, onDone) {
  const editing = !!user;
  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(10,18,26,.45);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;overflow:auto;';
  bg.innerHTML = `<div class="card" style="max-width:480px;width:100%;">
    <div class="section-title">${editing ? 'Edit user — ' + esc(user.name) : 'New user'}</div>
    <div class="field"><label class="field-label">Full name *</label><input id="uName" value="${editing ? esc(user.name) : ''}"></div>
    <div class="field"><label class="field-label">Email *</label><input id="uEmail" type="email" value="${editing ? esc(user.email) : ''}"></div>
    ${editing ? '' : `<div class="field"><label class="field-label">Role *</label><select id="uRole">${roles.map((r) => `<option value="${r}">${r}</option>`).join('')}</select></div>
    <div class="field"><label class="field-label">Password * (at least ${minPasswordLength} characters)</label><input id="uPass" type="password" autocomplete="new-password"></div>`}
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" id="uCancel">Cancel</button>
      <button class="btn btn-primary" id="uSave" data-busy="Saving…">${editing ? 'Save changes' : 'Create user'}</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = makeDismissable(bg);
  $('#uCancel', bg).onclick = close;
  $('#uName', bg).focus();
  $('#uSave', bg).onclick = async () => {
    const name = $('#uName', bg).value.trim();
    const email = $('#uEmail', bg).value.trim();
    if (!name || !email) return toast('Name and email are required', true);
    if (editing) {
      await api('/users/' + user.id, { method: 'PATCH', body: JSON.stringify({ name, email }) });
      toast('User updated.');
    } else {
      const password = $('#uPass', bg).value;
      if (password.length < minPasswordLength) return toast(`Password must be at least ${minPasswordLength} characters`, true);
      await api('/users', { method: 'POST', body: JSON.stringify({ name, email, role: $('#uRole', bg).value, password }) });
      toast('User created.');
    }
    close(); onDone && onDone();
  };
}

// ---------------- Audit ----------------
async function viewAudit(_, el) {
  el.innerHTML = `<div class="card" style="margin-bottom:12px;"><input id="aq" placeholder="Search..."></div><div class="table-wrap"><table><thead><tr><th>Timestamp</th><th>User</th><th>Role</th><th>Action</th><th>Target</th></tr></thead><tbody id="rows"></tbody></table></div>`;
  async function load() { const { logs } = await api('/audit?q=' + encodeURIComponent($('#aq').value)); $('#rows').innerHTML = logs.map((l) => `<tr><td class="faint mono">${fmtDT(l.created_at)}</td><td>${esc(l.user_name)}</td><td class="faint">${esc(l.role)}</td><td>${esc(l.action)}</td><td class="faint mono">${esc(l.target)}</td></tr>`).join('') || '<tr><td colspan="5" class="faint">No entries.</td></tr>'; }
  $('#aq').addEventListener('input', debounce(load, 300));
  load();
}

render();
