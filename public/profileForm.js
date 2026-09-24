// The candidate's own profile form, shared by the recruitment assessment portal
// and the IQ portal so the two ask for the same things in the same way.
//
// Two things this file is careful about:
//
//   * Switching English <-> Lao re-renders the form. Whatever the candidate has
//     typed is captured into DRAFT first and written back afterwards, so
//     changing the language never empties a field they had already filled in.
//   * The value saved for "graduated from" is the stable internal one
//     (HIGH_SCHOOL / COLLEGE / UNIVERSITY). The Lao and English wording beside
//     it is display only, so the stored value cannot change with the language.
//
// Lao wording: only the strings the business supplied are translated here.
// Anything still null falls back to English through the portal's own t(),
// exactly as the rest of the portal does, rather than being machine-translated
// or invented.
(function (global) {
  'use strict';

  const FIELD_ORDER = ['fullName', 'phone', 'graduateFrom', 'school', 'subject', 'gpa'];

  // Strings this form adds. `lo: null` means "not translated yet" and falls
  // back to English; it never means "show an empty label".
  const STRINGS = {
    en: {
      profileTitle: 'Your details',
      profileIntro: 'Please confirm your information before you begin. It is saved to your application.',
      personalSection: 'Personal information',
      educationSection: 'Education',
      fullNameLabel: 'Full name',
      phoneLabel: 'Phone number',
      graduateFromLabel: 'Graduated from',
      graduateFromPlaceholder: 'Please choose',
      schoolLabel: 'School name',
      subjectLabel: 'Subject',
      gpaLabel: 'GPA / mark',
      saveProfile: 'Save and continue',
      savingProfile: 'Saving…',
      profileSaved: 'Your details have been saved.',
      profileFixErrors: 'Please check the highlighted fields.',
    },
    lo: {
      profileTitle: null,
      profileIntro: null,
      personalSection: null,
      educationSection: null,
      fullNameLabel: null,
      phoneLabel: null,
      graduateFromLabel: null,
      graduateFromPlaceholder: null,
      schoolLabel: null,
      subjectLabel: null,
      gpaLabel: null,
      saveProfile: null,
      savingProfile: null,
      profileSaved: null,
      profileFixErrors: null,
    },
  };

  // What the candidate has typed so far, kept across re-renders (a language
  // switch is a re-render). Never read by the server; the server only ever sees
  // what is submitted.
  let DRAFT = null;
  let ERRORS = {};

  function seedDraft(profile) {
    DRAFT = {
      fullName: (profile && profile.fullName) || '',
      phone: (profile && profile.phone) || '',
      graduateFrom: (profile && profile.graduateFrom) || '',
      school: (profile && profile.school) || '',
      subject: (profile && profile.subject) || '',
      gpa: profile && profile.gpa !== null && profile.gpa !== undefined ? String(profile.gpa) : '',
    };
  }

  /** Read whatever is on screen right now, so a re-render does not lose it. */
  function captureDraft(root) {
    if (!DRAFT) DRAFT = {};
    FIELD_ORDER.forEach((key) => {
      const el = (root || document).querySelector('#pf_' + key);
      if (el) DRAFT[key] = el.value;
    });
  }

  function fieldError(key) {
    return ERRORS[key] ? `<div class="pf-err" style="color:var(--danger);font-size:12px;margin-top:4px;">${ERRORS[key]}</div>` : '';
  }

  /**
   * Render the profile step.
   *
   * ctx = {
   *   t, esc, api, shell,            // the portal's own helpers
   *   info,                          // the intro payload (profile, options)
   *   languageToggle(rerender),      // the portal's language switcher
   *   onSaved(profile),              // called once the server has stored it
   * }
   */
  function render(ctx) {
    const { t, esc, shell, info } = ctx;
    if (!DRAFT) seedDraft(info.profile);

    const options = info.graduateFromOptions || [];
    const lang = ctx.lang() === 'lo' ? 'lo' : 'en';

    const text = (key) => {
      const table = STRINGS[lang] || STRINGS.en;
      const v = table[key];
      return (v === null || v === undefined) ? STRINGS.en[key] : v;
    };

    const input = (key, label, attrs) => `
      <div class="field">
        <label class="field-label" for="pf_${key}">${esc(label)}</label>
        <input id="pf_${key}" ${attrs || ''} value="${esc(DRAFT[key] || '')}">
        ${fieldError(key)}
      </div>`;

    shell(`
      <h2 style="margin-bottom:6px;">${esc(text('profileTitle'))}</h2>
      <p class="faint" style="margin-bottom:16px;">${esc(text('profileIntro'))}</p>

      <div class="card">
        <div class="section-title">${esc(text('personalSection'))}</div>
        ${input('fullName', text('fullNameLabel'), 'autocomplete="name" maxlength="120"')}
        ${input('phone', text('phoneLabel'), 'inputmode="tel" autocomplete="tel" maxlength="32" placeholder="+856 20 ..."')}
      </div>

      <div class="card" style="margin-top:14px;">
        <div class="section-title">${esc(text('educationSection'))}</div>
        <div class="field">
          <label class="field-label" for="pf_graduateFrom">${esc(text('graduateFromLabel'))}</label>
          <select id="pf_graduateFrom">
            <option value="">${esc(text('graduateFromPlaceholder'))}</option>
            ${options.map((o) => `<option value="${esc(o.value)}" ${DRAFT.graduateFrom === o.value ? 'selected' : ''}>${esc(lang === 'lo' && o.lo ? o.lo : o.en)}</option>`).join('')}
          </select>
          ${fieldError('graduateFrom')}
        </div>
        ${input('school', text('schoolLabel'), 'maxlength="160"')}
        ${input('subject', text('subjectLabel'), 'maxlength="120"')}
        ${input('gpa', text('gpaLabel'), 'inputmode="decimal" placeholder="3.4"')}
      </div>

      <div id="pfErr" class="faint" style="color:var(--danger);margin-top:10px;"></div>
      <button class="btn btn-primary" id="pfSave" style="width:100%;justify-content:center;margin-top:12px;">${esc(text('saveProfile'))}</button>
    `, { timer: false });

    // A language switch must not discard what is already typed.
    ctx.languageToggle(() => { captureDraft(); render(ctx); });

    const btn = document.querySelector('#pfSave');
    btn.onclick = async () => {
      captureDraft();
      ERRORS = {};
      btn.disabled = true;
      btn.textContent = text('savingProfile');
      document.querySelector('#pfErr').textContent = '';
      try {
        const res = await ctx.api('/profile', {
          method: 'POST',
          body: JSON.stringify({
            fullName: DRAFT.fullName,
            phone: DRAFT.phone,
            graduateFrom: DRAFT.graduateFrom,
            school: DRAFT.school,
            subject: DRAFT.subject,
            gpa: DRAFT.gpa,
          }),
        });
        ctx.onSaved(res.profile);
      } catch (e) {
        const data = (e && e.data) || {};
        if (Array.isArray(data.errors)) {
          data.errors.forEach((err) => { if (err && err.field) ERRORS[err.field] = err.message; });
        }
        btn.disabled = false;
        btn.textContent = text('saveProfile');
        // Re-render to show the per-field messages, keeping what was typed.
        render(ctx);
        const box = document.querySelector('#pfErr');
        if (box) box.textContent = data.error || text('profileFixErrors');
      }
    };
  }

  /** Start again from what the server holds — used when the portal (re)boots. */
  function reset(profile) {
    DRAFT = null;
    ERRORS = {};
    if (profile) seedDraft(profile);
  }

  global.CandidateProfileForm = { render, reset, STRINGS, FIELD_ORDER };
})(window);
