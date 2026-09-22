// Static audit of the two SPAs: every rendered control must be wired to a real
// handler, and no control may be a dead stub.
//
// This is a regression guard for the button audit — it fails the build if a
// button is ever added without a handler, or if a TODO/placeholder/no-op
// handler creeps into the production interface.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = [];
let controls = 0;
let wired = 0;

function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function isBound(src, id) {
  return [
    new RegExp("\\$\\('#" + id + "'(?:\\s*,[^)]*)?\\)\\s*\\.\\s*(onclick|onchange|oninput)"),
    new RegExp("\\$\\('#" + id + "'(?:\\s*,[^)]*)?\\)\\s*\\.addEventListener"),
    new RegExp("(const|let|var)\\s+\\w+\\s*=\\s*\\$\\('#" + id + "'"),
    new RegExp("getElementById\\(['\"]" + id + "['\"]\\)"),
  ].some((p) => p.test(src));
}

function auditButtons(rel) {
  const src = readSrc(rel);
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(src))) {
    controls += 1;
    const attrs = m[1];
    const line = src.slice(0, m.index).split('\n').length;
    const label = m[2].replace(/\$\{[^}]*\}/g, '').replace(/<[^>]*>/g, '').trim().slice(0, 40) || '(no text)';
    const where = `${rel}:${line} "${label}"`;

    // Real id attribute — not the tail of data-id / aria-id etc.
    const idMatch = /(?:^|\s)id="([^"${]+)"/.exec(attrs);
    const dataAttr = /(?:^|\s)(data-[a-zA-Z0-9-]+)=/.exec(attrs);
    const inline = /(?:^|\s)on(click|change|submit)=/.test(attrs);

    if (inline) { wired += 1; continue; }

    if (idMatch) {
      if (isBound(src, idMatch[1])) wired += 1;
      else failures.push(`DEAD BUTTON — ${where} has id="${idMatch[1]}" but no handler is ever attached`);
      continue;
    }

    if (dataAttr) {
      const attr = dataAttr[1];
      const dsProp = attr.replace(/^data-/, '').replace(/-([a-z])/g, (x, c) => c.toUpperCase());
      const delegated = new RegExp("\\[" + attr + "\\]|" + attr + "=|dataset\\." + dsProp);
      if (delegated.test(src)) wired += 1;
      else failures.push(`DEAD BUTTON — ${where} carries ${attr} but nothing reads it`);
      continue;
    }

    // No identifier: acceptable only if an ancestor row is clickable.
    if (/tr\[data-id\]|tr\.onclick/.test(src)) wired += 1;
    else failures.push(`DEAD BUTTON — ${where} has no id, no data attribute and no clickable ancestor`);
  }
}

function auditLinks(rel) {
  const src = readSrc(rel);
  const re = /<a\b([^>]*)>/g;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    const href = /href="([^"]*)"/.exec(attrs);
    if (!href) continue;
    controls += 1;
    const line = src.slice(0, m.index).split('\n').length;
    if (['#', '', 'javascript:void(0)'].includes(href[1])) {
      failures.push(`DEAD LINK — ${rel}:${line} href="${href[1]}" goes nowhere`);
    } else wired += 1;
  }
}

function auditSmells(rel) {
  const src = readSrc(rel);
  const checks = [
    [/\bTODO\b/g, 'TODO marker left in production UI'],
    [/\bFIXME\b/g, 'FIXME marker left in production UI'],
    [/\balert\s*\(/g, 'placeholder alert() in production UI'],
    [/\.onclick\s*=\s*(\(\)\s*=>\s*\{\s*\}|function\s*\(\)\s*\{\s*\})/g, 'no-op click handler'],
    [/(coming soon|not implemented yet|under construction)/gi, 'placeholder copy'],
  ];
  checks.forEach(([re, name]) => {
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      failures.push(`SMELL — ${rel}:${line} ${name}: ${m[0].slice(0, 40)}`);
    }
  });
}

// Every mutating/async action button must declare a loading state so it cannot
// be double-fired (sections 27 and 28).
function auditBusyGuards() {
  const src = readSrc('public/admin/app.js');
  const mustGuard = [
    'lBtn', 'saveBtn', 'genLink', 'saveEssay', 'saveIv', 'addIv',
    'csvBatch', 'xlsxBatch', 'sheetsBatch', 'savePolicy', 'saveElig', 'saveSettings',
    'exportCandidatesBtn', 'exportResultsBtn', 'backupDbBtn', 'syncSheetsBtn',
    'retrySyncBtn', 'createDemoBtn', 'deleteDemoBtn', 'pdfBtn', 'csvBtn', 'revokeLink',
  ];
  mustGuard.forEach((id) => {
    const re = new RegExp('id="' + id + '"[^>]*data-busy=|data-busy=[^>]*id="' + id + '"');
    if (!re.test(src)) failures.push(`NO LOADING STATE — #${id} can be double-clicked (missing data-busy)`);
  });
  if (!/new MutationObserver\(decorateBusyButtons\)/.test(src)) {
    failures.push('NO LOADING STATE — the data-busy decorator is not installed');
  }
  // The delete-all button manages its own enabled state, so it is guarded by
  // hand rather than by data-busy; make sure that guard is still there.
  if (!/submitBtn\.textContent = 'Deleting…'/.test(src)) {
    failures.push('NO LOADING STATE — DELETE ALL CANDIDATE DATA has no busy state');
  }
}

function auditModals() {
  const src = readSrc('public/admin/app.js');
  if (!/function makeDismissable/.test(src)) failures.push('MODAL — no dismissable helper; a modal could get stuck');
  const uses = (src.match(/makeDismissable\(/g) || []).length;
  if (uses < 3) failures.push(`MODAL — makeDismissable is only used ${uses - 1} time(s); both modals must be dismissable`);
}

function auditErrorHandling() {
  const src = readSrc('public/admin/app.js');
  if (!/function httpMessage/.test(src)) failures.push('ERRORS — no per-status message mapping');
  ['401', '403', '404', '409', '422', '429', '500'].forEach((code) => {
    if (!new RegExp('\\b' + code + ':').test(src)) failures.push(`ERRORS — HTTP ${code} has no specific message`);
  });
  if (!/Could not reach the server/.test(src)) failures.push('ERRORS — network failure is not reported to the user');
  if (!/blob\.size === 0/.test(src)) failures.push('ERRORS — an empty download would be reported as success');
  if (!/catch\s*\(\s*e\s*\)\s*=>|\.catch\(\(e\)/.test(src)) failures.push('ERRORS — view loads have no failure path');
}

['public/admin/app.js', 'public/exam/app.js'].forEach((f) => {
  auditButtons(f);
  auditLinks(f);
  auditSmells(f);
});
auditBusyGuards();
auditModals();
auditErrorHandling();

console.log(`controls found: ${controls}`);
console.log(`controls wired: ${wired}`);
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('no dead controls, no smells, all action buttons guarded');
process.exit(0);
