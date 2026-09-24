// Inspects the candidate exam's UI_STRINGS table and prints a JSON summary.
// Lives in its own file rather than inline in the shell: escaping a regex and
// a newline through bash -e mangled both and turned real checks into
// vacuous ones that compared empty to empty.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public', 'exam', 'app.js');
const src = fs.readFileSync(SRC, 'utf8');

const OPEN = 'const UI_STRINGS = {';
const start = src.indexOf(OPEN);
if (start < 0) { console.error('UI_STRINGS not found'); process.exit(1); }
const end = src.indexOf(String.fromCharCode(10) + '};', start);
if (end < 0) { console.error('end of UI_STRINGS not found'); process.exit(1); }

// eslint-disable-next-line no-eval
const tbl = eval('(' + src.slice(start + 'const UI_STRINGS = '.length, end + 2) + ')');

const LAO = /[຀-໿]/;
const en = Object.keys(tbl.en);
const lo = Object.keys(tbl.lo);

const strings = (o, k) => typeof o[k] === 'string';
const supplied = lo.filter((k) => tbl.lo[k] !== null && strings(tbl.lo, k));
const pending = lo.filter((k) => tbl.lo[k] === null);

// Two keys are legitimately identical or cross-language in both columns:
//   otherLangLabel      - by definition the OTHER language's own name.
//   laoUnavailableTitle - the heading that tells a Lao-reading candidate this
//                         question has no Lao translation. It must be Lao in
//                         both columns, or the one person who needs to read it
//                         cannot. It was hardcoded Lao before it was ever in
//                         this table.
const EXEMPT = new Set(['otherLangLabel', 'laoUnavailableTitle']);

console.log(JSON.stringify({
  enCount: en.length,
  loCount: lo.length,
  missingInLo: en.filter((k) => !lo.includes(k)),
  extraInLo: lo.filter((k) => !en.includes(k)),
  supplied: supplied.length,
  pending: pending.length,
  pendingKeys: pending,
  // English pasted into the Lao column is worse than null: the fallback then
  // cannot be told apart from a real translation.
  copiedFromEnglish: supplied.filter((k) => !EXEMPT.has(k) && tbl.lo[k] === tbl.en[k]),
  // Anything claiming to be Lao must actually contain Lao script.
  notActuallyLao: supplied.filter((k) => !EXEMPT.has(k) && !LAO.test(tbl.lo[k])),
  // English is the source language and must never be blank.
  englishEmpty: en.filter((k) => tbl.en[k] === null || tbl.en[k] === undefined || tbl.en[k] === ''),
  // The three strings confirmed still English in production.
  productionGapsFixed: ['flag', 'next', 'notFlagged']
    .every((k) => strings(tbl.lo, k) && LAO.test(tbl.lo[k])),
}));
