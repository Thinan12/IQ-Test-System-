// Exercises the translation service's own validators and prints a JSON summary.
//
// These are the guards that protect marking, so they are tested directly rather
// than only through HTTP: the request validator (what an admin may send) and
// the provider-response validator (what the provider is allowed to return).
// Nothing here calls the provider and nothing here fakes a translation — the
// point is precisely to prove that a bad provider response is REJECTED.
//
// Lives in its own file for the same reason as inspect_lao_strings.js: escaping
// this much JSON through bash turned real checks into vacuous ones.
const path = require('path');
const t = require(path.join(__dirname, '..', 'src', 'lib', 'translation'));

function rejects(fn) {
  try { fn(); return null; } catch (e) { return e.code || e.name || 'ERROR'; }
}

const REQ = {
  noLanguages: {},
  sameLanguage: { sourceLanguage: 'en', targetLanguage: 'en', question: 'x' },
  unsupportedTarget: { sourceLanguage: 'en', targetLanguage: 'fr', question: 'x' },
  unsupportedSource: { sourceLanguage: 'de', targetLanguage: 'lo', question: 'x' },
  noQuestion: { sourceLanguage: 'en', targetLanguage: 'lo' },
  blankQuestion: { sourceLanguage: 'en', targetLanguage: 'lo', question: '   ' },
  oversizedQuestion: { sourceLanguage: 'en', targetLanguage: 'lo', question: 'x'.repeat(t.LIMITS.questionChars + 1) },
  tooManyOptions: {
    sourceLanguage: 'en', targetLanguage: 'lo', question: 'x',
    options: Array.from({ length: t.LIMITS.optionCount + 1 }, (_, i) => ({ value: 'v' + i, label: 'l' })),
  },
  oversizedOption: {
    sourceLanguage: 'en', targetLanguage: 'lo', question: 'x',
    options: [{ value: 'A', label: 'y'.repeat(t.LIMITS.optionChars + 1) }],
  },
  duplicateValue: {
    sourceLanguage: 'en', targetLanguage: 'lo', question: 'x',
    options: [{ value: 'A', label: 'a' }, { value: 'A', label: 'b' }],
  },
  optionsNotAList: { sourceLanguage: 'en', targetLanguage: 'lo', question: 'x', options: 'A,B' },
  valuelessOption: { sourceLanguage: 'en', targetLanguage: 'lo', question: 'x', options: [{ label: 'a' }] },
};

const requestRejections = {};
Object.keys(REQ).forEach((k) => { requestRejections[k] = rejects(() => t.validateTranslationRequest(REQ[k])); });

// A valid request, used as the baseline the provider must respect.
const accepted = t.validateTranslationRequest({
  sourceLanguage: 'EN', targetLanguage: 'LO',
  question: '  LALCO lends USD 100,000 for 6 months at 3% per month.  ',
  options: [{ value: 'A', label: '' }, { value: 'B', label: 'Reject' }],
});

const RES = {
  notAnObject: 'a translation',
  nullPayload: null,
  arrayPayload: [],
  missingQuestion: { options: [{ value: 'A', label: 'x' }, { value: 'B', label: 'y' }] },
  blankQuestion: { question: '  ', options: [{ value: 'A', label: 'x' }, { value: 'B', label: 'y' }] },
  missingOptions: { question: 'q' },
  tooFewOptions: { question: 'q', options: [{ value: 'A', label: 'x' }] },
  tooManyOptions: { question: 'q', options: [{ value: 'A', label: 'x' }, { value: 'B', label: 'y' }, { value: 'C', label: 'z' }] },
  renamedValue: { question: 'q', options: [{ value: 'Paris', label: 'x' }, { value: 'B', label: 'y' }] },
  reorderedValues: { question: 'q', options: [{ value: 'B', label: 'y' }, { value: 'A', label: 'x' }] },
  blankLabel: { question: 'q', options: [{ value: 'A', label: '' }, { value: 'B', label: 'y' }] },
  labelNotText: { question: 'q', options: [{ value: 'A', label: 5 }, { value: 'B', label: 'y' }] },
  oversizedLabel: { question: 'q', options: [{ value: 'A', label: 'z'.repeat(t.LIMITS.optionChars + 1) }, { value: 'B', label: 'y' }] },
};

const responseRejections = {};
Object.keys(RES).forEach((k) => { responseRejections[k] = rejects(() => t.validateProviderTranslation(RES[k], accepted)); });

// The one shape that must be accepted, with the canonical values untouched.
let good = null;
let goodError = null;
try {
  good = t.validateProviderTranslation(
    { question: 'Q in Lao', options: [{ value: 'A', label: 'A in Lao' }, { value: 'B', label: 'B in Lao' }] },
    accepted
  );
} catch (e) { goodError = e.message; }

console.log(JSON.stringify({
  configured: t.isTranslationConfigured(),
  model: t.MODEL,
  limits: t.LIMITS,
  // Every one of these must be a rejection; a null means it slipped through.
  requestRejections,
  requestAcceptedAll: Object.keys(requestRejections).filter((k) => !requestRejections[k]),
  responseRejections,
  responseAcceptedAll: Object.keys(responseRejections).filter((k) => !responseRejections[k]),
  // Normalisation of a good request.
  normalisedSource: accepted.sourceLanguage,
  normalisedTarget: accepted.targetLanguage,
  questionTrimmed: accepted.question,
  // An option with no label of its own falls back to its value, because that is
  // what the candidate reads.
  labelDefaultsToValue: accepted.options[0].label === 'A',
  numbersPreservedInRequest: /USD 100,000/.test(accepted.question) && /6 months/.test(accepted.question) && /3%/.test(accepted.question),
  goodAccepted: !!good,
  goodError,
  goodValues: good ? good.options.map((o) => o.value).join(',') : null,
  goodLabels: good ? good.options.map((o) => o.label).join(',') : null,
  // The service must never export the key, and must not carry one in source.
  exportsKey: Object.keys(t).some((k) => /key/i.test(k)),
}));
