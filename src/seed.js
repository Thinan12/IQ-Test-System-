// Seeds REFERENCE / SYSTEM data only, by default:
//   - the real LALCO question bank, eligibility rules, interview rubric and scholarship policy
//   - one admin login per role (DEMO credentials — change immediately in real use)
//
// Fake candidate records are NEVER created unless demo mode is asked for
// explicitly:
//
//   DEMO_PASSWORD must be set to a password meeting the same policy as the
//   Admin -> Users -> Reset Password workflow. There is no built-in default.
//
//   npm run seed         reference data only     <- safe for production
//   npm run seed:demo    + ~20 demo candidates   <- local/staging exploration
//   SEED_DEMO_CANDIDATES=true npm run seed       same as seed:demo
//
// Every step is idempotent: re-running skips anything already present and never
// touches candidates created through the real app.
require('dotenv').config();
const { validatePassword, MIN_LENGTH } = require('./lib/passwordPolicy');

// Local-parts of the seeded addresses, used to reject a password that echoes
// an account name.
const SEED_EMAILS_LOCAL = ['superadmin', 'hradmin', 'recruiter', 'interviewer', 'evaluator', 'manager'];

/**
 * The password the seeded admin accounts are created with.
 *
 * There is deliberately NO default. A password compiled into this file would be
 * public the moment the repository is, which is exactly how the previous
 * default became a liability. It must be supplied through the environment and
 * must satisfy the same policy the Admin -> Users -> Reset Password workflow
 * enforces, so a seeded account is never weaker than one created in the app.
 *
 * Resolution happens BEFORE any row is written, so a rejected password aborts
 * without touching the database.
 */
function resolveSeedPassword(emails) {
  const password = process.env.DEMO_PASSWORD;

  if (!password) {
    console.error('\nSeed aborted: DEMO_PASSWORD is not set.');
    console.error('  The seeded admin accounts need a password, and this project ships no default.');
    console.error('  Set DEMO_PASSWORD to a value of at least ' + MIN_LENGTH + ' characters using at least');
    console.error('  3 of lowercase / uppercase / digit / symbol, then run the seed again.');
    console.error('  Generate one with:');
    console.error("    node -e \"console.log(require('crypto').randomBytes(18).toString('base64url'))\"");
    console.error('  Nothing was written to the database.\n');
    process.exit(1);
  }

  // Validate against every seeded address so a password echoing an account name
  // is caught, exactly as the reset workflow would catch it.
  const problems = new Set();
  emails.forEach((email) => {
    const result = validatePassword(password, { email });
    if (!result.ok) result.errors.forEach((e) => problems.add(e));
  });

  if (problems.size) {
    console.error('\nSeed aborted: DEMO_PASSWORD does not meet the password policy.');
    // The reasons are printed; the password itself never is.
    problems.forEach((p) => console.error('  - ' + p));
    console.error('  Nothing was written to the database.\n');
    process.exit(1);
  }

  return password;
}

// Resolved and validated BEFORE the database module is loaded. Opening the
// database creates the file and applies the schema, so validating first means a
// rejected password leaves nothing behind at all — not even an empty database.
const seedPassword = resolveSeedPassword(SEED_EMAILS_LOCAL);

const bcrypt = require('bcryptjs');
const db = require('./db');
const { generateId } = require('./lib/tokens');
const { gradeAllCalc } = require('./lib/grading');

