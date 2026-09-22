# LALCO Recruitment & Assessment Platform

A real, deployable full-stack application: a private authenticated admin system for
LALCO HR staff, and a completely separate public exam portal for candidates —
backed by one Node.js/Express server and one SQLite database as the single source
of truth.

## What's genuinely separated

- **Admin app** (`/admin`, `public/admin/`): requires login (JWT + bcrypt password
  hashes). Every `/api/admin/*` route checks the token server-side — there is no
  client-side-only gate anywhere.
- **Candidate exam app** (`/exam/:token`, `public/exam/`): a distinct static bundle
  that contains **no admin code, no other candidates' data, and no answer keys**.
  Correct answers and marking rules live only in `questions.config_json` and are
  only ever read by `/api/admin/*` routes and by the server-side grading engine
  (`src/lib/grading.js`) at submit time — `sanitizeQuestionForCandidate()` in
  `src/routes/exam.js` strips them before anything is sent to the browser.
- **Marking is server-side.** The candidate's browser never computes a score; it
  only submits raw answers. The server is the only source of truth for scores,
  eligibility, and candidate status — nothing submitted by the browser is trusted
  for marks, timestamps, or eligibility.

This was verified directly, not just written: an automated test (`e2e_test.sh`)
confirms the candidate-facing question payload never contains the answer key,
that unauthenticated requests to `/api/admin/*` are rejected, that a bogus/foreign
exam token is rejected, and that answers can't be edited after submission.

## Quick start

```bash
npm install
cp .env.example .env
# generate a real secret and put it in .env as JWT_SECRET=
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm run seed     # creates demo users + the real question bank + 20 demo candidates
npm start
```

Open `http://localhost:4000/admin` and sign in with one of the seeded accounts
(see console output from `npm run seed`, or `hradmin@lalco.demo` / the
`DEMO_PASSWORD` from your `.env`, default `ChangeMe123!`).

**Change the demo password and rotate `JWT_SECRET` before using this for real
candidates.** Seeded demo candidates have `is_demo = 1` and are clearly
distinguishable in the UI; they are never mixed silently with real data.

## The core workflow

1. Sign in to `/admin` → Candidates → **New Candidate**.
2. Open the candidate → Assessment tab → **Generate New Link**. Copy the link or
   the WhatsApp message.
3. Send that `/exam/<token>` link to the candidate by any channel you like — it
   works from a completely different browser, device, and network, with no
   account needed.
4. The candidate completes the assessment on their phone or computer. Answers
   autosave to the server as they go (not just to their device), so closing and
   reopening the browser does not lose progress, and if their invitation link
   later expires mid-assessment it has no effect — once started, the assessment
   uses its own separately configured duration (Admin Settings).
5. After submission, open the candidate in `/admin` to see eligibility, every
   question with the candidate's answer vs. the correct answer and a marks
   breakdown, timing, essay text (for manual rubric scoring), and integrity
   indicators. Score the essay and interview from the same screen; the final
   score and pass/fail update automatically.
6. Generate a PDF/CSV report, or export the whole batch to CSV/Excel.

## Security notes (read before deploying with real candidates)

