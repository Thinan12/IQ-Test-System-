'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
// Every screen here renders by awaiting an API call and then writing into the
// element it was handed. renderShell() replaces document.body wholesale, so the
// moment the administrator clicks a different section that element is detached,
// and the document-wide lookups the renderer goes on to make all return null —
// which is how an ordinary second click produced "Cannot set properties of null
// (setting 'onclick')". A renderer whose target has been detached has nothing
// left worth doing, so it stops instead of painting into nothing.
const alive = (n) => !!n && n.isConnected;
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
  { key: 'iq', label: 'IQ Test', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'EVALUATOR', 'MANAGER'] },
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
      // The form can be replaced while the request is in flight, so the error
      // line is written only if it is still on the page.
      const showErr = (m) => { const n = $('#lErr'); if (n) n.textContent = m; };
      if (!res.ok) { showErr(data.error); return; }
      AUTH = data; saveAuth(); goto('dashboard'); render();
    } catch (e) { const n = $('#lErr'); if (n) n.textContent = 'Could not reach server.'; }
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
  const views = { print: viewPrintCandidate, dashboard: viewDashboard, candidates: viewCandidates, live: viewLive, links: viewLinks, assessments: viewAssessments, questions: viewQuestions, iq: viewIqTest, interviews: viewInterviews, analytics: viewAnalytics, scholarship: viewScholarship, users: viewUsers, settings: viewSettings, data: viewDataManagement, audit: viewAudit };
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
  if (!alive(el)) return;
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
    // Also reached from a debounced input, so the filters may already have gone
    // with the view by the time this runs.
    if (!alive(el)) return;
    const q = $('#fq').value;
    const archived = $('#fArchived').value;
    const params = [];
    if (q) params.push('q=' + encodeURIComponent(q));
    if (archived) params.push('archived=1');
    const { candidates } = await api('/candidates' + (params.length ? '?' + params.join('&') : ''));
    if (!alive(el)) return;
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
  if (!alive(el)) return;
  const c = d.candidate;
  const tabs = [['overview', 'Overview'], ['recruitment', 'Recruitment report'], ['eligibility', 'Eligibility'], ['assessment', 'Assessment'], ['questions', 'Questions'], ['interview', 'Interview'], ['performance', 'Performance'], ['integrity', 'Integrity'], ['reports', 'Reports'], ['audit', 'Audit']];
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
  if (!body) return;
  const renderers = { overview: tabOverview, recruitment: tabRecruitment, eligibility: tabEligibility, assessment: tabAssessment, questions: tabQuestions, interview: tabInterview, performance: tabPerformance, integrity: tabIntegrity, reports: tabReports, audit: tabAudit };
  (renderers[profileTab] || tabOverview)(d, body, id);
}
// A save handler re-opens the profile once the server has accepted the change.
// The administrator may have navigated away while that request was in flight,
// so the profile is re-rendered only when the container it lives in is still on
// the page — otherwise the re-render would paint into a detached element and
// bind its handlers to ids that are no longer in the document.
function reopenCandidate(id, host) {
  const content = alive(host) ? host.closest('#content') : null;
  if (!content) return;
  viewCandidateDetail([id], content);
}
function initials(n) { return (n || '').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase(); }
function kv(k, v) { return `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:13px;"><span class="muted">${esc(k)}</span><span style="font-weight:500;text-align:right;">${esc(v == null || v === '' ? '—' : v)}</span></div>`; }