function upsertLookup(table, name) {
  const existing = db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name);
  if (existing) return existing.id;
  const id = generateId(table.slice(0, 3));
  db.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`).run(id, name);
  return id;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedUsers(password) {
  const roles = [
    ['Super Admin', 'superadmin@lalco.demo', 'SUPER_ADMIN'],
    ['HR Admin', 'hradmin@lalco.demo', 'HR_ADMIN'],
    ['Recruiter', 'recruiter@lalco.demo', 'RECRUITER'],
    ['Interviewer', 'interviewer@lalco.demo', 'INTERVIEWER'],
    ['Evaluator', 'evaluator@lalco.demo', 'EVALUATOR'],
    ['Manager', 'manager@lalco.demo', 'MANAGER'],
  ];
  const hash = bcrypt.hashSync(password, 12);
  roles.forEach(([name, email, role]) => {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return;
    db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
      .run(generateId('user'), name, email, hash, role);
  });
  // The password is never logged. Whoever set DEMO_PASSWORD already has it.
  console.log(`Seeded ${roles.length} admin accounts (one per role) using the supplied DEMO_PASSWORD.`);
}

function seedQuestions() {
  const existing = db.prepare(
    `SELECT COUNT(*) AS n FROM questions WHERE question_family = 'GENERAL'`
  ).get().n;
  if (existing > 0) { console.log('Questions already seeded, skipping.'); return; }
  const calc = [
    { order: 1, category: 'Interest Calculation', difficulty: 'Basic',
      text: 'LALCO lends money to a customer for 6 months. Loan amount = USD 100,000. Interest rate = 3% per month (interest amount is the same every month). How much is the total interest that the customer needs to pay in 6 months?',
      parts: [
        { key: 'monthlyInterest', label: 'Monthly interest (USD)', marks: 2, expected: 3000, tol: 1 },
        { key: 'totalInterest', label: 'Total interest over 6 months (USD)', marks: 3, expected: 18000, tol: 1 },
      ],
      explanation: 'Monthly interest = 100,000 × 3% = 3,000. Total interest = 3,000 × 6 = 18,000 USD.' },
    { order: 2, category: 'Amortization', difficulty: 'Basic',
      text: 'LALCO lends USD 24,000 for 12 months. The principal is repaid in the same amount every month. How much principal is outstanding after the customer has repaid 5 months?',
      parts: [
        { key: 'monthlyPrincipal', label: 'Monthly principal repayment (USD)', marks: 2, expected: 2000, tol: 1 },
        { key: 'outstandingPrincipal', label: 'Outstanding principal after 5 months (USD)', marks: 3, expected: 14000, tol: 1 },
      ],
      explanation: 'Monthly principal = 24,000 / 12 = 2,000. Repaid in 5 months = 10,000. Outstanding = 24,000 - 10,000 = 14,000 USD.' },
    { order: 3, category: 'Collateral / LTV Policy', difficulty: 'Applied',
      text: "A customer wants to use a car as collateral. Estimated car value = USD 20,000. Requested loan = USD 50,000. Using LALCO's current Loan-to-Value (LTV) policy, can LALCO accept this customer?",
      parts: [
        { key: 'ltv', label: 'Loan-to-Value ratio (%) — Loan ÷ Collateral value × 100', marks: 2, expected: 250, tol: 2 },
        { key: 'decision', label: 'Decision', marks: 3, type: 'choice', options: ['Accept', 'Reject'], expected: 'Reject' },
      ],
      explanation: 'LTV = Loan ÷ Collateral value = 50,000 / 20,000 = 250%. This exceeds the admin-configured maximum LTV, so the loan must be REJECTED under current policy.' },
    { order: 4, category: 'Amortization', difficulty: 'Advanced',
      text: 'Loan = USD 5,000. Term = 36 months. Interest = 2.5% per month. The customer pays the same amount of principal every month, plus interest based on the outstanding principal. How much does the customer need to repay in the first month?',
      parts: [
        { key: 'monthlyPrincipal', label: 'Monthly principal (USD)', marks: 2, expected: 138.89, tol: 0.5 },
        { key: 'month1Interest', label: 'Month 1 interest (USD)', marks: 1, expected: 125, tol: 0.5 },
        { key: 'month1Total', label: 'Total month 1 repayment (USD)', marks: 2, expected: 263.89, tol: 0.5 },
      ],
      explanation: 'Monthly principal = 5,000/36 = 138.89. Month 1 interest = 5,000 × 2.5% = 125. Month 1 total = 138.89 + 125 = 263.89 USD.' },
    { order: 5, category: 'Interest-Only / Balloon', difficulty: 'Applied',
      text: 'Loan = USD 7,000. Term = 6 months. Interest = 3% per month. The customer pays only interest from month 1 to month 5. In month 6 the customer pays both principal and interest. How much must the customer pay in month 6?',
      parts: [
        { key: 'monthlyInterest', label: 'Monthly interest (USD)', marks: 2, expected: 210, tol: 1 },
        { key: 'month6Total', label: 'Month 6 total payment (USD)', marks: 3, expected: 7210, tol: 1 },
      ],
      explanation: 'Monthly interest = 7,000 × 3% = 210. Month 6 payment = 7,000 (principal) + 210 (interest) = 7,210 USD.' },
    { order: 6, category: 'Broker Fee', difficulty: 'Advanced',
      text: 'A broker recommends a customer borrow USD 10,000 from LALCO at 2.5% per month over a 36-month term. The broker charges an introductory fee of 3.5% of total interest. Interest is assumed the same every month. How much broker fee will the broker receive?',
      parts: [
        { key: 'monthlyInterest', label: 'Monthly interest (USD)', marks: 1, expected: 250, tol: 1 },
        { key: 'totalInterest', label: 'Total interest over 36 months (USD)', marks: 2, expected: 9000, tol: 1 },
        { key: 'brokerFee', label: 'Broker fee (USD)', marks: 2, expected: 315, tol: 1 },
      ],
      explanation: 'Monthly interest = 10,000 × 2.5% = 250. Total interest = 250 × 36 = 9,000. Broker fee = 9,000 × 3.5% = 315 USD.' },
  ];
  calc.forEach((q) => {
    const maxMarks = q.parts.reduce((s, p) => s + p.marks, 0);
    db.prepare(
      `INSERT INTO questions (id, type, order_index, category, difficulty, max_marks, text, config_json, explanation, created_by)
       VALUES (?, 'CALC', ?, ?, ?, ?, ?, ?, ?, 'Seed')`
    ).run(generateId('q'), q.order, q.category, q.difficulty, maxMarks, q.text, JSON.stringify({ parts: q.parts }), q.explanation);
  });

  const essayConfig = {
    rubric: [
      { key: 'content', label: 'Content — relevant, specific reasons given', max: 6 },
      { key: 'accuracy', label: 'Accuracy — correct understanding of LALCO / the role', max: 6 },
      { key: 'reasoning', label: 'Reasoning — logical, well-supported motivation', max: 6 },
      { key: 'communication', label: 'Communication — clear, organized writing', max: 6 },
      { key: 'professionalism', label: 'Professionalism — tone and presentation', max: 6 },
    ],
    themeHints: ['Salary', 'Clear career path', 'Clear promotion program', 'Chance to work in branches',
      'Exchange program between Head Office and branches', 'Chance to work as a business man/woman',
      'Chance to work for other departments, not only marketing', 'Chance to work in other LALCO group businesses, not only marketing'],
  };
  db.prepare(
    `INSERT INTO questions (id, type, order_index, category, difficulty, max_marks, text, config_json, explanation, created_by)
     VALUES (?, 'ESSAY', 1, 'Motivation', 'Written', 30, ?, ?, 'Manually reviewed by an evaluator against the rubric.', 'Seed')`
  ).run(generateId('q'), 'Lao Asean Leasing Public Company (LALCO) was established in 2015 and is now one of the biggest leasing companies in Laos. We were listed in 2020 and became the biggest listed company on the Lao Securities Exchange. With our background, why do you want to join our company?', JSON.stringify(essayConfig));

  console.log('Seeded question bank (6 calculation questions + 1 essay question).');
}

// The default assessment is created by the migration in db.js, which on a brand
// new database runs BEFORE this seed and therefore finds no questions to attach.
// Attach them here, once the bank exists. Only an assessment that still has no
// questions and has never been edited is touched, so an assessment someone
// deliberately emptied is left alone.

// ---------------------------------------------------------------------------
// IQ reasoning bank.
//
// Original questions written for this project, six categories, English only.
// No Lao is invented here: translation_status stays MISSING and an admin
// supplies or auto-translates Lao and approves it before any candidate sees it.
//
// Each question is a single-choice question with canonical values A-D. The
// VALUE is what is stored and marked; the visible text lives in optionLabels,
// so translating the text can never change the answer.
const IQ_BANK = [
  // ---------------------------------------------------------- NUMERICAL
  { category: 'NUMERICAL', difficulty: 'EASY',
    text: 'What number comes next in this series?\n\n2, 4, 8, 16, ?',
    options: { A: '24', B: '32', C: '36', D: '40' }, correct: 'B',
    explanation: 'Each term is double the one before it, so the next term is 16 x 2 = 32.' },
  { category: 'NUMERICAL', difficulty: 'MEDIUM',
    text: 'A machine produces 240 items in 8 hours, working at a constant rate. How many items does it produce in 5 hours?',
    options: { A: '120', B: '140', C: '150', D: '160' }, correct: 'C',
    explanation: '240 / 8 = 30 items per hour. 30 x 5 = 150.' },
  { category: 'NUMERICAL', difficulty: 'HARD',
    text: 'The average of five numbers is 18. When one number is removed the average of the remaining four is 20. What number was removed?',
    options: { A: '8', B: '10', C: '12', D: '14' }, correct: 'B',
    explanation: 'Total before = 5 x 18 = 90. Total after = 4 x 20 = 80. The removed number is 90 - 80 = 10.' },

  // ------------------------------------------------------------ LOGICAL
  { category: 'LOGICAL', difficulty: 'EASY',
    text: 'All engineers in a company attended the safety briefing.\nSome people who attended the safety briefing are contractors.\n\nWhich statement must be true?',
    options: {
      A: 'All contractors are engineers.',
      B: 'Some contractors attended the safety briefing.',
      C: 'No engineer is a contractor.',
      D: 'Every attendee is an engineer.',
    }, correct: 'B',
    explanation: 'The second premise states directly that some attendees are contractors. The other options claim more than the premises support.' },
  { category: 'LOGICAL', difficulty: 'MEDIUM',
    text: 'If the report is late, the review is postponed.\nThe review was not postponed.\n\nWhat follows?',
    options: {
      A: 'The report was late.',
      B: 'The report was not late.',
      C: 'The review was cancelled.',
      D: 'Nothing can be concluded.',
    }, correct: 'B',
    explanation: 'Denying the consequent denies the antecedent: if lateness would have forced a postponement and none happened, the report was not late.' },
  { category: 'LOGICAL', difficulty: 'HARD',
    text: 'Four colleagues sit in a row. Mai is not at either end. Som sits immediately to the right of Mai. Noy sits at the far left.\n\nWho sits at the far right?',
    options: { A: 'Mai', B: 'Som', C: 'Noy', D: 'The fourth colleague' }, correct: 'B',
    explanation: 'Noy is position 1. Mai cannot be position 1 or 4, and Som is immediately right of Mai, so Mai is 3 and Som is 4.' },

  // ------------------------------------------------------------ PATTERN
  { category: 'PATTERN', difficulty: 'EASY',
    text: 'Which letter continues the pattern?\n\nA, C, E, G, ?',
    options: { A: 'H', B: 'I', C: 'J', D: 'K' }, correct: 'B',
    explanation: 'The letters advance by two positions each time, so G is followed by I.' },
  { category: 'PATTERN', difficulty: 'MEDIUM',
    text: 'A pattern repeats every four steps:\n\ncircle, square, triangle, circle, circle, square, triangle, circle, ...\n\nWhat is the 15th shape?',
    options: { A: 'circle', B: 'square', C: 'triangle', D: 'cannot be determined' }, correct: 'C',
    explanation: '15 divided by 4 leaves a remainder of 3, so the 15th shape is the third in the block: triangle.' },
  { category: 'PATTERN', difficulty: 'HARD',
    text: 'Study the pairs:\n\n2 -> 5\n3 -> 10\n4 -> 17\n5 -> 26\n\nWhat does 6 map to?',
    options: { A: '35', B: '36', C: '37', D: '38' }, correct: 'C',
    explanation: 'Each output is the input squared plus one: 6 x 6 + 1 = 37.' },

  // ------------------------------------------------------------- VERBAL
  { category: 'VERBAL', difficulty: 'EASY',
    text: 'Book is to Library as Painting is to ?',
    options: { A: 'Artist', B: 'Gallery', C: 'Canvas', D: 'Frame' }, correct: 'B',
    explanation: 'A library is where books are kept and shown; a gallery is where paintings are kept and shown.' },
  { category: 'VERBAL', difficulty: 'MEDIUM',
    text: 'Which word does NOT belong with the others?',
    options: { A: 'Constant', B: 'Steady', C: 'Fluctuating', D: 'Stable' }, correct: 'C',
    explanation: 'Constant, steady and stable all describe something unchanging. Fluctuating is the opposite.' },
  { category: 'VERBAL', difficulty: 'HARD',
    text: 'Choose the pair whose relationship most closely matches:\n\nDrought is to Rainfall',
    options: {
      A: 'Famine is to Food',
      B: 'Storm is to Wind',
      C: 'Harvest is to Season',
      D: 'River is to Bank',
    }, correct: 'A',
    explanation: 'A drought is a severe shortage of rainfall; a famine is a severe shortage of food. The other pairs are not shortages.' },

  // ------------------------------------------------------------ SPATIAL
  { category: 'SPATIAL', difficulty: 'EASY',
    text: 'A square piece of paper is rotated 90 degrees clockwise, then 90 degrees clockwise again.\n\nHow does its final position compare with the start?',
    options: {
      A: 'Unchanged',
      B: 'Rotated 90 degrees clockwise',
      C: 'Rotated 180 degrees',
      D: 'Mirrored left to right',
    }, correct: 'C',
    explanation: 'Two quarter turns in the same direction make a half turn, which is 180 degrees.' },
  { category: 'SPATIAL', difficulty: 'MEDIUM',
    text: 'A cube is painted on all six faces and then cut into 27 identical smaller cubes.\n\nHow many of the small cubes have paint on exactly three faces?',
    options: { A: '4', B: '6', C: '8', D: '12' }, correct: 'C',
    explanation: 'Only the corner cubes show three painted faces, and a cube has 8 corners.' },
  { category: 'SPATIAL', difficulty: 'HARD',
    text: 'You face north, turn 90 degrees right, then 180 degrees, then 90 degrees left.\n\nWhich direction do you now face?',
    options: { A: 'North', B: 'East', C: 'South', D: 'West' }, correct: 'C',
    explanation: 'Facing north, a 90 degree right turn faces east. A 180 degree turn from east faces west. A 90 degree left turn from west faces south.' },

  // ----------------------------------------------------------- SEQUENCE
  { category: 'SEQUENCE', difficulty: 'EASY',
    text: 'Complete the sequence:\n\n5, 10, 15, 20, ?',
    options: { A: '22', B: '24', C: '25', D: '30' }, correct: 'C',
    explanation: 'The sequence increases by 5 each time, so the next term is 25.' },
  { category: 'SEQUENCE', difficulty: 'MEDIUM',
    text: 'Complete the sequence:\n\n1, 1, 2, 3, 5, 8, ?',
    options: { A: '11', B: '12', C: '13', D: '15' }, correct: 'C',
    explanation: 'Each term is the sum of the two before it: 5 + 8 = 13.' },
  { category: 'SEQUENCE', difficulty: 'HARD',
    text: 'Complete the sequence:\n\n3, 7, 16, 35, ?',
    options: { A: '70', B: '74', C: '78', D: '82' }, correct: 'B',
    explanation: 'Each term is double the previous term plus an increasing odd number: 3x2+1=7, 7x2+2=16, 16x2+3=35, 35x2+4=74.' },
];

const IQ_ASSESSMENT_NAME = 'LALCO Reasoning (IQ) Test';

function seedIqQuestions() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM questions WHERE question_family = 'IQ'").get().n;
  if (existing > 0) {
    console.log(`IQ bank already present (${existing} questions) - left untouched.`);
    return;
  }
  const insert = db.prepare(
    `INSERT INTO questions (id, type, order_index, category, difficulty, max_marks, text, config_json,
       explanation, active, created_by, question_family, iq_category, translation_status)
     VALUES (?, 'CALC', ?, ?, ?, ?, ?, ?, ?, 1, 'System (seed)', 'IQ', ?, 'MISSING')`
  );
  IQ_BANK.forEach((q, i) => {
    const values = Object.keys(q.options);
    const config = {
      parts: [{
        key: 'answer',
        label: 'Answer',
        marks: 1,
        type: 'choice',
        options: values,
        optionLabels: q.options,
        expected: q.correct,
      }],
    };
    insert.run(generateId('q'), i, q.category, q.difficulty, 1, q.text,
      JSON.stringify(config), q.explanation, q.category);
  });
  console.log(`Seeded ${IQ_BANK.length} IQ questions across ${new Set(IQ_BANK.map((q) => q.category)).size} categories.`);
}

function seedIqAssessment() {
  const existing = db.prepare("SELECT id FROM assessments WHERE assessment_type = 'IQ_TEST' LIMIT 1").get();
  if (existing) {
    console.log('IQ test already exists - left untouched.');
    return;
  }
  const id = 'asmt_iq_default';
  const questions = db.prepare(
    "SELECT id FROM questions WHERE question_family = 'IQ' AND active = 1 AND COALESCE(archived,0) = 0 ORDER BY order_index"
  ).all();
  const marks = questions.length;
  db.prepare(
    // randomize_questions / randomize_question_order are ON: an IQ test draws a
    // fresh paper per candidate. questions_to_show is left NULL, meaning "the
    // whole eligible pool", so the seeded test asks every seeded question — in
    // its own order per candidate. An administrator sets a smaller number once
    // the bank is bigger than one sitting should contain.
    `INSERT INTO assessments (id, name, description, active, archived, duration_minutes, link_expiry_minutes,
       calc_max, written_max, interview_max, total_max, pass_threshold, eligibility_rules_id,
       assessment_type, iq_scoring_json, randomize_questions, questions_to_show,
       randomize_question_order, randomize_options, created_by)
     VALUES (?,?,?,1,0,?,?,?,0,0,?,?,1,'IQ_TEST',?, 1, NULL, 1, 0, 'System (seed)')`
  ).run(
    id,
    IQ_ASSESSMENT_NAME,
    'Reasoning test across numerical, logical, pattern, verbal, spatial and sequence questions. Marked automatically. Any estimated figure it reports is an estimate from this test alone and is not a clinically validated IQ.',
    30,   // duration_minutes - configurable per assessment, not hardcoded in code
    10,   // link_expiry_minutes
    marks, marks,
    50,   // pass_threshold, as a percentage for the IQ scoring model
    JSON.stringify({ model: 'LINEAR_FROM_PERCENTAGE', mean: 100, scale: 0.6, min: 55, max: 145, estimatedIqEnabled: true, passThreshold: 50 })
  );
  const attach = db.prepare('INSERT OR IGNORE INTO assessment_questions (assessment_id, question_id, order_index) VALUES (?,?,?)');
  questions.forEach((q, i) => attach.run(id, q.id, i));
  console.log(`Created "${IQ_ASSESSMENT_NAME}" with ${questions.length} questions (30 minutes).`);
}

function seedAssessmentQuestions() {
  const targets = db.prepare(
    `SELECT a.id FROM assessments a
      WHERE a.created_by = 'System (migration)'
        AND a.updated_at = a.created_at
        AND NOT EXISTS (SELECT 1 FROM assessment_questions aq WHERE aq.assessment_id = a.id)`
  ).all();
  if (targets.length === 0) return;
  const questions = db.prepare(
    `SELECT id FROM questions
      WHERE active = 1 AND COALESCE(archived,0) = 0 AND question_family = 'GENERAL'
      ORDER BY CASE type WHEN 'CALC' THEN 0 ELSE 1 END, order_index`
  ).all();
  const attach = db.prepare('INSERT OR IGNORE INTO assessment_questions (assessment_id, question_id, order_index) VALUES (?,?,?)');
  targets.forEach((a) => questions.forEach((q, i) => attach.run(a.id, q.id, i)));
  console.log(`Attached ${questions.length} questions to the default assessment.`);
}

function seedInterview() {
  if (db.prepare('SELECT COUNT(*) AS n FROM interview_questions').get().n > 0) return;
  const qs = [
    ['Explain the task of marketing staff. Ask whether the candidate can make approximately 200 calls per day.', 1],
    ['For candidates from the provinces: ask whether they can come to Head Office for training when requested.', 1],
    ['Ask about previous employment and collect relevant information.', 0],
    ['Ask about family/social network referrals relevant to the recruitment role (parents, siblings, spouse, friends) and whether they would introduce them as customers.', 0],
  ];
  qs.forEach(([text, disq], i) => {
    db.prepare('INSERT INTO interview_questions (id, text, disqualifying, order_index) VALUES (?,?,?,?)').run(generateId('ivq'), text, disq, i + 1);
  });
  const criteria = [
    ['communication', 'Communication', 10, 'Answers quickly and decisively, polite, clear'],
    ['responsiveness', 'Responsiveness', 10, 'Speed and smoothness of conversation'],
    ['professionalism', 'Professionalism', 10, 'Politeness and demeanor'],
    ['jobUnderstanding', 'Job Understanding', 10, 'Understands the role and subject matter'],
  ];
  criteria.forEach(([key, label, max, hint], i) => {
    db.prepare('INSERT INTO interview_criteria (id, key, label, max_marks, hint, order_index) VALUES (?,?,?,?,?,?)').run(generateId('crit'), key, label, max, hint, i + 1);
  });
  console.log('Seeded interview questions and scoring rubric.');
}

function seedScholarship() {
  if (db.prepare('SELECT COUNT(*) AS n FROM scholarship_policies').get().n > 0) return;
  const rows = [
    ['CURRENT', 3, '1 MLAK/month', 'In 24 months', 2027, '10 months'],
    ['CURRENT', 4, '1 MLAK/month', 'In 12 months', 2026, '5 months'],
    ['PROPOSED', 3, '1 MLAK/month', 'In 24 months', 2028, '10 months'],
    ['PROPOSED', 4, '2 MLAK/month', 'In 12 months', 2027, '10 months'],
  ];
  rows.forEach(([kind, year, funding, timing, start, commit]) => {
    db.prepare('INSERT INTO scholarship_policies (id, kind, year, funding, payment_timing, year_to_start, commitment) VALUES (?,?,?,?,?,?,?)')
      .run(generateId('pol'), kind, year, funding, timing, start, commit);
  });
  console.log('Seeded scholarship policy (current + proposed).');
}

function seedDemoCandidates() {
  if (db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE is_demo = 1').get().n > 0) { console.log('Demo candidates already seeded, skipping.'); return; }
  const rand = mulberry32(20260922);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const ri = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
  const FIRST = ['Somchai', 'Bounmy', 'Khamla', 'Vilay', 'Chanthavy', 'Souda', 'Phet', 'Anousone', 'Malee', 'Kham', 'Sengdao', 'Bounlert', 'Vanida', 'Thipphavanh', 'Somsanouk', 'Latsamy', 'Manivanh', 'Sisavath', 'Amphone', 'Phonesavanh'];
  const LAST = ['Sisavath', 'Phommachanh', 'Vongsa', 'Keomany', 'Inthavong', 'Chanthaboury', 'Sengphachanh', 'Bouasavanh', 'Souvannasy', 'Vilaysane'];
  const POSITIONS = ['Marketing Staff', 'Credit Analyst', 'Branch Teller', 'IT Support', 'HR Officer', 'Accountant', 'Legal Officer'];
  const DEPARTMENTS = ['Marketing', 'Credit', 'Operations', 'IT', 'Human Resources', 'Finance', 'Legal'];
  const BRANCHES = ['Head Office - Vientiane', 'Luang Prabang Branch', 'Savannakhet Branch', 'Pakse Branch'];
  const PROVINCES = ['Vientiane Capital', 'Luang Prabang', 'Savannakhet', 'Champasak', 'Vientiane Province', 'Xieng Khouang'];

  const eligRules = db.prepare('SELECT * FROM eligibility_rules WHERE id = 1').get();
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const questions = db.prepare("SELECT * FROM questions WHERE active = 1 AND question_family = 'GENERAL'").all().map((q) => ({ ...q, config: JSON.parse(q.config_json) }));
  const calcQuestions = questions.filter((q) => q.type === 'CALC');
  const criteria = db.prepare('SELECT * FROM interview_criteria ORDER BY order_index').all();
  const recruiter = db.prepare(`SELECT id FROM users WHERE role = 'HR_ADMIN' LIMIT 1`).get();

  for (let i = 1; i <= 20; i++) {
    const isScholarship = i % 5 === 0;
    const gender = i % 2 === 0 ? 'Female' : 'Male';
    const fname = pick(FIRST), lname = pick(LAST);
    const province = pick(PROVINCES);
    const iq = isScholarship ? ri(85, 135) : ri(65, 130);
    const gpa = isScholarship ? Math.round((ri(20, 40) / 10) * 100) / 100 : null;
    const education = isScholarship ? 'Bachelor Degree' : pick(['High school', 'Vocational Diploma', 'Bachelor Degree']);

    const candId = generateId('cand');
    const code = 'LALCO-DEMO-' + String(i).padStart(5, '0');
    db.prepare(
      `INSERT INTO candidates (id, code, full_name, gender, dob, nationality, phone, email, address, province,
        current_location, education, university, major, gpa, previous_employer, previous_position, years_experience,
        expected_salary, application_type, applied_department_id, applied_position_id, branch_id, application_date,
        recruitment_batch, recruiter_id, iq, status, is_demo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
    ).run(
      candId, code, `${fname} ${lname}`, gender, `${ri(1992, 2003)}-${String(ri(1, 12)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}`,
      'Lao', '020 ' + ri(20000000, 99999999), `${fname}.${lname}${i}@mail.example.la`.toLowerCase(), province, province, province,
      education, isScholarship ? pick(['National University of Laos', 'Souphanouvong University']) : null, isScholarship ? 'Business' : null, gpa,
      i % 3 === 0 ? 'ABC Trading Co.' : null, i % 3 === 0 ? 'Sales Assistant' : null, i % 3 === 0 ? ri(1, 5) : 0,
      ri(3, 9) * 1000000, isScholarship ? 'SCHOLARSHIP' : 'NORMAL',
      upsertLookup('departments', pick(DEPARTMENTS)), upsertLookup('positions', pick(POSITIONS)), upsertLookup('branches', pick(BRANCHES)),
      `2026-0${ri(1, 8) > 9 ? 9 : ri(1, 8)}-${String(ri(1, 28)).padStart(2, '0')}`, '2026-Q3 Intake (Demo)', recruiter ? recruiter.id : null, iq, 'DRAFT'
    );

    const okIq = iq > (isScholarship ? eligRules.scholarship_iq_min : eligRules.normal_iq_min);
    const okEdu = isScholarship ? education === 'Bachelor Degree' : true;
    const okGpa = !isScholarship || (gpa != null && gpa > eligRules.scholarship_gpa_min);
    const eligible = okIq && okEdu && okGpa;

    if (!eligible) { db.prepare(`UPDATE candidates SET status='REJECTED' WHERE id=?`).run(candId); continue; }

    const progress = i % 6;
    if (progress === 0) { db.prepare(`UPDATE candidates SET status='INVITED' WHERE id=?`).run(candId); continue; }

    // Simulate a completed (or in-progress) assessment session for this demo candidate.
    const sessionId = generateId('sess');
    const startedAt = new Date(Date.now() - ri(1, 20) * 86400000).toISOString();
    db.prepare(
      `INSERT INTO assessment_sessions (id, candidate_id, link_id, started_at, duration_minutes, expires_at, submitted_at, status, verified)
       VALUES (?,?,NULL,?,?,?,?,?,1)`
    ).run(sessionId, candId, startedAt, settings.assessment_duration_minutes, new Date(Date.now() + 3600000).toISOString(), startedAt, 'SUBMITTED');

    const answersByQ = {};
    calcQuestions.forEach((q) => {
      const perf = Math.min(1.15, rand() * 1.15 + (isScholarship ? 0.15 : 0));
      const answer = {};
      q.config.parts.forEach((p) => {
        const correct = rand() < perf * 0.8 + 0.15;
        if (p.type === 'choice') answer[p.key] = correct ? p.expected : p.options.find((o) => o !== p.expected);
        else answer[p.key] = correct ? p.expected : Math.round(p.expected * (0.55 + rand() * 0.3) * 100) / 100;
      });
      const ansId = generateId('ans');
      const seconds = ri(28, 220);
      db.prepare(
        `INSERT INTO candidate_answers (id, session_id, question_id, answer_json, started_at, first_answered_at, last_modified_at, submitted_at, time_spent_seconds, visits)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(ansId, sessionId, q.id, JSON.stringify(answer), startedAt, startedAt, startedAt, startedAt, seconds, ri(1, 3));
      answersByQ[q.id] = { answer_json: JSON.stringify(answer) };
    });
    const calcResult = gradeAllCalc(questions, answersByQ);

    let essayMarks = null, essayBreakdown = null, essayMarkedAt = null;
    let interviewMarks = null, interviewBreakdown = null, interviewMarkedAt = null;
    if (progress >= 2) {
      essayMarks = Math.max(0, Math.min(30, Math.round((isScholarship ? 20 : 16) + rand() * 12)));
      essayBreakdown = { content: Math.round(essayMarks / 5), accuracy: Math.round(essayMarks / 5), reasoning: Math.round(essayMarks / 5), communication: Math.round(essayMarks / 5), professionalism: Math.round(essayMarks / 5) };
      essayMarkedAt = new Date().toISOString();
      const essayQ = questions.find((q) => q.type === 'ESSAY');
      db.prepare(
        `INSERT INTO candidate_answers (id, session_id, question_id, answer_json, started_at, first_answered_at, last_modified_at, submitted_at, time_spent_seconds, visits)
         VALUES (?,?,?,?,?,?,?,?,?,1)`
      ).run(generateId('ans'), sessionId, essayQ.id, JSON.stringify({ text: '[demo essay response — clearly labeled demo data]' }), startedAt, startedAt, startedAt, startedAt, ri(180, 900));
    }
    if (progress >= 3) {
      const critScores = {}; let total = 0;
      criteria.forEach((c) => { const v = Math.max(0, Math.min(c.max_marks, Math.round((isScholarship ? 7 : 5) + rand() * 4))); critScores[c.key] = v; total += v; });
      interviewMarks = total; interviewBreakdown = critScores; interviewMarkedAt = new Date().toISOString();
    }

    const finalMarks = progress >= 3 ? calcResult.marks + (essayMarks || 0) + (interviewMarks || 0) : null;
    const pass = finalMarks != null ? finalMarks >= settings.pass_threshold : null;

    db.prepare(
      `INSERT INTO scores (id, session_id, calc_marks, calc_max, calc_breakdown_json, essay_marks, essay_max, essay_breakdown_json, essay_marker, essay_comments, essay_marked_at,
        interview_marks, interview_max, interview_breakdown_json, interview_marker, interview_comments, interview_marked_at, final_marks, percentage, pass)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      generateId('score'), sessionId, calcResult.marks, 30, JSON.stringify(calcResult.breakdown),
      essayMarks, 30, essayBreakdown ? JSON.stringify(essayBreakdown) : null, essayMarks != null ? 'Evaluator (Demo)' : null,
      essayMarks != null ? (essayMarks >= 22 ? 'Clear, well-reasoned response covering several genuine motivations.' : 'Response covers basic points but lacks depth.') : null, essayMarkedAt,
      interviewMarks, 40, interviewBreakdown ? JSON.stringify(interviewBreakdown) : null, interviewMarks != null ? 'Interviewer (Demo)' : null,
      interviewMarks != null ? 'Responded promptly and clearly.' : null, interviewMarkedAt, finalMarks, finalMarks, pass == null ? null : (pass ? 1 : 0)
    );

    let riskLevel = 'Low'; const evidence = [];
    if (i === 13) { riskLevel = 'Medium'; evidence.push('Large text insertion detected. Candidate pasted 1,245 characters into the essay answer field.', 'Candidate changed browser focus 7 times during the assessment.'); }
    db.prepare('INSERT INTO integrity_assessments (id, session_id, paste_events, focus_changes, largest_paste, risk_level, evidence_json) VALUES (?,?,?,?,?,?,?)')
      .run(generateId('integ'), sessionId, i === 13 ? 2 : 0, i === 13 ? 7 : 0, i === 13 ? 1245 : 0, riskLevel, JSON.stringify(evidence));

    let status = 'ASSESSMENT_COMPLETED';
    if (progress >= 2) status = 'INTERVIEW_PENDING';
    if (progress >= 3) status = pass ? (isScholarship ? 'SCHOLARSHIP_SELECTED' : 'PASSED') : 'FAILED';
    if (i === 19) status = 'WITHDRAWN';
    db.prepare('UPDATE candidates SET status = ? WHERE id = ?').run(status, candId);
  }
  console.log('Seeded 20 demo candidates (is_demo = 1) with varied progress, clearly labeled as demo data.');
}

// Demo candidates are opt-in only: a production seed must never invent people.
const wantsDemo = process.argv.includes('--demo')
  || String(process.env.SEED_DEMO_CANDIDATES || '').toLowerCase() === 'true';

// One transaction for the whole seed, so a failure part-way through can never
// leave a half-populated database (users but no question bank, say).
const runSeed = db.transaction(() => {
  seedUsers(seedPassword);
  seedQuestions();
  seedAssessmentQuestions();
  seedIqQuestions();
  seedIqAssessment();
  seedInterview();
  seedScholarship();
  if (wantsDemo) {
    seedDemoCandidates();
  } else {
    console.log('Skipped demo candidates (reference data only). Use `npm run seed:demo` to add them.');
  }
});

try {
  runSeed();
} catch (error) {
  console.error('\nSeed failed and was rolled back. The database is unchanged.');
  console.error('  ' + (error && error.message ? error.message : String(error)) + '\n');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  if (wantsDemo) {
    console.warn('WARNING: demo candidates were seeded into a production database.');
  }
  console.log('Reminder: sign in and reset every account through Admin -> Users, so the');
  console.log('shared seed password stops being a shared password.');
}

console.log('Seed complete.');
