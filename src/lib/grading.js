// Server-side marking engine. This module (and the answer keys it reads from
// the `questions.config_json` column) is NEVER imported by, or served to,
// the public /api/exam routes' responses. Candidates only ever receive
// sanitized question data (see routes/exam.js -> sanitizeQuestionForCandidate).

function within(a, b, tol) {
  return Math.abs(a - b) <= (tol == null ? 0.01 : tol);
}

/**
 * Grade one CALC question against a candidate's submitted part values.
 * @param {object} question - row from `questions` table (type=CALC), with config_json parsed already onto question.config
 * @param {object} submitted - {partKey: value}
 */
function gradeCalcQuestion(question, submitted) {
  const parts = question.config.parts.map((p) => {
    const raw = submitted ? submitted[p.key] : undefined;
    let correct = false;
    let awarded = 0;
    if (p.type === 'choice') {
      correct = raw === p.expected;
      awarded = correct ? p.marks : 0;
    } else {
      const num = typeof raw === 'number' ? raw : parseFloat(raw);
      if (!Number.isNaN(num)) {
        correct = within(num, p.expected, p.tol);
        awarded = correct ? p.marks : 0;
      }
    }
    return {
      key: p.key,
      label: p.label,
      max: p.marks,
      awarded,
      submitted: raw === undefined || raw === null || raw === '' ? null : raw,
      expected: p.expected,
      correct,
    };
  });
  const marks = parts.reduce((s, p) => s + p.awarded, 0);
  const noneAnswered = parts.every((p) => p.submitted === null);
  let reason;
  if (noneAnswered) reason = 'No answer was submitted for this question.';
  else if (parts.every((p) => p.correct)) reason = 'All calculation steps were correct.';
  else reason = 'Candidate lost marks on: ' + parts.filter((p) => !p.correct).map((p) => p.label).join(', ') + '.';
  return { questionId: question.id, marks, max: question.max_marks, parts, reason };
}

function gradeAllCalc(questions, answersByQuestionId) {
  const breakdown = questions
    .filter((q) => q.type === 'CALC')
    .sort((a, b) => a.order_index - b.order_index)
    .map((q) => {
      const ans = answersByQuestionId[q.id];
      const submitted = ans ? JSON.parse(ans.answer_json || '{}') : null;
      return gradeCalcQuestion(q, submitted);
    });
  const marks = breakdown.reduce((s, b) => s + b.marks, 0);
  const max = breakdown.reduce((s, b) => s + b.max, 0);
  return { marks, max, breakdown };
}

/** LTV policy evaluation used by the collateral question and shown to evaluators. */
function evaluateLTV(loanAmount, collateralValue, maxLTV) {
  const ltv = (loanAmount / collateralValue) * 100;
  const withinPolicy = ltv <= maxLTV;
  return { ltv, maxLTV, withinPolicy, decision: withinPolicy ? 'Accept' : 'Reject' };
}

module.exports = { gradeCalcQuestion, gradeAllCalc, evaluateLTV, within };
