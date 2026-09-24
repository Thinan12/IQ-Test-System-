// Server-side machine translation of CANDIDATE-VISIBLE question wording.
//
// Scope, deliberately narrow:
//   * It translates the question stem and the human-readable option labels.
//   * It never sees or touches an answer key, an expected value, a tolerance,
//     a rubric or an explanation — those are not passed in and not returned.
//   * It never changes a canonical option VALUE. A choice answer is stored as
//     its value and graded by exact match (see lib/grading.js), so a translated
//     value would score every choice question zero and invalidate answers that
//     were already saved. The provider is told this, and the response is
//     rejected server-side if it does it anyway.
//
// Output is MACHINE output. It is saved as a DRAFT, which the candidate portal
// never shows, until a human reviews it and sets APPROVED. Nothing here can
// put unreviewed text in front of a candidate.
//
// The API key lives only in a server-side environment variable. It is never
// sent to a browser, never logged, and never included in an error message: the
// only thing the admin UI is told is the boolean from isTranslationConfigured().
const { LANGUAGES } = require('./questionText');

const API_URL = 'https://api.openai.com/v1/responses';
// Overridable because an OpenAI key's model access varies by account: if the
// default is not enabled on yours, set OPENAI_MODEL rather than editing code.
const MODEL = String(process.env.OPENAI_MODEL || '').trim() || 'gpt-4.1';
const MAX_OUTPUT_TOKENS = 2048;
const TIMEOUT_MS = 30000;

// Payload ceilings. A recruitment question is a paragraph, not a document;
// these stop an accidental paste from turning into an expensive request.
const LIMITS = {
  questionChars: 4000,
  optionChars: 500,
  optionCount: 12,
};

const LANGUAGE_NAMES = { en: 'English', lo: 'Lao' };

/** True when a provider key is configured. The KEY ITSELF never leaves here. */
function isTranslationConfigured() {
  return !!String(process.env.OPENAI_API_KEY || '').trim();
}

/** A stable, typed error so the route can map causes to status codes. */
class TranslationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TranslationError';
    this.code = code; // NOT_CONFIGURED | BAD_REQUEST | PROVIDER_UNAVAILABLE | PROVIDER_TIMEOUT | BAD_PROVIDER_RESPONSE
  }
}

/**
 * Validate what the ADMIN sent before spending a provider call on it.
 * Returns a normalised { sourceLanguage, targetLanguage, question, options }.
 */
function validateTranslationRequest(body) {
  const b = body || {};
  const source = String(b.sourceLanguage || '').trim().toLowerCase();
  const target = String(b.targetLanguage || '').trim().toLowerCase();

  if (!LANGUAGES.includes(source) || !LANGUAGES.includes(target)) {
    throw new TranslationError('BAD_REQUEST', 'sourceLanguage and targetLanguage must each be "en" or "lo".');
  }
  if (source === target) {
    throw new TranslationError('BAD_REQUEST', 'The source and target languages must be different.');
  }

  const question = typeof b.question === 'string' ? b.question.trim() : '';
  if (!question) {
    throw new TranslationError('BAD_REQUEST', 'There is no question text to translate.');
  }
  if (question.length > LIMITS.questionChars) {
    throw new TranslationError('BAD_REQUEST', `The question text is too long to translate (limit ${LIMITS.questionChars} characters).`);
  }

  const rawOptions = b.options === undefined || b.options === null ? [] : b.options;
  if (!Array.isArray(rawOptions)) {
    throw new TranslationError('BAD_REQUEST', 'options must be a list.');
  }
  if (rawOptions.length > LIMITS.optionCount) {
    throw new TranslationError('BAD_REQUEST', `A question may not have more than ${LIMITS.optionCount} options to translate.`);
  }

  const seen = new Set();
  const options = rawOptions.map((o, i) => {
    const value = o && typeof o.value === 'string' ? o.value : '';
    const label = o && typeof o.label === 'string' ? o.label : '';
    if (!value.trim()) {
      throw new TranslationError('BAD_REQUEST', `Option ${i + 1} has no canonical value.`);
    }
    if (seen.has(value)) {
      throw new TranslationError('BAD_REQUEST', `Option value "${value}" appears twice.`);
    }
    seen.add(value);
    if (label.length > LIMITS.optionChars) {
      throw new TranslationError('BAD_REQUEST', `Option "${value}" is too long to translate (limit ${LIMITS.optionChars} characters).`);
    }
    // An option with no label of its own reads as its value; that is what the
    // candidate sees, so that is what gets translated.
    return { value, label: label.trim() || value };
  });

  return { sourceLanguage: source, targetLanguage: target, question, options };
}

/**
 * Validate what the PROVIDER sent back. This is the barrier that protects
 * marking: a response that renames, drops, adds or reorders a canonical value
 * is rejected outright rather than saved.
 */
