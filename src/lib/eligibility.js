function evaluateEligibility(candidate, rules) {
  const isScholarship = candidate.application_type === 'SCHOLARSHIP';
  const req = isScholarship
    ? { iqMin: rules.scholarship_iq_min, educationMin: rules.scholarship_education_min, gpaMin: rules.scholarship_gpa_min }
    : { iqMin: rules.normal_iq_min, educationMin: rules.normal_education_min, gpaMin: null };

  const checks = [];
  const iq = candidate.iq;
  checks.push({
    condition: 'IQ',
    candidateValue: iq == null ? '—' : iq,
    requiredValue: '> ' + req.iqMin,
    status: iq != null && iq > req.iqMin ? 'PASSED' : 'FAILED',
    reason: iq != null && iq > req.iqMin ? 'IQ meets minimum requirement.' : 'IQ score does not meet minimum requirement.',
  });

  if (isScholarship) {
    const edu = candidate.education || '';
    const okEdu = /college|university|bachelor|master/i.test(edu);
    checks.push({
      condition: 'Education',
      candidateValue: edu || '—',
      requiredValue: req.educationMin,
      status: okEdu ? 'PASSED' : 'FAILED',
      reason: okEdu ? 'Education meets requirement.' : 'Candidate has not graduated from college/university.',
    });
    const gpa = candidate.gpa;
    const okGpa = gpa != null && gpa > req.gpaMin;
    checks.push({
      condition: 'GPA',
      candidateValue: gpa == null ? '—' : gpa,
      requiredValue: '> ' + req.gpaMin,
      status: okGpa ? 'PASSED' : 'FAILED',
      reason: okGpa ? 'GPA meets requirement.' : 'GPA does not meet minimum requirement.',
    });
  } else {
    const okEdu = !!candidate.education;
    checks.push({
      condition: 'Education',
      candidateValue: candidate.education || '—',
      requiredValue: req.educationMin,
      status: okEdu ? 'PASSED' : 'FAILED',
      reason: okEdu ? 'Education meets requirement.' : 'No education record on file.',
    });
  }

  checks.push({
    condition: 'Character Test',
    candidateValue: 'On file',
    requiredValue: rules.character_note,
    status: 'INFO',
    reason: 'For reference only — not a pass/fail condition.',
  });

  const fails = checks.filter((c) => c.status === 'FAILED');
  return { status: fails.length ? 'NOT_ELIGIBLE' : 'ELIGIBLE', checks, fails };
}

module.exports = { evaluateEligibility };