// The recruitment report: one candidate, in the sections the business reads
// them in. Assessment results are shown as the attempts recorded them and are
// not editable here — the attempt stays authoritative, so nothing on this
// screen can disagree with what the candidate actually did.
async function tabRecruitment(d, el, id) {
  if (!alive(el)) return;
  el.innerHTML = 'Loading…';
  const [{ report }, meta] = await Promise.all([
    api('/recruitment/' + id),
    api('/recruitment/meta'),
  ]);
  // Those two requests were awaited, so the administrator may have moved to
  // another tab or another candidate while they were in flight. Rendering into
  // an element that is no longer on the page would bind handlers to nothing.
  if (!alive(el)) return;
  const c = report.candidate;
  const a = report.assessment;
  const iv = report.interview;
  const adm = report.administrative;
  const out = report.outcome;

  const mark = (v, max) => (v === null || v === undefined ? '—' : v + (max != null ? ' / ' + max : ''));
  const scoreOptions = (selected) => ['', ...meta.interviewScores]
    .map((v) => '<option value="' + v + '" ' + (String(selected === null || selected === undefined ? '' : selected) === String(v) ? 'selected' : '') + '>' + (v === '' ? '—' : v) + '</option>').join('');

  el.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <div class="section-title">Candidate information</div>
        ${kv('Candidate name', c.name)}
        ${kv('Candidate phone number', c.phone)}
        ${kv('LALCO ID', c.code)}
        ${kv('Profile status', c.profileStatus === 'PROFILE_COMPLETED' ? 'Completed by the candidate' : 'Not completed yet')}
      </div>
      <div class="card">
        <div class="section-title">Education</div>
        ${kv('Graduate from', c.graduateFromLabels ? c.graduateFromLabels.en + ' / ' + c.graduateFromLabels.lo : (c.graduateFrom || '—'))}
        ${kv('School name', c.school)}
        ${kv('Subject', c.subject)}
        ${kv('GPA / mark', c.gpa)}
      </div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="section-title">Assessment results</div>
      <p class="faint" style="margin-top:-4px;">Taken from the attempts themselves. They cannot be typed in here.</p>
      <div class="grid grid-4" style="gap:12px;">
        <div class="kpi"><div class="num">${a.iq && a.iq.estimatedIq != null ? a.iq.estimatedIq : '—'}</div><div class="lbl">IQ mark (estimated)</div></div>
        <div class="kpi"><div class="num">${a.calculation ? mark(a.calculation.marks, a.calculation.max) : '—'}</div><div class="lbl">Calculation test</div></div>
        <div class="kpi"><div class="num">${a.essay ? mark(a.essay.marks, a.essay.max) : '—'}</div><div class="lbl">Essay test</div></div>
        <div class="kpi"><div class="num">${adm.character ? esc(adm.character) : '—'}</div><div class="lbl">Character</div></div>
      </div>
      ${a.iq ? `<p class="faint" style="margin-top:10px;">${esc(a.iq.correct)}/${esc(a.iq.totalQuestions)} correct · ${esc(a.iq.percentage)}%. ${esc(meta.estimatedIqDisclaimer)}</p>` : ''}
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="section-title">Interview</div>
      <div class="grid grid-3" style="gap:12px;">
        <div class="field"><label class="field-label">Interviewer</label>
          <select id="rrInterviewer">
            <option value="">—</option>
            ${meta.interviewers.map((u) => `<option value="${esc(u.id)}" ${iv.interviewerId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label class="field-label">HR / branch interview score</label>
          <select id="rrHr">${scoreOptions(iv.hrScore)}</select></div>
        <div class="field"><label class="field-label">Chairman interview score</label>
          <select id="rrChair">${scoreOptions(iv.chairmanScore)}</select></div>
        <div class="field"><label class="field-label">Interview result</label>
          <select id="rrResult">
            <option value="">—</option>
            ${meta.interviewResults.map((r) => `<option value="${r}" ${iv.result === r ? 'selected' : ''}>${r === 'PASS' ? 'Pass' : 'Not pass'}</option>`).join('')}
          </select></div>
        <div class="field" style="grid-column:span 2;"><label class="field-label">Remark</label>
          <input id="rrRemark" value="${esc(iv.remark || '')}" maxlength="500"></div>
      </div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="section-title">Reference and character</div>
      <div class="grid grid-2" style="gap:12px;">
        <div class="field"><label class="field-label">Result for reference</label>
          <input id="rrReference" value="${esc(adm.referenceResult || '')}" maxlength="500"></div>
        <div class="field"><label class="field-label">Character</label>
          <input id="rrCharacter" value="${esc(adm.character || '')}" maxlength="500"></div>
      </div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="section-title">Final result and employment</div>
      <div class="grid grid-2" style="gap:12px;">
        <div class="field"><label class="field-label">Final result</label>
          <select id="rrFinal">
            ${meta.finalResults.map((r) => `<option value="${r}" ${out.finalResult === r ? 'selected' : ''}>${r === 'PENDING' ? 'Pending' : r === 'PASS' ? 'Pass' : 'Not pass'}</option>`).join('')}
          </select></div>
        <div class="field"><label class="field-label">Date come to work</label>
          <input id="rrDate" type="date" value="${esc(out.dateComeToWork || '')}">
          <span class="faint">Leave blank until the candidate joins.</span></div>
      </div>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
      <span class="faint" style="align-self:center;">${report.updatedBy ? 'Last updated by ' + esc(report.updatedBy) : ''}</span>
      <button class="btn btn-primary" id="rrSave" data-busy="Saving…">Save recruitment record</button>
    </div>`;

  const rrSave = $('#rrSave');
  if (!rrSave) return;
  rrSave.onclick = async () => {
    // The server validates every one of these again and is the authority.
    const r = await api('/recruitment/' + id, {
      method: 'PATCH',
      body: JSON.stringify({
        interviewerId: $('#rrInterviewer').value || null,
        hrScore: $('#rrHr').value === '' ? null : Number($('#rrHr').value),
        chairmanScore: $('#rrChair').value === '' ? null : Number($('#rrChair').value),
        interviewResult: $('#rrResult').value || null,
        remark: $('#rrRemark').value.trim() || null,
        referenceResult: $('#rrReference').value.trim() || null,
        character: $('#rrCharacter').value.trim() || null,
        finalResult: $('#rrFinal').value,
        dateComeToWork: $('#rrDate').value || null,
      }),
    });
    toast(r.changed.length ? 'Recruitment record updated (' + r.changed.length + ' field(s)).' : 'Nothing changed.');
    // Awaited, so the refresh cannot still be running after the administrator
    // has moved on; the guard at the top of the renderer then stops it writing
    // into an element that has since been replaced.
    await tabRecruitment(d, el, id);
  };
}

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
// One place that names a language, so every admin screen says the same thing.
function langLabel(code) { return code === 'lo' ? 'ລາວ (Lao)' : 'English'; }

// Whether the server has a translation provider configured. Set from the
// question bank response; the browser never learns anything else about it.
let TRANSLATION_CONFIGURED = false;

// Provenance badge. Machine output is labelled as such wherever it is shown, so
// nobody can mistake it for a reviewed translation.
function sourceBadge(src) {
  if (src === 'MACHINE') return '<span class="badge badge-warning">MACHINE</span>';
  if (src === 'HUMAN') return '<span class="badge badge-neutral">HUMAN</span>';
  return '';
}

// What a Lao candidate would still read in English on this question. The server
// computes it; this only phrases it. A gap is not an error — the English
// fallback is deliberate — so it is shown as information, and only escalated
// when the question has been APPROVED and is therefore live in Lao.
function laoGapNote(q) {
  const g = q && q.laoGaps;
  if (!g || q.laoComplete) return '';
  const bits = [];
  if (g.text) bits.push('the question text');
  if (g.parts && g.parts.length) bits.push(g.parts.length + ' step' + (g.parts.length === 1 ? '' : 's'));
  if (g.options && g.options.length) bits.push(g.options.length + ' option' + (g.options.length === 1 ? '' : 's'));
  if (!bits.length) return '';
  const live = q.translationStatus === 'APPROVED';
  return `<div class="faint" style="font-size:11.5px;margin:-2px 0 8px;color:${live ? 'var(--danger,#A13B2F)' : 'inherit'};">`
    + `${live ? '⚠ Shown in Lao now, but ' : 'Not yet translated: '}`
    + `${bits.join(', ')} would still be read in English. Nothing is auto-translated.</div>`;
}

function tabAssessment(d, el, id) {
  const active = d.links.find((l) => l.status === 'ACTIVE');
  el.innerHTML = `<div class="grid grid-2">
    <div class="card"><div class="section-title">Secure exam link</div>
      ${active ? `<div class="mono faint" style="word-break:break-all;">${location.origin}/exam/${active.token}</div><div class="faint" style="margin-top:6px;">Created ${fmtT(active.created_at)} · Expires ${fmtT(active.expires_at)} · Language <b>${esc(langLabel(active.language))}</b></div>` : '<p class="faint">No active link.</p>'}
      <div class="field" style="margin-top:12px;">
        <label class="field-label" for="linkLangEn">Candidate language</label>
        <div class="langpick" id="linkLang" role="radiogroup" aria-label="Candidate language">
          <label class="langopt"><input type="radio" id="linkLangEn" name="linkLanguage" value="en" ${active && active.language === 'lo' ? '' : 'checked'}><span>English</span></label>
          <label class="langopt"><input type="radio" id="linkLangLo" name="linkLanguage" value="lo" ${active && active.language === 'lo' ? 'checked' : ''}><span>ລາວ (Lao)</span></label>
        </div>
        <span class="faint">The exam opens in this language automatically — the candidate does not have to translate the page. They may still switch. Language never changes the answer key, the marks, the tolerance or the timing.</span>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-gold btn-sm" id="genLink" data-busy="Generating…">Generate New Link</button>
        ${active ? `<button class="btn btn-sm" id="copyLink">Copy Link</button><button class="btn btn-sm" id="copyWA">Copy WhatsApp Message</button><button class="btn btn-danger btn-sm" id="revokeLink" data-busy="Revoking…" data-link="${active.id}">Revoke Link</button>` : ''}
      </div>
    </div>
    <div class="card"><div class="section-title">Link history</div><div class="table-wrap"><table><thead><tr><th>Token</th><th>Status</th><th>Language</th><th>Created</th><th>Expires</th><th>Accessed</th><th>Actions</th></tr></thead>
    <tbody>${d.links.map((l) => `<tr><td class="mono faint">${l.token.slice(0, 10)}…</td><td><span class="badge badge-${linkBadgeTone(l.liveStatus)}">${l.liveStatus}</span></td><td>${esc(langLabel(l.language))}</td><td class="faint">${fmtT(l.created_at)}</td><td class="faint">${fmtT(l.expires_at)}</td><td class="faint">${l.first_access_at ? fmtT(l.first_access_at) : '—'}</td>
      <td style="white-space:nowrap;">${linkActionsHTML(l)}</td></tr>`).join('') || '<tr><td colspan="7" class="faint">No links yet.</td></tr>'}</tbody></table></div></div>
  </div>
  ${candidateLifecycleHTML(d)}
  ${submissionRecordHTML(d.session)}
  <div class="card" style="margin-top:14px;"><div class="section-title">Score summary</div><div class="grid grid-3">
    <div class="kpi"><div class="num">${d.scores ? d.scores.calc_marks : 0}/30</div><div class="lbl">Calculation</div></div>
    <div class="kpi"><div class="num">${d.scores && d.scores.essay_marks != null ? d.scores.essay_marks : '—'}/30</div><div class="lbl">Written</div></div>
    <div class="kpi"><div class="num">${d.scores && d.scores.interview_marks != null ? d.scores.interview_marks : '—'}/40</div><div class="lbl">Interview</div></div>
  </div></div>`;
  $('#genLink').onclick = async () => {
    const picked = $('#linkLang input:checked', el);
    const language = picked ? picked.value : 'en';
    const r = await api('/candidates/' + id + '/links', { method: 'POST', body: JSON.stringify({ language }) });
    toast('New secure link generated · ' + langLabel(r.language) + '.');
    reopenCandidate(id, el);
  };
  if ($('#copyLink')) $('#copyLink').onclick = () => copyText(`${location.origin}/exam/${active.token}`, 'Link copied.');
  wireLinkActions(d, id, el);
  wireCandidateLifecycle(d, id, el);
  if ($('#revokeLink')) $('#revokeLink').onclick = async () => {
    if (!confirm('Revoke this assessment link? The candidate will no longer be able to open it. Link history is kept.')) return;
    await api('/candidates/links/' + $('#revokeLink').dataset.link + '/revoke', { method: 'POST' });
    toast('Assessment link revoked.');
    reopenCandidate(id, el);
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
    toast('Essay score saved.'); reopenCandidate(id, el);
  };
}

function tabInterview(d, el, id) {
  el.innerHTML = 'Loading…';
  Promise.all([api('/questions/interview/questions'), api('/questions/interview/criteria')]).then(([qres, cres]) => {
    if (!alive(el)) return;
    const s = d.scores; const existing = s && s.interview_breakdown_json ? JSON.parse(s.interview_breakdown_json) : {};
    el.innerHTML = `<div class="card"><div class="section-title">Interview questions</div>${qres.questions.filter((q) => q.active).map((q) => `<div style="padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:13px;">${esc(q.text)} ${q.disqualifying ? '<span class="badge badge-warning">Can disqualify</span>' : ''}</div>`).join('')}</div>
    <div class="card" style="margin-top:14px;"><div class="section-title">Scoring rubric (40 marks)</div><div class="grid grid-2">${cres.criteria.map((c) => `<div class="field"><label class="field-label">${c.label} (0–${c.max_marks}) <span class="faint">${esc(c.hint || '')}</span></label><input type="number" min="0" max="${c.max_marks}" id="crit_${c.key}" value="${existing[c.key] ?? ''}"></div>`).join('')}</div>
    <div class="field"><label class="field-label">Comments</label><textarea id="ivComments">${s ? esc(s.interview_comments || '') : ''}</textarea></div>
    <button class="btn btn-primary btn-sm" id="saveIv" data-busy="Saving…">Save interview score</button> <span class="faint">Current: ${s && s.interview_marks != null ? s.interview_marks + '/40' : 'not yet scored'}</span></div>`;
    $('#saveIv').onclick = async () => {
      const scores = {}; cres.criteria.forEach((c) => { scores[c.key] = Number($('#crit_' + c.key).value) || 0; });
      await api('/candidates/' + id + '/interview-score', { method: 'POST', body: JSON.stringify({ scores, comments: $('#ivComments').value }) });
      toast('Interview score saved.'); reopenCandidate(id, el);
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
    if (!alive(el)) return;
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Timestamp</th><th>User</th><th>Action</th><th>Target</th></tr></thead>
    <tbody>${logs.map((l) => `<tr><td class="faint mono">${fmtDT(l.created_at)}</td><td>${esc(l.user_name)}</td><td>${esc(l.action)}</td><td class="faint">${esc(l.target)}</td></tr>`).join('') || '<tr><td colspan="4" class="faint">No entries.</td></tr>'}</tbody></table></div>`;
  });
}

// ---------------- Links (global) ----------------
async function viewLinks(_, el) {
  const { links } = await api('/links');
  if (!alive(el)) return;
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
  if (!alive(el)) return;
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
    if (!alive(el)) return;

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
    randomizeQuestions: false, questionsToShow: null,
    randomizeQuestionOrder: false, randomizeOptions: false,
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

    <div class="field-label">Random question selection</div>
    <div class="grid grid-3" style="gap:12px;">
      <div class="field"><label class="field-label">Random selection</label>
        <select id="aRandom" ${ro}>
          <option value="0" ${a.randomizeQuestions ? '' : 'selected'}>Off — every candidate sits the same questions</option>
          <option value="1" ${a.randomizeQuestions ? 'selected' : ''}>On — each candidate gets their own draw</option>
        </select></div>
      <div class="field"><label class="field-label">Questions shown</label>
        <input type="number" id="aShow" ${ro} min="1" max="500"
               value="${a.questionsToShow != null ? a.questionsToShow : ''}" placeholder="All of them">
        <span class="faint">Blank uses the whole pool below.</span></div>
      <div class="field"><label class="field-label">Question pool</label>
        <input id="aPool" disabled value="${a.eligibleQuestionCount != null ? a.eligibleQuestionCount + ' eligible' : 'set by the list below'}">
        <span class="faint">The questions ticked below, of this assessment's own type.</span></div>
      <div class="field"><label class="field-label">Randomize question order</label>
        <select id="aRandomOrder" ${ro}>
          <option value="0" ${a.randomizeQuestionOrder ? '' : 'selected'}>Off</option>
          <option value="1" ${a.randomizeQuestionOrder ? 'selected' : ''}>On</option>
        </select></div>
      <div class="field"><label class="field-label">Randomize answer options</label>
        <select id="aRandomOpts" ${ro}>
          <option value="0" ${a.randomizeOptions ? '' : 'selected'}>Off</option>
          <option value="1" ${a.randomizeOptions ? 'selected' : ''}>On</option>
        </select>
        <span class="faint">Only applies to reasoning multiple-choice questions.</span></div>
    </div>
    <p class="faint">A candidate's questions are chosen once, when they start, and stored against that attempt: reloading, switching language or reopening the link never changes them.${
      (a.selectionProblems && a.selectionProblems.length)
        ? ' <strong style="color:#b00020;">' + esc(a.selectionProblems[0]) + '</strong>'
        : ''}</p>

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
      randomizeQuestions: $('#aRandom', bg).value === '1',
      questionsToShow: $('#aShow', bg).value === '' ? null : Number($('#aShow', bg).value),
      randomizeQuestionOrder: $('#aRandomOrder', bg).value === '1',
      randomizeOptions: $('#aRandomOpts', bg).value === '1',
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
    // Re-entered by the tab buttons, the archive filter and every question
    // action, any of which can be followed by a navigation.
    if (!alive(el)) return;
    el.innerHTML = `<div class="tabs">
        <button class="${tab === 'calc' ? 'active' : ''}" data-qt="calc">Calculation</button>
        <button class="${tab === 'essay' ? 'active' : ''}" data-qt="essay">Essay</button>
        <button class="${tab === 'interview' ? 'active' : ''}" data-qt="interview">Interview</button>
      </div><div id="qBody">Loading…</div>`;
    $$('.tabs button', el).forEach((b) => (b.onclick = () => show(b.dataset.qt)));

    if (tab === 'interview') return showInterview();

    const bank = await api('/questions' + (showArchived ? '?archived=1' : ''));
    if (!alive(el)) return;
    const questions = bank.questions;
    TRANSLATION_CONFIGURED = !!bank.translationConfigured;
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
    if (!alive(el)) return;
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
      <span>Lao: ${translationBadge(q.translationStatus)}${q.laoComplete ? ' <span class="badge badge-success">COMPLETE</span>' : ''} ${sourceBadge(q.translationSource)}</span>
    </div>
    ${laoGapNote(q)}
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
      ${!q.archived && TRANSLATION_CONFIGURED && !String(q.text_lo || '').trim()
        ? `<button class="btn btn-sm" data-qact="translate" data-qid="${q.id}">Auto-translate missing Lao</button>`
        : ''}
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
      // Opens the editor and runs the translation into it. Nothing is saved
      // until the admin has read it and pressed Save.
      if (act === 'translate') return openQuestionModal(q, q.type, reload, { autoTranslateTo: 'lo' });
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

// Bilingual editor for everything a CANDIDATE reads on a calculation question:
// each step's wording and each choice option's wording, English beside Lao.
//
// The canonical option VALUE is shown read-only and is never edited here. It is
// what the answer is stored as and what grading compares against, so relabelling
// an option in either language cannot move a mark or invalidate an answer that
// has already been saved.
//
// The marking configuration above stays the authority for STRUCTURE — keys,
// marks, expected answers, tolerances, which options exist. This panel is
// rebuilt from it whenever it changes, so the two can never disagree.
function bilingualEditorHTML(config, cfgLo) {
  const parts = config && Array.isArray(config.parts) ? config.parts : [];
  if (!parts.length) {
    return '<p class="faint">Add at least one part to the marking configuration above, then its English and Lao wording appears here.</p>';
  }
  const lo = cfgLo && cfgLo.parts && typeof cfgLo.parts === 'object' ? cfgLo.parts : {};
  return parts.map((p) => {
    const entry = lo[p.key] || {};
    const loOpts = entry.options && typeof entry.options === 'object' ? entry.options : {};
    const enOpts = p.optionLabels && typeof p.optionLabels === 'object' ? p.optionLabels : {};
    const isChoice = p.type === 'choice';
    const values = isChoice && Array.isArray(p.options) ? p.options : [];
    return `<div class="card" style="margin-top:10px;padding:12px;" data-partcard="${esc(p.key)}">
      <div class="faint" style="font-size:11.5px;">Part <b class="mono">${esc(p.key)}</b> · ${Number(p.marks) || 0} mark${Number(p.marks) === 1 ? '' : 's'} · ${isChoice ? 'choice' : 'numeric'}</div>
      <div class="bilrow" style="margin-top:6px;">
        <div class="field"><label class="field-label"><span class="biltag en">EN</span> Step wording (English) *</label>
          <input class="qPartEn" data-part="${esc(p.key)}" value="${esc(p.label || '')}"></div>
        <div class="field"><label class="field-label"><span class="biltag lo">LO</span> Step wording (Lao)</label>
          <input class="qPartLo" data-part="${esc(p.key)}" value="${esc(entry.label || '')}" placeholder="Leave blank to show the English"></div>
      </div>
      ${isChoice ? `<table class="optgrid"><thead><tr><th>Canonical value (graded)</th><th><span class="biltag en">EN</span> English label</th><th><span class="biltag lo">LO</span> Lao label</th></tr></thead>
        <tbody>${values.map((v) => `<tr data-optrow="${esc(v)}">
          <td class="canon">${esc(v)}</td>
          <td><input class="qOptEn" data-part="${esc(p.key)}" data-value="${esc(v)}" value="${esc(enOpts[v] || '')}" placeholder="${esc(v)}"></td>
          <td><input class="qOptLo" data-part="${esc(p.key)}" data-value="${esc(v)}" value="${esc(loOpts[v] || '')}" placeholder="Leave blank to show the English"></td>
        </tr>`).join('')}</tbody></table>
        <span class="faint">The canonical value is read-only on purpose — it is what the candidate's answer is stored as and graded against. Blank label = show the canonical value.</span>` : ''}
    </div>`;
  }).join('');
}

// Reads the panel back. English wording is merged into the marking
// configuration; Lao becomes the overlay. Blank fields are omitted rather than
// written as empty strings, so "not translated" stays distinguishable from
// "translated to nothing" and the English fallback keeps working.
function collectBilingual(bg, config) {
  const parts = config && Array.isArray(config.parts) ? config.parts : [];
  const byKey = {};
  parts.forEach((p) => { byKey[p.key] = p; });

  $$('.qPartEn', bg).forEach((inp) => {
    const p = byKey[inp.dataset.part];
    if (p) { const v = inp.value.trim(); if (v) p.label = v; }
  });
  $$('.qOptEn', bg).forEach((inp) => {
    const p = byKey[inp.dataset.part];
    if (!p || !Array.isArray(p.options) || !p.options.includes(inp.dataset.value)) return;
    const v = inp.value.trim();
    if (!v) { if (p.optionLabels) delete p.optionLabels[inp.dataset.value]; return; }
    p.optionLabels = p.optionLabels || {};
    p.optionLabels[inp.dataset.value] = v;
  });
  parts.forEach((p) => {
    if (p.optionLabels && !Object.keys(p.optionLabels).length) delete p.optionLabels;
  });

  const loParts = {};
  $$('.qPartLo', bg).forEach((inp) => {
    const v = inp.value.trim();
    if (v && byKey[inp.dataset.part]) loParts[inp.dataset.part] = { label: v };
  });
  $$('.qOptLo', bg).forEach((inp) => {
    const p = byKey[inp.dataset.part];
    const v = inp.value.trim();
    if (!v || !p || !Array.isArray(p.options) || !p.options.includes(inp.dataset.value)) return;
    loParts[inp.dataset.part] = loParts[inp.dataset.part] || {};
    loParts[inp.dataset.part].options = loParts[inp.dataset.part].options || {};
    loParts[inp.dataset.part].options[inp.dataset.value] = v;
  });

  return { config, configLo: Object.keys(loParts).length ? { parts: loParts } : null };
}

// Create / edit. English is required; Lao is optional and can only be marked
// APPROVED deliberately — nothing is auto-translated anywhere in this app.
// Builds the request the translation endpoint expects: the candidate-visible
// wording only. No answer key, expected value, tolerance, rubric or explanation
// is included, because none of it is candidate-visible and none of it is the
// translator's business.
function translationPayloadFrom(bg, config, from) {
  const parts = config && Array.isArray(config.parts) ? config.parts : [];
  const options = [];
  parts.forEach((p) => {
    if (p.type !== 'choice' || !Array.isArray(p.options)) return;
    p.options.forEach((value) => {
      const sel = from === 'en' ? '.qOptEn' : '.qOptLo';
      const input = $(`${sel}[data-part="${cssEscape(p.key)}"][data-value="${cssEscape(value)}"]`, bg);
      const label = input ? input.value.trim() : '';
      options.push({ part: p.key, value, label: label || value });
    });
  });
  return options;
}

// Attribute selectors need their values escaped; option values are admin-chosen
// text, not identifiers.
function cssEscape(v) {
  return String(v).replace(/["\\]/g, '\\$&');
}

function openQuestionModal(question, type, onDone, opts) {
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
      <div class="field"><label class="field-label"><span class="biltag en">EN</span> English question *</label>
        <textarea id="qText" style="min-height:96px;">${editing ? esc(question.text) : ''}</textarea></div>
      <div class="field"><label class="field-label"><span class="biltag lo">LO</span> Lao question (ຄຳຖາມພາສາລາວ)</label>
        <textarea id="qTextLo" style="min-height:96px;" placeholder="Leave blank until an approved translation exists">${editing && question.text_lo ? esc(question.text_lo) : ''}</textarea></div>
    </div>

    <div class="field" id="qTranslateRow">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button type="button" class="btn btn-sm" id="qTranslateLo">Auto-translate to Lao</button>
        <button type="button" class="btn btn-sm" id="qTranslateEn">Auto-translate to English</button>
        <span class="faint" id="qTranslateMsg"></span>
      </div>
      <span class="faint">Machine translation. It fills the fields on the other side so you can read and correct them — nothing is saved until you press Save, and a machine translation is never shown to a candidate until someone sets the status to APPROVED.</span>
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

    ${type === 'CALC' ? `<div class="field"><label class="field-label">Candidate wording — English and Lao</label>
      <div id="qBilingual"></div>
      <span class="faint">Rebuilt automatically when the marking configuration above changes.</span></div>` : ''}

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

  // The panel is derived from the marking configuration, so it is rebuilt
  // whenever that changes. Lao already typed is carried across by key and by
  // canonical value, so editing the JSON never silently discards a translation.
  const panel = $('#qBilingual', bg);
  // Rebuilding the panel replaces its inputs. Two rules keep that from
  // destroying work in progress:
  //   * only write when the markup would actually differ, so a rebuild that
  //     changes nothing leaves every node — and the caret — alone;
  //   * never rebuild while the caret is inside the panel. The textarea's
  //     `change` fires as focus LEAVES it, which is exactly when someone
  //     clicks from the configuration into a Lao field; replacing that field
  //     mid-click loses the keystrokes and sends them back to the textarea.
  // The check is deferred a tick because focus has not settled while `change`
  // is being dispatched.
  function renderBilingual(cfgSource, loSource) {
    if (!panel) return;
    const html = bilingualEditorHTML(cfgSource, loSource);
    if (html !== panel.innerHTML) panel.innerHTML = html;
  }
  if (panel) {
    renderBilingual(cfg, cfgLo);
    $('#qConfig', bg).addEventListener('change', () => {
      setTimeout(() => {
        if (!bg.isConnected || panel.contains(document.activeElement)) return;
        let parsed;
        try { parsed = JSON.parse($('#qConfig', bg).value); }
        catch (e) { return; }   // invalid JSON is reported on save, not mid-typing
        // Lao already typed is carried across by part key and canonical value,
        // so editing the configuration never silently discards a translation.
        const carried = collectBilingual(bg, JSON.parse(JSON.stringify(parsed))).configLo;
        renderBilingual(parsed, carried);
      }, 0);
    });
  }

  // ---------------------------------------------------------- translation
  // `source` records WHO produced the Lao currently in the form. It starts as
  // whatever is stored, becomes MACHINE when the translator fills it in, and
  // reverts to HUMAN the moment a person edits any translated field — because
  // at that point it is no longer machine output.
  let translationSource = (editing && question.translationSource) || null;
  let translating = false;

  function markHumanEdit() {
    if (translationSource === 'MACHINE') translationSource = 'HUMAN';
  }
  ['#qTextLo', '#qText'].forEach((sel) => {
    const node = $(sel, bg);
    if (node) node.addEventListener('input', markHumanEdit);
  });
  if (panel) panel.addEventListener('input', markHumanEdit);

  function refreshTranslateButtons() {
    const toLo = $('#qTranslateLo', bg);
    const toEn = $('#qTranslateEn', bg);
    if (!toLo || !toEn) return;
    const hasEn = !!$('#qText', bg).value.trim();
    const hasLo = !!$('#qTextLo', bg).value.trim();

    // Both sides filled -> nothing is overwritten by accident. The action is
    // still available, but it is renamed so the admin knows it replaces.
    toLo.textContent = translating ? 'Translating…' : (hasLo ? 'Regenerate Lao' : 'Auto-translate to Lao');
    toEn.textContent = translating ? 'Translating…' : (hasEn ? 'Regenerate English' : 'Auto-translate to English');
    toLo.disabled = translating || !TRANSLATION_CONFIGURED || !hasEn;
    toEn.disabled = translating || !TRANSLATION_CONFIGURED || !hasLo;

    const msg = $('#qTranslateMsg', bg);
    if (msg && !translating) {
      msg.textContent = TRANSLATION_CONFIGURED
        ? ''
        : 'Automatic translation is not configured on this server.';
    }
  }

  async function runTranslation(target) {
    if (translating) return;                       // no duplicate clicks
    const from = target === 'lo' ? 'en' : 'lo';
    const sourceText = (from === 'en' ? $('#qText', bg) : $('#qTextLo', bg)).value.trim();
    if (!sourceText) return toast('There is no ' + (from === 'en' ? 'English' : 'Lao') + ' text to translate.', true);

    const targetText = (target === 'lo' ? $('#qTextLo', bg) : $('#qText', bg)).value.trim();
    if (targetText && !confirm('Replace the existing ' + (target === 'lo' ? 'Lao' : 'English') + ' wording with a new machine translation?')) return;

    let config = null;
    try { config = JSON.parse($('#qConfig', bg).value); }
    catch (e) { return toast('Fix the marking configuration before translating.', true); }

    const optionRows = panel ? translationPayloadFrom(bg, config, from) : [];
    translating = true;
    refreshTranslateButtons();
    const msg = $('#qTranslateMsg', bg);
    if (msg) msg.textContent = 'Translating…';

    try {
      const r = await api('/questions/translate', {
        method: 'POST',
        body: JSON.stringify({
          questionId: editing ? question.id : null,
          sourceLanguage: from,
          targetLanguage: target,
          question: sourceText,
          options: optionRows.map((o) => ({ value: o.value, label: o.label })),
        }),
      });

      // Populate. Existing values on the SOURCE side are never touched.
      (target === 'lo' ? $('#qTextLo', bg) : $('#qText', bg)).value = r.question;
      const byValue = {};
      (r.options || []).forEach((o) => { byValue[o.value] = o.label; });
      optionRows.forEach((row) => {
        const label = byValue[row.value];
        if (label === undefined) return;
        const sel = target === 'lo' ? '.qOptLo' : '.qOptEn';
        const input = $(`${sel}[data-part="${cssEscape(row.part)}"][data-value="${cssEscape(row.value)}"]`, bg);
        if (input) input.value = label;
      });

      // Machine output is a DRAFT. It is never promoted to APPROVED here: a
      // person has to read it and choose that themselves.
      translationSource = 'MACHINE';
      const statusSel = $('#qStatus', bg);
      if (statusSel && statusSel.value === 'MISSING') statusSel.value = 'DRAFT';
      if (msg) msg.textContent = 'Machine translation inserted — review it before saving.';
      toast('Translated. Review the wording, then Save.');
    } catch (e) {
      // Controlled message only; the server never sends provider internals.
      const detail = (e.data && e.data.error) || 'Translation failed. Please try again.';
      if (msg) msg.textContent = '';
      toast(detail, true);
    } finally {
      translating = false;
      refreshTranslateButtons();
    }
  }

  if ($('#qTranslateLo', bg)) {
    $('#qTranslateLo', bg).onclick = () => runTranslation('lo');
    $('#qTranslateEn', bg).onclick = () => runTranslation('en');
    ['#qText', '#qTextLo'].forEach((sel) => {
      const node = $(sel, bg);
      if (node) node.addEventListener('input', refreshTranslateButtons);
    });
    refreshTranslateButtons();
    if (opts && opts.autoTranslateTo) runTranslation(opts.autoTranslateTo);
  }

  $('#qSave', bg).onclick = async () => {
    const text = $('#qText', bg).value.trim();
    if (!text) return toast('The English question text is required.', true);

    let config, configLo;
    try { config = JSON.parse($('#qConfig', bg).value); }
    catch (e) { return toast('The marking configuration is not valid JSON.', true); }
    if (panel) {
      // CALC: the panel is the authority for candidate-facing wording.
      const merged = collectBilingual(bg, config);
      config = merged.config;
      configLo = merged.configLo;
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
      // Who produced the Lao now in the form. Recorded separately from the
      // approval status so machine output is never passed off as reviewed.
      translationSource,
    };
    // Only a CALC question has candidate-facing config strings. Omitting the
    // key for an essay leaves whatever is stored untouched rather than wiping it.
    if (panel) payload.configLo = configLo;

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


// ---------------- IQ Test ----------------
// Three tabs over the same section: the question bank, the tests themselves,
// and results. The bank is the only place an answer key is visible, and it is
// role-gated on the server exactly as the recruitment bank is.
let IQ_META = null;
let iqTab = 'questions';
let iqCategoryFilter = '';
let iqShowArchived = false;

function iqCategoryLabel(key) {
  const c = (IQ_META && IQ_META.categories) || [];
  const hit = c.find((x) => x.key === key);
  return hit ? hit.label : (key || '—');
}

async function viewIqTest(parts, el) {
  if (!IQ_META) {
    IQ_META = await api('/iq/meta');
    // Whether the server can translate. The IQ section may be opened before the
    // recruitment bank, which is the other place this flag gets set.
    try {
      const lim = await api('/questions/translate/limits');
      TRANSLATION_CONFIGURED = !!lim.configured;
    } catch (e) { TRANSLATION_CONFIGURED = false; }
  }
  if (!alive(el)) return;
  if (parts && parts[0] === 'result' && parts[1]) return viewIqResult(parts[1], el);

  el.innerHTML = `<div class="tabs">
      <button class="${iqTab === 'questions' ? 'active' : ''}" data-iqt="questions">Question Bank</button>
      <button class="${iqTab === 'tests' ? 'active' : ''}" data-iqt="tests">IQ Tests</button>
      <button class="${iqTab === 'results' ? 'active' : ''}" data-iqt="results">Results</button>
    </div><div id="iqBody">Loading…</div>`;
  $$('.tabs button', el).forEach((b) => (b.onclick = () => { iqTab = b.dataset.iqt; viewIqTest([], el); }));

  if (iqTab === 'questions') return iqQuestionsTab(el);
  if (iqTab === 'tests') return iqTestsTab(el);
  return iqResultsTab(el);
}

// ------------------------------------------------------------- question bank
async function iqQuestionsTab(el) {
  const query = (iqShowArchived ? '?archived=1' : '?archived=0') + (iqCategoryFilter ? '&category=' + encodeURIComponent(iqCategoryFilter) : '');
  const { questions } = await api('/iq/questions' + query);
  if (!alive(el)) return;
  const cats = (IQ_META.categories || []);

  $('#iqBody').innerHTML = `
    <div class="card" style="margin-bottom:12px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
      <div class="field" style="margin:0;"><label class="field-label">Category</label>
        <select id="iqCat"><option value="">All categories</option>
          ${cats.map((c) => `<option value="${c.key}" ${iqCategoryFilter === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select></div>
      <div class="field" style="margin:0;"><label class="field-label">Show</label>
        <select id="iqArch">
          <option value="">Active questions</option>
          <option value="1" ${iqShowArchived ? 'selected' : ''}>Archived</option>
        </select></div>
      <span style="flex:1"></span>
      ${canEditQuestions() ? '<button class="btn btn-primary btn-sm" id="iqNew">+ New IQ question</button>' : ''}
    </div>
    <div class="faint" style="margin-bottom:10px;">${questions.length} question${questions.length === 1 ? '' : 's'}${iqCategoryFilter ? ' in ' + esc(iqCategoryLabel(iqCategoryFilter)) : ''}.</div>
    ${questions.map(iqQuestionCardHTML).join('') || '<div class="empty"><h3>No IQ questions</h3><p>Add one with the button above, or run the seed.</p></div>'}`;

  $('#iqCat').onchange = (e) => { iqCategoryFilter = e.target.value; iqQuestionsTab(el); };
  $('#iqArch').onchange = (e) => { iqShowArchived = e.target.value === '1'; iqQuestionsTab(el); };
  if ($('#iqNew')) $('#iqNew').onclick = () => openIqQuestionModal(null, () => iqQuestionsTab(el));
  wireIqQuestionActions(questions, () => iqQuestionsTab(el));
}

function iqQuestionCardHTML(q) {
  return `<div class="card" style="margin-bottom:10px;">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px;">
      <span><span class="badge badge-neutral">${esc(iqCategoryLabel(q.category))}</span>
        <span class="faint">${esc(q.difficulty || '—')} · ${q.marks} mark${q.marks === 1 ? '' : 's'}</span>
        ${q.archived ? '<span class="badge badge-neutral">ARCHIVED</span>' : ''}
        ${q.active ? '' : '<span class="badge badge-warning">INACTIVE</span>'}</span>
      <span>Lao: ${translationBadge(q.translationStatus)} ${sourceBadge(q.translationSource)}</span>
    </div>
    <div class="faint" style="font-size:12px;margin:-2px 0 8px;">${
      q.usedByAssessments && q.usedByAssessments.length
        ? 'Used by: ' + q.usedByAssessments.map((n) => esc(n)).join(', ')
        : 'Not used by any test yet — candidates will never see it.'}</div>
    <div style="white-space:pre-wrap;font-size:13.5px;">${esc(q.text)}</div>
    ${q.textLo ? `<div style="white-space:pre-wrap;font-size:13.5px;margin-top:6px;padding-top:6px;border-top:1px solid var(--line-soft);"><span class="biltag lo">LO</span> ${esc(q.textLo)}</div>` : ''}
    <table class="optgrid" style="margin-top:8px;"><thead><tr><th>Value</th><th><span class="biltag en">EN</span> English</th><th><span class="biltag lo">LO</span> Lao</th><th>Correct</th></tr></thead>
      <tbody>${q.options.map((o) => `<tr>
        <td class="canon">${esc(o.value)}</td>
        <td>${esc(o.label)}</td>
        <td>${o.labelLo ? esc(o.labelLo) : '<span class="faint">—</span>'}</td>
        <td>${o.value === q.correct ? '<span class="badge badge-success">CORRECT</span>' : ''}</td>
      </tr>`).join('')}</tbody></table>
    ${q.explanation ? `<p class="faint" style="margin-top:6px;">Explanation (internal): ${esc(q.explanation)}</p>` : ''}
    <p class="faint" style="margin-top:6px;">The correct answer and the explanation are shown only here, inside the authenticated admin app — never in the candidate test.</p>
    ${canEditQuestions() ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
      <button class="btn btn-sm" data-iqact="edit" data-iqid="${q.id}">Edit</button>
      ${!q.archived && TRANSLATION_CONFIGURED && !String(q.textLo || '').trim()
        ? `<button class="btn btn-sm" data-iqact="translate" data-iqid="${q.id}">Auto-translate missing Lao</button>` : ''}
      ${q.archived
        ? `<button class="btn btn-sm" data-iqact="restore" data-iqid="${q.id}" data-busy="Restoring…">Restore</button>`
        : `<button class="btn btn-sm" data-iqact="archive" data-iqid="${q.id}" data-busy="Archiving…">Archive</button>`}
    </div>` : ''}
  </div>`;
}

function wireIqQuestionActions(questions, reload) {
  $$('[data-iqact]').forEach((btn) => {
    btn.onclick = async () => {
      const q = questions.find((x) => x.id === btn.dataset.iqid);
      const act = btn.dataset.iqact;
      if (act === 'edit') return openIqQuestionModal(q, reload);
      if (act === 'translate') return openIqQuestionModal(q, reload, { autoTranslateTo: 'lo' });
      if (act === 'archive') {
        if (!confirm('Archive this question? It is withdrawn from new tests. Completed tests keep it, and you can restore it at any time.')) return;
        await api('/iq/questions/' + q.id + '/archive', { method: 'POST' });
        toast('Question archived.');
      }
      if (act === 'restore') {
        await api('/iq/questions/' + q.id + '/restore', { method: 'POST' });
        toast('Question restored.');
      }
      reload();
    };
  });
}

// The IQ editor is a plain form: no JSON anywhere. The canonical value is shown
// read-only, because it is what the answer is stored and marked as.
function openIqQuestionModal(question, onDone, opts) {
  const editing = !!question;
  const cats = IQ_META.categories || [];
  const values = IQ_META.optionValues || ['A', 'B', 'C', 'D'];
  const current = editing ? question : {
    category: cats[0] ? cats[0].key : 'NUMERICAL', difficulty: 'MEDIUM', marks: 1,
    text: '', textLo: '', correct: 'A', explanation: '',
    options: values.slice(0, 4).map((v) => ({ value: v, label: '', labelLo: '' })),
    translationStatus: 'MISSING', translationSource: null, active: true,
  };

  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(10,18,26,.5);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:4vh 16px;overflow:auto;';
  bg.innerHTML = `<div class="card" style="max-width:820px;width:100%;">
    <div class="section-title">${editing ? 'Edit IQ question' : 'New IQ question'}</div>

    <div class="grid grid-3" style="gap:12px;">
      <div class="field"><label class="field-label">Category *</label>
        <select id="iqQCat">${cats.map((c) => `<option value="${c.key}" ${current.category === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">Difficulty</label>
        <select id="iqQDiff">${(IQ_META.difficulties || []).map((d) => `<option value="${d}" ${current.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label">Marks</label>
        <input id="iqQMarks" type="number" min="1" value="${current.marks || 1}"></div>
    </div>

    <div class="grid grid-2" style="gap:12px;">
      <div class="field"><label class="field-label"><span class="biltag en">EN</span> Question *</label>
        <textarea id="iqQText" style="min-height:110px;">${esc(current.text || '')}</textarea></div>
      <div class="field"><label class="field-label"><span class="biltag lo">LO</span> Question (Lao)</label>
        <textarea id="iqQTextLo" style="min-height:110px;" placeholder="Leave blank until a translation exists">${esc(current.textLo || '')}</textarea></div>
    </div>

    <div class="field" id="iqTranslateRow">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button type="button" class="btn btn-sm" id="iqTrLo">Auto-translate to Lao</button>
        <button type="button" class="btn btn-sm" id="iqTrEn">Auto-translate to English</button>
        <span class="faint" id="iqTrMsg"></span>
      </div>
      <span class="faint">Machine translation fills the other side so you can read and correct it. Nothing is saved until you press Save, and a machine translation is never shown to a candidate until the status is APPROVED.</span>
    </div>

    <div class="field"><label class="field-label">Options — the canonical value is what the answer is marked against</label>
      <table class="optgrid"><thead><tr><th>Value</th><th><span class="biltag en">EN</span> English *</th><th><span class="biltag lo">LO</span> Lao</th><th>Correct</th></tr></thead>
        <tbody id="iqOpts">${current.options.map((o) => `<tr data-optrow="${esc(o.value)}">
          <td class="canon">${esc(o.value)}</td>
          <td><input class="iqOptEn" data-value="${esc(o.value)}" value="${esc(o.label || '')}"></td>
          <td><input class="iqOptLo" data-value="${esc(o.value)}" value="${esc(o.labelLo || '')}" placeholder="Leave blank to show the English"></td>
          <td style="text-align:center;"><input type="radio" name="iqCorrect" value="${esc(o.value)}" ${current.correct === o.value ? 'checked' : ''}></td>
        </tr>`).join('')}</tbody></table>
      <span class="faint">Renaming an option in either language never changes which answer is correct.</span></div>

    <div class="grid grid-2" style="gap:12px;">
      <div class="field"><label class="field-label">Translation status</label>
        <select id="iqQStatus">${['MISSING', 'DRAFT', 'APPROVED'].map((st) => `<option value="${st}" ${current.translationStatus === st ? 'selected' : ''}>${st}</option>`).join('')}</select>
        <span class="faint">Only APPROVED Lao is shown to a candidate.</span></div>
      <div class="field"><label class="field-label">Active</label>
        <select id="iqQActive">
          <option value="1" ${current.active !== false ? 'selected' : ''}>Active</option>
          <option value="0" ${current.active === false ? 'selected' : ''}>Inactive</option>
        </select></div>
    </div>

    <div class="field"><label class="field-label">Explanation (internal — never shown to candidates)</label>
      <textarea id="iqQExpl" style="min-height:60px;">${esc(current.explanation || '')}</textarea></div>

    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" id="iqCancel">Cancel</button>
      <button class="btn btn-primary" id="iqSave" data-busy="Saving…">${editing ? 'Save changes' : 'Create question'}</button>
    </div>
  </div>`;

  document.body.appendChild(bg);
  const close = makeDismissable(bg);
  $('#iqCancel', bg).onclick = close;
  $('#iqQText', bg).focus();

  // Provenance, exactly as the recruitment editor tracks it: machine output
  // stays labelled MACHINE only until a person edits it.
  let translationSource = (editing && question.translationSource) || null;
  let translating = false;
  function markHumanEdit() { if (translationSource === 'MACHINE') translationSource = 'HUMAN'; }
  ['#iqQText', '#iqQTextLo'].forEach((sel) => { const n = $(sel, bg); if (n) n.addEventListener('input', markHumanEdit); });
  $('#iqOpts', bg).addEventListener('input', markHumanEdit);

  function readOptions() {
    return $$('#iqOpts tr[data-optrow]', bg).map((tr) => ({
      value: tr.dataset.optrow,
      label: $('.iqOptEn', tr).value.trim(),
      labelLo: $('.iqOptLo', tr).value.trim(),
    }));
  }
  function selectedCorrect() {
    const r = $('#iqOpts input[name="iqCorrect"]:checked', bg);
    return r ? r.value : null;
  }

  function refreshTranslate() {
    const lo = $('#iqTrLo', bg), en = $('#iqTrEn', bg);
    const hasEn = !!$('#iqQText', bg).value.trim();
    const hasLo = !!$('#iqQTextLo', bg).value.trim();
    lo.textContent = translating ? 'Translating…' : (hasLo ? 'Regenerate Lao' : 'Auto-translate to Lao');
    en.textContent = translating ? 'Translating…' : (hasEn ? 'Regenerate English' : 'Auto-translate to English');
    lo.disabled = translating || !TRANSLATION_CONFIGURED || !hasEn;
    en.disabled = translating || !TRANSLATION_CONFIGURED || !hasLo;
    const msg = $('#iqTrMsg', bg);
    if (msg && !translating) msg.textContent = TRANSLATION_CONFIGURED ? '' : 'Automatic translation is not configured on this server.';
  }

  async function runTranslation(target) {
    if (translating) return;
    const from = target === 'lo' ? 'en' : 'lo';
    const sourceText = (from === 'en' ? $('#iqQText', bg) : $('#iqQTextLo', bg)).value.trim();
    if (!sourceText) return toast('There is no ' + (from === 'en' ? 'English' : 'Lao') + ' text to translate.', true);
    const targetText = (target === 'lo' ? $('#iqQTextLo', bg) : $('#iqQText', bg)).value.trim();
    if (targetText && !confirm('Replace the existing ' + (target === 'lo' ? 'Lao' : 'English') + ' wording with a new machine translation?')) return;

    const opts = readOptions().map((o) => ({ value: o.value, label: (from === 'en' ? o.label : o.labelLo) || o.value }));
    translating = true; refreshTranslate();
    const msg = $('#iqTrMsg', bg);
    if (msg) msg.textContent = 'Translating…';
    try {
      const r = await api('/questions/translate', {
        method: 'POST',
        body: JSON.stringify({
          questionId: editing ? question.id : null,
          sourceLanguage: from, targetLanguage: target,
          question: sourceText, options: opts,
        }),
      });
      (target === 'lo' ? $('#iqQTextLo', bg) : $('#iqQText', bg)).value = r.question;
      const byValue = {};
      (r.options || []).forEach((o) => { byValue[o.value] = o.label; });
      $$('#iqOpts tr[data-optrow]', bg).forEach((tr) => {
        const label = byValue[tr.dataset.optrow];
        if (label === undefined) return;
        $(target === 'lo' ? '.iqOptLo' : '.iqOptEn', tr).value = label;
      });
      translationSource = 'MACHINE';
      const st = $('#iqQStatus', bg);
      if (st && st.value === 'MISSING') st.value = 'DRAFT';
      if (msg) msg.textContent = 'Machine translation inserted — review it before saving.';
      toast('Translated. Review the wording, then Save.');
    } catch (e) {
      if (msg) msg.textContent = '';
      toast((e.data && e.data.error) || 'Translation failed. Please try again.', true);
    } finally {
      translating = false; refreshTranslate();
    }
  }

  $('#iqTrLo', bg).onclick = () => runTranslation('lo');
  $('#iqTrEn', bg).onclick = () => runTranslation('en');
  ['#iqQText', '#iqQTextLo'].forEach((sel) => { const n = $(sel, bg); if (n) n.addEventListener('input', refreshTranslate); });
  refreshTranslate();
  if (opts && opts.autoTranslateTo) runTranslation(opts.autoTranslateTo);

  $('#iqSave', bg).onclick = async () => {
    const payload = {
      category: $('#iqQCat', bg).value,
      difficulty: $('#iqQDiff', bg).value,
      marks: Number($('#iqQMarks', bg).value) || 1,
      text: $('#iqQText', bg).value.trim(),
      textLo: $('#iqQTextLo', bg).value.trim() || null,
      options: readOptions(),
      correct: selectedCorrect(),
      explanation: $('#iqQExpl', bg).value.trim() || null,
      translationStatus: $('#iqQStatus', bg).value,
      translationSource,
      active: $('#iqQActive', bg).value === '1',
    };
    // The server validates all of this again and is the authority.
    if (!payload.text) return toast('The English question text is required.', true);
    if (!payload.correct) return toast('Choose which option is correct.', true);
    const r = editing
      ? await api('/iq/questions/' + question.id, { method: 'PATCH', body: JSON.stringify(payload) })
      : await api('/iq/questions', { method: 'POST', body: JSON.stringify(payload) });
    toast(`IQ question ${editing ? 'updated' : 'created'} · Lao ${r.translationStatus}.`);
    close();
    onDone && onDone();
  };
}

// -------------------------------------------------------------------- tests
async function iqTestsTab(el) {
  const { assessments } = await api('/assessments');
  if (!alive(el)) return;
  const tests = assessments.filter((a) => a.assessmentType === 'IQ_TEST');
  $('#iqBody').innerHTML = `
    <div class="card" style="margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <span class="faint">An IQ test is an assessment of type IQ_TEST. It has its own duration, its own question set and its own scoring model.</span>
      <span style="flex:1"></span>
      ${canEditQuestions() ? '<button class="btn btn-primary btn-sm" id="iqNewTest">+ New IQ test</button>' : ''}
    </div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Questions</th><th>Duration</th><th>Pass</th><th>Estimated score</th><th>Status</th><th></th></tr></thead>
      <tbody>${tests.map((a) => `<tr>
        <td>${esc(a.name)}</td>
        <td class="mono">${a.questionCount}</td>
        <td class="mono">${a.duration_minutes} min</td>
        <td class="mono">${a.iqScoring ? a.iqScoring.passThreshold + '%' : '—'}</td>
        <td>${a.iqScoring && a.iqScoring.estimatedIqEnabled ? '<span class="badge badge-neutral">ON</span>' : '<span class="faint">off</span>'}</td>
        <td>${a.archived ? '<span class="badge badge-neutral">ARCHIVED</span>' : a.active ? '<span class="badge badge-success">ACTIVE</span>' : '<span class="badge badge-warning">INACTIVE</span>'}</td>
        <td><button class="btn btn-sm" data-iqtest="${a.id}">Open in Assessments →</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="faint">No IQ tests yet.</td></tr>'}</tbody></table></div>
    <p class="faint" style="margin-top:10px;">Any estimated figure is derived from this test alone. It is <b>not</b> a clinically validated IQ and must not be presented as one.</p>`;

  $$('[data-iqtest]').forEach((b) => (b.onclick = () => goto('assessments/' + b.dataset.iqtest)));
  if ($('#iqNewTest')) $('#iqNewTest').onclick = () => openIqTestModal(() => iqTestsTab(el));
}

function openIqTestModal(onDone) {
  const d = IQ_META.defaultScoring || {};
  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(10,18,26,.5);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;overflow:auto;';
  bg.innerHTML = `<div class="card" style="max-width:620px;width:100%;">
    <div class="section-title">New IQ test</div>
    <div class="field"><label class="field-label">Name *</label><input id="itName" placeholder="LALCO Reasoning (IQ) Test 2026"></div>
    <div class="grid grid-2" style="gap:12px;">
      <div class="field"><label class="field-label">Duration (minutes)</label><input id="itDur" type="number" min="1" value="30"></div>
      <div class="field"><label class="field-label">Invitation expiry (minutes)</label><input id="itExp" type="number" min="1" value="10"></div>
    </div>
    <div class="grid grid-2" style="gap:12px;">
      <div class="field"><label class="field-label">Pass threshold (% correct)</label><input id="itPass" type="number" min="0" max="100" value="${d.passThreshold != null ? d.passThreshold : 50}"></div>
      <div class="field"><label class="field-label">Estimated score</label>
        <select id="itEst"><option value="1">Publish an estimated figure</option><option value="0">Raw score and percentage only</option></select>
        <span class="faint">An estimate from this test only — never a clinical IQ.</span></div>
    </div>
    <div class="field-label">Random question selection</div>
    <div class="grid grid-2" style="gap:12px;">
      <div class="field"><label class="field-label">Random selection</label>
        <select id="itRandom"><option value="1" selected>On — each candidate gets their own draw</option><option value="0">Off</option></select></div>
      <div class="field"><label class="field-label">Questions shown</label>
        <input id="itShow" type="number" min="1" max="500" placeholder="All attached questions">
        <span class="faint">Blank shows every question attached to the test.</span></div>
      <div class="field"><label class="field-label">Randomize question order</label>
        <select id="itRandomOrder"><option value="1" selected>On</option><option value="0">Off</option></select></div>
      <div class="field"><label class="field-label">Randomize answer options</label>
        <select id="itRandomOpts"><option value="0" selected>Off</option><option value="1">On</option></select></div>
    </div>
    <p class="faint">Questions are attached afterwards in Assessments, from the IQ bank. Each candidate's questions are drawn once, when they start, and never change for that attempt.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" id="itCancel">Cancel</button>
      <button class="btn btn-primary" id="itSave" data-busy="Creating…">Create IQ test</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = makeDismissable(bg);
  $('#itCancel', bg).onclick = close;
  $('#itName', bg).focus();
  $('#itSave', bg).onclick = async () => {
    const name = $('#itName', bg).value.trim();
    if (!name) return toast('A name is required.', true);
    const r = await api('/assessments', {
      method: 'POST',
      body: JSON.stringify({
        name,
        assessmentType: 'IQ_TEST',
        duration_minutes: Number($('#itDur', bg).value) || 30,
        link_expiry_minutes: Number($('#itExp', bg).value) || 10,
        iqScoring: { ...d, passThreshold: Number($('#itPass', bg).value), estimatedIqEnabled: $('#itEst', bg).value === '1' },
        randomizeQuestions: $('#itRandom', bg).value === '1',
        questionsToShow: $('#itShow', bg).value === '' ? null : Number($('#itShow', bg).value),
        randomizeQuestionOrder: $('#itRandomOrder', bg).value === '1',
        randomizeOptions: $('#itRandomOpts', bg).value === '1',
      }),
    });
    toast('IQ test created. Attach questions in Assessments.');
    close();
    onDone && onDone();
  };
}

// ------------------------------------------------------------------ results
async function iqResultsTab(el) {
  const { results, estimatedIqDisclaimer } = await api('/iq/results');
  if (!alive(el)) return;
  $('#iqBody').innerHTML = `
    <div class="table-wrap"><table><thead><tr><th>Candidate</th><th>LALCO ID</th><th>Test</th><th>Language</th><th>Correct</th><th>Score</th><th>Estimated</th><th>Duration</th><th></th></tr></thead>
      <tbody>${results.map((r) => `<tr>
        <td>${esc(r.candidateName)}</td>
        <td class="mono faint">${esc(r.candidateCode)}</td>
        <td>${esc(r.assessmentName || '—')}</td>
        <td>${r.language === 'lo' ? 'ລາວ (Lao)' : 'English'}</td>
        <td class="mono">${r.correct}/${r.totalQuestions}</td>
        <td class="mono">${r.rawScore}/${r.rawMax} · ${r.percentage}%</td>
        <td class="mono">${r.estimatedIq != null ? r.estimatedIq : '—'}</td>
        <td class="mono">${r.durationSeconds != null ? Math.floor(r.durationSeconds / 60) + 'm ' + (r.durationSeconds % 60) + 's' : '—'}</td>
        <td><button class="btn btn-sm" data-iqres="${r.sessionId}">View →</button></td>
      </tr>`).join('') || '<tr><td colspan="9" class="faint">No IQ results yet.</td></tr>'}</tbody></table></div>
    <p class="faint" style="margin-top:10px;">${esc(estimatedIqDisclaimer)}</p>`;
  $$('[data-iqres]').forEach((b) => (b.onclick = () => goto('iq/result/' + b.dataset.iqres)));
}

async function viewIqResult(sessionId, el) {
  const { result, estimatedIqDisclaimer } = await api('/iq/results/' + encodeURIComponent(sessionId));
  if (!alive(el)) return;
  const cats = Object.keys(result.categoryScores || {});
  el.innerHTML = `
    <button class="btn btn-sm" id="iqBack" style="margin-bottom:12px;">← Back to results</button>
    <div class="card">
      <div class="section-title">${esc(result.candidate ? result.candidate.name : '')} <span class="faint">${esc(result.candidate ? result.candidate.code : '')}</span></div>
      <div class="grid grid-4">
        <div class="kpi"><div class="num">${result.correct}/${result.totalQuestions}</div><div class="lbl">Correct</div></div>
        <div class="kpi"><div class="num">${result.percentage}%</div><div class="lbl">Percentage</div></div>
        <div class="kpi"><div class="num">${result.rawScore}/${result.rawMax}</div><div class="lbl">Raw score</div></div>
        <div class="kpi"><div class="num">${result.estimatedIq != null ? result.estimatedIq : '—'}</div><div class="lbl">Estimated score</div></div>
      </div>
      <div class="grid grid-4" style="margin-top:10px;">
        ${kv('Test', result.assessment ? result.assessment.name : '—')}
        ${kv('Language sat in', result.language === 'lo' ? 'ລາວ (Lao)' : 'English')}
        ${kv('Duration', result.durationSeconds != null ? Math.floor(result.durationSeconds / 60) + 'm ' + (result.durationSeconds % 60) + 's' : '—')}
        ${kv('Submitted', fmtDT(result.submittedAt))}
      </div>
      <p class="faint" style="margin-top:8px;"><b>${esc(estimatedIqDisclaimer)}</b></p>
    </div>

    <div class="card" style="margin-top:14px;"><div class="section-title">Category breakdown</div>
      <div class="table-wrap"><table><thead><tr><th>Category</th><th>Correct</th><th>Incorrect</th><th>Unanswered</th><th>Score</th></tr></thead>
        <tbody>${cats.map((k) => {
          const c = result.categoryScores[k];
          return `<tr><td>${esc(iqCategoryLabel(k))}</td><td class="mono">${c.correct}/${c.total}</td>
            <td class="mono">${c.incorrect}</td><td class="mono">${c.unanswered}</td>
            <td class="mono">${c.marks}/${c.max} · ${c.percentage}%</td></tr>`;
        }).join('')}</tbody></table></div></div>

    <div class="card" style="margin-top:14px;"><div class="section-title">Question by question</div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Category</th><th>Question</th><th>Answer given</th><th>Correct answer</th><th>Marks</th></tr></thead>
        <tbody>${(result.review || []).map((r, i) => `<tr>
          <td>${i + 1}</td><td class="faint">${esc(iqCategoryLabel(r.category))}</td>
          <td style="max-width:320px;">${esc((r.text || '').slice(0, 140))}${(r.text || '').length > 140 ? '…' : ''}</td>
          <td class="mono">${r.submitted == null ? '<span class="faint">—</span>' : esc(r.submitted)}</td>
          <td class="mono">${esc(r.expected)}</td>
          <td>${r.correct ? '<span class="badge badge-success">' + r.marks + '/' + r.max + '</span>' : '<span class="badge badge-danger">0/' + r.max + '</span>'}</td>
        </tr>`).join('')}</tbody></table></div>
      <p class="faint" style="margin-top:6px;">Correct answers are shown only on this authenticated admin page.</p></div>`;
  $('#iqBack').onclick = () => { iqTab = 'results'; goto('iq'); };
}

// ---------------- Interviews queue ----------------
async function viewInterviews(_, el) {
  const { queue } = await api('/interviews/queue');
  if (!alive(el)) return;
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Calc</th><th>Essay</th><th>Interview</th><th></th></tr></thead>
  <tbody>${queue.map((q) => `<tr><td>${esc(q.fullName)}</td><td class="mono">${q.calc}/30</td><td class="mono">${q.essay}/30</td><td class="mono">${q.interview != null ? q.interview + '/40' : '<span class="badge badge-warning">Pending</span>'}</td><td><button class="btn btn-sm" data-id="${q.id}">${q.interview != null ? 'View' : 'Score'} →</button></td></tr>`).join('') || '<tr><td colspan="5" class="faint">No candidates ready for interview.</td></tr>'}</tbody></table></div>`;
  $$('button[data-id]', el).forEach((b) => (b.onclick = () => { profileTab = 'interview'; goto('candidates/' + b.dataset.id); }));
}

// ---------------- Analytics ----------------
async function viewAnalytics(_, el) {
  const a = await api('/analytics');
  if (!alive(el)) return;
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
  // The export takes a while; the administrator may be on another screen by the
  // time it answers, so the progress line is written only if it is still there.
  const sheetsMsg = (t) => { const n = $('#sheetsBatchMsg'); if (n) n.textContent = t; };
  $('#sheetsBatch').onclick = async () => {
    sheetsMsg('Exporting…');
    try {
      const r = await api('/reports/google-sheets', { method: 'POST' });
      sheetsMsg(`Candidates ${r.candidates} · Assessments ${r.assessments} · Questions ${r.questions} · Interviews ${r.interviews} · Errors ${r.errors}`);
      toast('Exported to Google Sheets.');
    } catch (e) {
      sheetsMsg('Google Sheets unavailable — data remains in the database and can be retried.');
    }
  };
}

// ---------------- Scholarship ----------------
async function viewScholarship(_, el) {
  const { policy } = await api('/scholarship');
  if (!alive(el)) return;
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
  if (!alive(el)) return;

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
  // Re-entered after a sync, a demo create/delete and a deletion, so the first
  // guard covers the callers and the second covers this call's own wait.
  if (!alive(el)) return;
  el.innerHTML = 'Loading…';
  const d = await api('/settings/data-management');
  if (!alive(el)) return;
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
    const syncResult = (html) => { const n = $('#syncResult'); if (n) n.innerHTML = html; };
    syncResult('Syncing…');
    try {
      const r = await api(path, { method: 'POST' });
      syncResult(`<b>Candidates synced:</b> ${r.candidates} &nbsp; <b>Assessments synced:</b> ${r.assessments} &nbsp; <b>Questions synced:</b> ${r.questions} &nbsp; <b>Interviews synced:</b> ${r.interviews} &nbsp; <b>Errors:</b> ${r.errors}`);
      toast('Google Sheets sync completed.');
      viewDataManagement(_, el);
    } catch (e) {
      syncResult(`<span style="color:var(--danger);">${esc(e.message)}</span> — assessment results remain safely stored in SQLite and can be retried.`);
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
    const previewEl = $('#deletePreview');
    if (!previewEl) return;
    previewEl.textContent = `About to remove ${preview.candidates} candidates, ${preview.assessments} assessment sessions, ${preview.answers} answers and ${preview.links} assessment links.`;
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
      if (!alive(el)) return;
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
  const reload = () => reopenCandidate(id, el);
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
      reopenCandidate(id, el);
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
    if (!alive(el)) return;
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
  // renderShell() stops the refresh when it replaces a view. If that already
  // happened while this first load was in flight, installing a timer here would
  // leave it polling for a screen nobody is looking at.
  if (!alive(el)) return;
  stopLiveRefresh();
  LIVE_TIMER = setInterval(load, 15000);
}

// ---------------- Users ---------------------------------------------------
async function viewUsers(_, el) {
  async function load() {
    const { users, roles, minPasswordLength } = await api('/users');
    if (!alive(el)) return;
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
  async function load() {
    // Debounced from the search box, so the view may already have been replaced
    // both before the request goes out and after it comes back.
    if (!alive(el)) return;
    const { logs } = await api('/audit?q=' + encodeURIComponent($('#aq').value));
    if (!alive(el)) return;
    $('#rows').innerHTML = logs.map((l) => `<tr><td class="faint mono">${fmtDT(l.created_at)}</td><td>${esc(l.user_name)}</td><td class="faint">${esc(l.role)}</td><td>${esc(l.action)}</td><td class="faint mono">${esc(l.target)}</td></tr>`).join('') || '<tr><td colspan="5" class="faint">No entries.</td></tr>';
  }
  $('#aq').addEventListener('input', debounce(load, 300));
  load();
}

render();
