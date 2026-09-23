# Railway deployment — LALCO Recruitment & Assessment Platform

Everything below is entered in the Railway dashboard. Nothing here belongs in
GitHub: no secret is committed, and `.env` is gitignored.

---

## 1. Persistent volume (do this FIRST)

The app uses SQLite. Railway containers have an **ephemeral filesystem** — without
a volume, every redeploy destroys all candidates, assessments, scores and the
audit log.

In your Railway service → **Settings → Volumes → New Volume**:

| Field | Value |
| --- | --- |
| Mount path | `/data` |

Then set `DATABASE_PATH=/data/lalco.db` (below) so the database, its WAL/SHM
sidecars, and the backups directory all live on that volume.

The app creates the directory if it does not exist, writes
`/data/lalco.db`, `/data/lalco.db-wal`, `/data/lalco.db-shm`, and puts backups
in `/data/backups/`. None of those paths is inside `public/`, so none of them is
web-accessible.

---

## 2. Environment variables

Railway service → **Variables**. Required:

| Variable | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Enables HTTPS enforcement, HSTS and strict CORS. |
| `JWT_SECRET` | *(generate — see below)* | **The server refuses to start without this.** Minimum 16 chars; use 96. |
| `DATABASE_PATH` | `/data/lalco.db` | Must be inside the mounted volume. |
| `CORS_ORIGIN` | `https://<your-app>.up.railway.app` | Your real public origin. Comma-separate if there is more than one. |

Generate the secret locally and paste the output:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Optional:

| Variable | Default | Notes |
| --- | --- | --- |
| `PUBLIC_EXAM_BASE_URL` | request host | Set to your public URL so generated exam links are correct. |
| `AUTO_SUBMIT_SWEEP_SECONDS` | `60` | How often abandoned expired assessments are finalized. Minimum 5. |
| `EXAM_RATE_LIMIT_PER_MINUTE` | `300` | Raise for a large sitting behind one office IP. |
| `LOGIN_RATE_LIMIT_PER_15_MIN` | `20` | Admin login attempts per IP. |
| `DEMO_PASSWORD` | *(none — required)* | Password given to the seeded admin accounts. **There is no default**: the seed aborts if it is unset, and rejects weak or publicly known values against the same policy as an admin password reset. Rotate every account through Admin → Users after seeding. |
| `JWT_SECRET_PREVIOUS` | *(unset)* | Only during a secret rotation — see section 2b. |

Google Sheets (only if you use it — otherwise leave all three unset and the app
behaves exactly as before):

| Variable | Notes |
| --- | --- |
| `GOOGLE_SHEET_ID` | Target spreadsheet. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account with edit access to it. |
| `GOOGLE_PRIVATE_KEY` | Keep the `\n` escapes on one line. |
| `GOOGLE_SYNC_ON_SUBMIT` | `false` by default. `true` syncs after each submission (never blocks the exam). |

**Do not set** `ALLOW_INSECURE_HTTP` — it disables HTTPS enforcement.

---

## 2b. Rotating JWT_SECRET without disrupting an assessment

The app accepts **two** signing secrets so a rotation never signs anybody out
mid-exam.

1. Generate a new secret:
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
2. In Railway **Variables**, set both at once:
   - `JWT_SECRET_PREVIOUS` = the *current* value of `JWT_SECRET`
   - `JWT_SECRET` = the new value
3. Redeploy. New sign-ins use the new secret; sessions issued under the old one
   keep working until they expire (8 hours), so an assessment in progress is
   unaffected.
4. **After at least 8 hours**, delete `JWT_SECRET_PREVIOUS` and redeploy. Any
   token still signed with the old secret is now rejected.

The server refuses to start if `JWT_SECRET_PREVIOUS` equals `JWT_SECRET`, so a
rotation that did not actually change anything fails loudly instead of looking
like it worked. Never print or commit either value.

To force everyone out immediately instead, reset each account's password —
that bumps `users.token_version` and invalidates that account's sessions at
once, without touching the secret.

---

## 3. Build and start

Railway detects these automatically; no `railway.json` is needed.

| | |
| --- | --- |
| Node version | `20` — from `.nvmrc` and `engines.node` in `package.json` |
| Install | `npm ci` (a `package-lock.json` is committed) |
| Start | `npm start` → `node src/server.js` |
| Port | Read from `process.env.PORT`; binds `0.0.0.0` |
| Health check path | `/api/health` |

Set the health check path in **Settings → Health Check** to `/api/health`. It
returns `{"status":"ok","database":"connected"}` and is deliberately exempt from
the HTTPS redirect so an internal plain-HTTP probe still succeeds.

---

## 4. Seed the database — once, after the first successful deploy

A fresh database has **no admin users and no question bank**, so nobody can log
in until it is seeded.

Railway → your service → **Settings → Deploy → Custom Start Command**, or a
one-off shell:

```bash
npm run seed
```

This seeds reference data only: admin accounts (one per role), the question
bank and answer keys, eligibility rules, the interview rubric and scholarship
policy. **It does not create any candidate records.** It is safe to re-run —
every step skips what already exists.

`npm run seed:demo` additionally creates ~20 demo candidates. Never run that
against production.

Immediately after seeding, sign in as `superadmin@lalco.demo` with your
`DEMO_PASSWORD` and change every password.

---

## 5. Verify after deploy

```bash
curl https://<your-app>.up.railway.app/api/health
# {"status":"ok","database":"connected","uptimeSeconds":...}

curl -I https://<your-app>.up.railway.app/admin
# 200, with strict-transport-security present

curl -s -o /dev/null -w '%{http_code}\n' https://<your-app>.up.railway.app/api/admin/candidates
# 401  (API alive and protected)

curl -s -o /dev/null -w '%{http_code}\n' https://<your-app>.up.railway.app/data/lalco.db
# 404  (the database is never web-accessible)
```

Then confirm persistence, which is the whole point of the volume: create a
candidate, redeploy, and check the candidate is still there.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Crash loop, `JWT_SECRET must be set...` | Variable missing | Set `JWT_SECRET`. |
| Deploy is healthy but nobody can log in | Database never seeded | Run `npm run seed`. |
| All data vanished after a deploy | No volume, or `DATABASE_PATH` outside it | Mount `/data` and set `DATABASE_PATH=/data/lalco.db`. |
| Health check failing | Wrong path | Set it to `/api/health`. |
| Browser console CORS errors | Admin UI served from another origin | Add that origin to `CORS_ORIGIN`. |
| `better-sqlite3` build errors | Wrong Node major | Confirm Node 20 is being used (`.nvmrc`, `engines`). |
