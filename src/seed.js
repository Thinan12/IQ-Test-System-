// Seeds the database with:
//   - the real LALCO question bank, eligibility rules, interview rubric and scholarship policy
//   - one admin login per role (DEMO credentials — change immediately in real use)
//   - ~20 DEMO candidates (is_demo = 1) so the admin UI has something to explore
// Re-running this script is safe: it clears and reseeds demo-only data, but leaves
// any candidate created through the real app (is_demo = 0) untouched.
require('dotenv').config();
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

function seedUsers() {
  const roles = [
    ['Super Admin', 'superadmin@lalco.demo', 'SUPER_ADMIN'],
    ['HR Admin', 'hradmin@lalco.demo', 'HR_ADMIN'],
    ['Recruiter', 'recruiter@lalco.demo', 'RECRUITER'],
    ['Interviewer', 'interviewer@lalco.demo', 'INTERVIEWER'],
    ['Evaluator', 'evaluator@lalco.demo', 'EVALUATOR'],
    ['Manager', 'manager@lalco.demo', 'MANAGER'],
  ];
  const password = process.env.DEMO_PASSWORD || 'ChangeMe123!';
  const hash = bcrypt.hashSync(password, 12);
  roles.forEach(([name, email, role]) => {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return;
    db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
      .run(generateId('user'), name, email, hash, role);
  });
  console.log(`Seeded ${roles.length} demo users. Password for all: "${password}" (set DEMO_PASSWORD env var to change).`);
}

function seedQuestions() {
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM questions`).get().n;
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
  const questions = db.prepare('SELECT * FROM questions WHERE active = 1').all().map((q) => ({ ...q, config: JSON.parse(q.config_json) }));
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

seedUsers();
seedQuestions();
seedInterview();
seedScholarship();
seedDemoCandidates();
console.log('Seed complete.');
