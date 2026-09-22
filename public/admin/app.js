'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtDT(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
function fmtT(iso) { if (!iso) return '—'; return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function toast(msg, isError) { let w = $('.toast-wrap'); if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); } const t = document.createElement('div'); t.className = 'toast' + (isError ? ' error' : ''); t.textContent = msg; w.appendChild(t); setTimeout(() => t.remove(), 3200); }

let AUTH = JSON.parse(localStorage.getItem('lalco_admin_auth') || 'null'); // {token, user}
function saveAuth() { localStorage.setItem('lalco_admin_auth', JSON.stringify(AUTH)); }

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (AUTH && AUTH.token) headers.Authorization = 'Bearer ' + AUTH.token;
  const res = await fetch('/api/admin' + path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { AUTH = null; saveAuth(); location.hash = '#/login'; throw new Error('Session expired'); }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.blob();
  if (!res.ok) { const msg = (data && data.error) || 'Request failed'; toast(msg, true); throw new Error(msg); }
  return data;
}
async function downloadFile(path, filenameFallback) {
  const headers = {}; if (AUTH && AUTH.token) headers.Authorization = 'Bearer ' + AUTH.token;
  const res = await fetch('/api/admin' + path, { headers });
  if (!res.ok) { toast('Download failed', true); return; }
  const blob = await res.blob();
  const disp = res.headers.get('content-disposition') || '';
  const m = disp.match(/filename="(.+)"/);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = m ? m[1] : filenameFallback; document.body.appendChild(a); a.click(); a.remove();
}