function validateProviderTranslation(payload, request) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TranslationError('BAD_PROVIDER_RESPONSE', 'The translation service returned an unexpected result.');
  }
  const question = typeof payload.question === 'string' ? payload.question.trim() : '';
  if (!question) {
    throw new TranslationError('BAD_PROVIDER_RESPONSE', 'The translation service returned no question text.');
  }

  const got = Array.isArray(payload.options) ? payload.options : [];
  if (got.length !== request.options.length) {
    throw new TranslationError('BAD_PROVIDER_RESPONSE', 'The translation service returned the wrong number of options.');
  }

  const options = request.options.map((expected, i) => {
    const o = got[i] || {};
    if (o.value !== expected.value) {
      // The single most dangerous failure: a renamed value silently breaks
      // grading for every candidate who answers this question.
      throw new TranslationError('BAD_PROVIDER_RESPONSE', 'The translation service altered a canonical option value.');
    }
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!label) {
      throw new TranslationError('BAD_PROVIDER_RESPONSE', `The translation service returned no label for option "${expected.value}".`);
    }
    if (label.length > LIMITS.optionChars) {
      throw new TranslationError('BAD_PROVIDER_RESPONSE', `The translation service returned an oversized label for option "${expected.value}".`);
    }
    return { value: expected.value, label };
  });

  return { question, options };
}

function buildPrompt(request) {
  const from = LANGUAGE_NAMES[request.sourceLanguage];
  const to = LANGUAGE_NAMES[request.targetLanguage];
  return [
    `You are translating a recruitment assessment question from ${from} into natural, professional ${to}.`,
    '',
    'This is an examination question used to mark real job candidates. Translate the wording only.',
    '',
    'Preserve EXACTLY, character for character:',
    '- every number and numeral',
    '- percentages, currency amounts and currency codes (e.g. USD 100,000 stays USD 100,000)',
    '- mathematical operators, equations, formulas and units',
    '- dates and durations',
    '- technical identifiers, placeholders and variable names',
    '- the canonical option values you are given',
    '',
    'You must NOT:',
    '- solve the question or reveal the answer',
    '- change, round, recalculate or convert any numeric value',
    '- convert a currency into another currency',
    '- change the meaning, simplify the calculation or omit a condition',
    '- change a canonical option value',
    '- add explanations, notes, answers or options that were not given',
    '',
    'Return the translated question text, and for each option return its canonical value unchanged together with the translated label.',
    '',
    `Question (${from}):`,
    request.question,
    '',
    request.options.length
      ? `Options (canonical value -> ${from} label):\n` + request.options.map((o) => `${o.value} -> ${o.label}`).join('\n')
      : 'This question has no options.',
  ].join('\n');
}

// Structured output: the response format IS the shape we accept, enforced by
// the provider in strict mode. That avoids parsing prose. The result is still
// validated by validateProviderTranslation() rather than trusted — strict mode
// guarantees the SHAPE, not that the canonical values were left alone.
const TRANSLATION_SCHEMA = {
  name: 'question_translation',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      question: { type: 'string', description: 'The translated question text.' },
      options: {
        type: 'array',
        description: 'One entry per option given, in the same order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'string', description: 'The canonical option value, copied through unchanged.' },
            label: { type: 'string', description: 'The translated, human-readable option label.' },
          },
          required: ['value', 'label'],
        },
      },
    },
    required: ['question', 'options'],
  },
};

/**
 * Pull the JSON payload out of a Responses API result.
 *
 * The raw HTTP response has no `output_text` convenience field (that belongs to
 * the SDKs), so the message content is walked directly. A refusal block is
 * treated as no text at all, which surfaces as BAD_PROVIDER_RESPONSE rather
 * than being parsed as if it were a translation.
 */
function extractOutputText(data) {
  const output = Array.isArray(data && data.output) ? data.output : [];
  for (const item of output) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part && part.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
        return part.text;
      }
    }
  }
  return null;
}

/**
 * Translate one question. Throws TranslationError; never leaks provider detail.
 * @param {object} body  the admin's request, validated here
 */
async function translateQuestion(body) {
  const request = validateTranslationRequest(body);
  if (!isTranslationConfigured()) {
    throw new TranslationError('NOT_CONFIGURED', 'Automatic translation is not configured on this server.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        // Deterministic wording matters more than variety for an exam question.
        temperature: 0,
        input: [{ role: 'user', content: buildPrompt(request) }],
        text: { format: { type: 'json_schema', ...TRANSLATION_SCHEMA } },
      }),
    });
  } catch (e) {
    // Includes the abort. Nothing from the provider is surfaced to the browser.
    const timedOut = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    throw new TranslationError(
      timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
      timedOut ? 'The translation service did not respond in time.' : 'The translation service could not be reached.'
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The status is logged server-side; the body may quote the request and is
    // never echoed to the browser.
    console.warn('[translation] provider responded ' + res.status);
    throw new TranslationError('PROVIDER_UNAVAILABLE', 'The translation service rejected the request.');
  }

  let data;
  try { data = await res.json(); }
  catch (e) { throw new TranslationError('BAD_PROVIDER_RESPONSE', 'The translation service returned an unreadable result.'); }

  // A refusal or a truncated response is a failure, not a translation.
  if (data && data.status && data.status !== 'completed') {
    console.warn('[translation] provider status ' + data.status);
    throw new TranslationError('BAD_PROVIDER_RESPONSE', 'The translation service did not complete the request.');
  }

  const text = extractOutputText(data);
  if (!text) {
    throw new TranslationError('BAD_PROVIDER_RESPONSE', 'The translation service returned an unexpected result.');
  }

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new TranslationError('BAD_PROVIDER_RESPONSE', 'The translation service returned malformed JSON.'); }

  return validateProviderTranslation(parsed, request);
}

module.exports = {
  isTranslationConfigured,
  translateQuestion,
  validateTranslationRequest,
  validateProviderTranslation,
  TranslationError,
  LIMITS,
  MODEL,
};