- **HTTPS is enforced in production.** The app does not terminate TLS itself —
  put it behind a reverse proxy (nginx, Caddy, or your platform's load balancer)
  that does. With `NODE_ENV=production` the server redirects plain-HTTP GETs to
  `https://`, refuses non-GET requests that arrive over plain HTTP, and sends
  HSTS (`max-age=31536000`). `app.set('trust proxy', 1)` is already set so the
  original scheme is read from `X-Forwarded-Proto` and `req.ip` / rate limiting
  are correct behind a proxy. `ALLOW_INSECURE_HTTP=true` disables the
  enforcement and should only ever be used when something upstream already
  guarantees TLS.
- **`JWT_SECRET` must be a long random value**, kept out of source control. The
  server refuses to start without one that's at least 16 characters.
- Admin auth uses a **Bearer token in the `Authorization` header**, not a cookie
  — this was a deliberate choice to remove CSRF as an attack surface for the
  admin API entirely, rather than needing CSRF tokens.
- **Rate limiting** is applied to `/api/exam/*` (300 req/min/IP by default) and
  to login (20 attempts/15 min/IP), plus a tight 5-per-15-min limiter on the
  destructive Super Admin deletion endpoint. Tune with `EXAM_RATE_LIMIT_PER_MINUTE`
  and `LOGIN_RATE_LIMIT_PER_15_MIN`. Keep the exam limit well above real traffic:
  answers autosave while a candidate types, and a room full of candidates shares
  one public IP.
- **Exam tokens** are 32 bytes of `crypto.randomBytes` (64 hex chars) — never
  derived from candidate ID, email, phone, or database primary keys.
- Candidate answers, once submitted, are immutable (`assessment_sessions.status
  = 'SUBMITTED'` blocks further writes) and marks are always recomputed
  server-side from the stored answer key — nothing the candidate's browser
  sends is trusted as a grade.
- SQLite runs in WAL mode for reasonable concurrent read/write behavior. For a
  larger recruitment drive (hundreds of concurrent candidates), consider
  migrating to PostgreSQL — the schema in `src/schema.sql` and the query layer
  in each route file are simple, deliberately un-ORM'd SQL, so the port is
  mechanical but not automatic (no migration tool is included).
- Set `CORS_ORIGIN` to your real admin frontend's origin in production instead
  of leaving it permissive.

## Automatic submission when time runs out

The assessment deadline is `assessment_sessions.expires_at`, set from the server
clock when the candidate starts. **The browser countdown is only a prompt** —
nothing the client sends about time is trusted.

An assessment is finalized exactly once, through `finalizeSession()` in
[src/lib/finalize.js](src/lib/finalize.js). Three things can trigger it:

1. **The candidate presses Submit** — recorded as `MANUAL` / `CANDIDATE_SUBMITTED`.
2. **The client countdown reaches zero** — the portal immediately POSTs the
   submission itself, so the candidate sees the outcome without waiting.
3. **The server notices the deadline has passed** — on any exam API request
   (`requireActiveSession`), when the link is reopened, and via a background
   sweep every `AUTO_SUBMIT_SWEEP_SECONDS` (default 60). The sweep is what
   covers a candidate who simply walks away: no request ever arrives from that
   browser, so nothing else would notice.

The server also sweeps once at startup, catching anything that expired while the
process was down.

### Exactly one final state

`finalizeSession()` opens a transaction whose first statement is a conditional
update:

```sql
UPDATE assessment_sessions SET status='SUBMITTED', ... WHERE id = ? AND status = 'IN_PROGRESS'
```

Only the caller whose update actually changed a row goes on to grade and record.
Everything else is told the assessment is already finalized and changes nothing.
A manual submission a second before expiry is therefore never re-finalized or
re-scored by the auto path, and six simultaneous submissions still produce one
score row, one integrity row and one audit entry — all asserted in
`test/auto_submit.sh`.

### What is preserved

Every answer already saved to the server is kept and graded. Nothing is
invented: a question the candidate never filled in stays unanswered and scores
zero. Question timing is closed off at finalization, the assessment is locked,
and no further writes are accepted.

### What is recorded

`status` stays `SUBMITTED` — it is the lifecycle lock, and everything that
already keyed off it keeps working unchanged. *How* the assessment ended is
recorded separately, and that is what HR and the candidate are shown:

| Column | Values |
| --- | --- |
| `submission_type` | `MANUAL` · `AUTO_SUBMITTED` |
| `submission_reason` | `CANDIDATE_SUBMITTED` · `TIME_EXPIRED` |
| `answered_count` / `unanswered_count` | counted at finalization |

The candidate's portal shows a **TIME EXPIRED** screen and cannot continue. HR
gets a **Submission record** panel on the candidate's Assessment tab with
status, reason, started, scheduled end, actual end, duration, answered and
unanswered. An `ASSESSMENT_AUTO_SUBMITTED` audit record carries the candidate,
assessment, timestamp, reason and both counts.

## UI guarantees

Every rendered control in both SPAs is wired to a real handler — there are no
placeholder buttons, TODO stubs or no-op handlers. `test/ui_wiring.js` enforces
this as a regression test: it fails if a button is ever added without a handler,
if a dead `href="#"` appears, or if an action button loses its loading state.

- **No duplicate operations.** Every mutating button carries `data-busy="Label"`
  and is decorated so it is disabled for the *whole* async operation, not just
  until the click handler returns. Two rapid clicks on Generate Link, Save,
  Backup or Submit produce exactly one operation. The server is independently
  idempotent (see `finalizeSession`), so this is defence in depth, not the only
  guard.
- **Loading states.** The same mechanism shows `Saving…`, `Generating…`,
  `Backing up…`, `Submitting…` while work is in flight.
- **Modals always close.** Escape, clicking the backdrop and Cancel all dismiss,
  so a failed action can never leave the page under a stuck overlay.
- **Errors are specific.** `httpMessage()` maps 400/401/403/404/409/422/429/500/503
  to something a user can act on; network failure says so plainly; a 401 clears
  the session and returns to login. A failed request never renders as success,
  and an empty download is reported rather than saved.
- **Views fail visibly.** A view whose data fails to load shows an error with a
  Retry button instead of hanging on `Loading…`.

## Administrative controls

**Candidate lifecycle.** Edit details (audited), Archive (reversible, hides from
the working list, keeps every record), Restore, and Permanent Delete. Deletion
is Super Admin only, requires the candidate's code typed back plus the admin's
password, is refused while an assessment is `IN_PROGRESS` or `PAUSED`, and
records the counts of everything it removed.

**Invitation links.** Generate, Copy, Revoke (permanent), Disable (reversible),
Re-enable, and Extend expiry. Expiry is configurable with presets
(5/10/15/20/30/60/custom); **already-issued links keep the expiry they were
created with**. A disabled link tells the candidate it is temporarily disabled
rather than pretending it never existed.

**Live exam control** (`Admin → Live Assessments`) shows every running
assessment with time remaining, progress, status, link status, integrity risk
and last activity, and offers only the actions valid for that state:

| Action | Effect |
| --- | --- |
| Pause | Candidate is locked out (HTTP 423) and **the countdown freezes** |
| Resume | Deadline is pushed out by exactly the paused duration — no time is lost |
| Change time | Sets a **new total duration**, measured from when the candidate started |
| Extend time | **Adds** minutes to the current deadline |
| Terminate | Locks the assessment immediately, marked from the answers already saved |

Pause policy is *freeze and credit back*. A paused assessment is never
auto-submitted: `isExpired()` returns false while paused and the background
sweep skips it, so an administrator can pause indefinitely without the clock
running out underneath the candidate. Terminate goes through the same single
finalizer as every other ending, so it cannot race a concurrent submission.
Every one of these is audited.

**Users** (`Admin → Users`, Super Admin only): create, edit, enable/disable,
change role and reset password across all six roles. Passwords are bcrypt-hashed
and no route ever returns a hash. A generated reset password is shown exactly
once and never written to the audit log. The last active Super Admin cannot be
demoted or disabled, and nobody can disable their own account.

## Account security

Admin passwords must be at least **14 characters** and use at least **three of
four** character classes (lowercase, uppercase, digit, symbol). Passwords that
are published in this repository — including the seeded default — are rejected
outright, as are passwords containing the account name. Rules live in
`src/lib/passwordPolicy.js` and apply to both account creation and reset.

`Admin → Users → Reset password` generates a 20-character password from a
CSPRNG, guaranteeing every class. It is returned **exactly once** so the
administrator can hand it over, is bcrypt-hashed before storage, and is never
written to the audit log — the audit record names who reset whose password and
nothing more.

**Sessions are invalidated** on password reset, role change and account
disable. Each user row carries a `token_version` that is embedded in their JWT;
raising it makes every token that account already holds fail on the next
request. `requireAuth` also re-reads the account on every request, so a
disabled account or a demotion takes effect immediately rather than lingering
until the token expires. The role used for authorisation comes from the
database, not from the token.

**JWT rotation** is supported without disruption: set `JWT_SECRET` to the new
value and `JWT_SECRET_PREVIOUS` to the old one, and tokens signed with either
are accepted until the old sessions expire. See `RAILWAY_DEPLOYMENT.md` §2b.

## Candidate identifier (LALCO ID)

`candidates.code` is the human-readable business identifier shown on reports and
typed by the candidate to verify their identity. It is generated automatically
as `LALCO-YYYY-NNNNN`, and an administrator may instead supply their own when
creating a candidate (for example `TEST-LIVE-001`).

- Optional — omit it and one is generated, exactly as before.
- Trimmed and uppercased; letters, digits, hyphen and underscore only, 3–32
  characters, must start and end with a letter or digit. Internal spaces are
  rejected rather than silently stripped.
- Unique, enforced both by validation and by the UNIQUE index.
- It can be corrected later, but **not once an assessment has been started** —
  the candidate verifies with it and reports already carry it. Changes are
  audited as `CANDIDATE_CODE_CHANGED`.
- Follows existing candidate-management RBAC (Super Admin, HR Admin, Recruiter).

**It is not a secret and never secures anything.** The invitation URL always
uses the 32-byte random token from `src/lib/tokens.js`; the LALCO ID and the
internal database id never appear in an exam URL.

## Data display rules

A NULL score means *this has not happened yet*; a 0 means *this was marked and
scored zero*. Conflating them would tell HR a candidate failed a section nobody
has marked. `src/lib/display.js` is the single source of these labels:

| State | Shown as |
| --- | --- |
| Written score not yet marked | `Not graded` |
| Interview not yet held | `Not completed` |
| Final not yet computable | `Not calculated` |
| Question never answered | `Not answered` |
| Genuinely scored zero | `0/30` |

Spreadsheet cells keep a real 0 as the number `0` and leave a missing mark
blank, so Excel sorts and sums correctly without inventing zeros.

**Encoding.** CSV exports start with a UTF-8 BOM and use CRLF so Excel detects
UTF-8 and renders Lao correctly. PDFs embed Noto Sans Lao (SIL Open Font
License, `src/assets/`) — PDFKit's built-in fonts are Latin-only and would
render Lao as blank boxes. Excel and Google Sheets carry Unicode natively.

**Timestamps.** SQLite's `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` in UTC
with no timezone marker, and JavaScript parses that shape as *local* time — which
silently shifted 14 stored columns by the server's UTC offset (7 hours in Laos)
everywhere they were displayed or used in arithmetic. `src/lib/timeutil.js`
(and its counterpart in both SPAs) normalises both shapes to the same instant.

## Deployment

See **[RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md)** for the exact Railway
configuration. The essentials:

- **`GET /api/health`** returns `{"status":"ok","database":"connected"}`. It
  needs no authentication, exposes no configuration, and is exempt from the
  HTTPS redirect so an internal plain-HTTP probe still succeeds.
- **SQLite needs a persistent volume.** `DATABASE_PATH` can point anywhere; the
  app creates the directory, and the database, its WAL/SHM sidecars and
  `backups/` all live beside it — never inside `public/`, so none of it is
  web-accessible. Without a mounted volume a container redeploy destroys
  everything.
- **CORS**: `CORS_ORIGIN` takes one origin or a comma-separated list. Under
  `NODE_ENV=production` an unlisted origin gets no allow-origin header at all,
  and the API never answers with a wildcard. The bundled admin and exam SPAs are
  same-origin, so the app works fully with `CORS_ORIGIN` unset.
- The server reads `PORT` from the environment and binds `HOST` (default
  `0.0.0.0`).

### Seeding a production database

```bash
npm run seed        # reference data only — safe for production
npm run seed:demo   # + ~20 demo candidates — local/staging only
```

`npm run seed` creates admin accounts, the question bank and answer keys,
eligibility rules, the interview rubric and scholarship policy. **It creates no
candidate records.** Every step is idempotent, so it is safe to re-run. A fresh
database has no users and no questions, so this must be run once before anyone
can log in.

## Data management (Super Admin)

`Admin -> Data Management` is a Super-Admin-only page. Every button on it calls an
API guarded by `requireRole('SUPER_ADMIN')` — HR Admin, Recruiter, Interviewer,
Evaluator and Manager all receive `403`, so hiding the nav item is a convenience,
not the access control.

It shows total candidates, active/completed assessments, passed, failed and
pending, and offers:

- **Export All Candidate Data** / **Export All Assessment Results** (CSV).
- **Backup Database** — `db.backup()` writes one consistent `.sqlite` file under
  `data/backups/` containing candidates, applications, sessions, answers, scores,
  interviews, integrity events and audit records. WAL/SHM scratch files are
  checkpointed in rather than copied, so no temporary files end up in the backup.
  Each backup is listed with its creation time and can be downloaded; the
  download endpoint accepts only names matching `LALCO_backup_<stamp>.sqlite`, so
  no other file on disk can be requested through it.
- **Create / Delete Demo Candidates** — demo records are ordinary, fully working
  candidates flagged `is_demo = 1`. They are excluded from the Google Sheets HR
  workbook unless `GOOGLE_SYNC_INCLUDE_DEMO=true`, and can be wiped repeatedly
  without touching real candidates. Candidate codes are derived from the highest
  code already issued, never from a row count, so a code is never reused after a
  deletion.
- **DANGER ZONE -> DELETE ALL CANDIDATE DATA**, which requires all four of:
  Super Admin role, the typed phrase `DELETE ALL CANDIDATES`, the Super Admin's
  password re-entered, and passing the 5-attempts-per-15-minutes limiter.

### What the deletion removes, and what it keeps

Removed (one SQLite transaction — if anything fails the whole thing rolls back,
so a partially deleted candidate is not possible): `candidates`,
`assessment_sessions`, `assessment_links`, `link_access_log`, `candidate_answers`,
`answer_events`, `scores`, `integrity_assessments`, `integrity_reviews`.

Kept: `users`, `questions` (and their answer keys), `interview_questions`,
`interview_criteria`, `eligibility_rules`, `settings`, `departments`, `branches`,
`positions`, `scholarship_policies` — and **`audit_logs`**. The audit log is never
deleted; instead the deletion writes a `DELETE_ALL_CANDIDATE_DATA` record naming
who performed it, the timestamp, and how many candidates, assessments and answers
were removed.

## Google Sheets (HR reporting)

**Google Sheets is a reporting/export destination, not a database.** SQLite stays
authoritative; nothing is ever read back from Sheets into the application.

```
Candidate -> Node.js backend -> SQLite (source of truth) -> Google Sheets API -> HR workbook
```

The workbook has seven sheets, rebuilt in full on each sync: `Candidates`,
`Applications`, `Assessment Results`, `Question Results`, `Interview Results`,
`Integrity Events`, `Audit Summary`. Column layouts live in `src/lib/sheetData.js`,
which is pure data transformation with no network calls — so the exact column
mapping is asserted by the test suite even on a machine with no Google
credentials. Interview criterion columns are read from the live
`interview_criteria` table, so they cannot drift from the configured rubric.

Configure it with `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
`GOOGLE_PRIVATE_KEY` (see `.env.example`). These are read server-side only; the
browser is told nothing but a `googleSyncConfigured` boolean. If they are unset,
the app behaves exactly as before and the sync buttons report "not configured".

**Failure is never allowed to affect an exam.** With `GOOGLE_SYNC_ON_SUBMIT=true`
a submitted assessment is synced *after* the response has already been sent to
the candidate. If Google is unreachable the candidate sees nothing unusual, the
result is already committed to SQLite, and the session is left at
`google_sync_status = 'PENDING'` for the administrator's **RETRY GOOGLE SHEETS
SYNC** button. `Analytics -> Export to Google Sheets` runs the same sync on demand
alongside the existing PDF/CSV/Excel exports.

### Integrity wording

The Integrity Events sheet reports mechanical signals only — paste events, large
pastes, focus changes, visibility changes, risk level. It never states that a
candidate used AI. The `Reviewer` and `Reviewer Comment` columns stay blank until
a named human records a conclusion through
`PUT /api/admin/integrity/:sessionId/review`, whose allowed values are
`NO_CONCERN`, `INCONCLUSIVE`, `POTENTIAL_AI_ASSISTANCE_INDICATOR` and
`CONFIRMED_MISCONDUCT`. Nothing in the system writes one automatically.

## Project layout

```
src/
  schema.sql              relational schema (see the ERD-ish comments inline)
  db.js                   opens the SQLite file, runs schema.sql, seeds singleton rows
  seed.js                 demo data — safe to re-run, never duplicates
  lib/
    tokens.js             secure random token/id generation
    grading.js            server-side calculation marking engine (partial credit)
    eligibility.js         eligibility rule engine
    audit.js              audit log writer
    finalize.js           the single, atomic, idempotent assessment finalizer
    examControl.js        pause/resume/terminate, exam time, link enable/disable
    display.js            NULL-vs-zero presentation rules shared by every export
    timeutil.js           parses SQLite and ISO timestamps as the same instant
    passwordPolicy.js     admin password rules + CSPRNG generator
    candidateCode.js      LALCO ID validation, normalisation and uniqueness
    dataManagement.js     statistics, demo fixtures, transactional candidate deletion
    sheetData.js          builds the seven HR reporting sheets from SQLite (no network)
    googleSheets.js       Google Sheets API client, sync + pending-retry logic
  middleware/auth.js       JWT auth, role guard, rate limiters
  routes/
    admin/                 auth, candidates, questions, links, reports,
                            dataManagement (Super Admin only), misc (interviews/
                            scholarship/settings/integrity review/audit/analytics)
    exam.js                the entire public candidate-facing API
  server.js               Express app wiring + static hosting for both frontends
public/
  admin/                   private admin single-page app (vanilla JS)
  exam/                    public candidate exam single-page app (vanilla JS)
  shared.css               design tokens shared by both
e2e_test.sh                automated black-box test of the full workflow incl. security checks
test/
  lib.sh                   shared harness - throwaway DB per suite, never touches data/
  security_check.sh        section 16 - security assertions
  auto_submit.sh           sections 1-8 - auto-submit on time expiry
  ui_wiring.js             static: no dead buttons, guards + error handling present
  ui_actions.sh            behavioural: the operation behind every control
  ui_browser.js/.sh        real Chromium driving the actual admin UI (opt-in)
  admin_controls.sh        candidate/link/exam-time/user controls + NULL-vs-zero
  deployment.sh            sections 9-15 - volume path, seeding, health, CORS, Node
  multi_candidate.sh       section 19 - three candidates, three sessions, no bleed
  mobile_markup.sh         section 20 - static mobile checks (device testing is manual)
  google_sync.sh           sections 13-16 - Sheets reporting and its failure paths
  data_lifecycle.sh        section 21 - demo data, deletion, what survives
  run_all.sh               runs every suite and prints one summary
```

## Known simplifications (so nothing here is oversold)

- No password reset flow, no email delivery, no SMS — links are generated for
  you to copy and send manually (a "Copy WhatsApp Message" button is provided).
- Interview questions are configurable via the admin API but the current UI
  only supports adding new ones, not reordering/deactivating (the API supports
  `PATCH /api/admin/questions/interview/questions/:id` for that already).
- Single essay question, matching the current LALCO assessment. The schema and
  grading engine support adding more (`type = 'ESSAY'` rows), the UI currently
  assumes one.
- No automated DB migrations tool — `schema.sql` uses `CREATE TABLE IF NOT
  EXISTS`, so it's additive-safe, but changing a column later is a manual ALTER.
- AI-assisted essay-scoring suggestions (mentioned as optional in the original
  brief) are not wired in this build — the essay rubric is scored by a human
  evaluator directly, which was already required regardless.

## Running the acceptance tests yourself

```bash
bash test/run_all.sh
```

Every suite seeds its own **throwaway database in a temp directory on its own
port** — none of them can touch `data/lalco.db`. If `node` on your `PATH` is not
the version `better-sqlite3` was compiled against, pass another one:
`NODE=/path/to/node bash test/run_all.sh`.

| Suite | Covers |
| --- | --- |
| `e2e_test.sh` | The core workflow end to end: create candidate, generate link, open it as an unauthenticated stranger, verify identity, answer all 6 calculation questions + essay, simulate a large paste and tab switches, submit, confirm post-submission edits are rejected, confirm a re-issued link revokes (but preserves) the old one, HR sees the full per-question breakdown, essay/interview scoring rolls into a final score and pass/fail, reports (CSV/PDF/Excel) and the audit log are populated, a bogus token is rejected. |
| `test/security_check.sh` | All 18 checks from the security section, 101 assertions: admin API auth, cross-candidate isolation, score/answer-key immutability, double submission, expired/revoked/superseded/invalid tokens, role permissions, Super-Admin-only deletion, no Google credentials in anything the browser receives, the database file not being served, bcrypt hashing, refusal to start without a strong `JWT_SECRET`, rate limiting, and HTTPS enforcement + HSTS under `NODE_ENV=production`. |
| `test/ui_actions.sh` | Every user-actionable control, verified by its underlying operation rather than by the click firing: login/logout incl. disabled accounts, all sidebar destinations, candidate create/search/open, link generate/revoke/regenerate, eligibility rules changing a real eligibility outcome, question bank, marking (30+30+40=100, threshold 70, role rules, re-mark does not duplicate), PDF/CSV/Excel with real bytes and real content, Google Sheets reporting an honest NOT CONFIGURED, all Data Management buttons, settings persisting across reload, audit coverage for eleven action types, HTTP error states, and the full delete-all authorisation chain. Includes the duplicate-click checks: five simultaneous Generate Link calls leave one active link, five simultaneous Submits produce one score row. |
| `test/auto_submit.sh` | Genuine auto-submission, driven by a real 1-minute assessment. An abandoned session is finalized by the server with no candidate action; saved answers are kept and unanswered ones stay unanswered; the result exists and the assessment is locked; `AUTO_SUBMITTED` / `TIME_EXPIRED` reach HR and the audit log; a late request finalizes on the spot and its answer is rejected; a manual submission just before expiry is never duplicated, re-scored or relabelled; six simultaneous submissions yield one final state; and a client-supplied deadline is ignored. |
| `test/deployment.sh` | Deployment readiness: SQLite opens from a custom `DATABASE_PATH` on a directory that does not exist yet, WAL/SHM sidecars and backups land beside it and never under `public/` or over HTTP, data survives a restart, the health check reports `ok`/`connected` and leaks nothing, production CORS allows only listed origins and never a wildcard, Node 20 pinning and `0.0.0.0` binding, and `npm run seed` creates reference data with **zero** candidate records while `seed:demo` is the only path that creates them. |
| `test/multi_candidate.sh` | Three candidates with three links, started interleaved and submitted independently: each sees only their own data, each identity check is bound to its own candidate, scores and essay text never cross over, each submission locks independently, and marking one candidate leaves the others untouched. |
| `test/mobile_markup.sh` | Static mobile-readiness checks on the candidate portal: viewport and safe-area handling, pinch zoom left enabled, numeric keypads, real radio inputs with tappable rows, 48px touch targets, 16px fields (so iOS Safari does not zoom on focus), the countdown, Next/Previous, and — over real HTTP — that a partially typed answer survives on the server, that reopening the link resumes the session with the server's own deadline, and that a resubmit from a flaky connection is rejected. **This is not a device test**; see `MOBILE_TEST_CHECKLIST.md`. |
| `test/google_sync.sh` | Google Sheets as a reporting destination, focused on the failure path. Unconfigured: the sync says exactly which variables are missing and returns 503 rather than crashing, and assessments complete normally. Configured but unreachable: the candidate still submits, is never shown a Google or database message, the submission is not delayed waiting on Google, the result is in SQLite, the session is left `PENDING`, the administrator sees it listed, **RETRY GOOGLE SHEETS SYNC** reports the failure honestly and leaves it retryable, the failure is audited, credentials never appear in any browser-facing response, and role restrictions hold. |
| `test/data_lifecycle.sh` | Create 5 demo candidates, complete all 5 assessments, verify statistics and that demo records stay out of HR reporting, back up and verify the backup's contents, delete demo candidates and confirm the question bank / admin users / scoring rules survive, verify candidate codes are not reused, create real candidates, verify the seven-sheet workbook layout and the human-reviewer integrity flow, `DELETE ALL CANDIDATE DATA`, confirm every candidate table is empty, every protected table is intact, and the audit log survives carrying a `DELETE_ALL_CANDIDATE_DATA` record with who/when/how many, then confirm the system still works afterwards. |

### Not covered by automation

Real-device browser testing (Android Chrome, iPhone Safari, desktop Chrome) has
to be done by hand — see `MOBILE_TEST_CHECKLIST.md`.
