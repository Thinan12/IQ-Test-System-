// The profile a candidate fills in themselves, before they sit anything.
//
// It writes into the candidate record that already exists — the invitation
// token resolves to that candidate, so reopening an invitation never creates a
// second one. Nothing here invents a candidate, and nothing here can reach a
// candidate other than the one the token belongs to.
//
// The stored values are stable internal ones. `graduateFrom` is an enum, never
// the translated label shown on screen, so switching the form between English
// and Lao cannot change what is saved.

const db = require('../db');

// Stable internal values. The labels beside them are for display only and are
// never what gets stored.
const GRADUATE_FROM = [
  { value: 'HIGH_SCHOOL', en: 'High school', lo: 'ມັດທະຍົມ' },
  { value: 'COLLEGE', en: 'College', lo: 'ວິທະຍາໄລ' },
  { value: 'UNIVERSITY', en: 'University', lo: 'ມະຫາວິທະຍາໄລ' },
];

const GRADUATE_FROM_VALUES = GRADUATE_FROM.map((g) => g.value);

// The readable English text kept in `education`, which the eligibility rules
// already read. Writing it keeps scholarship eligibility behaving exactly as it
// did before candidates filled in their own profile.
const EDUCATION_TEXT = {
  HIGH_SCHOOL: 'High school',
  COLLEGE: 'College',
  UNIVERSITY: 'University',
};

const LIMITS = {
  nameChars: 120,
  phoneChars: 32,
  schoolChars: 160,
  subjectChars: 120,
  gpaMax: 100,
};

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Phone numbers are accepted in the shapes people actually write them: a Lao
 * local number, an international one with or without +, and with spaces,
 * hyphens, dots or brackets as separators. Only the digits are counted, and the
 * range is wide on purpose — rejecting a real candidate's real number is worse
 * than accepting an odd one, and nothing downstream parses this.
 */
function isValidPhone(value) {
  const raw = str(value);
  if (!raw || raw.length > LIMITS.phoneChars) return false;
  if (!/^\+?[0-9 ().\-]+$/.test(raw)) return false;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 15;
}

/**
 * GPA / mark. Laos uses a 0-4 GPA and also a 0-100 mark, and schools abroad use
 * other scales, so this accepts any number from 0 to 100 rather than inventing
 * a narrower rule the business never asked for.
 */
function parseGpa(value) {
  const raw = str(value);
  if (!raw) return { ok: false };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false };
  if (n < 0 || n > LIMITS.gpaMax) return { ok: false };
  return { ok: true, value: n };
}

/**
 * Validate a submitted profile. Returns { errors, values }: `errors` is a list
 * of { field, message } so the portal can mark the field that is wrong, in
 * whichever language it is showing.
 */
function validateProfile(body) {
  const b = body || {};
  const errors = [];

  const fullName = str(b.fullName);
  if (!fullName) errors.push({ field: 'fullName', message: 'Your name is required.' });
  else if (fullName.length > LIMITS.nameChars) errors.push({ field: 'fullName', message: 'That name is too long.' });

  const phone = str(b.phone);
  if (!phone) errors.push({ field: 'phone', message: 'A phone number is required.' });
  else if (!isValidPhone(phone)) errors.push({ field: 'phone', message: 'Enter a valid phone number.' });

  const graduateFrom = str(b.graduateFrom).toUpperCase();
  if (!graduateFrom) errors.push({ field: 'graduateFrom', message: 'Select what you graduated from.' });
  else if (!GRADUATE_FROM_VALUES.includes(graduateFrom)) {
    errors.push({ field: 'graduateFrom', message: 'Select one of the listed options.' });
  }

  const school = str(b.school);
  if (!school) errors.push({ field: 'school', message: 'A school name is required.' });
  else if (school.length > LIMITS.schoolChars) errors.push({ field: 'school', message: 'That school name is too long.' });

  const subject = str(b.subject);
  if (!subject) errors.push({ field: 'subject', message: 'A subject is required.' });
  else if (subject.length > LIMITS.subjectChars) errors.push({ field: 'subject', message: 'That subject is too long.' });

  const gpa = parseGpa(b.gpa);
  if (!gpa.ok) errors.push({ field: 'gpa', message: 'Enter your GPA or mark as a number between 0 and 100.' });

  if (errors.length) return { errors, values: null };
  return {
    errors: [],
    values: { fullName, phone, graduateFrom, school, subject, gpa: gpa.value },
  };
}

/**
 * Write the profile onto the candidate this invitation already belongs to.
 * Never inserts a candidate: the token resolved to one, and that is the record
 * that is updated however many times the invitation is reopened.
 */
function saveProfile(candidateId, values) {
  const existing = db.prepare('SELECT profile_completed_at FROM candidates WHERE id = ?').get(candidateId);
  if (!existing) return null;
  db.prepare(
    `UPDATE candidates
        SET full_name = @fullName,
            phone = @phone,
            graduate_from = @graduateFrom,
            education = @education,
            university = @school,
            major = @subject,
            gpa = @gpa,
            profile_completed_at = COALESCE(profile_completed_at, datetime('now')),
            profile_updated_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = @id`
  ).run({
    id: candidateId,
    fullName: values.fullName,
    phone: values.phone,
    graduateFrom: values.graduateFrom,
    // Kept readable so the eligibility rules, which match on this text, carry
    // on behaving exactly as they did.
    education: EDUCATION_TEXT[values.graduateFrom] || null,
    school: values.school,
    subject: values.subject,
    gpa: values.gpa,
  });
  return db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
}

/** What the candidate's portal shows back: their own profile, nothing else. */
function profileForCandidate(candidate) {
  if (!candidate) return null;
  return {
    fullName: candidate.full_name || '',
    phone: candidate.phone || '',
    graduateFrom: candidate.graduate_from || '',
    school: candidate.university || '',
    subject: candidate.major || '',
    gpa: candidate.gpa === null || candidate.gpa === undefined ? '' : candidate.gpa,
    completed: !!candidate.profile_completed_at,
  };
}

/** PROFILE_COMPLETED once the candidate has filled it in; PROFILE_PENDING before. */
function profileStatus(candidate) {
  return candidate && candidate.profile_completed_at ? 'PROFILE_COMPLETED' : 'PROFILE_PENDING';
}

module.exports = {
  GRADUATE_FROM,
  GRADUATE_FROM_VALUES,
  EDUCATION_TEXT,
  LIMITS,
  isValidPhone,
  parseGpa,
  validateProfile,
  saveProfile,
  profileForCandidate,
  profileStatus,
};