const NAV = [
  { key: 'dashboard', label: 'Dashboard', roles: null },
  { key: 'candidates', label: 'Candidates', roles: null },
  { key: 'links', label: 'Assessment Links', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'RECRUITER'] },
  { key: 'questions', label: 'Question Bank', roles: ['SUPER_ADMIN', 'HR_ADMIN'] },
  { key: 'interviews', label: 'Interviews', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'INTERVIEWER', 'MANAGER'] },
  { key: 'analytics', label: 'Analytics', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER'] },
  { key: 'scholarship', label: 'Scholarship Policy', roles: ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER'] },
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
    <button class="btn btn-primary" id="lBtn" style="width:100%;justify-content:center;padding:11px;">Sign in</button>
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
function renderShell(parts) {
  const key = parts[0];
  const item = NAV.find((n) => n.key === key);
  document.body.innerHTML = `<div id="app"></div>`;
  const app = $('#app');
  app.innerHTML = `<div class="shell"><aside class="sidebar">${sidebarHTML(key)}</aside>
    <div class="main"><div class="topbar"><h2 style="font-size:16px;">${item ? item.label : ''}</h2></div><div class="content" id="content"></div></div></div>`;
  $$('.sidebar-nav a').forEach((a) => (a.onclick = () => goto(a.dataset.nav)));
  $('#logoutBtn').onclick = logout;
  if (item && !navAllowed(item)) { $('#content').innerHTML = `<div class="empty"><h3>Not authorized</h3><p>Your role does not have access to this section.</p></div>`; return; }
  const views = { dashboard: viewDashboard, candidates: viewCandidates, links: viewLinks, questions: viewQuestions, interviews: viewInterviews, analytics: viewAnalytics, scholarship: viewScholarship, settings: viewSettings, data: viewDataManagement, audit: viewAudit };
  (views[key] || viewDashboard)(parts.slice(1), $('#content'));
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
      <button class="btn btn-primary" id="newCandBtn">+ New Candidate</button>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Position</th><th>Type</th><th>Eligibility</th><th>Calc</th><th>Essay</th><th>Interview</th><th>Final</th><th>Status</th><th>AI Risk</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>`;
  async function load() {
    const q = $('#fq').value;
    const { candidates } = await api('/candidates' + (q ? '?q=' + encodeURIComponent(q) : ''));
    $('#rows').innerHTML = candidates.map((c) => `<tr style="cursor:pointer" data-id="${c.id}">
      <td class="mono faint">${c.code}</td><td>${esc(c.fullName)}${c.isDemo ? ' <span class="badge badge-neutral">demo</span>' : ''}</td>
      <td class="faint">${esc(c.appliedPosition || '—')}</td><td>${c.applicationType === 'SCHOLARSHIP' ? '<span class="badge badge-info">Scholarship</span>' : '<span class="badge badge-neutral">Normal</span>'}</td>
      <td>${eligBadge(c.eligibilityStatus)}</td><td class="mono">${c.calc ?? '—'}</td><td class="mono">${c.essay ?? '—'}</td><td class="mono">${c.interview ?? '—'}</td>
      <td class="mono"><b>${c.final ?? '—'}</b></td><td>${statusBadge(c.status)}</td><td>${riskBadge(c.aiRisk)}</td><td><button class="btn btn-sm">Open →</button></td></tr>`).join('') || `<tr><td colspan="12" class="faint" style="text-align:center;padding:20px;">No candidates.</td></tr>`;
    $$('#rows tr[data-id]').forEach((tr) => (tr.onclick = () => goto('candidates/' + tr.dataset.id)));
  }
  $('#fq').addEventListener('input', debounce(load, 300));
  $('#newCandBtn').onclick = () => openNewCandidateModal(load);
  load();
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function openNewCandidateModal(onDone) {
  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(10,18,26,.45);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px;overflow:auto;';
  bg.innerHTML = `<div class="card" style="max-width:520px;width:100%;">
    <div class="section-title">New candidate</div>
    <div class="grid grid-2">
      <div class="field"><label class="field-label">Full name *</label><input id="nFullName"></div>
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
    <div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn" id="cancelBtn">Cancel</button><button class="btn btn-primary" id="saveBtn">Create candidate</button></div>
  </div>`;
  document.body.appendChild(bg);
  $('#cancelBtn', bg).onclick = () => bg.remove();
  $('#saveBtn', bg).onclick = async () => {
    const fullName = $('#nFullName', bg).value.trim();
    if (!fullName) return toast('Full name is required', true);
    try {
      await api('/candidates', { method: 'POST', body: JSON.stringify({ fullName, applicationType: $('#nType', bg).value, iq: Number($('#nIQ', bg).value) || null, education: $('#nEdu', bg).value, gpa: Number($('#nGpa', bg).value) || null, position: $('#nPos', bg).value, department: $('#nDept', bg).value, branch: $('#nBranch', bg).value, phone: $('#nPhone', bg).value, dob: $('#nDob', bg).value }) });
      toast('Candidate created'); bg.remove(); onDone && onDone();
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
        <button class="btn btn-gold btn-sm" id="genLink">Generate New Link</button>
        ${active ? `<button class="btn btn-sm" id="copyLink">Copy Link</button><button class="btn btn-sm" id="copyWA">Copy WhatsApp Message</button>` : ''}
      </div>
    </div>
    <div class="card"><div class="section-title">Link history</div><div class="table-wrap"><table><thead><tr><th>Token</th><th>Status</th><th>Created</th><th>Expires</th><th>Accessed</th></tr></thead>
    <tbody>${d.links.map((l) => `<tr><td class="mono faint">${l.token.slice(0, 10)}…</td><td>${linkBadge(l.status, l.expires_at)}</td><td class="faint">${fmtT(l.created_at)}</td><td class="faint">${fmtT(l.expires_at)}</td><td class="faint">${l.first_access_at ? fmtT(l.first_access_at) : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="faint">No links yet.</td></tr>'}</tbody></table></div></div>
  </div>
  <div class="card" style="margin-top:14px;"><div class="section-title">Score summary</div><div class="grid grid-3">
    <div class="kpi"><div class="num">${d.scores ? d.scores.calc_marks : 0}/30</div><div class="lbl">Calculation</div></div>
    <div class="kpi"><div class="num">${d.scores && d.scores.essay_marks != null ? d.scores.essay_marks : '—'}/30</div><div class="lbl">Written</div></div>
    <div class="kpi"><div class="num">${d.scores && d.scores.interview_marks != null ? d.scores.interview_marks : '—'}/40</div><div class="lbl">Interview</div></div>
  </div></div>`;
  $('#genLink').onclick = async () => { await api('/candidates/' + id + '/links', { method: 'POST' }); toast('New secure link generated.'); viewCandidateDetail([id], el.parentElement); };
  if ($('#copyLink')) $('#copyLink').onclick = () => { navigator.clipboard.writeText(`${location.origin}/exam/${active.token}`); toast('Link copied.'); };
  if ($('#copyWA')) $('#copyWA').onclick = () => { navigator.clipboard.writeText(`Dear ${d.candidate.full_name},\n\nYou are invited to complete the LALCO recruitment assessment.\n\nAssessment link:\n${location.origin}/exam/${active.token}\n\nThis invitation link expires shortly. Please complete the assessment within the allocated assessment time once you begin.\n\nThank you.`); toast('WhatsApp message copied.'); };
}
function linkBadge(status, expiresAt) {
  let live = status;
  if (status === 'ACTIVE' && new Date(expiresAt) < new Date()) live = 'EXPIRED';
  const m = { ACTIVE: 'success', EXPIRED: 'warning', USED: 'info', REVOKED: 'danger' };
  return `<span class="badge badge-${m[live]}">${live}</span>`;
}

function tabQuestions(d, el, id) {
  const calc = d.answers.filter((a) => a.type === 'CALC');
  const essay = d.answers.find((a) => a.type === 'ESSAY');
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Q</th><th>Category</th><th>Max</th><th>Score</th><th>Time</th><th>Status</th><th></th></tr></thead>
    <tbody>${calc.map((a, i) => {
      const b = a.breakdown; const status = !b ? 'SKIPPED' : b.marks === b.max ? 'PASS' : b.marks === 0 ? 'FAIL' : 'PARTIAL';
      const m = { PASS: 'success', PARTIAL: 'warning', FAIL: 'danger', SKIPPED: 'neutral' };
      return `<tr><td>Q${i + 1}</td><td class="faint">${esc(a.category)}</td><td>${a.maxMarks}</td><td class="mono">${b ? b.marks : '—'}</td><td class="faint mono">${fmtSec(a.timeSpentSeconds)}</td><td><span class="badge badge-${m[status]}">${status}</span></td><td><button class="btn btn-sm" data-i="${i}">Details ▾</button></td></tr>
      <tr class="qd" data-d="${i}" style="display:none;"><td colspan="7">${b ? questionDetail(a, b) : '<span class="faint">Not attempted.</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>
    ${essayCard(essay, d, id)}`;
  $$('#content button[data-i]').forEach((b) => (b.onclick = () => { const r = $(`.qd[data-d="${b.dataset.i}"]`); r.style.display = r.style.display === 'none' ? 'table-row' : 'none'; }));
  wireEssayCard(d, id, el);
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
    <button class="btn btn-primary btn-sm" id="saveEssay">Save essay score</button> <span class="faint">Current: ${s && s.essay_marks != null ? s.essay_marks + '/30' : 'not yet scored'}</span>` : ''}
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
    <button class="btn btn-primary btn-sm" id="saveIv">Save interview score</button> <span class="faint">Current: ${s && s.interview_marks != null ? s.interview_marks + '/40' : 'not yet scored'}</span></div>`;
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
    <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" id="pdfBtn">Download PDF</button><button class="btn btn-sm" id="csvBtn">Export CSV</button></div></div>`;
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

// ---------------- Question bank ----------------
async function viewQuestions(_, el) {
  el.innerHTML = `<div class="tabs"><button class="active" data-qt="calc">Calculation</button><button data-qt="essay">Essay</button><button data-qt="interview">Interview</button></div><div id="qBody"></div>`;
  async function show(t) {
    if (t === 'calc' || t === 'essay') {
      const { questions } = await api('/questions');
      const list = questions.filter((q) => q.type === t.toUpperCase());
      $('#qBody').innerHTML = list.map((q) => `<div class="card" style="margin-bottom:12px;"><div class="section-title">${esc(q.category || q.type)} <span class="faint">${q.max_marks} marks</span></div>
        <p style="font-size:13px;">${esc(q.text)}</p>
        ${q.type === 'CALC' ? `<table style="font-size:12.6px;"><thead><tr><th>Step</th><th>Marks</th></tr></thead><tbody>${q.config.parts.map((p) => `<tr><td>${esc(p.label)}</td><td>${p.marks}</td></tr>`).join('')}</tbody></table>` : `<table style="font-size:12.6px;"><thead><tr><th>Criterion</th><th>Max</th></tr></thead><tbody>${q.config.rubric.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.max}</td></tr>`).join('')}</tbody></table>`}
        <p class="faint" style="margin-top:6px;">Answer key and marking rules are only ever shown here, inside the authenticated admin app — never in the candidate exam.</p>
      </div>`).join('');
    } else {
      const { questions } = await api('/questions/interview/questions');
      const { criteria } = await api('/questions/interview/criteria');
      $('#qBody').innerHTML = `<div class="card"><div class="section-title">Interview questions <button class="btn btn-sm" id="addIv">+ Add</button></div>
        ${questions.map((q) => `<div style="padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:13px;">${esc(q.text)} ${q.disqualifying ? '<span class="badge badge-warning">Can disqualify</span>' : ''}</div>`).join('')}</div>
        <div class="card" style="margin-top:14px;"><div class="section-title">Scoring rubric (40 marks)</div><table><thead><tr><th>Criterion</th><th>Max</th></tr></thead><tbody>${criteria.map((c) => `<tr><td>${esc(c.label)}</td><td>${c.max_marks}</td></tr>`).join('')}</tbody></table></div>`;
      if ($('#addIv')) $('#addIv').onclick = async () => { const text = prompt('New interview question:'); if (!text) return; await api('/questions/interview/questions', { method: 'POST', body: JSON.stringify({ text }) }); show('interview'); };
    }
  }
  $$('.tabs button', el).forEach((b) => (b.onclick = () => { $$('.tabs button', el).forEach((x) => x.classList.remove('active')); b.classList.add('active'); show(b.dataset.qt); }));
  show('calc');
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
    <button class="btn btn-sm" id="csvBatch">Export batch CSV</button>
    <button class="btn btn-sm" id="xlsxBatch">Export batch Excel</button>
    <button class="btn btn-sm" id="sheetsBatch">Export to Google Sheets</button>
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
  </div><button class="btn btn-primary" id="savePolicy" style="margin-top:12px;">Save proposed policy</button>`;
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
      <button class="btn btn-primary btn-sm" id="saveElig">Save eligibility rules</button>
    </div>
    <div class="card"><div class="section-title">Assessment settings</div>
      <div class="field"><label class="field-label">Pass threshold (/100)</label><input type="number" id="passT" value="${settings.pass_threshold}"></div>
      <div class="field"><label class="field-label">Invitation link expiry (minutes)</label><input type="number" id="linkExp" value="${settings.link_expiry_minutes}"></div>
      <div class="field"><label class="field-label">Assessment duration (minutes) — separate timer from the invitation link</label><input type="number" id="duration" value="${settings.assessment_duration_minutes}"></div>
      <div class="field"><label class="field-label">Maximum LTV (%)</label><input type="number" id="maxLtv" value="${settings.max_ltv}"></div>
      <b class="faint">Candidate identity verification (before starting)</b>
      <label style="display:flex;gap:8px;align-items:center;margin:6px 0;"><input type="checkbox" id="reqId" ${settings.require_candidate_id ? 'checked' : ''} style="width:16px;height:16px;"> Require Candidate ID</label>
      <label style="display:flex;gap:8px;align-items:center;margin:6px 0;"><input type="checkbox" id="reqPhone" ${settings.require_phone ? 'checked' : ''} style="width:16px;height:16px;"> Require Phone</label>
      <label style="display:flex;gap:8px;align-items:center;margin:6px 0 12px;"><input type="checkbox" id="reqDob" ${settings.require_dob ? 'checked' : ''} style="width:16px;height:16px;"> Require Date of Birth</label>
      <button class="btn btn-primary btn-sm" id="saveSettings">Save settings</button>
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
        <button class="btn btn-primary btn-sm" id="exportCandidatesBtn">Export All Candidate Data</button>
        <button class="btn btn-primary btn-sm" id="exportResultsBtn">Export All Assessment Results</button>
        <button class="btn btn-sm" id="backupDbBtn">Backup Database</button>
      </div>
      <p class="faint" style="margin:10px 0 0;">A backup is a single consistent SQLite file containing candidates, applications, assessment sessions, answers, scores, interviews, integrity events and audit records. No temporary files are included.</p>
      <div id="backupList" style="margin-top:10px;"></div>
    </div>

    <div class="card" style="margin-bottom:12px;">
      <div class="section-title">Google Sheets (HR reporting) ${sheetsState}</div>
      <p class="faint" style="margin:0 0 10px;">SQLite remains the source of truth. Google Sheets receives a copy for HR reporting, sharing and analysis. Credentials are held server-side only.</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <button class="btn btn-primary btn-sm" id="syncSheetsBtn">SYNC TO GOOGLE SHEETS</button>
        <button class="btn btn-sm" id="retrySyncBtn">RETRY GOOGLE SHEETS SYNC</button>
        <span class="badge ${d.googleSyncPending ? 'badge-warning' : 'badge-neutral'}">${d.googleSyncPending} assessment(s) pending sync</span>
        <span class="faint">Auto-sync on submit: ${d.googleAutoSyncOnSubmit ? 'on' : 'off'}</span>
      </div>
      <div id="syncResult" class="faint" style="margin-top:10px;"></div>
    </div>

    <div class="card" style="margin-bottom:12px;">
      <div class="section-title">Test / demo data <span class="badge badge-neutral">${s.demoCandidates} demo · ${s.realCandidates} real</span></div>
      <p class="faint" style="margin:0 0 10px;">Demo candidates are flagged <span class="mono">is_demo = true</span>, kept out of HR reporting, and can be deleted without touching real candidates.</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        <button class="btn btn-sm" id="createDemoBtn">CREATE DEMO CANDIDATES</button>
        <button class="btn btn-sm" id="deleteDemoBtn">DELETE DEMO CANDIDATES</button>
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

  $('#deleteAllBtn').onclick = async () => {
    phrase.value = ''; password.value = ''; updateDeleteButton();
    modal.style.display = 'flex';
    const { preview } = await api('/settings/data-management/delete-all-candidate-data/preview');
    $('#deletePreview').textContent = `About to remove ${preview.candidates} candidates, ${preview.assessments} assessment sessions, ${preview.answers} answers and ${preview.links} assessment links.`;
  };
  $('#cancelDeleteBtn').onclick = () => { modal.style.display = 'none'; };

  submitBtn.onclick = async () => {
    submitBtn.disabled = true;
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
      <td><button class="btn btn-sm" data-backup="${esc(b.fileName)}">Download</button></td></tr>`).join('')}
  </tbody></table></div>`;
  $$('[data-backup]').forEach((btn) => {
    btn.onclick = () => downloadFile('/settings/data-management/backup/download?file=' + encodeURIComponent(btn.dataset.backup), btn.dataset.backup);
  });
}

// ---------------- Audit ----------------
async function viewAudit(_, el) {
  el.innerHTML = `<div class="card" style="margin-bottom:12px;"><input id="aq" placeholder="Search..."></div><div class="table-wrap"><table><thead><tr><th>Timestamp</th><th>User</th><th>Role</th><th>Action</th><th>Target</th></tr></thead><tbody id="rows"></tbody></table></div>`;
  async function load() { const { logs } = await api('/audit?q=' + encodeURIComponent($('#aq').value)); $('#rows').innerHTML = logs.map((l) => `<tr><td class="faint mono">${fmtDT(l.created_at)}</td><td>${esc(l.user_name)}</td><td class="faint">${esc(l.role)}</td><td>${esc(l.action)}</td><td class="faint mono">${esc(l.target)}</td></tr>`).join('') || '<tr><td colspan="5" class="faint">No entries.</td></tr>'; }
  $('#aq').addEventListener('input', debounce(load, 300));
  load();
}

render();
