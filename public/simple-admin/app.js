'use strict';

const $ = (s) => document.querySelector(s);
function base64(buffer) { let out=''; const bytes=new Uint8Array(buffer); for(let i=0;i<bytes.length;i+=0x8000) out+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(out); }
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

let auth = JSON.parse(localStorage.getItem('simple_admin_auth') || 'null');

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (auth && auth.token) headers.Authorization = 'Bearer ' + auth.token;
  const response = await fetch('/api/admin/simple' + path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    auth = null;
    localStorage.removeItem('simple_admin_auth');
    renderLogin();
    throw new Error('Your admin session expired. Please sign in again.');
  }
  if (!response.ok) throw new Error(data.error || 'Request failed (' + response.status + ')');
  return data;
}

function shell(content) {
  document.body.innerHTML = `
    <main class="simple-shell">
      <header class="simple-header">
        <div>
          <div class="brand">LALCO</div>
          <div class="subtitle">Simple Assessment Dashboard</div>
        </div>
        <button class="btn btn-light" id="logout">Logout</button>
      </header>
      ${content}
    </main>`;
}

function renderLogin() {
  document.body.innerHTML = `
    <main class="login-shell">
      <div class="login-card">
        <div class="brand">LALCO</div>
        <h1>Simple Assessment</h1>
        <p class="muted">Admin login</p>
        <label>Email</label>
        <input id="email" type="email" autocomplete="username">
        <label>Password</label>
        <input id="pass" type="password" autocomplete="current-password">
        <button class="btn btn-primary btn-wide" id="login">Sign in</button>
        <p id="loginError" class="error"></p>
      </div>
    </main>`;
  $('#login').onclick = async () => {
    const button = $('#login');
    button.disabled = true;
    $('#loginError').textContent = '';
    try {
      const response = await fetch('/api/admin/auth/login', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ email: $('#email').value.trim(), password: $('#pass').value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Login failed.');
      auth = data;
      localStorage.setItem('simple_admin_auth', JSON.stringify(auth));
      await render();
    } catch (e) {
      $('#loginError').textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
}

function styles() {
  if (document.getElementById('simple-dashboard-styles')) return;
  const style = document.createElement('style');
  style.id = 'simple-dashboard-styles';
  style.textContent = `
    *{box-sizing:border-box}
    body{margin:0;background:#f4f7fa;color:#13283b;font-family:Arial,Helvetica,sans-serif}
    .simple-shell{max-width:1200px;margin:auto;padding:28px 22px 60px}
    .simple-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:26px}
    .brand{font-weight:800;letter-spacing:2px;font-size:24px;color:#10283d}
    .subtitle{color:#64748b;margin-top:4px}
    h1,h2{margin:0 0 8px}.section{background:#fff;border:1px solid #dbe3ea;border-radius:12px;padding:22px;margin-top:18px;box-shadow:0 2px 8px rgba(15,36,56,.04)}
    .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
    .card{background:#fff;border:1px solid #dbe3ea;border-radius:12px;padding:18px}.card .num{font-size:30px;font-weight:800}.card .label{color:#64748b;margin-top:5px}
    .form-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.field{display:flex;flex-direction:column;gap:6px}.field label{font-size:13px;font-weight:700;color:#475569}
    input,select{width:100%;padding:11px 12px;border:1px solid #cbd5df;border-radius:8px;background:#fff;font-size:14px}
    .actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
    .btn{border:0;border-radius:8px;padding:10px 15px;font-weight:700;cursor:pointer}.btn:disabled{opacity:.55;cursor:not-allowed}
    .btn-primary{background:#102f47;color:#fff}.btn-light{background:#e8eef3;color:#17334a}.btn-danger{background:#b42318;color:#fff}.btn-small{padding:7px 10px;font-size:12px}
    .muted{color:#64748b}.success{color:#087443}.error{color:#b42318;min-height:18px}.hint{font-size:13px;color:#64748b;margin-top:8px}
    .notice{padding:12px;border-radius:8px;background:#edf7f1;color:#087443;margin-top:12px;word-break:break-word}.notice a{color:inherit}
    .error-box{padding:12px;border-radius:8px;background:#fff1f0;color:#b42318;margin-top:12px;word-break:break-word}
    .table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:760px}th,td{padding:11px 9px;border-bottom:1px solid #e5eaf0;text-align:left;font-size:13px;vertical-align:middle}th{background:#f8fafc;font-weight:800}
    .status{display:inline-block;padding:4px 8px;border-radius:99px;background:#e8eef3;font-size:11px;font-weight:800}.status.active{background:#e8f7ef;color:#087443}.status.disabled,.status.expired{background:#fff1f0;color:#b42318}
    .empty{padding:18px;text-align:center;color:#64748b;background:#f8fafc;border-radius:8px}
    .login-shell{min-height:100vh;display:grid;place-items:center;padding:20px}.login-card{width:min(420px,100%);background:#fff;border:1px solid #dbe3ea;border-radius:14px;padding:30px;box-shadow:0 10px 30px rgba(15,36,56,.08)}.login-card h1{margin-top:12px}.login-card label{display:block;font-size:13px;font-weight:700;margin:16px 0 6px}.btn-wide{width:100%;margin-top:18px}
    @media(max-width:800px){.cards{grid-template-columns:repeat(2,1fr)}.form-grid{grid-template-columns:repeat(2,1fr)}}
    @media(max-width:520px){.simple-shell{padding:18px 12px 40px}.cards,.form-grid{grid-template-columns:1fr}.simple-header{align-items:flex-start}.simple-header .btn{margin-top:4px}}
  `;
  document.head.appendChild(style);
}

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function linkUrl(row) {
  return location.origin + (row.assessment_type === 'IQ_TEST' ? '/simple/iq/' : '/simple/test/') + row.token;
}

async function refreshDashboard() {
  const [summary, links, results] = await Promise.all([
    api('/summary'), api('/links'), api('/results')
  ]);

  $('#iqCount').textContent = summary.counts.iqQuestions;
  $('#generalCount').textContent = summary.counts.generalQuestions;
  $('#linkCount').textContent = summary.counts.links;
  $('#resultCount').textContent = results.results.length;

  $('#links').innerHTML = links.links.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Test</th><th>Status</th><th>Candidate</th><th>Created</th><th>Link</th><th>Action</th></tr></thead>
      <tbody>
        ${links.links.map((x) => {
          const url = linkUrl(x);
          const cls = String(x.liveStatus || '').toLowerCase();
          return `<tr>
            <td>${esc(x.assessment_type === 'IQ_TEST' ? 'IQ Test' : 'Other Test')}</td>
            <td><span class="status ${esc(cls)}">${esc(x.liveStatus)}</span></td>
            <td>${esc(x.full_name || 'Pending candidate')}</td>
            <td>${esc(formatDate(x.created_at))}</td>
            <td><a href="${esc(url)}" target="_blank" rel="noopener">Open candidate link</a></td>
            <td>${x.liveStatus === 'ACTIVE'
              ? '<button class="btn btn-danger btn-small" data-disable="' + esc(x.id) + '">Disable</button>'
              : '<button class="btn btn-light btn-small" data-copy="' + esc(url) + '">Copy</button>'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>` : '<div class="empty">No links created yet.</div>';

  $('#results').innerHTML = results.results.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Candidate</th><th>Test</th><th>Marks</th><th>Percentage</th><th>Result</th><th>Submitted</th><th>Export</th></tr></thead>
      <tbody>
        ${results.results.map((x) => `<tr>
          <td><strong>${esc(x.name || '-')}</strong><br><span class="muted">${esc(x.email || '')}</span></td>
          <td>${esc(x.assessment || '-')}</td>
          <td>${Number(x.marks || 0)} / ${Number(x.maxMarks || 0)}</td>
          <td>${Number(x.percentage || 0).toFixed(1)}%</td>
          <td><span class="status ${x.pass ? 'active' : 'expired'}">${x.pass ? 'PASS' : 'FAIL'}</span></td>
          <td>${esc(formatDate(x.submittedAt))}</td>
          <td>
            <a href="/api/admin/simple/results/${encodeURIComponent(x.sessionId)}.pdf" target="_blank">PDF</a> |
            <a href="/api/admin/simple/results/${encodeURIComponent(x.sessionId)}.xlsx">Excel</a> |
            <a href="/api/admin/simple/results/${encodeURIComponent(x.sessionId)}.doc">Word</a>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>` : '<div class="empty">No completed results yet.</div>';

  document.querySelectorAll('[data-disable]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('Disable this candidate link?')) return;
      button.disabled = true;
      try {
        await api('/links/' + encodeURIComponent(button.dataset.disable) + '/disable', {method:'POST',body:'{}'});
        await refreshDashboard();
      } catch (e) { alert(e.message); button.disabled = false; }
    };
  });

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.onclick = async () => {
      try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = 'Copied'; }
      catch (_) { prompt('Copy this link:', button.dataset.copy); }
    };
  });
}

async function render() {
  styles();
  if (!auth) return renderLogin();

  try {
    const summary = await api('/summary');
    shell(`
      <div class="cards">
        <div class="card"><div class="num" id="iqCount">${summary.counts.iqQuestions}</div><div class="label">IQ Questions</div></div>
        <div class="card"><div class="num" id="generalCount">${summary.counts.generalQuestions}</div><div class="label">Other Questions</div></div>
        <div class="card"><div class="num" id="linkCount">${summary.counts.links}</div><div class="label">Active Links</div></div>
        <div class="card"><div class="num" id="resultCount">${summary.results.length}</div><div class="label">Results</div></div>
      </div>

      <section class="section">
        <h2>1. Upload Questions</h2>
        <p class="muted">Upload your question file. The system reads the questions and adds them to the selected bank.</p>
        <div class="form-grid">
          <div class="field"><label>Question bank</label><select id="family"><option value="IQ">IQ Test</option><option value="GENERAL">Other Test</option></select></div>
          <div class="field" style="grid-column:span 3"><label>Question file</label><input type="file" id="file" accept=".xlsx,.xls,.csv,.json,.txt,.md,.docx,.pdf"></div>
        </div>
        <div class="actions"><button class="btn btn-primary" id="upload">Upload & Import</button></div>
        <div id="uploadStatus"></div>
      </section>

      <section class="section">
        <h2>2. Create Candidate Link</h2>
        <p class="muted">The candidate will enter their own name, email, phone and ID after opening the link.</p>
        <div class="form-grid">
          <div class="field"><label>Test type</label><select id="type"><option value="IQ">IQ Test</option><option value="GENERAL">Other Test</option></select></div>
          <div class="field"><label>Questions</label><input id="count" type="number" min="1" value="30"></div>
          <div class="field"><label>Test time (minutes)</label><input id="duration" type="number" min="1" value="30"></div>
          <div class="field"><label>Link expiry (minutes)</label><input id="expiry" type="number" min="1" value="1440"></div>
          <div class="field"><label>Pass mark</label><input id="pass" type="number" min="0" value="18"></div>
        </div>
        <div class="hint" id="poolHint"></div>
        <div class="actions"><button class="btn btn-primary" id="create">Create Candidate Link</button></div>
        <div id="linkOut"></div>
      </section>

      <section class="section">
        <h2>3. Candidate Links</h2>
        <div id="links"><div class="empty">Loading...</div></div>
      </section>

      <section class="section">
        <h2>4. Results</h2>
        <div class="actions" style="margin-top:0"><a class="btn btn-light" href="/api/admin/simple/results.xlsx">Export All Results (Excel)</a></div>
        <div id="results" style="margin-top:14px"><div class="empty">Loading...</div></div>
      </section>
    `);

    $('#logout').onclick = () => {
      auth = null;
      localStorage.removeItem('simple_admin_auth');
      renderLogin();
    };

    async function updatePoolHint() {
      try {
        const family = $('#type').value;
        const data = await api('/questions?family=' + encodeURIComponent(family));
        const available = data.questions.length;
        $('#poolHint').textContent = available
          ? available + ' question(s) available in this bank.'
          : 'No questions available. Upload questions before creating a link.';
        $('#count').max = String(Math.max(1, available));
        if (available && Number($('#count').value) > available) $('#count').value = available;
        if (family === 'GENERAL') $('#pass').value = Math.ceil(Number($('#count').value || 1) * 0.6);
        else if (!$('#pass').value || Number($('#pass').value) > Number($('#count').value)) $('#pass').value = Math.ceil(Number($('#count').value || 1) * 0.6);
      } catch (e) {
        $('#poolHint').textContent = e.message;
      }
    }

    $('#type').onchange = updatePoolHint;
    $('#count').oninput = () => {
      const count = Number($('#count').value) || 1;
      if ($('#type').value === 'IQ' && Number($('#pass').value) > count) $('#pass').value = Math.ceil(count * 0.6);
    };

    $('#upload').onclick = async () => {
      const file = $('#file').files[0];
      if (!file) { $('#uploadStatus').innerHTML = '<div class="error-box">Choose a question file first.</div>'; return; }
      const button = $('#upload');
      button.disabled = true;
      $('#uploadStatus').innerHTML = '<div class="notice">Reading and importing ' + esc(file.name) + '...</div>';
      try {
        const buffer = await file.arrayBuffer();
        const result = await api('/import', {
          method:'POST',
          body:JSON.stringify({
            fileName:file.name,
            dataBase64:base64(buffer),
            family:$('#family').value
          })
        });
        let message = 'Found ' + result.found + ' question(s). Imported ' + result.imported + '. Failed ' + result.failed + '.';
        if (result.errors && result.errors.length) message += '<br>' + result.errors.map((e) => 'Row ' + e.row + ': ' + esc(e.error)).join('<br>');
        $('#uploadStatus').innerHTML = result.failed ? '<div class="error-box">' + message + '</div>' : '<div class="notice">' + message + '</div>';
        await refreshDashboard();
        await updatePoolHint();
      } catch (e) {
        $('#uploadStatus').innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
      } finally {
        button.disabled = false;
      }
    };

    $('#create').onclick = async () => {
      const type = $('#type').value;
      const questions = Number($('#count').value);
      const durationMinutes = Number($('#duration').value);
      const linkExpiryMinutes = Number($('#expiry').value);
      const passMark = Number($('#pass').value);
      if (!Number.isInteger(questions) || questions < 1) return alert('Questions must be at least 1.');
      if (!Number.isInteger(durationMinutes) || durationMinutes < 1) return alert('Test time must be at least 1 minute.');
      if (!Number.isInteger(linkExpiryMinutes) || linkExpiryMinutes < 1) return alert('Link expiry must be at least 1 minute.');
      if (!Number.isInteger(passMark) || passMark < 0 || passMark > questions) return alert('Pass mark must be between 0 and the number of questions.');

      const button = $('#create');
      button.disabled = true;
      $('#linkOut').innerHTML = '<div class="notice">Creating candidate link...</div>';
      try {
        const result = await api('/link', {
          method:'POST',
          body:JSON.stringify({type,questions,durationMinutes,linkExpiryMinutes,passMark})
        });
        $('#linkOut').innerHTML = `
          <div class="notice">
            <strong>Candidate link created.</strong><br>
            <a href="${esc(result.examUrl)}" target="_blank" rel="noopener">${esc(result.examUrl)}</a>
            <div class="actions">
              <button class="btn btn-primary btn-small" id="copyNewLink">Copy Link</button>
            </div>
            <span class="muted">${result.questions} questions · ${result.durationMinutes} minutes · pass ${result.passMark}</span>
          </div>`;
        $('#copyNewLink').onclick = async () => {
          try { await navigator.clipboard.writeText(result.examUrl); $('#copyNewLink').textContent='Copied'; }
          catch (_) { prompt('Copy this link:', result.examUrl); }
        };
        await refreshDashboard();
      } catch (e) {
        $('#linkOut').innerHTML = '<div class="error-box"><strong>Could not create link.</strong><br>' + esc(e.message) + '</div>';
      } finally {
        button.disabled = false;
      }
    };

    await refreshDashboard();
    await updatePoolHint();
  } catch (e) {
    shell('<section class="section"><div class="error-box"><strong>Dashboard error</strong><br>' + esc(e.message) + '</div><div class="actions"><button class="btn btn-primary" id="retry">Retry</button></div></section>');
    $('#retry').onclick = render;
  }
}

render();
